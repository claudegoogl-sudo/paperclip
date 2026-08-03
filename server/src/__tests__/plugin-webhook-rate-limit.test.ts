import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PLUGIN_WEBHOOK_RATE_LIMIT_MAX_PER_ENDPOINT,
  PLUGIN_WEBHOOK_RATE_LIMIT_MAX_PER_IP,
  PLUGIN_WEBHOOK_RATE_LIMIT_WINDOW_MS,
  createPluginWebhookRateLimiter,
} from "../services/plugin-webhook-rate-limit.js";
import { DEFAULT_JSON_BODY_LIMIT, WEBHOOK_JSON_BODY_LIMIT } from "../http/body-limits.js";
import { PLUGIN_WEBHOOK_INGESTION_PATH_PATTERN } from "../routes/plugin-webhook-paths.js";
import { pluginRoutes } from "../routes/plugins.js";
import { errorHandler } from "../middleware/index.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
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
    mockRegistry.getById.mockResolvedValue(READY_PLUGIN);
    mockRegistry.getByKey.mockResolvedValue(READY_PLUGIN);
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
