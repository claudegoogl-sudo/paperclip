// PLA-597: Postgres transient-failure retry helper.
//
// Wraps a function that runs a Postgres transaction so that deadlock
// (SQLSTATE 40P01) and serialization-failure (40001) errors get retried with
// bounded exponential backoff and jitter. Both codes are safe to retry from
// the application because Postgres has already rolled the transaction back.
//
// Used by mutation routes (e.g. PATCH /issues/:id) that contend with
// concurrent heartbeat-run mutations on overlapping rows.

import { logger } from "../middleware/logger.js";

const PG_DEADLOCK_CODE = "40P01";
const PG_SERIALIZATION_FAILURE_CODE = "40001";

export const RETRYABLE_PG_ERROR_CODES = new Set([
  PG_DEADLOCK_CODE,
  PG_SERIALIZATION_FAILURE_CODE,
]);

// PLA-638: drizzle-orm (>=0.36, this repo is on 0.45) no longer surfaces the
// raw driver error — every failed query is rewrapped as a `DrizzleQueryError`
// ("Failed query: ...") whose constructor has NO top-level `code`; the original
// postgres.js `PostgresError` (the one carrying SQLSTATE 40P01) is stashed on
// `.cause`. So a code check on the thrown error alone always missed the
// deadlock and the retry never fired — the deadlock surfaced as a 500. Walk the
// `.cause` chain (bounded depth, cycle-guarded) to find the real SQLSTATE.
const MAX_CAUSE_DEPTH = 8;

export interface RetryOnTransientPgErrorOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  /**
   * Tagged in logs and used by tests/operators to disambiguate which call site
   * is retrying. Keep short (e.g. "patch_issue").
   */
  label?: string;
}

/**
 * Returns the retryable SQLSTATE found anywhere in the error's `.cause` chain
 * (the thrown error itself counts as depth 0), or `null` if none is present.
 * Exposed so callers can log the resolved code even when the surfaced error is
 * a wrapper without a top-level `code` (see MAX_CAUSE_DEPTH note above).
 */
export function findRetryablePgErrorCode(err: unknown): string | null {
  let current: unknown = err;
  const seen = new Set<unknown>();
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current && typeof current === "object";
    depth += 1
  ) {
    if (seen.has(current)) break;
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && RETRYABLE_PG_ERROR_CODES.has(code)) {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function isRetryablePgError(err: unknown): boolean {
  return findRetryablePgErrorCode(err) !== null;
}

/**
 * Returns the first SQLSTATE string `code` found anywhere in the error's
 * `.cause` chain (the thrown error itself counts as depth 0), or `null` if
 * none is present. Unlike {@link findRetryablePgErrorCode} this is not limited
 * to the retryable set, so callers can match any SQLSTATE (e.g. 22P02
 * invalid_text_representation) despite drizzle-orm rewrapping the driver error
 * as a `DrizzleQueryError` without a top-level `code` (see MAX_CAUSE_DEPTH note
 * above).
 */
export function findPgErrorCode(err: unknown): string | null {
  let current: unknown = err;
  const seen = new Set<unknown>();
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current && typeof current === "object";
    depth += 1
  ) {
    if (seen.has(current)) break;
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export async function retryOnTransientPgError<T>(
  fn: () => Promise<T>,
  opts: RetryOnTransientPgErrorOptions = {},
): Promise<T> {
  // PLA-597: default 6 attempts × 25 ms × 2^(n-1) + jitter = ~1.6 s worst-case
  // added latency, enough headroom for the CI-observed deadlock cluster where
  // a single attempt was sometimes still racing the heartbeat-run lifecycle.
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 6);
  const baseDelayMs = Math.max(1, opts.baseDelayMs ?? 25);
  const label = opts.label ?? "pg_tx";

  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      const code = findRetryablePgErrorCode(err);
      if (code === null || attempt >= maxAttempts) {
        throw err;
      }
      const jitter = Math.floor(Math.random() * baseDelayMs);
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + jitter;
      logger.warn(
        { label, attempt, maxAttempts, code, delayMs: delay },
        "retrying postgres transaction after transient error",
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
