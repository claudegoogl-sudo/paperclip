// Sliding-window rate limit for the *unauthenticated* plugin webhook ingestion
// route (POST /api/plugins/:pluginId/webhooks/:endpointKey). Without it, any
// anonymous caller can drive unbounded `plugin_webhook_deliveries` row growth,
// unbounded jsonb payload writes, and one worker RPC dispatch per request.
// (OWASP API4:2023 Unrestricted Resource Consumption.)
//
// Traffic is split into two tiers before any bucket is consulted. A delivery
// that presented the endpoint's shared token (see plugin-webhook-auth.ts) is
// `verified`; everything else is `anonymous`.
//
// The tiers do not share buckets, and that separation is the entire point of
// the design. Both components of the anonymous key are public, so an anonymous
// caller can spend the whole endpoint budget at ~2 req/s and hold real provider
// deliveries at 429 — and because plugins are global, that starves ingestion
// for every tenant at once. Moving credentialled traffic into its own bucket
// puts the scarce resource behind something the attacker does not hold.
//
// Anonymous bucket keys, in priority order — unchanged from the original
// limiter, byte for byte, because a mismatched or unauthenticated delivery must
// behave exactly as it did before this tiering existed:
//
//  1. `(pluginId, endpointKey)` — the *primary* key. It is always meaningful
//     and has no reverse-proxy dependency.
//  2. Client IP — a *secondary, additive* bucket with a cap strictly above the
//     per-endpoint cap.
//
// Verified deliveries consume one bucket only: `(pluginId, endpointKey)` in the
// verified map. They deliberately skip the per-IP bucket. Behind a tunnel with
// TRUST_PROXY unset every request shares one apparent ip, so an anonymous flood
// would otherwise exhaust the shared IP bucket and starve verified traffic
// through the side door — reintroducing exactly the starvation this fixes. The
// verified endpoint cap is the ceiling that bounds a leaked credential.
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
//
// All three buckets are built on the shared sliding-window store
// (sliding-window-rate-limit-store.ts), which deletes a key as soon as its
// window fully ages out and caps the live-key count with oldest-first
// eviction. The IP bucket is the unbounded-growth surface: an operator that
// flips `TRUST_PROXY` on exposes `req.ip` to whatever an attacker sends, and
// without the store's eviction backstop a rotating-source-IP flood would grow
// the map without bound.

import {
  DEFAULT_SLIDING_WINDOW_MAX_KEYS,
  createSlidingWindowRateLimitStore,
} from "./sliding-window-rate-limit-store.js";

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

/**
 * Deliveries allowed per (plugin, endpoint) per window for callers that
 * presented the endpoint's shared token.
 *
 * Larger than the anonymous cap so a credentialled provider is never throttled
 * by an anonymous flood, but still finite: the token is shared, it can leak,
 * and an unbounded tier would just relocate the DoS behind a credential.
 */
export const PLUGIN_WEBHOOK_RATE_LIMIT_MAX_PER_VERIFIED_ENDPOINT = 600;

/** Which budget a delivery is billed to. */
export type PluginWebhookRateLimitTier = "verified" | "anonymous";

export type PluginWebhookRateLimitActor = {
  /** Canonical plugin row id — never the raw URL param, so key aliasing between a plugin's uuid and its key cannot split the budget. */
  pluginId: string;
  /** Endpoint key, already validated against the plugin manifest. */
  endpointKey: string;
  /** `req.ip` as governed by `applyTrustProxy`. Omit when unavailable. Ignored for the verified tier. */
  ip?: string | null;
  /** Defaults to `"anonymous"`, so an un-updated caller keeps the original behaviour. */
  tier?: PluginWebhookRateLimitTier;
};

