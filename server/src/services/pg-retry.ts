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

export interface RetryOnTransientPgErrorOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  /**
   * Tagged in logs and used by tests/operators to disambiguate which call site
   * is retrying. Keep short (e.g. "patch_issue").
   */
  label?: string;
}

export function isRetryablePgError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && RETRYABLE_PG_ERROR_CODES.has(code);
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
      if (!isRetryablePgError(err) || attempt >= maxAttempts) {
        throw err;
      }
      const code = (err as { code?: string }).code;
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
