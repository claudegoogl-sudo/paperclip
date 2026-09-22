/**
 * Staggered replay of boot/recovery-driven wakes.
 *
 * After a crash or restart, recovery sweeps requeue continuations for every stranded
 * `in_progress` issue in one pass. Each requeue dispatches through the normal admission
 * gate, so a full house of heavy adapter processes can spawn within a couple of seconds —
 * fast enough to refill the service cgroup before the memory-pressure admission check
 * (or the kernel) can react. Pacing the *wakes the sweeps drive* spreads those spawns
 * out instead: at most `ceil(hostCeiling / 2)` recovery dispatches in flight at a time,
 * with a jittered delay of at least `RECOVERY_REPLAY_JITTER_MIN_DELAY_MS` between
 * dispatch starts.
 *
 * This is pacing, not a queue: every paced wake still runs, still goes through
 * `reserveHostRunSlot`, and an isolated wake (nothing else dispatched within the jitter
 * window) starts immediately. The cap and spacing only bind during bursts.
 */

export const RECOVERY_REPLAY_MAX_CONCURRENT_ENV_VAR =
  "PAPERCLIP_RECOVERY_REPLAY_MAX_CONCURRENT";

/** Lower bound of the jittered spacing between recovery replay dispatch starts. */
export const RECOVERY_REPLAY_JITTER_MIN_DELAY_MS = 2000;
/** Width of the jitter window: spacing is `min + random() * span` ms. */
export const RECOVERY_REPLAY_JITTER_SPAN_MS = 4000;

export type RecoveryReplayCap = {
  value: number;
  source: "env" | "default";
  /** Present when the env var was set but unusable, so startup can say why it was ignored. */
  invalidEnvValue?: string;
};

/** Default cap: half the host ceiling, rounded up, never below one. */
export function defaultRecoveryReplayCap(hostCeilingValue: number): number {
  const ceiling = Number.isFinite(hostCeilingValue) && hostCeilingValue >= 1
    ? Math.floor(hostCeilingValue)
    : 1;
  return Math.max(1, Math.ceil(ceiling / 2));
}

export function resolveRecoveryReplayCap(
  rawEnvValue: unknown,
  hostCeilingValue: number,
): RecoveryReplayCap {
  const defaultValue = defaultRecoveryReplayCap(hostCeilingValue);
  const fallback: RecoveryReplayCap = { value: defaultValue, source: "default" };
  if (typeof rawEnvValue !== "string") return fallback;
  const trimmed = rawEnvValue.trim();
  if (trimmed === "") return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || Math.floor(parsed) < 1) {
    return { ...fallback, invalidEnvValue: trimmed };
  }
  // A replay cap above the host ceiling is meaningless — admission would not let more
  // through anyway — so it clamps to the ceiling rather than silently overriding it.
  return {
    value: Math.min(Math.floor(parsed), Math.max(1, Math.floor(hostCeilingValue) || 1)),
    source: "env",
  };
}

export function computeRecoveryReplayJitterDelayMs(random: () => number = Math.random): number {
  const jitter = Math.min(Math.max(random(), 0), 1);
  return (
    RECOVERY_REPLAY_JITTER_MIN_DELAY_MS +
    Math.floor(jitter * (RECOVERY_REPLAY_JITTER_SPAN_MS + 1))
  );
}

export type RecoveryReplayPacingLogger = {
  info: (payload: Record<string, unknown>, message: string) => void;
};

export type RecoveryReplayPacerDeps = {
  cap: number;
  minDelayMs?: number;
  jitterSpanMs?: number;
  random?: () => number;
  now?: () => number;
  setTimeoutImpl?: (ms: number) => Promise<void>;
  logger?: RecoveryReplayPacingLogger;
};

export type RecoveryReplayPacingStats = {
  cap: number;
  inFlight: number;
  waiting: number;
  dispatched: number;
  maxObservedInFlight: number;
  lastWaitMs: number | null;
};

/**
 * FIFO admission for paced dispatches: a dispatch starts only when a slot is free AND
 * the jittered spacing since the previous start has elapsed. Waiters are served in
 * order, so a large boot replay rotates through stranded issues instead of racing.
 */
export function createRecoveryReplayPacer(deps: RecoveryReplayPacerDeps) {
  const cap = Math.max(1, Math.floor(deps.cap) || 1);
  const minDelayMs = deps.minDelayMs ?? RECOVERY_REPLAY_JITTER_MIN_DELAY_MS;
  const jitterSpanMs = deps.jitterSpanMs ?? RECOVERY_REPLAY_JITTER_SPAN_MS;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const sleep = deps.setTimeoutImpl ?? ((ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  }));

  let inFlight = 0;
  let maxObservedInFlight = 0;
  let dispatched = 0;
  let lastWaitMs: number | null = null;
  let nextStartAtMs = 0;
  let timer: Promise<void> | null = null;
  const waiters: Array<() => void> = [];

  const jitterDelayMs = () =>
    minDelayMs + Math.floor(Math.min(Math.max(random(), 0), 1) * (jitterSpanMs + 1));

  const pump = () => {
    let progressed = true;
    while (progressed) {
      progressed = false;
      if (waiters.length === 0 || inFlight >= cap) break;
      const currentMs = now();
      if (currentMs < nextStartAtMs) break;
      const waiter = waiters.shift();
      if (!waiter) break;
      inFlight += 1;
      dispatched += 1;
      maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
      nextStartAtMs = currentMs + jitterDelayMs();
      waiter();
      progressed = true;
    }
    if (waiters.length > 0 && inFlight < cap && !timer) {
      const waitMs = Math.max(0, nextStartAtMs - now()) + 1;
      timer = sleep(waitMs).finally(() => {
        timer = null;
        pump();
      });
      // Keep the sleep alive even if nothing awaits it.
      void timer.catch(() => {});
    }
  };

  const acquire = async (): Promise<void> => {
    const startedWaitingAtMs = now();
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
      pump();
    });
    lastWaitMs = Math.max(0, now() - startedWaitingAtMs);
  };

  const release = () => {
    inFlight = Math.max(0, inFlight - 1);
    pump();
  };

  return {
    cap,
    /**
     * Wraps a wake/dispatch function with pacing. The wrapper preserves the wrapped
     * function's arguments and return value; a rejected inner call still releases its
     * slot, so one failed wake cannot stall the replay.
     */
    wrapWake<A, R>(wake: (agentId: string, opts?: A) => Promise<R>) {
      const paced = async (agentId: string, opts?: A): Promise<R> => {
        await acquire();
        if (lastWaitMs !== null && lastWaitMs > 0) {
          // One line per genuinely delayed dispatch, so a staggered boot replay is
          // visible in logs instead of looking like a stall. Isolated wakes that
          // started immediately stay silent.
          deps.logger?.info(
            {
              event: "recovery_replay_pacing",
              agentId,
              waitMs: lastWaitMs,
              cap,
              inFlight,
              dispatched,
            },
            "recovery replay dispatch staggered",
          );
        }
        try {
          return await wake(agentId, opts);
        } finally {
          release();
        }
      };
      return paced;
    },
    stats: (): RecoveryReplayPacingStats => ({
      cap,
      inFlight,
      waiting: waiters.length,
      dispatched,
      maxObservedInFlight,
      lastWaitMs,
    }),
  };
}

export type RecoveryReplayPacer = ReturnType<typeof createRecoveryReplayPacer>;
