import { describe, expect, it } from "vitest";
import { runMayHaveLiveProcess, AGENT_STOP_HISTORY_WINDOW_MS } from "../services/agent-execution-stop.js";

describe("runMayHaveLiveProcess age window", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  const old = new Date(now.getTime() - 8 * 24 * 3600 * 1000);
  it("run started 8 days ago, cancelled now, with a PID: checks kept", () => {
    expect(runMayHaveLiveProcess({ status: "cancelled", processPid: 4242, startedAt: old, finishedAt: now }, now)).toBe(true);
  });
  it("run started 8 days ago, cancelled now, no process evidence: checks kept (finish time is recent)", () => {
    expect(runMayHaveLiveProcess({ status: "cancelled", startedAt: old, finishedAt: now }, now)).toBe(true);
  });
  it("run finished 8 days ago with no process evidence is skipped", () => {
    expect(runMayHaveLiveProcess({ status: "cancelled", startedAt: old, finishedAt: new Date(old.getTime() + 1000) }, now)).toBe(false);
    expect(AGENT_STOP_HISTORY_WINDOW_MS).toBe(7 * 24 * 3600 * 1000);
  });
});
