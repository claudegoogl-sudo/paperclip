// Sliding-window rate-limit store shared by every process-wide limiter that
// keys on an untrusted identifier — anonymous webhook source IP, plugin wake
// target agent, etc. The map of live buckets is the unbounded-growth surface:
// every previous in-tree implementation pruned timestamps *within* a bucket
// but never deleted the bucket itself, so once a key was seen it stayed in
// memory for the process lifetime. Under `TRUST_PROXY` an attacker rotating
// source IPs grows the map without bound; under a relay storm the wake map
// does the same across (plugin, company, agent) triples.
//
// The fix lives here so both limiters cannot drift apart. Three properties:
//
//   1. Empty-bucket keys are deleted on write. As soon as a window fully ages
//      out, the key is gone — the map returns to zero once traffic stops.
//   2. A hard ceiling on live keys bounds memory even when a burst of distinct
//      keys arrives faster than once-per-window (the case where sweep-on-write
//      alone would momentarily lag). When a new key would push the map over
//      the ceiling, the key that was inserted first is evicted — FIFO by
//      insertion order, not LRU (see `DEFAULT_SLIDING_WINDOW_MAX_KEYS`).
//   3. The inspect/record split lets multi-bucket limiters (e.g. webhook
//      endpoint + IP) decide atomically: inspect every relevant bucket before
//      committing any of them, so a request rejected by the IP bucket does
//      not spend endpoint budget.
//
// All three are sweep-on-write — no timer, no background handle, no event-loop
// registration. Pruning and eviction run on the existing consume() hot path,
// so the cost is O(1) amortised against the work the limiter was already
// doing.

import { logger } from "../middleware/logger.js";

/**
 * Default ceiling on the number of distinct live keys a single limiter keeps
 * in memory. Sized to never bind under legitimate traffic — even a busy
 * deployment with `TRUST_PROXY` configured sees orders of magnitude fewer
 * distinct source IPs per minute — while bounding worst-case memory to a few
 * hundred kilobytes per limiter when an attacker rotates keys. Legitimate
 * working sets are never trimmed: only a flood that has already outrun the
 * sweep reaches this ceiling. When it binds, eviction is FIFO by first
 * insertion: the key that entered the map earliest is dropped first even if
 * it is still hot, and a cold key inserted later outlives it. The ceiling is
 * a memory bound, not a popularity-ranking cache — insertion order is the
 * only eviction signal a `Map` gives without scanning every key. The first
 * binding per store emits a single `logger.warn` naming the limiter and
 * ceiling, so a working set that no longer fits is observable rather than
 * silently trimmed.
 */
export const DEFAULT_SLIDING_WINDOW_MAX_KEYS = 10_000;

export type SlidingWindowBucketState = {
  /** Whether consuming now would exceed the per-key cap. */
  blocked: boolean;
  /**
   * Hits remaining in the window before consume, clamped at 0. After a
   * successful {@link SlidingWindowRateLimitStore.record} call the actual
   * remaining is `this - 1`.
   */
  remaining: number;
  /**
   * Whole seconds until the oldest hit in the bucket slides out of the
   * window, so a blocked caller can honour `Retry-After`. Always `>= 1` when
   * blocked, `0` when not.
   */
  retryAfterSeconds: number;
};

export type SlidingWindowRateLimitStore = {
  /**
   * Prune hits outside the window for `key`, delete the key when the
   * post-prune hit list is empty (the fix for the original
   * leak-on-empty-bucket), and report whether the next consume would exceed
   * the cap. Does NOT record a hit — call {@link record} once every relevant
   * bucket has been inspected.
   */
  inspect(key: string, currentTime: number): SlidingWindowBucketState;
  /**
   * Append `currentTime` to `key`'s hit list, re-inserting the key if the
   * prior inspect pruned it to empty. Enforces the ceiling with
   * first-inserted-first (FIFO) eviction when a *new* key would push the map
   * over `maxKeys`.
   * No-op semantics are not supported: only call this after a successful
   * inspect for the same `key` and `currentTime`.
   */
  record(key: string, currentTime: number): void;
  /** Live key count. Test/diagnostic surface; do not branch on it in production. */
  readonly size: number;
};

export function createSlidingWindowRateLimitStore(options: {
  windowMs: number;
  max: number;
  maxKeys?: number;
  /**
   * Identity reported by the once-per-instance warning emitted when the
   * `maxKeys` ceiling first binds. Limiters pass their own name (and bucket
   * role, when they keep several stores) so the log line says *which* map
   * ran out of keys.
   */
  name?: string;
}): SlidingWindowRateLimitStore {
  const windowMs = options.windowMs;
  const max = options.max;
  const maxKeys = options.maxKeys ?? DEFAULT_SLIDING_WINDOW_MAX_KEYS;
  const name = options.name ?? "sliding-window-rate-limit-store";
  // Map iteration order is insertion order; setting an existing key does not
  // move it, so the first key reached by the iterator is the one first
  // inserted among the currently-live set — the closest cheap proxy for
  // "oldest live bucket" without scanning every key on every eviction.
  const hitsByKey = new Map<string, number[]>();
  // Flips on the first ceiling eviction so the warning below fires once per
  // store instance, not once per eviction — under a key flood the eviction
  // branch runs on every new key and per-eviction logging would be its own
  // flood.
  let warnedCeilingBound = false;

  function evictOldest() {
    const oldest = hitsByKey.keys().next().value;
    if (oldest !== undefined) {
      hitsByKey.delete(oldest);
    }
  }

  return {
    inspect(key, currentTime) {
      const cutoff = currentTime - windowMs;
      const hits = (hitsByKey.get(key) ?? []).filter((hit) => hit > cutoff);
      if (hits.length === 0) {
        // Empty-bucket eviction. The previous implementations called
        // `store.set(key, hits)` on every consume even when the pruned list
        // was empty, pinning every key for the process lifetime. Deleting
        // here lets the map return to zero once traffic stops.
        hitsByKey.delete(key);
      } else {
        // Persist the pruned list so the window keeps sliding. Setting an
        // existing key preserves insertion order, so this does not move the
        // key to the back of the eviction queue.
        hitsByKey.set(key, hits);
      }
      if (hits.length < max) {
        return {
          blocked: false,
          remaining: max - hits.length,
          retryAfterSeconds: 0,
        };
      }
      const oldestHit = hits[0] ?? currentTime;
      return {
        blocked: true,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((oldestHit + windowMs - currentTime) / 1000)),
      };
    },

    record(key, currentTime) {
      // Ceiling backstop. Only evict when a new key is about to be
      // introduced — re-touching an existing key cannot grow the map. The
      // inspect() sweep already prunes idle keys, so under steady state this
      // branch is cold. It exists for the burst case: a flood of distinct
      // keys arriving faster than once-per-window cannot outrun the sweep
      // and grow the map past maxKeys.
      if (!hitsByKey.has(key) && hitsByKey.size >= maxKeys) {
        if (!warnedCeilingBound) {
          warnedCeilingBound = true;
          logger.warn(
            { limiter: name, maxKeys },
            "sliding-window rate-limit key ceiling bound; evicting first-inserted (FIFO) keys",
          );
        }
        evictOldest();
      }
      const hits = hitsByKey.get(key);
      if (hits) {
        hits.push(currentTime);
      } else {
        hitsByKey.set(key, [currentTime]);
      }
    },

    get size() {
      return hitsByKey.size;
    },
  };
}
