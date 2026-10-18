import { describe, expect, it } from "vitest";
import type { IssueRelationIssueSummary } from "@paperclipai/shared";
import {
  classifyWaitingBlocker,
  hasAssignedBacklogBlocker,
  isAssignedBacklogBlocker,
  orderWaitingBlockers,
} from "./issue-blockers";

function makeBlocker(overrides: Partial<IssueRelationIssueSummary> = {}): IssueRelationIssueSummary {
  return {
    id: "id-default",
    identifier: "ISSUE-1",
    title: "Default blocker",
    status: "backlog",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    ...overrides,
  };
}

describe("classifyWaitingBlocker", () => {
  it("classifies a done blocker as done", () => {
    const blocker = makeBlocker({ status: "done" });
    expect(classifyWaitingBlocker(blocker, new Set())).toBe("done");
  });

  it("classifies a cancelled blocker as done", () => {
    const blocker = makeBlocker({ status: "cancelled" });
    expect(classifyWaitingBlocker(blocker, new Set())).toBe("done");
  });

  it("classifies a non-terminal blocker present in the live set as running", () => {
    const blocker = makeBlocker({ id: "live-1", status: "in_progress" });
    expect(classifyWaitingBlocker(blocker, new Set(["live-1"]))).toBe("running");
  });

  it("classifies a non-terminal blocker absent from the live set as queued", () => {
    const blocker = makeBlocker({ id: "queued-1", status: "backlog" });
    expect(classifyWaitingBlocker(blocker, new Set(["some-other-id"]))).toBe("queued");
  });

  it("treats done/cancelled status as taking priority over live-set membership", () => {
    // A blocker can be marked done while still lingering in a stale live-issue
    // set; status must win so a finished blocker never renders as "running".
    const blocker = makeBlocker({ id: "finished-but-live", status: "done" });
    expect(classifyWaitingBlocker(blocker, new Set(["finished-but-live"]))).toBe("done");
  });
});

describe("orderWaitingBlockers", () => {
  it("orders done before running before queued", () => {
    const done = makeBlocker({ id: "d", identifier: "ISSUE-1", status: "done" });
    const running = makeBlocker({ id: "r", identifier: "ISSUE-2", status: "in_progress" });
    const queued = makeBlocker({ id: "q", identifier: "ISSUE-3", status: "backlog" });

    // Shuffle the input order to confirm the sort — not incoming order —
    // determines the result.
    const steps = orderWaitingBlockers([queued, done, running], new Set(["r"]));

    expect(steps.map((step) => step.blocker.id)).toEqual(["d", "r", "q"]);
    expect(steps.map((step) => step.status)).toEqual(["done", "running", "queued"]);
  });

  it("breaks ties within the same status by identifier using numeric comparison", () => {
    // Three queued blockers sharing the same rank (tie-breaking field under
    // test). Plain string comparison would sort "ISSUE-10" before "ISSUE-2";
    // the numeric-aware comparator must keep them in numeric order instead,
    // matching the "stable tie-break used by plan-generated task chains"
    // comment on orderWaitingBlockers.
    const a = makeBlocker({ id: "a", identifier: "ISSUE-10", status: "backlog" });
    const b = makeBlocker({ id: "b", identifier: "ISSUE-2", status: "backlog" });
    const c = makeBlocker({ id: "c", identifier: "ISSUE-1", status: "backlog" });

    const steps = orderWaitingBlockers([a, b, c], new Set());

    expect(steps.map((step) => step.blocker.identifier)).toEqual([
      "ISSUE-1",
      "ISSUE-2",
      "ISSUE-10",
    ]);
  });

  it("falls back to id for the tie-break when identifier is null", () => {
    const withIdentifier = makeBlocker({ id: "z-id", identifier: "ISSUE-5", status: "backlog" });
    const noIdentifier = makeBlocker({ id: "a-id", identifier: null, status: "backlog" });

    const steps = orderWaitingBlockers([withIdentifier, noIdentifier], new Set());

    // "a-id" (fallback key for noIdentifier) sorts before "ISSUE-5".
    expect(steps.map((step) => step.blocker.id)).toEqual(["a-id", "z-id"]);
  });

  it("does not mutate the input array", () => {
    const first = makeBlocker({ id: "first", identifier: "ISSUE-9", status: "backlog" });
    const second = makeBlocker({ id: "second", identifier: "ISSUE-1", status: "backlog" });
    const input = [first, second];

    orderWaitingBlockers(input, new Set());

    expect(input).toEqual([first, second]);
  });

  it("returns an empty list for an empty input", () => {
    expect(orderWaitingBlockers([], new Set())).toEqual([]);
  });
});

describe("isAssignedBacklogBlocker", () => {
  it("returns true for a backlog blocker with an assigned agent", () => {
    const blocker = makeBlocker({ status: "backlog", assigneeAgentId: "agent-1" });
    expect(isAssignedBacklogBlocker(blocker)).toBe(true);
  });

  it("returns false for a backlog blocker with no assigned agent", () => {
    const blocker = makeBlocker({ status: "backlog", assigneeAgentId: null });
    expect(isAssignedBacklogBlocker(blocker)).toBe(false);
  });

  it("returns false for a non-backlog blocker even with an assigned agent", () => {
    const blocker = makeBlocker({ status: "in_progress", assigneeAgentId: "agent-1" });
    expect(isAssignedBacklogBlocker(blocker)).toBe(false);
  });
});

describe("hasAssignedBacklogBlocker", () => {
  it("returns false for undefined, null, and empty input", () => {
    expect(hasAssignedBacklogBlocker(undefined)).toBe(false);
    expect(hasAssignedBacklogBlocker(null)).toBe(false);
    expect(hasAssignedBacklogBlocker([])).toBe(false);
  });

  it("returns true when a direct blocker is an assigned backlog blocker", () => {
    const blockers = [makeBlocker({ status: "backlog", assigneeAgentId: "agent-1" })];
    expect(hasAssignedBacklogBlocker(blockers)).toBe(true);
  });

  it("returns true when only a nested terminal blocker qualifies", () => {
    const terminal = makeBlocker({
      id: "terminal-1",
      status: "backlog",
      assigneeAgentId: "agent-1",
    });
    const blockers = [
      makeBlocker({
        id: "direct-1",
        status: "in_progress",
        assigneeAgentId: null,
        terminalBlockers: [terminal],
      }),
    ];
    expect(hasAssignedBacklogBlocker(blockers)).toBe(true);
  });

  it("returns false when neither the blocker nor its terminal blockers qualify", () => {
    const terminal = makeBlocker({ id: "terminal-2", status: "in_progress", assigneeAgentId: "agent-1" });
    const blockers = [
      makeBlocker({
        id: "direct-2",
        status: "backlog",
        assigneeAgentId: null,
        terminalBlockers: [terminal],
      }),
    ];
    expect(hasAssignedBacklogBlocker(blockers)).toBe(false);
  });
});
