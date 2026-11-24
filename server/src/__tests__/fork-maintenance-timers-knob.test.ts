import { describe, expect, it } from "vitest";
import { forkMaintenanceTimersEnabled } from "../services/fork-maintenance-timers.js";

describe("fork maintenance timers env knob", () => {
  it("is on by default and off only for the exact value off", () => {
    expect(forkMaintenanceTimersEnabled({})).toBe(true);
    expect(forkMaintenanceTimersEnabled({ PAPERCLIP_FORK_MAINTENANCE_TIMERS: "off" })).toBe(false);
    for (const v of ["", "0", "false", "OFF", "on"]) expect(forkMaintenanceTimersEnabled({ PAPERCLIP_FORK_MAINTENANCE_TIMERS: v })).toBe(true);
  });
});
