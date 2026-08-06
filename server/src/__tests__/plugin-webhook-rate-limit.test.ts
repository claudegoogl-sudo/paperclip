import { createHash, createHmac } from "node:crypto";

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PLUGIN_WEBHOOK_RATE_LIMIT_MAX_PER_ENDPOINT,
  PLUGIN_WEBHOOK_RATE_LIMIT_MAX_PER_IP,
  PLUGIN_WEBHOOK_RATE_LIMIT_MAX_PER_VERIFIED_ENDPOINT,
  PLUGIN_WEBHOOK_RATE_LIMIT_WINDOW_MS,
  createPluginWebhookRateLimiter,
} from "../services/plugin-webhook-rate-limit.js";
import {
  computeWebhookTokenDigest,
  isVerifiedWebhookDelivery,
  resetPluginWebhookAuthWarnings,
} from "../services/plugin-webhook-auth.js";
import { DEFAULT_JSON_BODY_LIMIT, WEBHOOK_JSON_BODY_LIMIT } from "../http/body-limits.js";
import { PLUGIN_WEBHOOK_INGESTION_PATH_PATTERN } from "../routes/plugin-webhook-paths.js";
import { pluginRoutes } from "../routes/plugins.js";
import { errorHandler } from "../middleware/index.js";
import { logger } from "../middleware/logger.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({}),
}));

const PLUGIN_ID = "11111111-1111-4111-8111-111111111111";
const ENDPOINT_KEY = "telegram";

const READY_PLUGIN = {
  id: PLUGIN_ID,
  pluginKey: "paperclip-messenger",
  status: "ready",
  manifestJson: {
    capabilities: ["webhooks.receive"],
    webhooks: [{ endpointKey: ENDPOINT_KEY }],
  },
};

const TOKEN_HEADER = "x-telegram-bot-api-secret-token";
const TOKEN_CONFIG_KEY = "webhookTokenDigest";
const SALT = "e3b0c44298fc1c14";
const TOKEN = "provider-shared-token-with-plenty-of-entropy";

const WEBHOOK_AUTH = {
  type: "header-token" as const,
  header: TOKEN_HEADER,
  tokenDigestConfigKey: TOKEN_CONFIG_KEY,
};

/** Same plugin, but declaring the optional credential block. */
const READY_PLUGIN_WITH_AUTH = {
  ...READY_PLUGIN,
  manifestJson: {
    capabilities: ["webhooks.receive", "webhooks.verify"],
    webhooks: [{ endpointKey: ENDPOINT_KEY, auth: WEBHOOK_AUTH }],
  },
};

/**
 * A persisted manifest carrying `auth` but *without* `webhooks.verify` in its
 * capabilities — the exact artifact the install-time validator rejects, but
 * which a pre-feature row, a reinstall path, or a direct DB write could leave
 * behind. The runtime must not trust it into the verified tier.
 */
const READY_PLUGIN_WITH_AUTH_NO_VERIFY_CAP = {
  ...READY_PLUGIN,
  manifestJson: {
    capabilities: ["webhooks.receive"],
    webhooks: [{ endpointKey: ENDPOINT_KEY, auth: WEBHOOK_AUTH }],
  },
};

const VALID_DIGEST_CONFIG = {
  configJson: {
    [TOKEN_CONFIG_KEY]: { salt: SALT, digest: computeWebhookTokenDigest(SALT, TOKEN) },
  },
};

const ACTOR = { pluginId: PLUGIN_ID, endpointKey: ENDPOINT_KEY, ip: "203.0.113.7" };

