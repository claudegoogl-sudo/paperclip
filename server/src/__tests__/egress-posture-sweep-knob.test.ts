import { describe, expect, it } from "vitest";
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
