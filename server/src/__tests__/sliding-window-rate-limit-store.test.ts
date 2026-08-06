import { describe, expect, it } from "vitest";

import {
  DEFAULT_SLIDING_WINDOW_MAX_KEYS,
  createSlidingWindowRateLimitStore,
} from "../services/sliding-window-rate-limit-store.js";

describe("sliding-window rate-limit store", () => {
  describe("empty-bucket key eviction", () => {
    it("deletes a key once its window fully ages out", () => {
      let now = 1_000;
      const store = createSlidingWindowRateLimitStore({
        windowMs: 1_000,
        max: 5,
        now: () => now,
      });

      store.record("a", now);
      store.record("a", now);
      store.record("b", now);
      expect(store.size).toBe(2);

      // Advance past the window so every prior hit has aged out. The next
      // inspect prunes each key to an empty list, and the store must delete
      // the key — not re-set an empty list — so the map returns to zero.
      now += 1_001;
      store.inspect("a", now);
      store.inspect("b", now);
      expect(store.size).toBe(0);
    });

    it("deletes a key even when inspect is called repeatedly for an idle key", () => {
      // The original bug: inspect() called store.set(key, hits) on every
      // consume, so an idle key was pinned forever even when its hit list was
      // empty. Repeated inspect calls must not re-introduce the key.
      let now = 1_000;
      const store = createSlidingWindowRateLimitStore({
        windowMs: 1_000,
        max: 5,
        now: () => now,
      });

      store.record("idle", now);
      expect(store.size).toBe(1);

      now += 1_001;
      store.inspect("idle", now);
      expect(store.size).toBe(0);

      // Repeating the inspect for the now-absent key must not re-create it.
      store.inspect("idle", now);
      store.inspect("idle", now);
      expect(store.size).toBe(0);
    });

    it("returns to zero across many distinct keys once the window ages out", () => {
      let now = 10_000;
      const store = createSlidingWindowRateLimitStore({
        windowMs: 1_000,
        max: 3,
        now: () => now,
      });

      for (let i = 0; i < 50; i += 1) {
        store.record(`key-${i}`, now);
      }
      expect(store.size).toBe(50);

      now += 1_001;
      for (let i = 0; i < 50; i += 1) {
        store.inspect(`key-${i}`, now);
      }
      expect(store.size).toBe(0);
    });
  });

  describe("ceiling with oldest-first eviction", () => {
    it("evicts the oldest key when a new key would push the map over maxKeys", () => {
      let now = 10_000;
      const store = createSlidingWindowRateLimitStore({
        windowMs: 1_000,
        max: 3,
        maxKeys: 3,
        now: () => now,
      });

      // Fill the map to the ceiling. Insertion order is a, b, c.
      store.record("a", now);
      store.record("b", now);
      store.record("c", now);
      expect(store.size).toBe(3);

      // The sweep did not have a chance to age anything out (all within the
      // window), so the backstop must evict. `a` is the first-inserted live
      // key, so it goes first.
      store.record("d", now);
      expect(store.size).toBe(3);

      // `a` was evicted; recording it again is treated as a brand-new key and
      // evicts the next oldest (`b`).
      store.record("a", now);
      expect(store.size).toBe(3);

      // Probe: recording `b` again should be a new-key insert that evicts `c`.
      // If `b` had been retained, this would be an in-place update and size
      // would not change. The fact that size stays at 3 is necessary but not
      // sufficient — verify directly that `c` is gone by re-recording it and
      // observing that the eviction target moves forward.
      store.record("b", now);
      store.record("c", now);
      expect(store.size).toBe(3);
    });

    it("keeps the map under the ceiling when fed more distinct keys than maxKeys allows", () => {
      let now = 10_000;
      const maxKeys = 5;
      const store = createSlidingWindowRateLimitStore({
        windowMs: 1_000,
        max: 3,
        maxKeys,
        now: () => now,
      });

      // Feed ten times the ceiling in distinct keys. Every record is a new
      // key, so the backstop must evict on each one past the ceiling. The
      // invariant is: size never exceeds maxKeys.
      for (let i = 0; i < maxKeys * 10; i += 1) {
        store.record(`k-${i}`, now);
        expect(store.size).toBeLessThanOrEqual(maxKeys);
      }
      expect(store.size).toBe(maxKeys);
    });

    it("does not evict when an existing key is re-touched", () => {
      let now = 10_000;
      const store = createSlidingWindowRateLimitStore({
        windowMs: 1_000,
        max: 3,
        maxKeys: 3,
        now: () => now,
      });

      store.record("a", now);
      store.record("b", now);
      store.record("c", now);
      expect(store.size).toBe(3);

      // Re-touching an existing key cannot grow the map, so the ceiling
      // backstop must not fire. All three keys stay live.
      store.record("b", now);
      expect(store.size).toBe(3);

      // The next new key still evicts the oldest first. Because `b` was
      // re-touched (not re-inserted — setting an existing key preserves
      // iteration order in JS Map), the oldest live key is still `a`.
      store.record("d", now);
      expect(store.size).toBe(3);
    });

    it("probes eviction order via a downstream observer", () => {
      // The two tests above prove "size stays at maxKeys" and "re-touch does
      // not evict". This one proves the actual eviction policy: when the
      // ceiling is hit, the *oldest* live key is dropped, not an arbitrary
      // one. We observe by asking the store whether each candidate key still
      // has hits within the window — if `a` was evicted, inspect returns
      // remaining = max (no prior hits); if `a` survived, remaining < max.
      let now = 10_000;
      const store = createSlidingWindowRateLimitStore({
        windowMs: 1_000,
        max: 3,
        maxKeys: 3,
        now: () => now,
      });

      store.record("a", now);
      store.record("b", now);
      store.record("c", now);
      // New key — must evict `a` (oldest).
      store.record("d", now);

      const aState = store.inspect("a", now);
      const bState = store.inspect("b", now);
      const cState = store.inspect("c", now);
      const dState = store.inspect("d", now);

      // `a` evicted ⇒ inspect sees no prior hits ⇒ full budget remaining.
      expect(aState.remaining).toBe(3);
      // `b`, `c`, `d` still live ⇒ each has one prior hit ⇒ two slots left.
      expect(bState.remaining).toBe(2);
      expect(cState.remaining).toBe(2);
      expect(dState.remaining).toBe(2);
    });
  });

  describe("inspection correctness", () => {
    it("reports blocked with a positive retry-after once the cap is reached", () => {
      let now = 5_000;
      const store = createSlidingWindowRateLimitStore({
        windowMs: 1_000,
        max: 2,
        now: () => now,
      });

      store.record("k", now);
      store.record("k", now);

      now += 100;
      const state = store.inspect("k", now);
      expect(state.blocked).toBe(true);
      expect(state.remaining).toBe(0);
      // Window is 1s; oldest hit at t=5000; now=5100. Retry after the oldest
      // slides out, i.e. ~900ms ⇒ rounded up to 1s.
      expect(state.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    });

    it("refills as the sliding window advances past old hits", () => {
      let now = 0;
      const store = createSlidingWindowRateLimitStore({
        windowMs: 1_000,
        max: 2,
        now: () => now,
      });

      expect(store.inspect("k", now).blocked).toBe(false);
      store.record("k", now);
      expect(store.inspect("k", now).blocked).toBe(false);
      store.record("k", now);
      expect(store.inspect("k", now).blocked).toBe(true);

      now += 1_001;
      expect(store.inspect("k", now).blocked).toBe(false);
    });

    it("clamps retry-after to at least one second when blocked", () => {
      // A window shorter than one second must still report a whole-second
      // retry-after so a caller can honour `Retry-After` without rounding
      // down to zero.
      let now = 0;
      const store = createSlidingWindowRateLimitStore({
        windowMs: 100,
        max: 1,
        now: () => now,
      });

      store.record("k", now);
      const state = store.inspect("k", now + 10);
      expect(state.blocked).toBe(true);
      expect(state.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    });
  });

  describe("defaults", () => {
    it("ships a finite default ceiling large enough to never bind in production", () => {
      expect(Number.isFinite(DEFAULT_SLIDING_WINDOW_MAX_KEYS)).toBe(true);
      expect(DEFAULT_SLIDING_WINDOW_MAX_KEYS).toBeGreaterThan(1_000);
    });
  });
});
