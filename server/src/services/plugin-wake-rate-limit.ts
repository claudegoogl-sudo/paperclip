// Sliding-window rate limit for assignee heartbeat wakes enqueued from the
// plugin inbound relay path (buildHostServices(...).issues.createComment with
// wakeAssignee). The comment itself always lands; only the *wake* is throttled.
//
// A hostile or buggy relay (e.g. the messenger plugin forwarding untrusted
// Telegram content) can otherwise enqueue one assignee heartbeat run per
// relayed comment with no ceiling, spamming the target agent and burning
// budget. The window/cap below bound wakes per (plugin, company, target-agent)
// so a relay storm collapses to at most `maxWakes` heartbeats per window.
// (OWASP API4 Unrestricted Resource Consumption / LLM04 Model DoS.)
//
// The bucket map is built on the shared sliding-window store
// (sliding-window-rate-limit-store.ts): a key is deleted the moment its
// window fully ages out, and a hard ceiling on live keys with oldest-first
// eviction backstops the sweep so a relay storm across many distinct
// (plugin, company, agent) triples cannot outrun the sweep and grow the map
// without bound.

import {
  DEFAULT_SLIDING_WINDOW_MAX_KEYS,
  createSlidingWindowRateLimitStore,
} from "./sliding-window-rate-limit-store.js";

export const PLUGIN_WAKE_RATE_LIMIT_WINDOW_MS = 60_000;
export const PLUGIN_WAKE_RATE_LIMIT_MAX_WAKES = 5;

export type PluginWakeRateLimitActor = {
  pluginId: string;
  companyId: string;
  agentId: string;
};

export type PluginWakeRateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

export type PluginWakeRateLimiter = {
  consume(actor: PluginWakeRateLimitActor): PluginWakeRateLimitResult;
};

export function createPluginWakeRateLimiter(options: {
  windowMs?: number;
  maxWakes?: number;
  /**
   * Per-bucket ceiling on live keys. Defaults to the shared
   * `DEFAULT_SLIDING_WINDOW_MAX_KEYS`; override is intended for tests that
   * need to exercise oldest-first eviction without flooding the map.
   */
  maxKeys?: number;
  now?: () => number;
} = {}): PluginWakeRateLimiter {
  const windowMs = options.windowMs ?? PLUGIN_WAKE_RATE_LIMIT_WINDOW_MS;
  const maxWakes = options.maxWakes ?? PLUGIN_WAKE_RATE_LIMIT_MAX_WAKES;
  const maxKeys = options.maxKeys ?? DEFAULT_SLIDING_WINDOW_MAX_KEYS;
  const now = options.now ?? Date.now;
  const store = createSlidingWindowRateLimitStore({
    windowMs,
    max: maxWakes,
    maxKeys,
  });

  function key(actor: PluginWakeRateLimitActor) {
    return `${actor.pluginId}:${actor.companyId}:${actor.agentId}`;
  }

  return {
    consume(actor) {
      const currentTime = now();
      const actorKey = key(actor);
      const bucket = store.inspect(actorKey, currentTime);
      if (bucket.blocked) {
        return {
          allowed: false,
          limit: maxWakes,
          remaining: 0,
          retryAfterSeconds: bucket.retryAfterSeconds,
        };
      }

      store.record(actorKey, currentTime);
      return {
        allowed: true,
        limit: maxWakes,
        remaining: Math.max(0, bucket.remaining - 1),
        retryAfterSeconds: 0,
      };
    },
  };
}

/**
 * Process-wide default limiter shared by every plugin host instance. Living at
 * module scope (not per-buildHostServices) means the budget survives worker
 * restarts — a relay cannot reset its ceiling by bouncing its worker.
 */
export const defaultPluginWakeRateLimiter = createPluginWakeRateLimiter();