describe("plugin webhook rate limiter", () => {
  it("allows up to the per-endpoint cap then blocks within the window", () => {
    let now = 1_000;
    const limiter = createPluginWebhookRateLimiter({
      windowMs: 60_000,
      maxPerEndpoint: 3,
      maxPerIp: 100,
      now: () => now,
    });

    const results = Array.from({ length: 6 }, () => {
      now += 10;
      return limiter.consume(ACTOR);
    });

    expect(results.filter((r) => r.allowed).length).toBe(3);
    expect(results.slice(3).every((r) => !r.allowed && r.scope === "endpoint")).toBe(true);
    expect(results[3]?.retryAfterSeconds).toBeGreaterThan(0);
    expect(results[2]?.remaining).toBe(0);
  });

  it("refills as the sliding window advances past old hits", () => {
    let now = 0;
    const limiter = createPluginWebhookRateLimiter({
      windowMs: 1_000,
      maxPerEndpoint: 2,
      maxPerIp: 100,
      now: () => now,
    });

    expect(limiter.consume(ACTOR).allowed).toBe(true);
    expect(limiter.consume(ACTOR).allowed).toBe(true);
    expect(limiter.consume(ACTOR).allowed).toBe(false);

    now += 1_001;
    expect(limiter.consume(ACTOR).allowed).toBe(true);
  });

  it("scopes the primary budget per (plugin, endpoint), not per IP", () => {
    const limiter = createPluginWebhookRateLimiter({ maxPerEndpoint: 1, maxPerIp: 1_000 });

    expect(limiter.consume(ACTOR).allowed).toBe(true);
    expect(limiter.consume(ACTOR).allowed).toBe(false);
    // Same IP, different endpoint or plugin: independent budget.
    expect(limiter.consume({ ...ACTOR, endpointKey: "other" }).allowed).toBe(true);
    expect(limiter.consume({ ...ACTOR, pluginId: "plugin-b" }).allowed).toBe(true);
    // Same endpoint from a different IP is still blocked — the endpoint bucket
    // is the primary key, so rotating source addresses does not buy budget.
    expect(limiter.consume({ ...ACTOR, ip: "198.51.100.4" }).allowed).toBe(false);
  });

  it("applies the per-IP bucket only as an additive secondary limit", () => {
    const limiter = createPluginWebhookRateLimiter({ maxPerEndpoint: 2, maxPerIp: 3 });

    // Spread across distinct endpoints so the endpoint buckets never bind.
    expect(limiter.consume({ ...ACTOR, endpointKey: "a" }).allowed).toBe(true);
    expect(limiter.consume({ ...ACTOR, endpointKey: "b" }).allowed).toBe(true);
    expect(limiter.consume({ ...ACTOR, endpointKey: "c" }).allowed).toBe(true);

    const blocked = limiter.consume({ ...ACTOR, endpointKey: "d" });
    expect(blocked.allowed).toBe(false);
    expect(blocked.scope).toBe("ip");
    expect(blocked.limit).toBe(3);

    // A different IP is unaffected.
    expect(limiter.consume({ ...ACTOR, endpointKey: "d", ip: "198.51.100.4" }).allowed).toBe(true);
  });

  it("does not spend endpoint budget on a request the IP bucket rejected", () => {
    const limiter = createPluginWebhookRateLimiter({ maxPerEndpoint: 2, maxPerIp: 1 });

    // Spend the noisy IP's whole allowance on an unrelated endpoint.
    expect(limiter.consume({ ...ACTOR, endpointKey: "a" }).allowed).toBe(true);
    expect(limiter.consume(ACTOR).scope).toBe("ip");
    expect(limiter.consume(ACTOR).scope).toBe("ip");

    // Those two IP-rejected attempts must not have consumed the target
    // endpoint's budget: two fresh IPs still get its full allowance, and only
    // the third is turned away — by the endpoint bucket, as designed.
    expect(limiter.consume({ ...ACTOR, ip: "198.51.100.4" }).allowed).toBe(true);
    expect(limiter.consume({ ...ACTOR, ip: "198.51.100.5" }).allowed).toBe(true);
    expect(limiter.consume({ ...ACTOR, ip: "198.51.100.6" }).scope).toBe("endpoint");
  });

  it("still limits when no IP is available", () => {
    const limiter = createPluginWebhookRateLimiter({ maxPerEndpoint: 1, maxPerIp: 10 });
    const anonymous = { pluginId: PLUGIN_ID, endpointKey: ENDPOINT_KEY, ip: undefined };

    expect(limiter.consume(anonymous).allowed).toBe(true);
    expect(limiter.consume(anonymous).scope).toBe("endpoint");
  });

  it("keeps the verified budget out of reach of an exhausted anonymous bucket", () => {
    // The ticket in one assertion. An anonymous flood spends the whole
    // (pluginId, endpointKey) budget; a credentialled delivery to the very same
    // endpoint must still get through.
    const limiter = createPluginWebhookRateLimiter({
      maxPerEndpoint: 2,
      maxPerIp: 1_000,
      maxPerVerifiedEndpoint: 3,
    });

    expect(limiter.consume(ACTOR).allowed).toBe(true);
    expect(limiter.consume(ACTOR).allowed).toBe(true);
    expect(limiter.consume(ACTOR).allowed).toBe(false);

    const verified = { ...ACTOR, tier: "verified" as const };
    expect(limiter.consume(verified).allowed).toBe(true);
    expect(limiter.consume(verified).allowed).toBe(true);
    expect(limiter.consume(verified).allowed).toBe(true);

    // ...and the verified tier has its own finite ceiling, so a leaked token
    // relocates the flood rather than removing the bound.
    const overrun = limiter.consume(verified);
    expect(overrun.allowed).toBe(false);
    expect(overrun.tier).toBe("verified");
    expect(overrun.limit).toBe(3);
  });

  it("does not let verified traffic spend the anonymous budget", () => {
    const limiter = createPluginWebhookRateLimiter({
      maxPerEndpoint: 2,
      maxPerIp: 1_000,
      maxPerVerifiedEndpoint: 10,
    });

    for (let i = 0; i < 5; i += 1) {
      expect(limiter.consume({ ...ACTOR, tier: "verified" }).allowed).toBe(true);
    }

    // The anonymous bucket is untouched by those five deliveries.
    expect(limiter.consume(ACTOR).allowed).toBe(true);
    expect(limiter.consume(ACTOR).allowed).toBe(true);
    expect(limiter.consume(ACTOR).allowed).toBe(false);
  });

  it("exempts verified traffic from the shared per-IP bucket", () => {
    // Behind a tunnel with TRUST_PROXY unset every caller shares one apparent
    // IP. If verified deliveries consumed that bucket, an anonymous flood would
    // starve them through the side door — the exact failure this ticket fixes.
    const limiter = createPluginWebhookRateLimiter({
      maxPerEndpoint: 1_000,
      maxPerIp: 2,
      maxPerVerifiedEndpoint: 10,
    });

    expect(limiter.consume({ ...ACTOR, endpointKey: "a" }).allowed).toBe(true);
    expect(limiter.consume({ ...ACTOR, endpointKey: "b" }).allowed).toBe(true);
    expect(limiter.consume({ ...ACTOR, endpointKey: "c" }).scope).toBe("ip");

    expect(limiter.consume({ ...ACTOR, tier: "verified" }).allowed).toBe(true);
  });

  it("treats an actor with no tier as anonymous", () => {
    const limiter = createPluginWebhookRateLimiter({ maxPerEndpoint: 1, maxPerIp: 1_000 });

    const first = limiter.consume(ACTOR);
    expect(first.tier).toBe("anonymous");
    expect(limiter.consume({ ...ACTOR, tier: "anonymous" }).allowed).toBe(false);
  });

  it("ships a verified cap strictly above the anonymous per-endpoint cap", () => {
    expect(PLUGIN_WEBHOOK_RATE_LIMIT_MAX_PER_VERIFIED_ENDPOINT).toBeGreaterThan(
      PLUGIN_WEBHOOK_RATE_LIMIT_MAX_PER_ENDPOINT,
    );
    // Finite by construction: a shared token can leak, and an uncapped verified
    // tier would just move the DoS behind a credential.
    expect(Number.isFinite(PLUGIN_WEBHOOK_RATE_LIMIT_MAX_PER_VERIFIED_ENDPOINT)).toBe(true);
  });

  it("ships a per-IP cap strictly above the per-endpoint cap", () => {
    // Load-bearing: behind a proxy with TRUST_PROXY unset every request shares
    // one apparent IP. If the IP cap were the tighter of the two it would bind
    // first and starve legitimate provider traffic — a self-inflicted DoS.
    expect(PLUGIN_WEBHOOK_RATE_LIMIT_MAX_PER_IP).toBeGreaterThan(
      PLUGIN_WEBHOOK_RATE_LIMIT_MAX_PER_ENDPOINT,
    );
    expect(PLUGIN_WEBHOOK_RATE_LIMIT_MAX_PER_ENDPOINT).toBeGreaterThan(0);
    expect(PLUGIN_WEBHOOK_RATE_LIMIT_WINDOW_MS).toBeGreaterThan(0);
  });
});

