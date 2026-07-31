import type { UsageSummary } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  parseObject,
  parseJson,
} from "@paperclipai/adapter-utils/server-utils";

const CLAUDE_AUTH_REQUIRED_RE = /(?:not\s+logged\s+in|please\s+log\s+in|please\s+run\s+(?:`?claude\s+login`?|\/login)|login\s+required|requires\s+login|unauthorized|authentication\s+required|invalid\s+api\s+key[\s\S]{0,120}(?:\/login|claude\s+login|log\s+in))/i;
const URL_RE = /(https?:\/\/[^\s'"`<>()[\]{};,!?]+[^\s'"`<>()[\]{};,!.?:]+)/gi;

const CLAUDE_TRANSIENT_UPSTREAM_RE =
  /(?:rate[-\s]?limit(?:ed)?|rate_limit_error|too\s+many\s+requests|\b429\b|overloaded(?:_error)?|server\s+overloaded|service\s+unavailable|\b503\b|\b529\b|high\s+demand|try\s+again\s+later|temporarily\s+unavailable|throttl(?:ed|ing)|throttlingexception|servicequotaexceededexception|out\s+of\s+extra\s+usage|extra\s+usage\b|claude\s+usage\s+limit\s+reached|(?:5[-\s]?hour|weekly|session|usage)\s+limit(?:\s+reached)?|usage\s+cap\s+reached)/i;
// The trailing `reached` is optional on every limit-family regex below:
// upstream moved from "You're out of extra usage · resets 4am (UTC)" to
// "You've hit your weekly limit · resets Jul 31, 8am (UTC)". Requiring
// "reached" silently killed the PLA-1790 backoff (and this fork's
// provider_quota classification) for every limit result after that wording
// change.
const CLAUDE_PROVIDER_QUOTA_RE =
  /(?:you(?:'|’)ve\s+hit\s+your\s+session\s+limit|session\s+limit\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|extra\s+usage\b|claude\s+usage\s+limit(?:\s+reached)?|(?:5[-\s]?hour|weekly|session|usage)\s+limit(?:\s+reached)?|usage\s+cap(?:\s+reached)?|servicequotaexceededexception)/i;
const CLAUDE_MODEL_NOT_FOUND_RE =
  /(?:\b404\b[\s\S]{0,120})?(?:model[\s_-]*(?:not[\s_-]*found|does not exist|unknown|invalid)|unknown[\s_-]*model)/i;
const CLAUDE_EXTRA_USAGE_RESET_RE =
  /(?:out\s+of\s+extra\s+usage|extra\s+usage|claude\s+usage\s+limit(?:\s+reached)?|usage\s+cap(?:\s+reached)?|(?:5[-\s]?hour|weekly|session|usage)\s+limit(?:\s+reached)?)[\s\S]{0,80}?\bresets?\s+(?:at\s+)?([^\n()]+?)(?:\s*\(([^)]+)\))?(?:[.!]|\n|$)/i;

/**
 * Sum the per-model usage ledger from a Claude CLI result event. The result
 * event's top-level `usage` reflects only the main-loop message chain, so it
 * undercounts output tokens whenever subagents or sidechains ran; `modelUsage`
 * is the CLI's authoritative per-model accounting (it is what backs /cost).
 * Cache-creation tokens are billed prompt tokens, so they count as input.
 */
export function claudeModelUsageTotals(modelUsage: unknown): UsageSummary | null {
  const byModel = parseObject(modelUsage);
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let sawEntry = false;
  for (const value of Object.values(byModel)) {
    const entry = parseObject(value);
    if (Object.keys(entry).length === 0) continue;
    sawEntry = true;
    inputTokens += asNumber(entry.inputTokens, 0) + asNumber(entry.cacheCreationInputTokens, 0);
    outputTokens += asNumber(entry.outputTokens, 0);
    cachedInputTokens += asNumber(entry.cacheReadInputTokens, 0);
  }
  if (!sawEntry) return null;
  return { inputTokens, outputTokens, cachedInputTokens };
}

export function parseClaudeStreamJson(stdout: string) {
  let sessionId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "system" && asString(event.subtype, "") === "init") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      model = asString(event.model, model);
      continue;
    }

    if (type === "assistant") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      const message = parseObject(event.message);
      const content = Array.isArray(message.content) ? message.content : [];
      for (const entry of content) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const block = entry as Record<string, unknown>;
        if (asString(block.type, "") === "text") {
          const text = asString(block.text, "");
          if (text) assistantTexts.push(text);
        }
      }
      continue;
    }

    if (type === "result") {
      finalResult = event;
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
    }
  }

  if (!finalResult) {
    return {
      sessionId,
      model,
      costUsd: null as number | null,
      usage: null as UsageSummary | null,
      usageBasis: null as "per_run" | null,
      summary: assistantTexts.join("\n\n").trim(),
      resultJson: null as Record<string, unknown> | null,
    };
  }

  const modelUsageTotals = claudeModelUsageTotals(finalResult.modelUsage);
  const usageObj = parseObject(finalResult.usage);
  const usage: UsageSummary = modelUsageTotals ?? {
    inputTokens: asNumber(usageObj.input_tokens, 0),
    cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
    outputTokens: asNumber(usageObj.output_tokens, 0),
  };
  const costRaw = finalResult.total_cost_usd;
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
  const summary = asString(finalResult.result, assistantTexts.join("\n\n")).trim();

  return {
    sessionId,
    model,
    costUsd,
    usage,
    // modelUsage covers exactly this CLI invocation, so mark it per-run to
    // keep the server from applying its session-cumulative delta heuristic.
    usageBasis: "per_run" as const,
    summary,
    resultJson: finalResult,
  };
}

