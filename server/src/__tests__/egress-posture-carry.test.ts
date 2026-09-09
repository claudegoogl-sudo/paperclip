import { describe, expect, it } from "vitest";
import {
  egressPostureCarryIndex,
  egressPostureCarryKey,
  preservedEgressPosture,
} from "../services/egress-posture.js";

/**
 * Unit coverage for the ONE shared helper every delete+reinsert binding sync
 * must route its re-insert egress posture through (PLA-6272). The behavioural
 * proof that each call site actually uses it lives in
 * secret-binding-egress-posture-preserve.test.ts.
 */
describe("preservedEgressPosture", () => {
  it("falls back to the born-enforcing column defaults when there is no prior row", () => {
    expect(preservedEgressPosture(undefined)).toEqual({
      allowedEgress: [],
      egressAllowlistEnforced: true,
    });
    expect(preservedEgressPosture(null)).toEqual({
      allowedEgress: [],
      egressAllowlistEnforced: true,
    });
  });

  it("carries an operator-set allowlist and enforcement flag across a delete+reinsert", () => {
    expect(
      preservedEgressPosture({
        allowedEgress: ["https://example.com"],
        egressAllowlistEnforced: true,
      }),
    ).toEqual({ allowedEgress: ["https://example.com"], egressAllowlistEnforced: true });
    expect(
      preservedEgressPosture({
        allowedEgress: ["https://example.com"],
        egressAllowlistEnforced: false,
      }),
    ).toEqual({ allowedEgress: ["https://example.com"], egressAllowlistEnforced: false });
  });
});

describe("egressPostureCarryIndex", () => {
  it("keys carried posture by binding identity (companyId + configPath), not row id", () => {
    const index = egressPostureCarryIndex([
      {
        companyId: "c1",
        configPath: "apiKey",
        allowedEgress: ["https://a.example"],
        egressAllowlistEnforced: false,
      },
      { companyId: "c2", configPath: "apiKey", allowedEgress: [], egressAllowlistEnforced: true },
    ]);
    expect(index.get(egressPostureCarryKey("c1", "apiKey"))).toEqual({
      allowedEgress: ["https://a.example"],
      egressAllowlistEnforced: false,
    });
    expect(index.get(egressPostureCarryKey("c2", "apiKey"))).toEqual({
      allowedEgress: [],
      egressAllowlistEnforced: true,
    });
    expect(index.get(egressPostureCarryKey("c3", "apiKey"))).toBeUndefined();
  });
});
