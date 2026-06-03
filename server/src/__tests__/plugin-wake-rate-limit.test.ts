import { describe, expect, it } from "vitest";
import {
  PLUGIN_WAKE_RATE_LIMIT_MAX_WAKES,
  PLUGIN_WAKE_RATE_LIMIT_WINDOW_MS,
  createPluginWakeRateLimiter,
} from "../services/plugin-wake-rate-limit.js";

const ACTOR = { pluginId: "plugin-a", companyId: "company-1", agentId: "agent-x" };

describe("plugin wake rate limiter (PLA-829)", () => {
  it("allows up to the cap then blocks within the window", () => {
    let now = 1_000;
    const limiter = createPluginWakeRateLimiter({ windowMs: 60_000, maxWakes: 3, now: () => now });

    const results = Array.from({ length: 8 }, () => {
      now += 100; // rapid burst, all inside one window
      return limiter.consume(ACTOR);
    });

    const allowed = results.filter((r) => r.allowed);
    expect(allowed.length).toBe(3);
    expect(results.slice(3).every((r) => !r.allowed)).toBe(true);
    expect(results[3]?.retryAfterSeconds).toBeGreaterThan(0);
    expect(results[2]?.remaining).toBe(0);
  });

  it("refills as the sliding window advances past old hits", () => {
    let now = 0;
    const limiter = createPluginWakeRateLimiter({ windowMs: 1_000, maxWakes: 2, now: () => now });

    expect(limiter.consume(ACTOR).allowed).toBe(true);
    expect(limiter.consume(ACTOR).allowed).toBe(true);
    expect(limiter.consume(ACTOR).allowed).toBe(false);

    now += 1_001; // both prior hits age out of the window
    expect(limiter.consume(ACTOR).allowed).toBe(true);
  });

  it("scopes the budget per (plugin, company, agent)", () => {
    const limiter = createPluginWakeRateLimiter({ windowMs: 60_000, maxWakes: 1 });

    expect(limiter.consume(ACTOR).allowed).toBe(true);
    expect(limiter.consume(ACTOR).allowed).toBe(false);
    // A different agent, company, or plugin keeps its own budget.
    expect(limiter.consume({ ...ACTOR, agentId: "agent-y" }).allowed).toBe(true);
    expect(limiter.consume({ ...ACTOR, companyId: "company-2" }).allowed).toBe(true);
    expect(limiter.consume({ ...ACTOR, pluginId: "plugin-b" }).allowed).toBe(true);
  });

  it("ships sane defaults", () => {
    expect(PLUGIN_WAKE_RATE_LIMIT_MAX_WAKES).toBeGreaterThan(0);
    expect(PLUGIN_WAKE_RATE_LIMIT_WINDOW_MS).toBeGreaterThan(0);
    const limiter = createPluginWakeRateLimiter();
    const first = limiter.consume(ACTOR);
    expect(first.allowed).toBe(true);
    expect(first.limit).toBe(PLUGIN_WAKE_RATE_LIMIT_MAX_WAKES);
  });
});