function extractClaudeErrorMessages(parsed: Record<string, unknown>): string[] {
  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  const messages: string[] = [];

  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const obj = entry as Record<string, unknown>;
    const msg = asString(obj.message, "") || asString(obj.error, "") || asString(obj.code, "");
    if (msg) {
      messages.push(msg);
      continue;
    }

    try {
      messages.push(JSON.stringify(obj));
    } catch {
      // skip non-serializable entry
    }
  }

  return messages;
}

export function extractClaudeLoginUrl(text: string): string | null {
  const match = text.match(URL_RE);
  if (!match || match.length === 0) return null;
  for (const rawUrl of match) {
    const cleaned = rawUrl.replace(/[\])}.!,?;:'\"]+$/g, "");
    if (cleaned.includes("claude") || cleaned.includes("anthropic") || cleaned.includes("auth")) {
      return cleaned;
    }
  }
  return match[0]?.replace(/[\])}.!,?;:'\"]+$/g, "") ?? null;
}

export function detectClaudeLoginRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean; loginUrl: string | null } {
  const resultText = asString(input.parsed?.result, "").trim();
  const messages = [resultText, ...extractClaudeErrorMessages(input.parsed ?? {}), input.stdout, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const requiresLogin = messages.some((line) => CLAUDE_AUTH_REQUIRED_RE.test(line));
  return {
    requiresLogin,
    loginUrl: extractClaudeLoginUrl([input.stdout, input.stderr].join("\n")),
  };
}

export function describeClaudeFailure(parsed: Record<string, unknown>): string | null {
  const subtype = asString(parsed.subtype, "");
  const resultText = asString(parsed.result, "").trim();
  const errors = extractClaudeErrorMessages(parsed);

  let detail = resultText;
  if (!detail && errors.length > 0) {
    detail = errors[0] ?? "";
  }

  const parts = ["Claude run failed"];
  if (subtype) parts.push(`subtype=${subtype}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

export function isClaudeModelNotFoundError(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const parsed = input.parsed ?? null;
  const messages = [
    input.errorMessage ?? "",
    input.stdout ?? "",
    input.stderr ?? "",
    parsed ? asString(parsed.result, "") : "",
    ...(parsed ? extractClaudeErrorMessages(parsed) : []),
  ];
  return messages.some((message) => CLAUDE_MODEL_NOT_FOUND_RE.test(message));
}

/**
 * The CLI reported that it finished its work cleanly. This is deliberately
 * strict: it requires both the positive `subtype=success` marker and
 * `is_error=false`, so an absent/unknown subtype never reads as success.
 */
export function isClaudeCleanCompletionResult(
  parsed: Record<string, unknown> | null | undefined,
): boolean {
  if (!parsed) return false;
  if (parsed.is_error !== false) return false;
  return asString(parsed.subtype, "").trim().toLowerCase() === "success";
}

export function isClaudeMaxTurnsResult(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;

  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype === "error_max_turns") return true;

  const structuredStopReasons = [
    parsed.stop_reason,
    parsed.stopReason,
    parsed.error_code,
    parsed.errorCode,
  ].map((value) => asString(value, "").trim().toLowerCase());

  return structuredStopReasons.some((reason) =>
    reason === "max_turns" ||
    reason === "max_turns_exhausted" ||
    reason === "turn_limit" ||
    reason === "turn_limit_exhausted",
  );
}

export function isClaudeRefusalResult(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;

  // A policy refusal exits the CLI cleanly (exitCode=0, is_error=false), so it
  // must be detected from the structured fields rather than the failure flag.
  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype === "model_refusal" || subtype === "refusal") return true;

  const structuredStopReasons = [
    parsed.stop_reason,
    parsed.stopReason,
    parsed.error_code,
    parsed.errorCode,
  ].map((value) => asString(value, "").trim().toLowerCase());

  return structuredStopReasons.some((reason) => reason === "refusal");
}

export function isClaudeUnknownSessionError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /no conversation found with session id|unknown session|session .* not found|not a valid UUID|--resume requires a valid session|is not a UUID|does not match any session title/i.test(
      msg,
    ),
  );
}

export function isClaudePoisonedPreviousMessageIdError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /diagnostics\.previous_message_id.*starts with `msg_`/i.test(msg),
  );
}

export function isClaudeImageProcessingError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /could not process image/i.test(msg),
  );
}

function readZeroableNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * A session-limit 429 is reported as a result the CLI never spent any model time on.
 * `num_turns` is unreliable here (observed as 1 on a dispatch that never reached the
 * model), so zero billed cost *and* zero API time are what actually prove it.
 */
export function isClaudePreTurnRateLimitResult(
  parsed: Record<string, unknown> | null | undefined,
): boolean {
  if (!parsed) return false;
  if (readZeroableNumber(parsed.api_error_status) !== 429) return false;
  return (
    readZeroableNumber(parsed.total_cost_usd) === 0 &&
    readZeroableNumber(parsed.duration_api_ms) === 0
  );
}

/**
 * Anchored on purpose. A usage-limit result is the *entire* result payload the
 * CLI emits, so the message always starts the text. Matching the phrase
 * anywhere in `result` instead misreads a genuine run that merely wrote about a
 * limit in its summary — two such rows exist in the live corpus, one of which is
 * a real dirty-exit success whose report opens "Delivered (messageId 672)" and
 * goes on to mention "session-limit recovery".
 */
const CLAUDE_USAGE_LIMIT_RESULT_RE =
  /^(?:you(?:['’`]|&#39;)?ve\s+hit\s+your\s+(?:weekly|session|usage|5[-\s]?hour)\s+limit|claude\s+usage\s+limit\s+reached|(?:weekly|session|usage|5[-\s]?hour)\s+limit\s+reached)/i;

/**
 * The account ran out of quota, so the CLI stopped early. This is never a
 * completed run, no matter how many turns landed before the limit hit.
 */
export function isClaudeUsageLimitResult(
  parsed: Record<string, unknown> | null | undefined,
): boolean {
  if (!parsed) return false;
  const candidates = [asString(parsed.result, ""), ...extractClaudeErrorMessages(parsed)];
  return candidates.some((text) => CLAUDE_USAGE_LIMIT_RESULT_RE.test(text.trim()));
}

/**
 * A result that billed nothing and never got past the first turn did no work,
 * whatever it claims in `subtype`. This is the wording-independent backstop for
 * `isClaudeUsageLimitResult`: it keeps holding if upstream rephrases the limit
 * message.
 */
export function isClaudeNoWorkResult(
  parsed: Record<string, unknown> | null | undefined,
): boolean {
  if (!parsed) return false;
  const cost = readZeroableNumber(parsed.total_cost_usd);
  const turns = readZeroableNumber(parsed.num_turns);
  if (cost === null || turns === null) return false;
  return cost === 0 && turns <= 1;
}

function buildClaudeTransientHaystack(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): string {
  const parsed = input.parsed ?? null;
  const resultText = parsed ? asString(parsed.result, "") : "";
  const parsedErrors = parsed ? extractClaudeErrorMessages(parsed) : [];
  return [
    input.errorMessage ?? "",
    resultText,
    ...parsedErrors,
    input.stdout ?? "",
    input.stderr ?? "",
  ]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function readTimeZoneParts(date: Date, timeZone: string) {
  const values = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number.parseInt(values.get("year") ?? "", 10),
    month: Number.parseInt(values.get("month") ?? "", 10),
    day: Number.parseInt(values.get("day") ?? "", 10),
    hour: Number.parseInt(values.get("hour") ?? "", 10),
    minute: Number.parseInt(values.get("minute") ?? "", 10),
  };
}

function normalizeResetTimeZone(timeZoneHint: string | null | undefined): string | null {
  const normalized = timeZoneHint?.trim();
  if (!normalized) return null;
  if (/^(?:utc|gmt)$/i.test(normalized)) return "UTC";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
    return normalized;
  } catch {
    return null;
  }
}

function dateFromTimeZoneWallClock(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date | null {
  let candidate = new Date(Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0));
  const targetUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = readTimeZoneParts(candidate, input.timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const offsetMs = targetUtc - actualUtc;
    if (offsetMs === 0) break;
    candidate = new Date(candidate.getTime() + offsetMs);
  }

  const verified = readTimeZoneParts(candidate, input.timeZone);
  if (
    verified.year !== input.year ||
    verified.month !== input.month ||
    verified.day !== input.day ||
    verified.hour !== input.hour ||
    verified.minute !== input.minute
  ) {
    return null;
  }

  return candidate;
}

/**
 * The reset message names a month and day but no year, so pick the next
 * occurrence — rolling to next year keeps a late-December limit that resets in
 * January from landing ~11 months in the past.
 */
function nextDatedTimeInTimeZone(input: {
  now: Date;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZoneHint: string;
}): Date | null {
  const timeZone = normalizeResetTimeZone(input.timeZoneHint);
  if (!timeZone) return null;

  const nowParts = readTimeZoneParts(input.now, timeZone);
  for (const year of [nowParts.year, nowParts.year + 1]) {
    const candidate = dateFromTimeZoneWallClock({
      year,
      month: input.month,
      day: input.day,
      hour: input.hour,
      minute: input.minute,
      timeZone,
    });
    if (candidate && candidate.getTime() > input.now.getTime()) return candidate;
  }
  return null;
}

function nextClockTimeInTimeZone(input: {
  now: Date;
  hour: number;
  minute: number;
  timeZoneHint: string;
}): Date | null {
  const timeZone = normalizeResetTimeZone(input.timeZoneHint);
  if (!timeZone) return null;

  const nowParts = readTimeZoneParts(input.now, timeZone);
  let retryAt = dateFromTimeZoneWallClock({
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
    hour: input.hour,
    minute: input.minute,
    timeZone,
  });
  if (!retryAt) return null;

  if (retryAt.getTime() <= input.now.getTime()) {
    const nextDay = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1, 0, 0, 0, 0));
    retryAt = dateFromTimeZoneWallClock({
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
      hour: input.hour,
      minute: input.minute,
      timeZone,
    });
  }

  return retryAt;
}

