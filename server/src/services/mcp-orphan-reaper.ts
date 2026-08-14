import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { logger } from "../middleware/logger.js";

const execFileAsync = promisify(execFile);

/**
 * Matches only Model Context Protocol server processes that a run spawns as a
 * descendant (today the Playwright MCP server). The predicate is intentionally
 * narrow: it requires the MCP package/binary name, never a bare "playwright",
 * so we cannot signal an unrelated node process or a `playwright test` run.
 *
 * Recognised forms:
 *   - `@playwright/mcp` — the published package (e.g. `node .../@playwright/mcp/cli.js`)
 *   - `mcp-server-playwright` — the installed bin name
 *   - `playwright-mcp` — the short bin/alias name
 */
export const MCP_ORPHAN_COMMAND_RE =
  /(?:@playwright\/mcp(?![A-Za-z0-9._-])|(?:^|[/\s])mcp-server-playwright(?![A-Za-z0-9._-])|(?:^|[/\s])playwright-mcp(?![A-Za-z0-9._-]))/;

export interface ProcessSnapshot {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

export type ProcessLister = () => Promise<ProcessSnapshot[]>;

export interface McpReapOptions {
  /** Override the process enumeration (used by tests). */
  lister?: ProcessLister;
  /** Grace period between SIGTERM and SIGKILL when reaping. */
  graceMs?: number;
}

const DEFAULT_GRACE_MS = 2_000;

async function listProcessesViaPs(): Promise<ProcessSnapshot[]> {
  if (process.platform === "win32") return [];
  try {
    // `command=` yields the full argv on Linux/macOS. Suppress the header with
    // the trailing `=` on each field so parsing stays positional.
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,pgid=,command="], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const rows: ProcessSnapshot[] = [];
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const command = match[4].trim();
      if (!command) continue;
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        command,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

export function isMcpOrphanCommand(command: string): boolean {
  return MCP_ORPHAN_COMMAND_RE.test(command);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone / not ours — nothing to do.
  }
}

/**
 * SIGTERM the given pids, wait up to `graceMs` for them to exit, then SIGKILL
 * any survivors. Returns the pids that were signalled (i.e. were alive when the
 * reap began).
 */
export async function killMcpPids(pids: number[], opts?: { graceMs?: number }): Promise<number[]> {
  const targets = [...new Set(pids)].filter((pid) => pidAlive(pid));
  if (targets.length === 0) return [];

  for (const pid of targets) signalPid(pid, "SIGTERM");

  const graceMs = Math.max(0, opts?.graceMs ?? DEFAULT_GRACE_MS);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (targets.every((pid) => !pidAlive(pid))) return targets;
    await delay(50);
  }

  for (const pid of targets) {
    if (pidAlive(pid)) signalPid(pid, "SIGKILL");
  }
  return targets;
}

function collectDescendantPids(processes: ProcessSnapshot[], rootPid: number): Set<number> {
  const childrenByPpid = new Map<number, number[]>();
  for (const proc of processes) {
    const bucket = childrenByPpid.get(proc.ppid);
    if (bucket) bucket.push(proc.pid);
    else childrenByPpid.set(proc.ppid, [proc.pid]);
  }

  const descendants = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const child of childrenByPpid.get(current) ?? []) {
      if (descendants.has(child)) continue;
      descendants.add(child);
      stack.push(child);
    }
  }
  return descendants;
}

/**
 * Pure selector: MCP pids that belong to a run, resolved from a process
 * snapshot taken *before* teardown so ppid links are intact. A well-behaved
 * MCP stays inside the run's process group and is killed by the group signal;
 * a misbehaving one that `setsid`s into its own session escapes that signal
 * and would otherwise orphan (ppid==1). We identify it by process-tree
 * membership so it can be killed explicitly afterwards.
 *
 * Selection = MCP command AND (descendant of `pid` OR shares `processGroupId`).
 */