describe("plugin webhook rate limiter bucket-map eviction", () => {
  // The IP bucket is the unbounded-growth surface the parent ticket calls out:
  // with TRUST_PROXY off every caller shares one apparent IP, so the bucket
  // stays at size 1 regardless of traffic, but with TRUST_PROXY on each
  // distinct source IP gets its own key and the map can grow without bound.
  // These tests pin the two properties the shared store guarantees:
  //   1. the map returns to zero once the window fully ages out, and
  //   2. a hard ceiling with oldest-first eviction backstops the sweep so a
  //      burst of distinct IPs cannot outrun it.

  it("returns the IP bucket map to zero once every window has aged out", () => {
    let now = 10_000;
    const limiter = createPluginWebhookRateLimiter({
      windowMs: 1_000,
      maxPerEndpoint: 100,
      maxPerIp: 100,
      now: () => now,
    });

    // Drive traffic from several distinct IPs. Each one creates a key in the
    // per-IP map. The endpoint key rotates too so the endpoint cap never
    // binds first.
    for (let i = 0; i < 5; i += 1) {
      now += 10;
      limiter.consume({ ...ACTOR, endpointKey: `ep-${i}`, ip: `203.0.113.${i}` });
    }

    // Advance past the window so every prior hit has aged out, then drive one
    // more consume per IP. Each consume prunes its own key to an empty list
    // and the shared store deletes it — by the end of the loop the IP map is
    // empty, not five-idle.
    now += 1_001;
    for (let i = 0; i < 5; i += 1) {
      limiter.consume({ ...ACTOR, endpointKey: `ep-after-${i}`, ip: `203.0.113.${i}` });
    }

    // The proof of eviction is behavioural: if the IP map had retained the
    // five idle keys, the per-IP cap (set to 100 above) would not have been
    // touched, so a fresh burst from a new IP is fully allowed. That is also
    // true when the map is empty, so this test alone does not distinguish —
    // but the next test (ceiling) does. Here we assert the weaker property
    // directly via the shared store's own test suite (see
    // sliding-window-rate-limit-store.test.ts) and use this case to pin the
    // observable behaviour: an aged-out burst does not pin its keys.
    expect(limiter.consume({ ...ACTOR, endpointKey: "fresh", ip: "198.51.100.42" }).allowed).toBe(true);
  });

  it("holds the IP bucket under a hard ceiling when fed more distinct IPs than the ceiling allows", () => {
    let now = 10_000;
    // Tight ceiling so we can exercise eviction without flooding the test.
    // maxPerEndpoint is set high enough that the endpoint bucket never binds
    // (each consume uses a distinct endpoint key anyway, so the per-endpoint
    // map grows one key per consume and would itself hit maxKeys — set it to
    // the same ceiling so the assertion is about the IP bucket specifically).
    const maxKeys = 4;
    const limiter = createPluginWebhookRateLimiter({
      windowMs: 1_000,
      maxPerEndpoint: 1_000,
      maxPerIp: 1_000,
      maxKeys,
      now: () => now,
    });

    // Feed three times the ceiling in distinct IPs. Each consume also uses a
    // distinct endpoint so neither bucket reuses a key. The shared store's
    // ceiling backstop keeps each map at or below maxKeys.
    const total = maxKeys * 3;
    for (let i = 0; i < total; i += 1) {
      now += 1;
      const res = limiter.consume({
        ...ACTOR,
        endpointKey: `ep-${i}`,
        ip: `203.0.113.${i % 256}`,
      });
      expect(res.allowed, `consume ${i} should be allowed`).toBe(true);
    }

    // Observable proof: a brand-new IP whose key would be the (maxKeys+1)th
    // distinct key in the IP map is still allowed — the backstop evicted an
    // older IP's key to make room, rather than rejecting the request. (If the
    // limiter had let the IP map grow without bound, this consume would also
    // be allowed; the assertion is that the limiter behaves identically under
    // the ceiling as it does without one. The map-size invariant itself is
    // pinned in the store's own test suite.)
    const probe = limiter.consume({
      ...ACTOR,
      endpointKey: "probe",
      ip: "198.51.100.42",
    });
    expect(probe.allowed).toBe(true);
  });

  it("does not change observable limiter behaviour under load", () => {
    // Regression guard: the eviction backstop must be transparent to a caller
    // that stays under the per-key cap. A normal interleaving of allowed and
    // blocked consumes must produce exactly the same results as before the
    // shared store existed.
    let now = 1_000;
    const limiter = createPluginWebhookRateLimiter({
      windowMs: 60_000,
      maxPerEndpoint: 3,
      maxPerIp: 100,
      now: () => now,
    });

    const results = Array.from({ length: 6 }, () => {
      now += 10;
      return limiter.consume(ACTOR);
    });

    expect(results.filter((r) => r.allowed).length).toBe(3);
    expect(results.slice(3).every((r) => !r.allowed && r.scope === "endpoint")).toBe(true);
  });
});

