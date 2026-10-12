import { describe, expect, it } from "vitest";
import { isYieldableExecutionLockHolder } from "../services/issues.js";

// Direct fence for the scheduled_retry lock-yield predicate. Route tests cannot
// isolate the assignee conjunct (the outer adoption guards already require the
// assignee to be the actor), so this test pins it at the predicate itself.
describe("isYieldableExecutionLockHolder", () => {
  const actor = "agent-actor";
  const holder = { status: "scheduled_retry", agentId: actor, startedAt: null };

  it("yields for the same agent's unstarted scheduled_retry run when the issue is assigned to the actor", () => {
    expect(isYieldableExecutionLockHolder(holder, actor, actor)).toBe(true);
  });

  it("does not yield when the issue is assigned to a different agent (assignee conjunct)", () => {
    expect(isYieldableExecutionLockHolder(holder, actor, "agent-other")).toBe(false);
  });

  it("does not yield when the issue is unassigned", () => {
    expect(isYieldableExecutionLockHolder(holder, actor, null)).toBe(false);
  });

  it("does not yield for a cross-agent, started, or non-scheduled_retry holder, or no holder", () => {
    expect(isYieldableExecutionLockHolder({ ...holder, agentId: "agent-other" }, actor, actor)).toBe(false);
    expect(isYieldableExecutionLockHolder({ ...holder, startedAt: new Date() }, actor, actor)).toBe(false);
    expect(isYieldableExecutionLockHolder({ ...holder, status: "queued" }, actor, actor)).toBe(false);
    expect(isYieldableExecutionLockHolder(null, actor, actor)).toBe(false);
    expect(isYieldableExecutionLockHolder(undefined, actor, actor)).toBe(false);
  });
});
