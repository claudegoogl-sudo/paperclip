import { describe, expect, it, vi } from "vitest";

import type { Db } from "@paperclipai/db";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";

import {
  AGENT_TOOL_DISPATCH_POLICIES,
  buildDispatchAuditInput,
  createToolDispatchRateLimiter,
  escapeAuditName,
  guardAndAuditToolDispatch,
  MAX_AUDIT_NAME_LENGTH,
  RateLimitExceededError,
} from "./plugin-tool-dispatch-guard.js";
import type { LogActivityInput } from "./activity-log.js";

/**
 * PLA-903 regression: the host dispatcher (`POST /api/plugins/tools/execute`)
 * must (B) rate-limit `agent.tools.register` dispatches per
 * `(company, agent, tool)` and (A) write exactly one charset-escaped
 * `plugin_tool.execute` audit row per authorized dispatch. Both layers live in
 * `plugin-tool-dispatch-guard.ts` so a plugin bug can never bypass them.
 */

const CREATE_TOPIC = "paperclip-messenger:messenger.create_topic";

// Matches any raw control/format char (C0, DEL+C1, LINE/PARAGRAPH SEPARATOR).
const RAW_CONTROL_RE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]");

function runContext(overrides: Partial<ToolRunContext> = {}): ToolRunContext {
  return {
    agentId: "agent-1",
    runId: "run-1",
    companyId: "company-1",
    projectId: "project-1",
    ...overrides,
  } as ToolRunContext;
}

const fakeDb = {} as Db;

describe("escapeAuditName", () => {
  it("escapes control and markdown characters so the name cannot forge log structure", () => {
    const malicious = "topic\nname\t`*_~|<>[]#\\end";
    const escaped = escapeAuditName(malicious);
    // No raw control characters survive.
    expect(RAW_CONTROL_RE.test(escaped)).toBe(false);
    expect(escaped).toContain("\\u000a"); // newline
    expect(escaped).toContain("\\u0009"); // tab
    // Markdown-significant chars are backslash-escaped, not raw.
    expect(escaped).toContain("\\`");
    expect(escaped).toContain("\\*");
    expect(escaped).toContain("\\[");
    expect(escaped).toContain("\\]");
    expect(escaped).toContain("\\#");
    expect(escaped).toContain("\\\\"); // the backslash itself
  });

  it("escapes bidi/zero-width format chars so they cannot reorder or hide audited text (F1)", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE, U+200E LRM, U+2066 LRI, U+200B ZWSP,
    // U+FEFF BOM — none of these were escaped before the F1 fix.
    const spoof = "a‮b‎⁦c​﻿d";
    const escaped = escapeAuditName(spoof);
    expect(escaped).toContain("\\u202e");
    expect(escaped).toContain("\\u200e");
    expect(escaped).toContain("\\u2066");
    expect(escaped).toContain("\\u200b");
    expect(escaped).toContain("\\ufeff");
    // No raw bidi/zero-width format char survives in the stored copy.
    const RAW_BIDI_FORMAT_RE = new RegExp(
      "[\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff\\ufff9-\\ufffb]",
    );
    expect(RAW_BIDI_FORMAT_RE.test(escaped)).toBe(false);
  });

  it("truncates to the configured maximum without splitting surrogate pairs", () => {
    const emoji = "😀"; // astral codepoint = surrogate pair
    const raw = emoji.repeat(MAX_AUDIT_NAME_LENGTH + 10);
    const escaped = escapeAuditName(raw);
    expect(Array.from(escaped)).toHaveLength(MAX_AUDIT_NAME_LENGTH);
    expect(escaped.endsWith("�")).toBe(false); // no broken pair
  });
});