export type PluginWebhookRateLimitResult = {
  allowed: boolean;
  /** Which bucket produced the decision. `null` when allowed. */
  scope: "endpoint" | "ip" | null;
  /** Which budget the delivery was billed to, whether allowed or not. */
  tier: PluginWebhookRateLimitTier;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

export type PluginWebhookRateLimiter = {
  consume(actor: PluginWebhookRateLimitActor): PluginWebhookRateLimitResult;
};

export function createPluginWebhookRateLimiter(options: {
  windowMs?: number;
  maxPerEndpoint?: number;
  maxPerIp?: number;
  maxPerVerifiedEndpoint?: number;
  /**
   * Per-bucket ceiling on live keys. Defaults to the shared
   * `DEFAULT_SLIDING_WINDOW_MAX_KEYS`; override is intended for tests that
   * need to exercise oldest-first eviction without flooding the map.
   */
  maxKeys?: number;
  now?: () => number;
} = {}): PluginWebhookRateLimiter {
  const windowMs = options.windowMs ?? PLUGIN_WEBHOOK_RATE_LIMIT_WINDOW_MS;
  const maxPerEndpoint = options.maxPerEndpoint ?? PLUGIN_WEBHOOK_RATE_LIMIT_MAX_PER_ENDPOINT;
  const maxPerIp = options.maxPerIp ?? PLUGIN_WEBHOOK_RATE_LIMIT_MAX_PER_IP;
  const maxPerVerifiedEndpoint = options.maxPerVerifiedEndpoint
    ?? PLUGIN_WEBHOOK_RATE_LIMIT_MAX_PER_VERIFIED_ENDPOINT;
  const maxKeys = options.maxKeys ?? DEFAULT_SLIDING_WINDOW_MAX_KEYS;
  const now = options.now ?? Date.now;
  // Three independent stores, not three key prefixes in one store: an
  // anonymous flood must not be able to reach the verified budget by any
  // path, and the per-IP store must not share its eviction queue with the
  // per-endpoint store (a cold endpoint key must not be evicted because an
  // unrelated IP key flooded).
  const endpointStore = createSlidingWindowRateLimitStore({
    windowMs,
    max: maxPerEndpoint,
    maxKeys,
  });
  const ipStore = createSlidingWindowRateLimitStore({
    windowMs,
    max: maxPerIp,
    maxKeys,
  });
  const verifiedStore = createSlidingWindowRateLimitStore({
    windowMs,
    max: maxPerVerifiedEndpoint,
    maxKeys,
  });

  return {
    consume(actor) {
      const currentTime = now();
      const endpointKey = `${actor.pluginId}:${actor.endpointKey}`;
      const tier = actor.tier ?? "anonymous";

      if (tier === "verified") {
        const verified = verifiedStore.inspect(endpointKey, currentTime);
        if (verified.blocked) {
          return {
            allowed: false,
            scope: "endpoint",
            tier,
            limit: maxPerVerifiedEndpoint,
            remaining: 0,
            retryAfterSeconds: verified.retryAfterSeconds,
          };
        }
        verifiedStore.record(endpointKey, currentTime);
        return {
          allowed: true,
          scope: null,
          tier,
          limit: maxPerVerifiedEndpoint,
          // inspect reports the pre-consume remaining; the record we just
          // committed spends one slot.
          remaining: Math.max(0, verified.remaining - 1),
          retryAfterSeconds: 0,
        };
      }

      const endpoint = endpointStore.inspect(endpointKey, currentTime);
      if (endpoint.blocked) {
        return {
          allowed: false,
          scope: "endpoint",
          tier,
          limit: maxPerEndpoint,
          remaining: 0,
          retryAfterSeconds: endpoint.retryAfterSeconds,
        };
      }

      const ip = actor.ip?.trim();
      const perIp = ip ? ipStore.inspect(ip, currentTime) : null;
      if (perIp?.blocked) {
        // The endpoint bucket is deliberately left unconsumed: a rejected
        // request must not spend budget that legitimate traffic needs. The
        // shared store makes this trivial — `record` is a separate call, so
        // skipping it on rejection leaves the bucket untouched.
        return {
          allowed: false,
          scope: "ip",
          tier,
          limit: maxPerIp,
          remaining: 0,
          retryAfterSeconds: perIp.retryAfterSeconds,
        };
      }

      endpointStore.record(endpointKey, currentTime);
      if (ip) {
        ipStore.record(ip, currentTime);
      }
      return {
        allowed: true,
        scope: null,
        tier,
        limit: maxPerEndpoint,
        remaining: Math.max(0, endpoint.remaining - 1),
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
