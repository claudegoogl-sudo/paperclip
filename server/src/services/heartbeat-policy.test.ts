import { describe, expect, it } from "vitest";
import { isHeartbeatWakeOnDemandEnabled } from "./heartbeat-policy.js";

describe("isHeartbeatWakeOnDemandEnabled", () => {
  it("defaults to true when runtimeConfig is missing", () => {
    // @ts-expect-error - intentionally passing a null runtimeConfig
    expect(isHeartbeatWakeOnDemandEnabled({ runtimeConfig: null })).toBe(true);
  });

  it("defaults to true when runtimeConfig has no heartbeat key", () => {
    expect(isHeartbeatWakeOnDemandEnabled({ runtimeConfig: {} })).toBe(true);
  });

  it("defaults to true when every legacy key is absent", () => {
    expect(isHeartbeatWakeOnDemandEnabled({ runtimeConfig: { heartbeat: {} } })).toBe(true);
  });

  it("honors wakeOnDemand: false", () => {
    expect(
      isHeartbeatWakeOnDemandEnabled({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } }),
    ).toBe(false);
  });

  it("prefers wakeOnDemand over the older wakeOnAssignment key when both are set", () => {
    expect(
      isHeartbeatWakeOnDemandEnabled({
        runtimeConfig: { heartbeat: { wakeOnDemand: true, wakeOnAssignment: false } },
      }),
    ).toBe(true);
  });

  it("falls back to wakeOnAssignment when wakeOnDemand is absent", () => {
    expect(
      isHeartbeatWakeOnDemandEnabled({ runtimeConfig: { heartbeat: { wakeOnAssignment: false } } }),
    ).toBe(false);
  });

  it("falls back to wakeOnOnDemand when the two newer keys are absent", () => {
    expect(
      isHeartbeatWakeOnDemandEnabled({ runtimeConfig: { heartbeat: { wakeOnOnDemand: false } } }),
    ).toBe(false);
  });

  it("falls back to wakeOnAutomation as the last legacy key", () => {
    expect(
      isHeartbeatWakeOnDemandEnabled({ runtimeConfig: { heartbeat: { wakeOnAutomation: false } } }),
    ).toBe(false);
  });

  it("treats a non-boolean value (e.g. a stringified flag) as absent and defaults to true", () => {
    expect(
      isHeartbeatWakeOnDemandEnabled({ runtimeConfig: { heartbeat: { wakeOnDemand: "false" } } }),
    ).toBe(true);
  });

  it("defaults to true when runtimeConfig is not an object (e.g. a raw string or array)", () => {
    // @ts-expect-error - intentionally passing a malformed runtimeConfig shape
    expect(isHeartbeatWakeOnDemandEnabled({ runtimeConfig: "not-an-object" })).toBe(true);
    expect(isHeartbeatWakeOnDemandEnabled({ runtimeConfig: [] as unknown as Record<string, unknown> })).toBe(true);
  });

  it("defaults to true when heartbeat is not an object", () => {
    expect(
      isHeartbeatWakeOnDemandEnabled({ runtimeConfig: { heartbeat: "not-an-object" } }),
    ).toBe(true);
  });
});