describe("rate limit (B)", () => {
  it("denies an over-budget create_topic dispatch and fails closed with a rate-limit error", async () => {
    const nowMs = 1_000_000;
    const limiter = createToolDispatchRateLimiter(() => nowMs);
    const logActivityFn = vi.fn(async () => {});
    const dispatch = () =>
      guardAndAuditToolDispatch({
        db: fakeDb,
        namespacedTool: CREATE_TOPIC,
        runContext: runContext(),
        parameters: { companyId: "company-1", name: "ok" },
        rateLimiter: limiter,
        logActivityFn,
      });

    const budget = AGENT_TOOL_DISPATCH_POLICIES[CREATE_TOPIC]!.maxPerWindow;
    for (let i = 0; i < budget; i += 1) {
      await expect(dispatch()).resolves.toBeUndefined();
    }
    // The (budget + 1)-th within the window is denied.
    await expect(dispatch()).rejects.toBeInstanceOf(RateLimitExceededError);

    // Denied dispatch writes NO audit row — only the allowed ones did.
    expect(logActivityFn).toHaveBeenCalledTimes(budget);
  });

  it("scopes the budget per (company, agent, tool) and slides the window open", async () => {
    let nowMs = 0;
    const limiter = createToolDispatchRateLimiter(() => nowMs);
    const budget = AGENT_TOOL_DISPATCH_POLICIES[CREATE_TOPIC]!.maxPerWindow;
    const windowMs = AGENT_TOOL_DISPATCH_POLICIES[CREATE_TOPIC]!.windowMs;

    const run = (companyId: string) =>
      guardAndAuditToolDispatch({
        db: fakeDb,
        namespacedTool: CREATE_TOPIC,
        runContext: runContext({ companyId }),
        parameters: { name: "ok" },
        rateLimiter: limiter,
        logActivityFn: async () => {},
      });

    // Exhaust company-1's budget.
    for (let i = 0; i < budget; i += 1) await run("company-1");
    await expect(run("company-1")).rejects.toBeInstanceOf(RateLimitExceededError);

    // A different company is unaffected (separate bucket).
    await expect(run("company-2")).resolves.toBeUndefined();

    // After the window fully elapses, company-1 is allowed again.
    nowMs += windowMs + 1;
    await expect(run("company-1")).resolves.toBeUndefined();
  });

  it("does not rate-limit tools without a configured policy", async () => {
    const limiter = createToolDispatchRateLimiter(() => 0);
    const logActivityFn = vi.fn(async () => {});
    for (let i = 0; i < 50; i += 1) {
      await guardAndAuditToolDispatch({
        db: fakeDb,
        namespacedTool: "acme.linear:search-issues",
        runContext: runContext(),
        parameters: { query: "x" },
        rateLimiter: limiter,
        logActivityFn,
      });
    }
    // All 50 audited, none denied (layer A universal, layer B opt-in).
    expect(logActivityFn).toHaveBeenCalledTimes(50);
  });
});

describe("audit (A)", () => {
  it("writes exactly one plugin_tool.execute row with the escaped, length-tagged name", async () => {
    const limiter = createToolDispatchRateLimiter(() => 0);
    const calls: LogActivityInput[] = [];
    const logActivityFn = vi.fn(async (_db: Db, input: LogActivityInput) => {
      calls.push(input);
    });

    const maliciousName = "pwn`*_~|<>\nINJECT";
    await guardAndAuditToolDispatch({
      db: fakeDb,
      namespacedTool: CREATE_TOPIC,
      runContext: runContext(),
      parameters: { companyId: "company-1", name: maliciousName },
      rateLimiter: limiter,
      logActivityFn,
    });

    expect(logActivityFn).toHaveBeenCalledTimes(1);
    const row = calls[0]!;
    expect(row.action).toBe("plugin_tool.execute");
    expect(row.entityType).toBe("plugin_tool");
    expect(row.entityId).toBe(CREATE_TOPIC);
    expect(row.actorType).toBe("agent");
    expect(row.actorId).toBe("agent-1");
    expect(row.agentId).toBe("agent-1");
    expect(row.runId).toBe("run-1");
    expect(row.companyId).toBe("company-1");

    const details = row.details as Record<string, unknown>;
    expect(details.tool).toBe(CREATE_TOPIC);
    // Length is the ORIGINAL untruncated length.
    expect(details.nameLength).toBe(maliciousName.length);
    // Stored copy is escaped — no raw control/markdown chars.
    const storedName = details.name as string;
    expect(RAW_CONTROL_RE.test(storedName)).toBe(false);
    expect(storedName).toContain("\\`");
    expect(storedName).toContain("\\u000a");
  });

  it("buildDispatchAuditInput omits name fields when the tool has no auditNameParam", () => {
    const input = buildDispatchAuditInput("acme.linear:search-issues", runContext(), {
      query: "secret",
    });
    const details = input.details as Record<string, unknown>;
    expect(details.tool).toBe("acme.linear:search-issues");
    expect(details).not.toHaveProperty("name");
    expect(details).not.toHaveProperty("nameLength");
  });
});