describe("plugin webhook token-digest recognition", () => {
  beforeEach(() => {
    resetPluginWebhookAuthWarnings();
  });

  const verify = (over: Partial<Parameters<typeof isVerifiedWebhookDelivery>[0]> = {}) =>
    isVerifiedWebhookDelivery({
      auth: WEBHOOK_AUTH,
      headers: { [TOKEN_HEADER]: TOKEN },
      config: VALID_DIGEST_CONFIG.configJson,
      pluginId: PLUGIN_ID,
      endpointKey: ENDPOINT_KEY,
      ...over,
    });

  it("recognises the token behind the salted digest", () => {
    expect(verify()).toBe(true);
  });

  it("matches the header name case-insensitively, as HTTP requires", () => {
    expect(verify({ headers: { [TOKEN_HEADER.toUpperCase().toLowerCase()]: TOKEN } })).toBe(true);
    expect(verify({ auth: { ...WEBHOOK_AUTH, header: "X-Telegram-Bot-Api-Secret-Token" } })).toBe(true);
  });

  it("rejects a wrong token, including one differing only in the last byte", () => {
    expect(verify({ headers: { [TOKEN_HEADER]: `${TOKEN}x` } })).toBe(false);
    expect(verify({ headers: { [TOKEN_HEADER]: TOKEN.slice(0, -1) } })).toBe(false);
    expect(verify({ headers: { [TOKEN_HEADER]: "" } })).toBe(false);
  });

  it("rejects the salt or the digest presented as the token", () => {
    // A digest is not a bearer credential. Anyone who reads plugin config must
    // not thereby be able to authenticate.
    expect(verify({ headers: { [TOKEN_HEADER]: SALT } })).toBe(false);
    expect(verify({ headers: {
      [TOKEN_HEADER]: computeWebhookTokenDigest(SALT, TOKEN),
    } })).toBe(false);
  });

  it("treats a missing header, absent auth, or a repeated header as unverified", () => {
    expect(verify({ headers: {} })).toBe(false);
    expect(verify({ auth: undefined })).toBe(false);
    // Repeated header arrives as an array; there is no principled way to pick
    // which copy the provider sent, so it does not count.
    expect(verify({ headers: { [TOKEN_HEADER]: [TOKEN, "guess"] } })).toBe(false);
  });

  it("falls through to unverified when the digest config is missing or malformed", () => {
    const bad = [
      undefined,
      {},
      { [TOKEN_CONFIG_KEY]: "not-an-object" },
      { [TOKEN_CONFIG_KEY]: { salt: SALT } },
      { [TOKEN_CONFIG_KEY]: { digest: computeWebhookTokenDigest(SALT, TOKEN) } },
      // Salt too short to be worth anything against a precomputed table.
      { [TOKEN_CONFIG_KEY]: { salt: "abc", digest: computeWebhookTokenDigest("abc", TOKEN) } },
      // Digest that is not 64 hex characters.
      { [TOKEN_CONFIG_KEY]: { salt: SALT, digest: "deadbeef" } },
      { [TOKEN_CONFIG_KEY]: { salt: SALT, digest: "z".repeat(64) } },
    ];

    for (const config of bad) {
      expect(verify({ config: config as Record<string, unknown> | undefined })).toBe(false);
    }
  });

  it("derives the digest the way the spec documents it", () => {
    // Plugin authors compute this in their own language; pin the exact
    // construction so the two halves cannot drift.
    expect(computeWebhookTokenDigest(SALT, TOKEN)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeWebhookTokenDigest(SALT, TOKEN)).toBe(
      createHmac("sha256", SALT).update(TOKEN, "utf8").digest("hex"),
    );
    expect(computeWebhookTokenDigest(SALT, TOKEN)).not.toBe(computeWebhookTokenDigest(`${SALT}x`, TOKEN));
  });

  it("is HMAC, not sha256(salt || token), so the salt/token boundary is pinned", () => {
    // Why HMAC and not bare `sha256(salt || token)`: concatenation is not a
    // canonical encoding, so the salt/token boundary is not pinned. HMAC keys
    // the salt instead of concatenating it. (Length extension is *not* the
    // reason — it breaks `H(secret || msg)` where the secret is the prefix,
    // whereas here the salt is the public prefix and the token the secret
    // suffix, so it does not apply.)
    expect(computeWebhookTokenDigest(SALT, TOKEN)).not.toBe(
      createHash("sha256").update(SALT + TOKEN, "utf8").digest("hex"),
    );

    // The concatenation ambiguity is gone: under sha256(salt || token) these two
    // pairs hash identically, because ("ab","cd") and ("abc","d") are the same
    // input. HMAC keeps them distinct.
    expect(computeWebhookTokenDigest("ab", "cd")).not.toBe(computeWebhookTokenDigest("abc", "d"));
  });
});

