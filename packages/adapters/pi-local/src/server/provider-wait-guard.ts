// Bound silent provider waits for the pi_local adapter.
//
// The vendored CLI can stall inside a blocking provider call (auth refresh,
// rate-limit backoff, network hang) and emit no NDJSON at all. The adapter owns
// the CLI process and its output stream, so it can (a) report the silence and
// (b) bound it: periodic stderr diagnostics name the best-effort wait class and
// keep the host's run activity fresh, and after a configurable silent bound the
// stalled process group is terminated so the run fails with a distinct
// `provider_wait_timeout` error code instead of hanging for hours.
//
// Everything here is opt-in via the `providerWaitGuard` adapter config block or
// the PAPERCLIP_PI_WAIT_* environment variables. With the guard disabled the
// adapter's behavior is byte-identical to before.
//
// Wait-class detection is best-effort: it classifies the tail of the CLI's own
// stderr output observed before/during the silence. A fully silent stall is
// reported as "unknown".

import { asBoolean, asNumber, parseObject, runningProcesses } from "@paperclipai/adapter-utils/server-utils";

export type ProviderWaitClass = "auth" | "rate_limit" | "network" | "unknown";

export interface ProviderWaitGuardConfig {
  /** Master switch. Default false: the guard is fully inert unless enabled. */
  enabled: boolean;
  /** Silent seconds before a one-time diagnostic naming the wait class. 0 disables. */
  idleDiagnosticSec: number;
  /** Cadence in silent seconds for periodic progress lines while idle. 0 disables. */
  progressSec: number;
  /** Silent seconds before the stalled CLI process is terminated. 0 = observe-only. */
  maxWaitSec: number;
}

export const PROVIDER_WAIT_TIMEOUT_ERROR_CODE = "provider_wait_timeout";

const DEFAULT_IDLE_DIAGNOSTIC_SEC = 900;
const DEFAULT_PROGRESS_SEC = 300;
const DEFAULT_MAX_WAIT_SEC = 3600;

const ENV_ENABLED = "PAPERCLIP_PI_WAIT_GUARD";
const ENV_IDLE_DIAGNOSTIC_SEC = "PAPERCLIP_PI_WAIT_IDLE_DIAGNOSTIC_SEC";
const ENV_PROGRESS_SEC = "PAPERCLIP_PI_WAIT_PROGRESS_SEC";
const ENV_MAX_WAIT_SEC = "PAPERCLIP_PI_WAIT_MAX_SEC";

const STDERR_EVIDENCE_TAIL_CHARS = 8 * 1024;

