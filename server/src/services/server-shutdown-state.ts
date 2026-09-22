/**
 * Process-wide server shutdown state and the persisted shutdown boundary.
 *
 * Single source of truth for "a server shutdown is in progress (this process)"
 * and "a previous process of this instance announced a shutdown before dying".
 * Every terminal-state path that closes a heartbeat run (graceful drain,
 * adapter-error close, process-lost reap) must consult `isRunKilledByServerShutdown`
 * before choosing between a genuine failure class (`adapter_failed`,
 * `process_lost`) and the shutdown class, so a run that dies *because the server
 * is shutting down* is never recorded as a run/adapter failure.
 *
 * Two signals, one predicate:
 *
 * 1. In-process flag: `markServerShutdownStarted` runs as the FIRST statement
 *    of the process signal handler (before any await) and sets a write-once
 *    memory flag. Close paths racing the graceful drain observe it no later
 *    than the drain itself.
 * 2. Persisted boundary: the same call writes a small JSON marker next to the
 *    hot-restart intent (synchronously — a signal handler cannot await). The
 *    marker survives a process that dies mid-drain (OOM kill, watchdog) and is
 *    consumed by the NEXT process's startup orphan reap, which is where runs
 *    killed by the previous shutdown surface as `process_lost` today. A run
 *    counts as shutdown-killed only if it was already running when the
 *    shutdown began (`run.startedAt <= boundary.startedAt`), so runs started
 *    after the boundary are never swept into the shutdown class.
 *
 * Incident context (2026-09-22): during paperclip.service
 * restart churn, runs killed by the shutdown were recorded as
 * `adapter_failed` (×3) and `process_lost` (×2) because their close paths ran
 * without consulting shutdown state — the adapter close because a SIGTERM wave
 * lands as a non-zero adapter exit, the startup reap because the new process
 * never saw the old process's signal. Only the runs the graceful drain itself
 * reached got the correct `server_shutdown_interrupted` state.
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

export type ServerShutdownSignal = "SIGINT" | "SIGTERM";

export interface ServerShutdownState {
  signal: ServerShutdownSignal;
  startedAt: Date;
}

/** Terminal error code recorded for a run killed by a server shutdown. */
export const SERVER_SHUTDOWN_INTERRUPTED_ERROR_CODE = "server_shutdown_interrupted";

/**
 * A shutdown boundary announced by a process of this instance, persisted at
 * signal-receipt time. `pid` identifies the process that wrote it; a marker
 * left behind by a dead process is exactly the evidence the next startup's
 * orphan reap needs.
 */
export interface ServerShutdownBoundary {
  signal: ServerShutdownSignal;
  startedAt: Date;
  pid: number;
}

const SERVER_SHUTDOWN_BOUNDARY_FILENAME = "server-shutdown-boundary.json";

export function resolveServerShutdownBoundaryPath(homeDir?: string): string {
  return path.join(resolvePaperclipInstanceRoot({ homeDir }), SERVER_SHUTDOWN_BOUNDARY_FILENAME);
}

let activeShutdown: ServerShutdownState | null = null;

function parseShutdownBoundary(value: unknown): ServerShutdownBoundary | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const signal = record.signal === "SIGINT" || record.signal === "SIGTERM"
    ? record.signal
    : null;
  const startedAt = typeof record.startedAt === "string" ? new Date(record.startedAt) : null;
  const pid = typeof record.pid === "number" && Number.isInteger(record.pid) ? record.pid : null;
  if (!signal || !startedAt || Number.isNaN(startedAt.getTime()) || pid === null) return null;
  return { signal, startedAt, pid };
}

/**
 * Mark the shutdown as started. Call this as the FIRST statement of the
 * process signal handler, before any await, so concurrent close paths observe
 * the flag no later than the drain itself does. First marker wins; repeat
 * calls (e.g. SIGINT after SIGTERM) do not move `startedAt` forward.
 *
 * Also persists the boundary marker synchronously: the periodic scheduler is
 * stopped during shutdown, so the marker's only reader is the NEXT process's
 * startup orphan reap. Write failures are logged to stderr but never fail the
 * shutdown — the in-memory flag still covers in-process close paths.
 */
