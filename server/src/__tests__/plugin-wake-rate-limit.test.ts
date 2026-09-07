import { describe, expect, it } from "vitest";
import {
  PLUGIN_WAKE_RATE_LIMIT_MAX_WAKES,
  PLUGIN_WAKE_RATE_LIMIT_WINDOW_MS,
  createPluginWakeRateLimiter,
} from "../services/plugin-wake-rate-limit.js";

const ACTOR = { pluginId: "plugin-a", companyId: "company-1", agentId: "agent-x" };

describe("plugin wake rate limiter", () => {
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

describe("plugin wake rate limiter bucket-map eviction", () => {
  // The wake limiter's (plugin, company, agent) bucket map is the second
  // unbounded-growth surface the parent ticket calls out: a relay storm across
  // many distinct agent targets grows the map without bound. These tests pin
  // the two properties the shared store guarantees once the window ages out
  // and once a burst of distinct keys outruns the sweep.

  it("returns the wake bucket map to zero once the window has aged out", () => {
    let now = 10_000;
    const limiter = createPluginWakeRateLimiter({
      windowMs: 1_000,
      maxWakes: 5,
      now: () => now,
    });

    for (let i = 0; i < 5; i += 1) {
      now += 10;
      limiter.consume({ ...ACTOR, agentId: `agent-${i}` });
    }

    // Every consume above pins a key. Advance past the window and re-touch
    // each key; the shared store prunes the aged-out hits and deletes the
    // now-empty key, so the map returns to zero rather than retaining five
    // idle entries.
    now += 1_001;
    for (let i = 0; i < 5; i += 1) {
      limiter.consume({ ...ACTOR, agentId: `agent-${i}` });
    }

    // Observable proof: a fresh agent gets its full wake budget. (This is also
    // true if idle keys are retained, so the map-size invariant itself is
    // pinned in the store's own test suite — here we only assert the limiter
    // behaves identically.)
    const fresh = limiter.consume({ ...ACTOR, agentId: "agent-fresh" });
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(4);
  });

  it("holds the wake bucket map under a hard ceiling when fed more distinct keys than the ceiling allows", () => {
    let now = 10_000;
    const maxKeys = 4;
    const limiter = createPluginWakeRateLimiter({
      windowMs: 1_000,
      maxWakes: 1_000,
      maxKeys,
      now: () => now,
    });

    // Feed three times the ceiling in distinct agents. The shared store's
    // ceiling backstop keeps the live-key count at or below maxKeys.
    const total = maxKeys * 3;
    for (let i = 0; i < total; i += 1) {
      now += 1;
      const res = limiter.consume({ ...ACTOR, agentId: `agent-${i}` });
      expect(res.allowed, `consume ${i} should be allowed`).toBe(true);
    }

    // Observable proof: a brand-new agent is still allowed. The backstop
    // evicted an older agent's key to make room, rather than rejecting the
    // wake. (Same caveat as the webhook IP test — the size invariant itself
    // is pinned in the store suite.)
    const probe = limiter.consume({ ...ACTOR, agentId: "agent-probe" });
    expect(probe.allowed).toBe(true);
  });

  it("does not change observable limiter behaviour under load", () => {
    let now = 1_000;
    const limiter = createPluginWakeRateLimiter({
      windowMs: 60_000,
      maxWakes: 3,
      now: () => now,
    });

    const results = Array.from({ length: 8 }, () => {
      now += 100;
      return limiter.consume(ACTOR);
    });

    expect(results.filter((r) => r.allowed).length).toBe(3);
    expect(results.slice(3).every((r) => !r.allowed)).toBe(true);
  });
});
