import { sql } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";

// A provider-admission failure is a run that died at the provider's door —
// dispatched, rejected with a transient upstream error (HTTP 429-class
// `transient_upstream` family), and billed nothing. During an account-wide
// outage these stack by the hundred while carrying zero information about the
// assignee's actual productivity, so evidence consumers (the productivity
// monitor's no-comment streak and churn windows) must not count them as
// "completed-but-silent" work. Everything else — real successes, costed
// transient failures, non-transient error codes — keeps its existing
// treatment.
export const PROVIDER_ADMISSION_FAILURE_ERROR_CODES = [
  "claude_transient_upstream",
  "codex_transient_upstream",
] as const;

export type ProviderAdmissionFailureRunShape = {
  status: string | null;
  errorCode: string | null;
  resultJson?: Record<string, unknown> | null;
  usageJson?: Record<string, unknown> | null;
};

function readZeroableNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// Mirrors the token keys in `notProviderAdmissionFailureCondition` exactly —
// if you change one, change the other. The embedded-Postgres tests in
// productivity-review-service.test.ts pin the two to the same semantics.
const BILLABLE_USAGE_TOKEN_KEYS = [
  "inputTokens",
  "outputTokens",
  "input_tokens",
  "output_tokens",
] as const;

function hasBillableModelWork(usageJson: Record<string, unknown> | null | undefined): boolean {
  if (!usageJson) return false;
  return BILLABLE_USAGE_TOKEN_KEYS.some((key) => {
    const value = readZeroableNumber(usageJson[key]);
    return value !== null && value > 0;
  });
}

export function isProviderAdmissionFailureRun(run: ProviderAdmissionFailureRunShape): boolean {
  if (run.status !== "failed") return false;
  const resultJson = run.resultJson ?? {};
  const errorFamily =
    typeof resultJson.errorFamily === "string" && resultJson.errorFamily.trim()
      ? resultJson.errorFamily.trim()
      : null;
  const transientUpstream =
    errorFamily === "transient_upstream" ||
    (run.errorCode !== null &&
      (PROVIDER_ADMISSION_FAILURE_ERROR_CODES as readonly string[]).includes(run.errorCode));
  if (!transientUpstream) return false;
  const costUsd = readZeroableNumber(resultJson.total_cost_usd);
  return (costUsd === null || costUsd === 0) && !hasBillableModelWork(run.usageJson);
}

// Numeric jsonb fields are read as text, so guard every cast behind a shape
// check — casting a non-numeric string would raise at query time.
function zeroableJsonNumber(expr: ReturnType<typeof sql>) {
  return sql`case when ${expr} ~ '^[0-9]+(\\.[0-9]+)?$' then (${expr})::float8 else 0 end`;
}

function providerAdmissionFailureCostIsZero() {
  return sql`(
    ${zeroableJsonNumber(sql`coalesce(${heartbeatRuns.resultJson} ->> 'total_cost_usd', '0')`)} = 0
    and ${zeroableJsonNumber(
      sql`coalesce(${heartbeatRuns.usageJson} ->> 'inputTokens', ${heartbeatRuns.usageJson} ->> 'input_tokens', '0')`,
    )} = 0
    and ${zeroableJsonNumber(
      sql`coalesce(${heartbeatRuns.usageJson} ->> 'outputTokens', ${heartbeatRuns.usageJson} ->> 'output_tokens', '0')`,
    )} = 0
  )`;
}

// SQL twin of `isProviderAdmissionFailureRun`, for aggregate queries that must
// exclude admission failures without materializing rows (rolling churn
// windows). Keep the semantics in lockstep with the TypeScript classifier.
export function notProviderAdmissionFailureCondition() {
  return sql`not (
    ${heartbeatRuns.status} = 'failed'
    and (
      coalesce(${heartbeatRuns.resultJson} ->> 'errorFamily', '') = 'transient_upstream'
      or ${heartbeatRuns.errorCode} in ('claude_transient_upstream', 'codex_transient_upstream')
    )
    and ${providerAdmissionFailureCostIsZero()}
  )`;
}
