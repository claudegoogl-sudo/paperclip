import { describe, expect, it } from "vitest";
import { taskBridgeRenewalSweepEnabled } from "../services/task-bridge-renewal.js";
import { egressPostureSweepEnabled } from "../services/egress-posture.js";

describe("egress posture sweep env knob", () => {
  it("is on by default", () => {
    expect(egressPostureSweepEnabled({})).toBe(true);
  });
  it("is off only for the exact value off", () => {
    expect(egressPostureSweepEnabled({ PAPERCLIP_EGRESS_POSTURE_SWEEP: "off" })).toBe(false);
    for (const v of ["", "0", "false", "OFF", "on"]) {
      expect(egressPostureSweepEnabled({ PAPERCLIP_EGRESS_POSTURE_SWEEP: v })).toBe(true);
    }
  });
});

describe("task bridge renewal sweep env knob", () => {
  it("is on by default and off only for the exact value off", () => {
    expect(taskBridgeRenewalSweepEnabled({})).toBe(true);
    expect(taskBridgeRenewalSweepEnabled({ PAPERCLIP_TASK_BRIDGE_RENEWAL_SWEEP: "off" })).toBe(false);
    for (const v of ["", "0", "false", "OFF"]) expect(taskBridgeRenewalSweepEnabled({ PAPERCLIP_TASK_BRIDGE_RENEWAL_SWEEP: v })).toBe(true);
  });
});
