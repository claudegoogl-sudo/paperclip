import { describe, expect, it } from "vitest";
import { createAuthCircuitBreaker } from "../services/auth-circuit-breaker.js";

const fail = { status: "failed", errorCode: "claude_auth_required" };
describe("auth circuit breaker", () => {
  it("opens after N failures, alerts once, holds, probes, resumes on success", () => {
    let t = 1000;
    const b = createAuthCircuitBreaker({ threshold: 3, probeCooldownMs: 100, now: () => t });
    expect(b.recordOutcome("claude_local", fail)).toBeNull();
    expect(b.recordOutcome("claude_local", fail)).toBeNull();
    expect(b.recordOutcome("claude_local", fail)).toBe("opened");
    expect(b.recordOutcome("claude_local", fail)).toBeNull();
    expect(b.shouldHold("claude_local")).toBe(true);
    expect(b.shouldHold("codex_local")).toBe(false);
    t += 150;
    expect(b.shouldHold("claude_local")).toBe(false); // probe
    expect(b.shouldHold("claude_local")).toBe(true);
    expect(b.recordOutcome("claude_local", { status: "succeeded" })).toBe("closed");
    expect(b.shouldHold("claude_local")).toBe(false);
  });
  it("success resets the consecutive count; matches message text", () => {
    const b = createAuthCircuitBreaker({ threshold: 2 });
    b.recordOutcome("p", fail);
    b.recordOutcome("p", { status: "succeeded" });
    expect(b.recordOutcome("p", fail)).toBeNull();
    expect(b.recordOutcome("p", { status: "failed", error: "No API key for provider x" })).toBe("opened");
  });
});
