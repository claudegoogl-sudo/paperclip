import { describe, expect, it } from "vitest";
import { HANDOFF_PENDING_GRACE_MS, handoffSuppressesHold } from "./legacy-execution-recovery.js";

const now = new Date("2026-11-11T12:00:00Z");
const base = (over: Record<string, unknown> = {}, pending: Record<string, unknown> = {}) => ({
  id: "run-1",
  resultJson: {
    reassignmentStopConfirmed: true,
    issueMutationStopId: "stop-1",
    handoffPending: { runId: "run-1", stopId: "stop-1", toAgentId: "agent-2", at: now.toISOString(), ...pending },
    ...over,
  },
}) as never;
const committed = { handoffCommitted: { runId: "run-1", stopId: "stop-1", toAgentId: "agent-2" } };

describe("handoffSuppressesHold (PLA-12409)", () => {
  it("skips the hold when the handoff committed, also after the grace (board self-handoff: marker decides, not actor)", () => {
    const later = new Date(now.getTime() + 10 * HANDOFF_PENDING_GRACE_MS);
    expect(handoffSuppressesHold(base(committed), later)).toBe(true);
  });
  it("skips the hold inside the grace window while the update is in flight", () => {
    expect(handoffSuppressesHold(base(), new Date(now.getTime() + 1000))).toBe(true);
  });
  it("crash gap: no commit marker after the grace gets the normal hold", () => {
    expect(handoffSuppressesHold(base(), new Date(now.getTime() + HANDOFF_PENDING_GRACE_MS + 1))).toBe(false);
  });
  it("failed update: a released (dropped) pending marker gets the hold", () => {
    expect(handoffSuppressesHold(base({ handoffPending: undefined }), now)).toBe(false);
  });
  it("workspace-restore evidence keeps the hold", () => {
    expect(handoffSuppressesHold(base({ ...committed, workspaceRestoreFailure: "restore_unsafe_archive" }), now)).toBe(false);
  });
  it("mismatched run, stop id or missing target keeps the hold", () => {
    expect(handoffSuppressesHold(base(committed, { runId: "other" }), now)).toBe(false);
    expect(handoffSuppressesHold(base(committed, { stopId: "stop-x" }), now)).toBe(false);
    expect(handoffSuppressesHold(base(committed, { toAgentId: undefined }), now)).toBe(false);
  });
});