const MONTH_NAMES = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

function parseClaudeResetClockTime(clockText: string, now: Date, timeZoneHint?: string | null): Date | null {
  let normalized = clockText.trim().replace(/\s+/g, " ");

  // A weekly limit resets on a named day ("Jul 31, 8am"); a session limit just
  // names a clock time. Peel the date off first so the clock parse below is
  // shared by both.
  let resetDate: { month: number; day: number } | null = null;
  const dated = normalized.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(.+)$/);
  if (dated) {
    const monthIndex = MONTH_NAMES.indexOf((dated[1] ?? "").slice(0, 3).toLowerCase());
    const day = Number.parseInt(dated[2] ?? "", 10);
    if (monthIndex >= 0 && Number.isInteger(day) && day >= 1 && day <= 31) {
      resetDate = { month: monthIndex + 1, day };
      normalized = dated[3] ?? "";
    }
  }

  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i);
  if (!match) return null;

  const hour12 = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour24 = hour12 % 12;
  if ((match[3] ?? "").toLowerCase() === "p") hour24 += 12;

  if (resetDate) {
    const dateRetryAt = nextDatedTimeInTimeZone({
      now,
      month: resetDate.month,
      day: resetDate.day,
      hour: hour24,
      minute,
      timeZoneHint: timeZoneHint ?? "UTC",
    });
    if (dateRetryAt) return dateRetryAt;
  }

  if (timeZoneHint) {
    const explicitRetryAt = nextClockTimeInTimeZone({
      now,
      hour: hour24,
      minute,
      timeZoneHint,
    });
    if (explicitRetryAt) return explicitRetryAt;
  }

  const retryAt = new Date(now);
  retryAt.setHours(hour24, minute, 0, 0);
  if (retryAt.getTime() <= now.getTime()) {
    retryAt.setDate(retryAt.getDate() + 1);
  }
  return retryAt;
}

