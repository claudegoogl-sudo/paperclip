// Sliding-window rate limit for the *unauthenticated* plugin webhook ingestion
// route (POST /api/plugins/:pluginId/webhooks/:endpointKey). Without it, any
// anonymous caller can drive unbounded `plugin_webhook_deliveries` row growth,
// unbounded jsonb payload writes, and one worker RPC dispatch per request.
// (OWASP API4:2023 Unrestricted Resource Consumption.)
//
// Bucket keys, in priority order:
//
//  1. `(pluginId, endpointKey)` — the *primary* key. It is always meaningful
//     and has no reverse-proxy dependency.
//  2. Client IP — a *secondary, additive* bucket with a cap strictly above the
//     per-endpoint cap.
//
// The ordering matters. This host sits behind a tunnel that terminates TLS and
// proxies to localhost, and `TRUST_PROXY` is unset by default, so `req.ip` is
// the loopback address for every tunnelled request (see middleware/trust-proxy.ts).
// An IP-primary limiter would therefore collapse into a single global bucket:
// an attacker would exhaust it and starve legitimate provider deliveries — a
// self-inflicted DoS, strictly worse than no limiter at all. Keeping the per-IP
// cap above the per-endpoint cap guarantees that when all traffic shares one
// apparent IP the per-endpoint bucket is the binding constraint, so the per-IP
// bucket only fires when `TRUST_PROXY` is configured and IPs are real.

/** Sliding window both buckets are measured over. */
export const PLUGIN_WEBHOOK_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Deliveries allowed per (plugin, endpoint) per window.
 *
 * Sized against real provider traffic: a Telegram bot webhook on this
 * deployment peaks in the low single digits per minute, so 120/min is ~two
 * orders of magnitude of headroom while still bounding an anonymous flood to a
 * known row-and-jsonb budget.
 */
export const PLUGIN_WEBHOOK_RATE_LIMIT_MAX_PER_ENDPOINT = 120;

/**
 * Deliveries allowed per client IP per window. Strictly above the per-endpoint
 * cap by construction — see the module comment.
 */
export const PLUGIN_WEBHOOK_RATE_LIMIT_MAX_PER_IP = 600;

export type PluginWebhookRateLimitActor = {
  /** Canonical plugin row id — never the raw URL param, so key aliasing between a plugin's uuid and its key cannot split the budget. */
  pluginId: string;
  /** Endpoint key, already validated against the plugin manifest. */
  endpointKey: string;
  /** `req.ip` as governed by `applyTrustProxy`. Omit when unavailable. */
  ip?: string | null;
};

export type PluginWebhookRateLimitResult = {
  allowed: boolean;
  /** Which bucket produced the decision. `null` when allowed. */
  scope: "endpoint" | "ip" | null;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

export type PluginWebhookRateLimiter = {
  consume(actor: PluginWebhookRateLimitActor): PluginWebhookRateLimitResult;
};

type Bucket = {
  hits: number[];
  blocked: boolean;
  retryAfterSeconds: number;
};

export function createPluginWebhookRateLimiter(options: {
  windowMs?: number;
  maxPerEndpoint?: number;
  maxPerIp?: number;
  now?: () => number;
} = {}): PluginWebhookRateLimiter {
  const windowMs = options.windowMs ?? PLUGIN_WEBHOOK_RATE_LIMIT_WINDOW_MS;
  const maxPerEndpoint = options.maxPerEndpoint ?? PLUGIN_WEBHOOK_RATE_LIMIT_MAX_PER_ENDPOINT;
  const maxPerIp = options.maxPerIp ?? PLUGIN_WEBHOOK_RATE_LIMIT_MAX_PER_IP;
  const now = options.now ?? Date.now;
  const endpointHits = new Map<string, number[]>();
  const ipHits = new Map<string, number[]>();

  function inspect(store: Map<string, number[]>, key: string, max: number, currentTime: number): Bucket {
    const cutoff = currentTime - windowMs;
    const hits = (store.get(key) ?? []).filter((hit) => hit > cutoff);
    // Persist the pruned list so the window keeps sliding even while blocked.
    store.set(key, hits);
    if (hits.length < max) {
      return { hits, blocked: false, retryAfterSeconds: 0 };
    }
    const oldestHit = hits[0] ?? currentTime;
    return {
      hits,
      blocked: true,
      retryAfterSeconds: Math.max(1, Math.ceil((oldestHit + windowMs - currentTime) / 1000)),
    };
  }

  return {
    consume(actor) {
      const currentTime = now();
      const endpointKey = `${actor.pluginId}:${actor.endpointKey}`;
      const endpoint = inspect(endpointHits, endpointKey, maxPerEndpoint, currentTime);
      if (endpoint.blocked) {
        return {
          allowed: false,
          scope: "endpoint",
          limit: maxPerEndpoint,
          remaining: 0,
          retryAfterSeconds: endpoint.retryAfterSeconds,
        };
      }

      const ip = actor.ip?.trim();
      const perIp = ip ? inspect(ipHits, ip, maxPerIp, currentTime) : null;
      if (perIp?.blocked) {
        // The endpoint bucket is deliberately left unconsumed: a rejected
        // request must not spend budget that legitimate traffic needs.
        return {
          allowed: false,
          scope: "ip",
          limit: maxPerIp,
          remaining: 0,
          retryAfterSeconds: perIp.retryAfterSeconds,
        };
      }

      endpoint.hits.push(currentTime);
      perIp?.hits.push(currentTime);
      return {
        allowed: true,
        scope: null,
        limit: maxPerEndpoint,
        remaining: Math.max(0, maxPerEndpoint - endpoint.hits.length),
        retryAfterSeconds: 0,
      };
    },
  };
}

/**
 * Process-wide default limiter shared by every plugin router instance. Living
 * at module scope (not per-`pluginRoutes(...)`) means the budget survives a
 * plugin worker restart — an attacker must not be able to reset the ceiling by
 * bouncing a worker.
 */
export const defaultPluginWebhookRateLimiter = createPluginWebhookRateLimiter();
