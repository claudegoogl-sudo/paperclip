// Sliding-window rate limit for assignee heartbeat wakes enqueued from the
// plugin inbound relay path (buildHostServices(...).issues.createComment with
// wakeAssignee). The comment itself always lands; only the *wake* is throttled.
//
// A hostile or buggy relay (e.g. the messenger plugin forwarding untrusted
// Telegram content) can otherwise enqueue one assignee heartbeat run per
// relayed comment with no ceiling, spamming the target agent and burning
// budget. The window/cap below bound wakes per (plugin, company, target-agent)
// so a relay storm collapses to at most `maxWakes` heartbeats per window.
// (PLA-829: OWASP API4 Unrestricted Resource Consumption / LLM04 Model DoS.)

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
  now?: () => number;
} = {}): PluginWakeRateLimiter {
  const windowMs = options.windowMs ?? PLUGIN_WAKE_RATE_LIMIT_WINDOW_MS;
  const maxWakes = options.maxWakes ?? PLUGIN_WAKE_RATE_LIMIT_MAX_WAKES;
  const now = options.now ?? Date.now;
  const hitsByKey = new Map<string, number[]>();

  function key(actor: PluginWakeRateLimitActor) {
    return `${actor.pluginId}:${actor.companyId}:${actor.agentId}`;
  }

  return {
    consume(actor) {
      const currentTime = now();
      const cutoff = currentTime - windowMs;
      const actorKey = key(actor);
      const recentHits = (hitsByKey.get(actorKey) ?? []).filter((hit) => hit > cutoff);

      if (recentHits.length >= maxWakes) {
        // Persist the pruned list so the window keeps sliding even while blocked.
        hitsByKey.set(actorKey, recentHits);
        const oldestHit = recentHits[0] ?? currentTime;
        return {
          allowed: false,
          limit: maxWakes,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((oldestHit + windowMs - currentTime) / 1000)),
        };
      }

      recentHits.push(currentTime);
      hitsByKey.set(actorKey, recentHits);
      return {
        allowed: true,
        limit: maxWakes,
        remaining: Math.max(0, maxWakes - recentHits.length),
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
