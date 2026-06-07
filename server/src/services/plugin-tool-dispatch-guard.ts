/**
 * PLA-903 — host-side hardening for `agent.tools.register` tool dispatches.
 *
 * Every plugin tool reachable through `POST /api/plugins/tools/execute`
 * (server/src/routes/plugins.ts) is contributed via the `agent.tools.register`
 * capability. That dispatch path previously had NO audit trail and NO rate
 * limit, so a tool such as `messenger.create_topic` could be invoked an
 * unbounded number of times with no record (OWASP LLM "Excessive Agency" /
 * API4 "Unrestricted Resource Consumption").
 *
 * This module supplies two generic, host-enforced layers used by the route:
 *
 *   A. **Audit** — `buildDispatchAuditInput` produces exactly one
 *      `plugin_tool.execute` activity row per authorized dispatch. The
 *      untrusted name-bearing argument is treated as hostile output: it is
 *      charset-escaped and truncated before it lands in the log, even though
 *      `logActivity` already sanitizes (defense in depth against log
 *      injection).
 *
 *   B. **Rate limit** — `createToolDispatchRateLimiter` is a sliding-window,
 *      in-memory limiter (mirrors the pattern in plugin-secrets-handler.ts).
 *      It is enforced at the host dispatcher so a plugin bug can never bypass
 *      it. Budgets are declared per namespaced tool in
 *      `AGENT_TOOL_DISPATCH_POLICIES`, so the mechanism is generic rather than
 *      hard-coded to one tool. The limiter is process-local and resets on host
 *      restart — acceptable for an abuse cap; we deliberately do NOT persist it.
 */

import type { Db } from "@paperclipai/db";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import { logActivity, type LogActivityInput } from "./activity-log.js";

/** Max length of the escaped name copy retained in the audit detail. */
export const MAX_AUDIT_NAME_LENGTH = 128;

/**
 * Per-tool dispatch policy, keyed by fully namespaced tool name.
 *
 * `maxPerWindow`/`windowMs` define the sliding-window budget (layer B).
 * `auditNameParam` names the single untrusted string argument to capture in
 * the audit detail (layer A) — e.g. `messenger.create_topic`'s `name`.
 */
export interface ToolDispatchPolicy {
  maxPerWindow: number;
  windowMs: number;
  auditNameParam?: string;
}

/**
 * Generic policy map. Tools NOT listed here are still audited (layer A is
 * universal) but are not rate-limited (layer B is opt-in per tool).
 */
export const AGENT_TOOL_DISPATCH_POLICIES: Readonly<Record<string, ToolDispatchPolicy>> = {
  // PLA-902/903: provisioning tool — 5 topic creations per company+agent per hour.
  "paperclip-messenger:messenger.create_topic": {
    maxPerWindow: 5,
    windowMs: 60 * 60 * 1000,
    auditNameParam: "name",
  },
};

/** Thrown when a dispatch exceeds its per-`(company, agent, tool)` budget. */
export class RateLimitExceededError extends Error {
  readonly code = "RATE_LIMIT_EXCEEDED";
  constructor(
    readonly namespacedTool: string,
    readonly maxPerWindow: number,
    readonly windowMs: number,
  ) {
    const minutes = Math.max(1, Math.round(windowMs / 60_000));
    super(
      `Rate limit exceeded for tool "${namespacedTool}": ` +
        `max ${maxPerWindow} dispatches per ${minutes} minute(s).`,
    );
    this.name = "RateLimitExceededError";
  }
}

export interface ToolDispatchRateLimiter {
  /** Returns true if allowed (and records the attempt); false if over budget. */
  check(key: string, maxPerWindow: number, windowMs: number): boolean;
}

/**
 * Sliding-window, in-memory rate limiter. Mirrors the limiter in
 * plugin-secrets-handler.ts. State is process-local and resets on restart.
 *
 * @param now Injectable clock for deterministic tests.
 */
export function createToolDispatchRateLimiter(
  now: () => number = () => Date.now(),
): ToolDispatchRateLimiter {
  const attempts = new Map<string, number[]>();
  return {
    check(key, maxPerWindow, windowMs) {
      const ts = now();
      const windowStart = ts - windowMs;
      const existing = (attempts.get(key) ?? []).filter((t) => t > windowStart);
      if (existing.length >= maxPerWindow) {
        attempts.set(key, existing);
        return false;
      }
      existing.push(ts);
      attempts.set(key, existing);
      return true;
    },
  };
}

