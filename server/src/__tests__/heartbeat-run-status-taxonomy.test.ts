import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_RUN_STATUSES,
  SUCCESSFUL_HEARTBEAT_RUN_STATUSES,
  TERMINAL_HEARTBEAT_RUN_STATUSES,
  UNSUCCESSFUL_HEARTBEAT_RUN_STATUSES,
  isSuccessfulHeartbeatRunStatus,
  isTerminalHeartbeatRunStatus,
} from "@paperclipai/shared";

// A dozen call sites depend on agreeing about what counts as success, so a
// status that is terminal but classified as neither successful nor
// unsuccessful would silently strand runs.
describe("heartbeat run status taxonomy", () => {
  it("classifies every terminal status as exactly one of successful/unsuccessful", () => {
    for (const status of TERMINAL_HEARTBEAT_RUN_STATUSES) {
      const successful = SUCCESSFUL_HEARTBEAT_RUN_STATUSES.includes(status as never);
      const unsuccessful = UNSUCCESSFUL_HEARTBEAT_RUN_STATUSES.includes(status as never);
      expect(successful !== unsuccessful, `${status} must be exactly one of the two`).toBe(true);
    }
  });

  it("keeps every terminal status a member of the declared status set", () => {
    for (const status of TERMINAL_HEARTBEAT_RUN_STATUSES) {
      expect(HEARTBEAT_RUN_STATUSES).toContain(status);
    }
  });

  it("treats succeeded_dirty as a terminal success, never a failure", () => {
    expect(isTerminalHeartbeatRunStatus("succeeded_dirty")).toBe(true);
    expect(isSuccessfulHeartbeatRunStatus("succeeded_dirty")).toBe(true);
    expect(UNSUCCESSFUL_HEARTBEAT_RUN_STATUSES).not.toContain("succeeded_dirty");
  });

  it("still treats genuine failures as unsuccessful", () => {
    for (const status of ["failed", "cancelled", "timed_out"] as const) {
      expect(isTerminalHeartbeatRunStatus(status)).toBe(true);
      expect(isSuccessfulHeartbeatRunStatus(status)).toBe(false);
    }
  });

  it("does not treat in-flight statuses as terminal", () => {
    for (const status of ["queued", "running", "scheduled_retry"] as const) {
      expect(isTerminalHeartbeatRunStatus(status)).toBe(false);
      expect(isSuccessfulHeartbeatRunStatus(status)).toBe(false);
    }
  });
});