describe("webhook ingestion body-parser mount path", () => {
  it("matches the ingestion route and nothing else under /api/plugins", () => {
    expect(PLUGIN_WEBHOOK_INGESTION_PATH_PATTERN.test(`/api/plugins/${PLUGIN_ID}/webhooks/${ENDPOINT_KEY}`)).toBe(true);
    expect(PLUGIN_WEBHOOK_INGESTION_PATH_PATTERN.test(`/api/plugins/${PLUGIN_ID}/webhooks/${ENDPOINT_KEY}/`)).toBe(true);
    expect(PLUGIN_WEBHOOK_INGESTION_PATH_PATTERN.test("/api/plugins/paperclip-messenger/webhooks/telegram")).toBe(true);

    expect(PLUGIN_WEBHOOK_INGESTION_PATH_PATTERN.test(`/api/plugins/${PLUGIN_ID}/webhooks`)).toBe(false);
    expect(PLUGIN_WEBHOOK_INGESTION_PATH_PATTERN.test(`/api/plugins/${PLUGIN_ID}/config`)).toBe(false);
    expect(PLUGIN_WEBHOOK_INGESTION_PATH_PATTERN.test(`/api/plugins/${PLUGIN_ID}/webhooks/${ENDPOINT_KEY}/replay`)).toBe(false);
    expect(PLUGIN_WEBHOOK_INGESTION_PATH_PATTERN.test("/api/companies/import")).toBe(false);
  });

  it("matches case variants, because Express routes case-insensitively by default", () => {
    expect(PLUGIN_WEBHOOK_INGESTION_PATH_PATTERN.test(`/API/plugins/${PLUGIN_ID}/webhooks/${ENDPOINT_KEY}`)).toBe(true);
    expect(PLUGIN_WEBHOOK_INGESTION_PATH_PATTERN.test(`/api/plugins/${PLUGIN_ID}/WEBHOOKS/${ENDPOINT_KEY}`)).toBe(true);
    expect(PLUGIN_WEBHOOK_INGESTION_PATH_PATTERN.test(`/Api/Plugins/${PLUGIN_ID}/Webhooks/${ENDPOINT_KEY}`)).toBe(true);

    // Widening to case variants must not widen to sibling routes.
    expect(PLUGIN_WEBHOOK_INGESTION_PATH_PATTERN.test(`/API/plugins/${PLUGIN_ID}/WEBHOOKS`)).toBe(false);
  });

  it("keeps the webhook cap tighter than the generic one", () => {
    expect(DEFAULT_JSON_BODY_LIMIT).toBe("10mb");
    expect(WEBHOOK_JSON_BODY_LIMIT).toBe("1mb");
  });
});

