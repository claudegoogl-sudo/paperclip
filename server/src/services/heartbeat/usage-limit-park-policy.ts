import { USAGE_LIMIT_PARK_MAX_HORIZON_MS } from "../usage-limit-park.js";
import type { RunSessionOutcome } from "./run-state.js";

// The advertised reset time is a lossy wall clock; wake just past it, not exactly on it.
export const NO_OP_DISPATCH_RETRY_SAFETY_MARGIN_MS = 60 * 1000;
const NO_OP_DISPATCH_RETRY_FALLBACK_DELAY_MS = 10 * 60 * 1000;
const NO_OP_DISPATCH_RETRY_MAX_DELAY_MS = 5 * 60 * 60 * 1000;

// A genuine account-wide usage-limit hit bills nothing and
// never reaches the model, whatever the adapter's own classification says.
// Checked independently of `noOpDispatch` (which is Claude/429-specific) so the
// park gate stays adapter-agnostic. The zero-work conjuncts alone proved too
// loose in practice — any zero-work failure (an expired OAuth token, a bad
// model id, a transient 529) matched and parked the whole fleet on a 15-row/
// 30-day false-positive rate. Requiring a limit-signal string too is what
// makes the zero-work conjuncts safe: a passing mention of "limit" can't trip
// this unless the run *also* never reached the model, and a genuine zero-work
// failure with no limit wording no longer parks. Every live genuine hit
// carries a signal, so this removes the false positives at zero cost to true
// positives.
// Exported for direct unit/replay testing (AC2/AC3/AC6) — the actual dispatch this
// gates lives deep inside `executeRun`'s adapter-execution path, which is not a
// practical seam to drive end-to-end from a unit test.
export function isZeroWorkUsageLimitResult(resultJson: Record<string, unknown>): boolean {
  const cost = readZeroableAmount(resultJson.total_cost_usd);
  const durationApiMs = readZeroableAmount(resultJson.duration_api_ms);
  const numTurns = readZeroableAmount(resultJson.num_turns);
  if (cost === null || durationApiMs === null || numTurns === null) return false;
  if (!(cost === 0 && durationApiMs === 0 && numTurns <= 1)) return false;
  return hasUsageLimitSignal(resultJson.result);
}

// Minimum signal set from the live-data audit. "Usage
// credits are required for this model" is a quota condition (CTO's explicit
// read on the 3 live rows), so it's included alongside the weekly/session/
// rate-limit phrasing rather than left to fall through as a false positive.
const USAGE_LIMIT_SIGNAL_RE = /hit your \S+ limit|usage limit|rate limit|usage credits are required/i;

function hasUsageLimitSignal(result: unknown): boolean {
  return typeof result === "string" && USAGE_LIMIT_SIGNAL_RE.test(result);
}

// AC4: folds the failed-outcome guard into the classifier's call
// site instead of leaving it to the `if (outcome === "failed")` wrapper alone,
// so a future refactor that moves the call out from under that wrapper still
// fails closed. Exported so the guard is unit-testable independent of
// `executeRun`'s completion path.
export function shouldParkForUsageLimit(
  outcome: RunSessionOutcome,
  resultJson: Record<string, unknown>,
): boolean {
  if (outcome !== "failed") return false;
  return isZeroWorkUsageLimitResult(resultJson);
}

function readZeroableAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// Mirrors `buildNoOpDispatchRetrySchedule`'s own target calc, including its fallback:
// a zero-work usage-limit hit with no parseable reset hint (e.g. AC6's replayed live
// row, produced by the pre-fix adapter, has no `retryNotBefore` key at all) still
// parks — for a bounded fallback window — rather than silently not parking. Without
// this fallback the exact storm this ticket exists to stop (a limit result the parser
// can't extract a reset from) would slip straight through the new gate too.
// It also mirrors that function's clamp to [now, now + max delay]: the adapter's
// dated-reset parser rolls a passed day to next year, so an unclamped target can
// land ~365 days out and freeze the whole instance. See
// USAGE_LIMIT_PARK_MAX_HORIZON_MS (same 5h ceiling).
// Exported alongside `isZeroWorkUsageLimitResult` for AC6 replay testing.
export function resolveUsageLimitParkTarget(input: { now: Date; retryNotBefore: Date | null }): Date {
  const target = input.retryNotBefore
    ? input.retryNotBefore.getTime() + NO_OP_DISPATCH_RETRY_SAFETY_MARGIN_MS
    : input.now.getTime() + NO_OP_DISPATCH_RETRY_FALLBACK_DELAY_MS;
  const nowMs = input.now.getTime();
  const maxDelayMs = Math.min(NO_OP_DISPATCH_RETRY_MAX_DELAY_MS, USAGE_LIMIT_PARK_MAX_HORIZON_MS);
  return new Date(Math.min(nowMs + maxDelayMs, Math.max(nowMs, target)));
}