export function selectRunMcpDescendantPids(
  processes: ProcessSnapshot[],
  target: { pid?: number | null; processGroupId?: number | null },
  selfPid: number = process.pid,
): number[] {
  const rootPid = typeof target.pid === "number" && target.pid > 0 ? target.pid : null;
  const pgid =
    typeof target.processGroupId === "number" && target.processGroupId > 0 ? target.processGroupId : null;
  if ((rootPid === null && pgid === null) || processes.length === 0) return [];

  const descendants = rootPid !== null ? collectDescendantPids(processes, rootPid) : new Set<number>();
  const selected: number[] = [];
  for (const proc of processes) {
    if (proc.pid === selfPid || proc.pid <= 1) continue;
    if (!isMcpOrphanCommand(proc.command)) continue;
    if (descendants.has(proc.pid) || (pgid !== null && proc.pgid === pgid)) {
      selected.push(proc.pid);
    }
  }
  return [...new Set(selected)];
}

/**
 * Pure selector: pre-existing MCP strays that were orphaned to init. Safe
 * matching = MCP command AND ppid==1. A healthy MCP owned by a live run has a
 * live parent, so ppid==1 uniquely identifies a leaked orphan.
 */
export function selectOrphanedMcpStrayPids(
  processes: ProcessSnapshot[],
  selfPid: number = process.pid,
): number[] {
  const strays: number[] = [];
  for (const proc of processes) {
    if (proc.pid === selfPid || proc.pid <= 1) continue;
    if (proc.ppid !== 1) continue;
    if (!isMcpOrphanCommand(proc.command)) continue;
    strays.push(proc.pid);
  }
  return [...new Set(strays)];
}

/**
 * Snapshot the run's MCP descendant pids before its process group is torn down.
 */
export async function snapshotRunMcpDescendantPids(
  target: { pid?: number | null; processGroupId?: number | null },
  opts?: McpReapOptions,
): Promise<number[]> {
  if (process.platform === "win32") return [];
  const processes = await (opts?.lister ?? listProcessesViaPs)();
  return selectRunMcpDescendantPids(processes, target);
}

/**
 * Reap MCP descendants of a run around its teardown. Snapshots the descendant
 * MCP pids, invokes the provided `terminate` callback (which kills the run's
 * process group), then kills any MCP pid that survived the group signal because
 * it had escaped into its own session.
 */
export async function reapRunMcpDescendants(
  target: { pid?: number | null; processGroupId?: number | null },
  terminate: () => Promise<void>,
  opts?: McpReapOptions,
): Promise<number[]> {
  const snapshot = await snapshotRunMcpDescendantPids(target, opts).catch(() => [] as number[]);
  await terminate();
  if (snapshot.length === 0) return [];

  const reaped = await killMcpPids(snapshot, { graceMs: opts?.graceMs });
  if (reaped.length > 0) {
    logger.warn(
      { reapedPids: reaped, runPid: target.pid ?? null, runProcessGroupId: target.processGroupId ?? null },
      "reaped MCP child processes that escaped a run's process group on teardown",
    );
  }
  return reaped;
}

/**
 * Startup sweep: kill pre-existing MCP strays that were orphaned by a prior
 * crash/kill. Safe matching = MCP command AND ppid==1 (reparented to init). A
 * healthy MCP owned by a live run has a live parent, so ppid==1 uniquely
 * identifies a leaked orphan and never a currently-serving MCP.
 */
export async function reapOrphanedMcpProcessesOnStartup(opts?: McpReapOptions): Promise<number[]> {
  if (process.platform === "win32") return [];
  const processes = await (opts?.lister ?? listProcessesViaPs)().catch(() => [] as ProcessSnapshot[]);
  const strays = selectOrphanedMcpStrayPids(processes);
  if (strays.length === 0) return [];

  const reaped = await killMcpPids(strays, { graceMs: opts?.graceMs });
  if (reaped.length > 0) {
    logger.warn({ reapedPids: reaped }, "startup sweep reaped orphaned MCP child processes (ppid==1)");
  }
  return reaped;
}