/** The rate-limiter bucket key for a dispatch. */
export function dispatchRateKey(runContext: ToolRunContext, namespacedTool: string): string {
  return `${runContext.companyId}|${runContext.agentId}|${namespacedTool}`;
}

// Control/format chars (C0, DEL+C1, LINE/PARAGRAPH SEPARATOR), backslash, and
// the markdown-significant set. Built from a string so no literal control
// bytes live in this source file.
const AUDIT_NAME_ESCAPE_RE = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\\\`*_~|<>\\[\\]#]",
  "g",
);

/**
 * Charset-escape an untrusted name for safe inclusion in an audit log.
 *
 * Truncates to {@link MAX_AUDIT_NAME_LENGTH} codepoints (never splitting a
 * surrogate pair), then escapes control/format characters to `\uXXXX` and
 * backslash-escapes markdown-significant characters. The result contains no
 * raw control characters or markdown that could forge log structure.
 */
export function escapeAuditName(raw: string): string {
  const truncated = Array.from(raw).slice(0, MAX_AUDIT_NAME_LENGTH).join("");
  return truncated.replace(AUDIT_NAME_ESCAPE_RE, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    const isControl =
      code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    return isControl ? `\\u${code.toString(16).padStart(4, "0")}` : `\\${ch}`;
  });
}

/**
 * Build the single `plugin_tool.execute` activity row for one authorized
 * dispatch. When the tool has a configured `auditNameParam` and that argument
 * is a string, its original LENGTH and a charset-escaped, truncated copy are
 * recorded.
 */
export function buildDispatchAuditInput(
  namespacedTool: string,
  runContext: ToolRunContext,
  parameters: unknown,
  policy?: ToolDispatchPolicy,
): LogActivityInput {
  const details: Record<string, unknown> = { tool: namespacedTool };
  const param = policy?.auditNameParam;
  if (param && parameters && typeof parameters === "object") {
    const raw = (parameters as Record<string, unknown>)[param];
    if (typeof raw === "string") {
      details.nameLength = raw.length;
      details.name = escapeAuditName(raw);
    }
  }
  return {
    companyId: runContext.companyId,
    actorType: "agent",
    actorId: runContext.agentId,
    agentId: runContext.agentId,
    runId: runContext.runId,
    action: "plugin_tool.execute",
    entityType: "plugin_tool",
    entityId: namespacedTool,
    details,
  };
}

/**
 * Host-dispatcher chokepoint: enforce the per-tool rate limit (layer B), then
 * write exactly one audit row (layer A) for the authorized dispatch.
 *
 * Call AFTER `validateToolRunContextScope` has passed and the tool is known to
 * exist, BEFORE handing the call to the plugin worker. On budget breach it
 * throws {@link RateLimitExceededError} and writes no audit row (the dispatch
 * is denied, not performed).
 *
 * @throws {RateLimitExceededError} when the dispatch is over budget.
 */
export async function guardAndAuditToolDispatch(opts: {
  db: Db;
  namespacedTool: string;
  runContext: ToolRunContext;
  parameters: unknown;
  rateLimiter: ToolDispatchRateLimiter;
  /** Injectable for tests; defaults to the real {@link logActivity}. */
  logActivityFn?: (db: Db, input: LogActivityInput) => Promise<void>;
}): Promise<void> {
  const { db, namespacedTool, runContext, parameters, rateLimiter } = opts;
  const policy = AGENT_TOOL_DISPATCH_POLICIES[namespacedTool];

  if (policy) {
    const allowed = rateLimiter.check(
      dispatchRateKey(runContext, namespacedTool),
      policy.maxPerWindow,
      policy.windowMs,
    );
    if (!allowed) {
      throw new RateLimitExceededError(namespacedTool, policy.maxPerWindow, policy.windowMs);
    }
  }

  const writeActivity = opts.logActivityFn ?? logActivity;
  await writeActivity(db, buildDispatchAuditInput(namespacedTool, runContext, parameters, policy));
}