export function markServerShutdownStarted(
  signal: ServerShutdownSignal,
  at: Date = new Date(),
  homeDir?: string,
): ServerShutdownState {
  activeShutdown ??= { signal, startedAt: at };
  if (activeShutdown.startedAt === at) {
    // First marker for this shutdown: persist it. Synchronous on purpose —
    // a signal handler cannot await, and a process killed mid-drain must
    // leave the boundary behind for the next startup reap. `homeDir` exists
    // so tests can scope the marker to a temp home instead of the ambient
    // (possibly live) instance root.
    try {
      const boundary: ServerShutdownBoundary = {
        signal: activeShutdown.signal,
        startedAt: activeShutdown.startedAt,
        pid: process.pid,
      };
      const markerPath = resolveServerShutdownBoundaryPath(homeDir);
      fsSync.mkdirSync(path.dirname(markerPath), { recursive: true });
      fsSync.writeFileSync(markerPath, JSON.stringify(boundary, null, 2), "utf8");
    } catch (err) {
      process.stderr.write(
        `[server-shutdown-state] failed to persist shutdown boundary marker: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }
  return activeShutdown;
}

/** True from the signal handler's first statement until process exit. */
export function isServerShutdownInProgress(): boolean {
  return activeShutdown !== null;
}

export function getServerShutdownState(): ServerShutdownState | null {
  return activeShutdown;
}

/** Signal for callers that have their own fallback; prefers the observed shutdown signal. */
export function currentShutdownSignal(fallback: ServerShutdownSignal): ServerShutdownSignal {
  return activeShutdown?.signal ?? fallback;
}

/**
 * Read the persisted shutdown boundary written by the most recent process of
 * this instance that received a shutdown signal. Null when no marker exists
 * (clean first boot, or the marker was consumed by a completed startup reap).
 */
export async function readLastServerShutdownBoundary(homeDir?: string): Promise<ServerShutdownBoundary | null> {
  try {
    const raw = await fs.readFile(resolveServerShutdownBoundaryPath(homeDir), "utf8");
    return parseShutdownBoundary(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Consume the persisted boundary after the startup orphan reap has classified against it. */
export async function clearLastServerShutdownBoundary(homeDir?: string): Promise<void> {
  await fs.rm(resolveServerShutdownBoundaryPath(homeDir), { force: true });
}

/**
 * THE shared shutdown-boundary predicate. Every terminal-state path that can
 * observe a shutdown (graceful drain, adapter-error close, process-lost reap)
 * routes its decision through this one function — no per-site copies that can
 * drift.
 *
 * A run is killed by the server shutdown when either:
 * - a shutdown is in progress in THIS process (the close raced the drain), or
 * - a persisted boundary from a previous process proves the run was already
 *   running when that shutdown began.
 *
 * Runs started after the boundary (new-process work, post-boot dispatches)
 * are never classified as shutdown kills — they get the genuine failure class.
 */
export function isRunKilledByServerShutdown(input: {
  inProgress: boolean;
  boundary?: ServerShutdownBoundary | null;
  runStartedAt?: Date | null;
}): boolean {
  if (input.inProgress) return true;
  if (!input.boundary || !input.runStartedAt) return false;
  return input.runStartedAt.getTime() <= input.boundary.startedAt.getTime();
}

/** Test-only: reset the process-wide flag and remove the persisted marker. */
export async function resetServerShutdownStateForTests(homeDir?: string): Promise<void> {
  activeShutdown = null;
  await clearLastServerShutdownBoundary(homeDir);
}

/**
 * Test-only: reset the in-memory flag WITHOUT touching the persisted marker.
 * Suite-level afterEach hooks use this so a leaked flag from a failed test
 * cannot reclassify later runs — while never deleting a real marker at the
 * ambient instance root, which may belong to a live server on this host.
 */
export function resetServerShutdownMemoryForTests(): void {
  activeShutdown = null;
}