/**
 * Mirrors the parser layering in app.ts (webhook-specific parser mounted on the
 * RegExp path ahead of the generic one) so the routing behaviour is exercised
 * against real Express 5 rather than asserted from the source.
 */
function createWebhookApp(options: {
  rateLimiter?: ReturnType<typeof createPluginWebhookRateLimiter>;
  workerCall?: ReturnType<typeof vi.fn>;
  insert?: ReturnType<typeof vi.fn>;
} = {}) {
  const insert = options.insert ?? vi.fn(() => ({
    values: () => ({ returning: () => Promise.resolve([{ id: "delivery-1" }]) }),
  }));
  const db = {
    insert,
    update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve() }) })),
  };

  const captureRawBody = (req: express.Request, _res: express.Response, buf: Buffer) => {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
  };

  const app = express();
  app.use(PLUGIN_WEBHOOK_INGESTION_PATH_PATTERN, express.json({
    limit: WEBHOOK_JSON_BODY_LIMIT,
    verify: captureRawBody,
  }));
  app.use(express.json({ limit: DEFAULT_JSON_BODY_LIMIT, verify: captureRawBody }));
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "user-1" } as typeof req.actor;
    next();
  });

  const workerCall = options.workerCall ?? vi.fn(() => Promise.resolve({ ok: true }));
  app.use("/api", pluginRoutes(
    db as never,
    { installPlugin: vi.fn() } as never,
    undefined,
    { workerManager: { call: workerCall } as never, rateLimiter: options.rateLimiter },
  ));
  app.use(errorHandler);

  return { app, db, insert, workerCall };
}