function resolveEnvValue(env: Record<string, string>, name: string): string | null {
  const value = env[name] ?? process.env[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function envSeconds(env: Record<string, string>, name: string): number | null {
  const raw = resolveEnvValue(env, name);
  if (raw === null) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function envEnabled(env: Record<string, string>, name: string): boolean | null {
  const raw = resolveEnvValue(env, name);
  if (raw === null) return null;
  return ["1", "true", "on", "yes"].includes(raw.toLowerCase());
}

function configSeconds(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const parsed = asNumber(raw, -1);
  if (parsed < 0) return null;
  return Math.floor(parsed);
}

/**
 * Resolve the guard configuration from the adapter config block
 * (`providerWaitGuard.{enabled,idleDiagnosticSec,progressSec,maxWaitSec}`)
 * with PAPERCLIP_PI_WAIT_* environment fallbacks. Precedence: explicit config
 * value > environment > built-in default. The guard is disabled unless an
 * explicit config or environment value turns it on.
 */
export function resolveProviderWaitGuardConfig(
  config: Record<string, unknown>,
  env: Record<string, string>,
): ProviderWaitGuardConfig {
  const block = parseObject((config as Record<string, unknown>).providerWaitGuard);

  const configEnabled = block.enabled !== undefined ? asBoolean(block.enabled, false) : null;
  const enabled = configEnabled ?? envEnabled(env, ENV_ENABLED) ?? false;

  return {
    enabled,
    idleDiagnosticSec:
      configSeconds(block.idleDiagnosticSec) ?? envSeconds(env, ENV_IDLE_DIAGNOSTIC_SEC) ?? DEFAULT_IDLE_DIAGNOSTIC_SEC,
    progressSec: configSeconds(block.progressSec) ?? envSeconds(env, ENV_PROGRESS_SEC) ?? DEFAULT_PROGRESS_SEC,
    maxWaitSec: configSeconds(block.maxWaitSec) ?? envSeconds(env, ENV_MAX_WAIT_SEC) ?? DEFAULT_MAX_WAIT_SEC,
  };
}

const WAIT_CLASS_PATTERNS: Array<{ waitClass: ProviderWaitClass; pattern: RegExp }> = [
  {
    // Provider rejected the credentials: 401/403 responses, invalid or missing
    // API keys, token/credential refresh failures.
    waitClass: "auth",
    pattern: /\b401\b|\b403\b|unauthorized|forbidden|invalid[ _-]api[ _-]?key|missing[ _-]api[ _-]key|credential|authenticat(?:e|ion|ing) failed|token refresh failed|refresh token/i,
  },
  {
    // Provider throttling or capacity: HTTP 429, rate-limit and quota wording.
    waitClass: "rate_limit",
    pattern: /\b429\b|rate[ _-]?limit|quota|too many requests|overloaded|capacity/i,
  },
  {
    // Transport-level failures: DNS, connect, reset, timeout wording.
    waitClass: "network",
    pattern: /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|fetch failed|socket hang up|network error|connection error|getaddrinfo/i,
  },
];

/** Best-effort wait-class classification from the CLI's own stderr evidence. */
export function classifyProviderWaitReason(evidence: string): ProviderWaitClass {
  for (const { waitClass, pattern } of WAIT_CLASS_PATTERNS) {
    if (pattern.test(evidence)) return waitClass;
  }
  return "unknown";
}

export interface ProviderWaitSpawnMeta {
  pid: number | null;
  processGroupId: number | null;
}

export interface ProviderWaitTimeoutInfo {
  idleSec: number;
  waitClass: ProviderWaitClass;
  pid: number | null;
}

export interface ProviderWaitGuardHandle {
  /** Feed every stdout/stderr chunk; any output resets the idle clock. */
  noteChunk(stream: "stdout" | "stderr", chunk: string): Promise<void>;
  /** Record spawn metadata so the kill can verify it owns the process. */
  onSpawn(meta: ProviderWaitSpawnMeta): void;
  /** Stop all timers. Idempotent. */
  dispose(): void;
  /** Non-null when this guard terminated the stalled process. */
  waitTimeout(): ProviderWaitTimeoutInfo | null;
  /** Resolved when pending emissions have been handed to onLog. */
  settled(): Promise<void>;
}

export interface ProviderWaitGuardDeps {
  now?: () => number;
  schedule?: (fn: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  /** Test seam: perform the actual process termination. */
  kill?: (input: {
    pid: number | null;
    processGroupId: number | null;
    signal: "SIGTERM" | "SIGKILL";
  }) => boolean;
}

interface GuardOptions {
  runId: string;
  config: ProviderWaitGuardConfig;
  /** SIGTERM -> SIGKILL escalation window, reused from the adapter grace. */
  graceSec: number;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
  deps?: ProviderWaitGuardDeps;
}

function defaultKill(runId: string): NonNullable<ProviderWaitGuardDeps["kill"]> {
  return (input) => {
    const running = runningProcesses.get(runId);
    if (!running) return false;
    // Verify the map entry is still the process this guard spawned. A resumed
    // retry can re-register the same runId; never signal an unknown process.
    if (input.pid != null && running.child.pid != null && running.child.pid !== input.pid) return false;
    if (input.signal !== "SIGKILL" && running.processGroupId && running.processGroupId > 0) {
      try {
        process.kill(-running.processGroupId, input.signal);
        return true;
      } catch {
        // Fall through to the direct child signal.
      }
    }
    try {
      running.child.kill(input.signal);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Arm the silent-wait watchdog for one CLI attempt. Any stdout/stderr chunk
 * resets the idle clock; while silent the guard emits a one-time diagnostic
 * naming the best-effort wait class plus periodic progress lines on stderr, and
 * after maxWaitSec of total silence terminates the stalled process group.
 * When config.enabled is false this returns an inert handle: no timers, no
 * output, byte-identical behavior.
 */
export function armProviderWaitGuard(options: GuardOptions): ProviderWaitGuardHandle {
  const { config } = options;
  const onLog = options.onLog;

  if (!config.enabled) {
    return {
      noteChunk: async () => {},
      onSpawn: () => {},
      dispose: () => {},
      waitTimeout: () => null,
      settled: async () => {},
    };
  }

  const now = options.deps?.now ?? Date.now;
  const schedule =
    options.deps?.schedule ??
    ((fn: () => void, delayMs: number) => {
      const timer = setTimeout(fn, Math.max(0, delayMs));
      // Never hold the process open for a watchdog.
      timer.unref?.();
      return timer;
    });
  const cancel = options.deps?.cancel ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  const kill = options.deps?.kill ?? defaultKill(options.runId);

  let disposed = false;
  let killed = false;
  let diagnosticEmitted = false;
  let lastActivityAt = now();
  let lastProgressAt: number | null = null;
  let timer: unknown = null;
  let spawnMeta: ProviderWaitSpawnMeta | null = null;
  let stderrEvidence = "";
  let emitChain: Promise<void> = Promise.resolve();

  const emit = (line: string) => {
    emitChain = emitChain.then(() => onLog("stderr", line)).catch(() => undefined);
    return emitChain;
  };

  const idleMs = () => Math.max(0, now() - lastActivityAt);

  const describeState = () => ({
    idleSec: Math.floor(idleMs() / 1000),
    waitClass: classifyProviderWaitReason(stderrEvidence),
    pid: spawnMeta?.pid ?? null,
  });

  const fireKill = () => {
    if (killed || disposed) return;
    killed = true;
    const { idleSec, waitClass, pid } = describeState();
    void emit(
      `[paperclip] provider-wait: no CLI output for ${idleSec}s (wait class: ${waitClass}); terminating the stalled CLI process${
        pid ? ` (pid ${pid})` : ""
      }.\n`,
    );
    kill({ pid: spawnMeta?.pid ?? null, processGroupId: spawnMeta?.processGroupId ?? null, signal: "SIGTERM" });
    const graceMs = Math.max(1, options.graceSec) * 1000;
    schedule(() => {
      kill({ pid: spawnMeta?.pid ?? null, processGroupId: spawnMeta?.processGroupId ?? null, signal: "SIGKILL" });
    }, graceMs);
  };

  const tick = () => {
    if (disposed || killed) return;
    timer = null;
    const idle = idleMs();

    if (config.maxWaitSec > 0 && idle >= config.maxWaitSec * 1000) {
      fireKill();
      return;
    }
    if (!diagnosticEmitted && config.idleDiagnosticSec > 0 && idle >= config.idleDiagnosticSec * 1000) {
      diagnosticEmitted = true;
      const { idleSec, waitClass, pid } = describeState();
      const boundNote =
        config.maxWaitSec > 0
          ? ` The guard terminates the process after ${config.maxWaitSec}s of total silence.`
          : " The guard is observe-only (maxWaitSec=0): no termination will fire.";
      void emit(
        `[paperclip] provider-wait: no CLI output for ${idleSec}s (wait class: ${waitClass})${
          pid ? `, pid ${pid}` : ""
        }. The run may be blocked on the provider.${boundNote}\n`,
      );
    }
    if (
      config.progressSec > 0 &&
      idle >= config.progressSec * 1000 &&
      (lastProgressAt === null || now() - lastProgressAt >= config.progressSec * 1000 - 50)
    ) {
      lastProgressAt = now();
      const { idleSec, waitClass } = describeState();
      void emit(
        `[paperclip] provider-wait: still waiting on the provider; no CLI output for ${idleSec}s (wait class: ${waitClass}).\n`,
      );
    }

    scheduleNext();
  };

  const scheduleNext = () => {
    if (disposed || killed || timer) return;
    const dueCandidates: number[] = [];
    if (config.maxWaitSec > 0) dueCandidates.push(config.maxWaitSec * 1000);
    if (!diagnosticEmitted && config.idleDiagnosticSec > 0) dueCandidates.push(config.idleDiagnosticSec * 1000);
    if (config.progressSec > 0) {
      const nextProgress =
        lastProgressAt === null
          ? config.progressSec * 1000
          : lastProgressAt - lastActivityAt + config.progressSec * 1000;
      dueCandidates.push(nextProgress);
    }
    if (dueCandidates.length === 0) return;
    const dueAt = Math.min(...dueCandidates);
    timer = schedule(tick, Math.max(1, dueAt - idleMs()));
  };

  scheduleNext();

  return {
    noteChunk: async (stream, chunk) => {
      if (disposed) return;
      lastActivityAt = now();
      if (stream === "stderr" && chunk) {
        stderrEvidence = (stderrEvidence + chunk).slice(-STDERR_EVIDENCE_TAIL_CHARS);
      }
    },
    onSpawn: (meta) => {
      spawnMeta = meta;
    },
    dispose: () => {
      disposed = true;
      if (timer) {
        cancel(timer);
        timer = null;
      }
    },
    waitTimeout: () => {
      if (!killed) return null;
      return describeState();
    },
    settled: () => emitChain,
  };
}

/** Build the adapter result fragment for a guard-terminated run. */
export function providerWaitTimeoutResult(input: {
  proc: { exitCode: number | null; signal: string | null };
  wait: ProviderWaitTimeoutInfo;
}) {
  const { wait } = input;
  return {
    exitCode: input.proc.exitCode,
    signal: input.proc.signal,
    timedOut: false,
    errorMessage: `provider_wait_timeout: no CLI output for ${wait.idleSec}s (wait class: ${wait.waitClass})${
      wait.pid ? `, pid ${wait.pid}` : ""
    }; the stalled CLI process was terminated.`,
    errorCode: PROVIDER_WAIT_TIMEOUT_ERROR_CODE,
    errorFamily: "transient_upstream" as const,
    clearSession: false,
  };
}