export function extractClaudeRetryNotBefore(
  input: {
    parsed?: Record<string, unknown> | null;
    stdout?: string | null;
    stderr?: string | null;
    errorMessage?: string | null;
  },
  now = new Date(),
): Date | null {
  const haystack = buildClaudeTransientHaystack(input);
  const match = haystack.match(CLAUDE_EXTRA_USAGE_RESET_RE);
  if (!match) return null;
  return parseClaudeResetClockTime(match[1] ?? "", now, match[2]);
}

export function isClaudeTransientUpstreamError(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const parsed = input.parsed ?? null;
  // Deterministic failures are handled by their own classifiers.
  if (parsed && (isClaudeMaxTurnsResult(parsed) || isClaudeUnknownSessionError(parsed) || isClaudePoisonedPreviousMessageIdError(parsed) || isClaudeImageProcessingError(parsed))) {
    return false;
  }
  const loginMeta = detectClaudeLoginRequired({
    parsed,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
  });
  if (loginMeta.requiresLogin) return false;

  const haystack = buildClaudeTransientHaystack(input);
  if (!haystack) return false;
  if (isClaudeProviderQuotaError(input)) return false;
  return CLAUDE_TRANSIENT_UPSTREAM_RE.test(haystack);
}

export function isClaudeProviderQuotaError(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const parsed = input.parsed ?? null;
  if (parsed && (isClaudeMaxTurnsResult(parsed) || isClaudeUnknownSessionError(parsed) || isClaudePoisonedPreviousMessageIdError(parsed) || isClaudeImageProcessingError(parsed))) {
    return false;
  }
  const loginMeta = detectClaudeLoginRequired({
    parsed,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
  });
  if (loginMeta.requiresLogin) return false;

  const haystack = buildClaudeTransientHaystack(input);
  if (!haystack) return false;
  return CLAUDE_PROVIDER_QUOTA_RE.test(haystack);
}