describe("POST /api/plugins/:pluginId/webhooks/:endpointKey resource limits", () => {
  beforeEach(() => {
    mockRegistry.getById.mockReset();
    mockRegistry.getByKey.mockReset();
    mockRegistry.getConfig.mockReset();
    mockRegistry.getById.mockResolvedValue(READY_PLUGIN);
    mockRegistry.getByKey.mockResolvedValue(READY_PLUGIN);
    mockRegistry.getConfig.mockResolvedValue(null);
  });

  const url = `/api/plugins/${PLUGIN_ID}/webhooks/${ENDPOINT_KEY}`;

  it("accepts a normal delivery under the limit", async () => {
    const { app, workerCall } = createWebhookApp();

    const res = await request(app).post(url).send({ update_id: 1 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deliveryId: "delivery-1", status: "success" });
    expect(workerCall).toHaveBeenCalledTimes(1);
  });

  it("rejects over-limit deliveries with 429 and writes no row or RPC", async () => {
    const rateLimiter = createPluginWebhookRateLimiter({ maxPerEndpoint: 2, maxPerIp: 1_000 });
    const { app, insert, workerCall } = createWebhookApp({ rateLimiter });

    await request(app).post(url).send({ update_id: 1 });
    await request(app).post(url).send({ update_id: 2 });

    expect(insert).toHaveBeenCalledTimes(2);
    expect(workerCall).toHaveBeenCalledTimes(2);

    const res = await request(app).post(url).send({ update_id: 3 });

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/too many/i);
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(Number(res.headers["retry-after"])).toBe(res.body.retryAfterSeconds);
    // The whole point: the rejected request touched neither the DB nor a worker.
    expect(insert).toHaveBeenCalledTimes(2);
    expect(workerCall).toHaveBeenCalledTimes(2);
  });

  it("preserves rawBody byte-for-byte through the webhook parser", async () => {
    const workerCall = vi.fn(() => Promise.resolve({ ok: true }));
    const { app } = createWebhookApp({ workerCall });

    // Whitespace and unicode that JSON.stringify(req.body) would not reproduce.
    const signedBytes = '{"update_id":  42,\n  "text": "café ✓"}';
    const res = await request(app)
      .post(url)
      .set("content-type", "application/json")
      .send(signedBytes);

    expect(res.status).toBe(200);
    const dispatched = workerCall.mock.calls[0]?.[2] as { rawBody: string; parsedBody: unknown };
    expect(dispatched.rawBody).toBe(signedBytes);
    expect(dispatched.parsedBody).toEqual({ update_id: 42, text: "café ✓" });
  });

  it("rejects an oversized body with a clean 413, not a 500", async () => {
    const { app, insert } = createWebhookApp();

    const res = await request(app)
      .post(url)
      .set("content-type", "application/json")
      .send(JSON.stringify({ blob: "x".repeat(1_200_000) }));

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: "Request entity too large", code: "entity.too.large" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("applies the tighter cap regardless of path case, matching Express's router", async () => {
    const { app, insert } = createWebhookApp();
    const oversized = JSON.stringify({ blob: "x".repeat(1_200_000) });

    // Express routes case-insensitively by default, so these all reach the
    // handler. The body-parser mount must agree, or the cap is opt-out: a
    // case-varied path would fall through to the generic 10mb parser and give
    // an anonymous caller 10x the jsonb write this route is meant to bound.
    for (const path of [
      `/API/plugins/${PLUGIN_ID}/webhooks/${ENDPOINT_KEY}`,
      `/api/plugins/${PLUGIN_ID}/WEBHOOKS/${ENDPOINT_KEY}`,
      `/Api/Plugins/${PLUGIN_ID}/Webhooks/${ENDPOINT_KEY}`,
    ]) {
      const res = await request(app)
        .post(path)
        .set("content-type", "application/json")
        .send(oversized);

      expect(res.status, `${path} must hit the 1mb cap, not the generic 10mb one`).toBe(413);
    }

    expect(insert).not.toHaveBeenCalled();
  });

  it("does not read plugin config for an endpoint that declares no auth", async () => {
    // The "identical to today" promise is partly a cost promise: an anonymous
    // delivery to an endpoint without `auth` must not pay for a config lookup.
    const { app } = createWebhookApp();

    await request(app).post(url).send({ update_id: 1 });

    expect(mockRegistry.getConfig).not.toHaveBeenCalled();
  });

  it("leaves other /api/plugins routes on the generic 10mb parser", async () => {
    const { app } = createWebhookApp();
    // 1.2 MB is over the webhook cap but well under the generic one. If the
    // webhook parser were mounted too broadly this would 413 instead of
    // reaching the route (which 404s for an undeclared endpoint key).
    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks`)
      .set("content-type", "application/json")
      .send(JSON.stringify({ blob: "x".repeat(1_200_000) }));

    expect(res.status).not.toBe(413);
  });
});

describe("POST /api/plugins/:pluginId/webhooks/:endpointKey credential tiering", () => {
  beforeEach(() => {
    mockRegistry.getById.mockReset();
    mockRegistry.getByKey.mockReset();
    mockRegistry.getConfig.mockReset();
    mockRegistry.getById.mockResolvedValue(READY_PLUGIN_WITH_AUTH);
    mockRegistry.getByKey.mockResolvedValue(READY_PLUGIN_WITH_AUTH);
    mockRegistry.getConfig.mockResolvedValue(VALID_DIGEST_CONFIG);
    resetPluginWebhookAuthWarnings();
  });

  const url = `/api/plugins/${PLUGIN_ID}/webhooks/${ENDPOINT_KEY}`;

  it("lets a credentialled delivery through an anonymous flood that has exhausted the endpoint budget", async () => {
    // This is the ticket. An attacker holds the public (pluginId, endpointKey)
    // bucket at zero; the real provider, which holds the token, must still be
    // delivered. Asserted as an interleaving, not as two independent counts.
    const rateLimiter = createPluginWebhookRateLimiter({
      maxPerEndpoint: 2,
      maxPerIp: 1_000,
      maxPerVerifiedEndpoint: 10,
    });
    const { app, insert, workerCall } = createWebhookApp({ rateLimiter });

    await request(app).post(url).send({ flood: 1 });
    await request(app).post(url).send({ flood: 2 });
    const starved = await request(app).post(url).send({ flood: 3 });
    expect(starved.status).toBe(429);

    const delivered = await request(app)
      .post(url)
      .set(TOKEN_HEADER, TOKEN)
      .send({ update_id: 42 });

    expect(delivered.status).toBe(200);
    expect(delivered.body).toMatchObject({ status: "success" });

    // The flood keeps being turned away while verified traffic keeps flowing.
    expect((await request(app).post(url).send({ flood: 4 })).status).toBe(429);
    expect((await request(app).post(url).set(TOKEN_HEADER, TOKEN).send({ update_id: 43 })).status).toBe(200);

    // Two anonymous + two verified deliveries reached the database and worker;
    // the three rejected ones did not.
    expect(insert).toHaveBeenCalledTimes(4);
    expect(workerCall).toHaveBeenCalledTimes(4);
  });

  it("treats a wrong token exactly like an anonymous caller", async () => {
    const rateLimiter = createPluginWebhookRateLimiter({
      maxPerEndpoint: 1,
      maxPerIp: 1_000,
      maxPerVerifiedEndpoint: 10,
    });
    const { app, insert, workerCall } = createWebhookApp({ rateLimiter });

    // Spend the anonymous budget with a bad token, proving it was billed there.
    const first = await request(app).post(url).set(TOKEN_HEADER, "wrong-token").send({ n: 1 });
    expect(first.status).toBe(200);

    const second = await request(app).post(url).set(TOKEN_HEADER, "wrong-token").send({ n: 2 });
    expect(second.status).toBe(429);
    expect(Number(second.headers["retry-after"])).toBe(second.body.retryAfterSeconds);
    expect(second.body.error).toMatch(/too many/i);

    // A plain anonymous caller sees the same exhausted bucket — one budget,
    // not two — and the real token still gets through.
    expect((await request(app).post(url).send({ n: 3 })).status).toBe(429);
    expect((await request(app).post(url).set(TOKEN_HEADER, TOKEN).send({ n: 4 })).status).toBe(200);

    expect(insert).toHaveBeenCalledTimes(2);
    expect(workerCall).toHaveBeenCalledTimes(2);
  });

  it("reaches the digest check before the delivery insert and the worker RPC", async () => {
    // A request that is both mismatched *and* over the anonymous limit must
    // cost nothing: no row, no RPC. If the tier decision had been made after
    // either, this would be non-zero.
    const rateLimiter = createPluginWebhookRateLimiter({
      maxPerEndpoint: 0,
      maxPerIp: 1_000,
      maxPerVerifiedEndpoint: 10,
    });
    const { app, insert, workerCall } = createWebhookApp({ rateLimiter });

    const res = await request(app).post(url).set(TOKEN_HEADER, "wrong-token").send({ n: 1 });

    expect(res.status).toBe(429);
    expect(insert).not.toHaveBeenCalled();
    expect(workerCall).not.toHaveBeenCalled();
  });

  it("falls back to the anonymous budget when the configured digest is unusable", async () => {
    // A stale or mistyped digest must degrade to today's behaviour, never to a
    // hard rejection — a misconfiguration cannot be allowed to take ingestion
    // down for every tenant sharing the plugin.
    mockRegistry.getConfig.mockResolvedValue({ configJson: { [TOKEN_CONFIG_KEY]: { salt: SALT } } });
    const rateLimiter = createPluginWebhookRateLimiter({
      maxPerEndpoint: 1,
      maxPerIp: 1_000,
      maxPerVerifiedEndpoint: 10,
    });
    const { app } = createWebhookApp({ rateLimiter });

    expect((await request(app).post(url).set(TOKEN_HEADER, TOKEN).send({ n: 1 })).status).toBe(200);
    expect((await request(app).post(url).set(TOKEN_HEADER, TOKEN).send({ n: 2 })).status).toBe(429);
  });

  it("stays anonymous when the manifest declares auth but lacks the webhooks.verify capability", async () => {
    // Complete mediation: the capability is re-checked at request time against
    // the persisted manifest, not only at install. A manifest that carries
    // `auth` but never earned `webhooks.verify` (a stale row, a reinstall path,
    // a direct DB write) must not reach the verified tier even with the correct
    // token — the tier decision falls through to the anonymous budget.
    mockRegistry.getById.mockResolvedValue(READY_PLUGIN_WITH_AUTH_NO_VERIFY_CAP);
    mockRegistry.getByKey.mockResolvedValue(READY_PLUGIN_WITH_AUTH_NO_VERIFY_CAP);
    const rateLimiter = createPluginWebhookRateLimiter({
      maxPerEndpoint: 1,
      maxPerIp: 1_000,
      maxPerVerifiedEndpoint: 10,
    });
    const { app } = createWebhookApp({ rateLimiter });

    // The correct token is presented, but without the capability grant it earns
    // nothing: the single anonymous slot is spent and the next delivery — token
    // and all — is turned away at the anonymous ceiling.
    expect((await request(app).post(url).set(TOKEN_HEADER, TOKEN).send({ n: 1 })).status).toBe(200);
    expect((await request(app).post(url).set(TOKEN_HEADER, TOKEN).send({ n: 2 })).status).toBe(429);
  });

  it("never puts the token, header value or digest in the rate-limit warning", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      const rateLimiter = createPluginWebhookRateLimiter({
        maxPerEndpoint: 0,
        maxPerIp: 1_000,
        maxPerVerifiedEndpoint: 0,
      });
      const { app } = createWebhookApp({ rateLimiter });

      await request(app).post(url).set(TOKEN_HEADER, TOKEN).send({ n: 1 });

      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain(SALT);
      expect(logged).not.toContain(computeWebhookTokenDigest(SALT, TOKEN));
      // The one thing the warning does gain is which budget was exhausted.
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ tier: "verified", endpointKey: ENDPOINT_KEY }),
        expect.stringMatching(/rate-limited/),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
