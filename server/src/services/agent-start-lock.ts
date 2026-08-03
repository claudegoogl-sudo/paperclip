import { logger } from "../middleware/logger.js";

const START_LOCK_STALE_MS = 30_000;
const startLocksByKey = new Map<string, { promise: Promise<void>; startedAtMs: number }>();

const HOST_ADMISSION_LOCK_KEY = "host:admission";

async function waitForStartLock(key: string, lock: { promise: Promise<void>; startedAtMs: number }) {
  const elapsedMs = Date.now() - lock.startedAtMs;
  const remainingMs = START_LOCK_STALE_MS - elapsedMs;
  if (remainingMs <= 0) {
    logger.warn({ lockKey: key, staleMs: elapsedMs }, "start lock stale; continuing queued-run start");
    return;
  }

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    lock.promise,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, remainingMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (timedOut) {
    logger.warn({ lockKey: key, staleMs: START_LOCK_STALE_MS }, "start lock timed out; continuing queued-run start");
  }
}

async function withStartLock<T>(key: string, fn: () => Promise<T>) {
  const previous = startLocksByKey.get(key);
  const waitForPrevious = previous ? waitForStartLock(key, previous) : Promise.resolve();
  const run = waitForPrevious.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByKey.set(key, { promise: marker, startedAtMs: Date.now() });
  try {
    return await run;
  } finally {
    if (startLocksByKey.get(key)?.promise === marker) {
      startLocksByKey.delete(key);
    }
  }
}

export async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  return withStartLock(`agent:${agentId}`, fn);
}

/**
 * Serialises the host-wide admission decision (count running runs, take a slot) across
 * every agent. Must only ever be taken *inside* an agent start lock and must not wrap
 * run-claim work: `claimQueuedRun` re-enters the scheduler via `cancelRunInternal`, and
 * holding this lock across that re-entry would stall admission for every other agent.
 */
export async function withHostAdmissionLock<T>(fn: () => Promise<T>) {
  return withStartLock(HOST_ADMISSION_LOCK_KEY, fn);
}
