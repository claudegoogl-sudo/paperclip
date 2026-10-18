import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, gte, lte } from "drizzle-orm";
import { authUsers, boardApiKeyAuthEvents, boardApiKeys, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { registerActorContext, resetBoardKeyAuthEventThrottleForTests } from "../middleware/auth.ts";
import {
  pruneBoardApiKeyAuthEvents,
  DEFAULT_BOARD_API_KEY_AUTH_EVENT_RETENTION_DAYS,
} from "../services/board-api-key-auth-event-retention.js";
import { errorHandler } from "../middleware/error-handler.ts";
import { boardAuthService, hashBearerToken } from "../services/board-auth.ts";

// Board-key bearer auth must log EVERY attempt (success, expired,
// revoked, bad_key) to an append-only table, not just successful business
// actions. Drives real HTTP requests through registerActorContext (the same
// chain createApp uses) so a regression that stops logging a given outcome
// goes red here.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping board API key auth event tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("board API key auth events", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const operatorUserId = "operator-user-auth-events";

  function buildApp(options?: { trustedProxies?: string[] }) {
    const app = express();
    app.use(express.json());
    registerActorContext(app, db, {
      deploymentMode: "authenticated",
      authEventTrustedProxies: options?.trustedProxies,
    });
    app.get("/api/ping", (req, res) => res.json({ ok: true, actorType: req.actor?.type ?? null }));
    app.get("/api/ping/:pad", (req, res) => res.json({ ok: true, pad: req.params.pad.length }));
    app.use(errorHandler);
    return app;
  }

  async function eventsFor(keyId: string | null) {
    return db
      .select()
      .from(boardApiKeyAuthEvents)
      .where(keyId ? eq(boardApiKeyAuthEvents.keyId, keyId) : eq(boardApiKeyAuthEvents.outcome, "bad_key"))
      .orderBy(boardApiKeyAuthEvents.createdAt);
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-key-auth-events-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    const now = new Date();
    await db.insert(authUsers).values({
      id: operatorUserId,
      name: "Operator",
      email: "operator-auth-events@example.com",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(async () => {
    resetBoardKeyAuthEventThrottleForTests();
    await db.delete(boardApiKeyAuthEvents);
    await db.delete(boardApiKeys);
    await db.delete(authUsers).where(eq(authUsers.id, operatorUserId));
  });

  it("logs a success event with method, route, and key id -- no secret material", async () => {
    const boardAuth = boardAuthService(db);
    const created = await boardAuth.createNamedBoardApiKey({ userId: operatorUserId, name: "success-key" });
    const app = buildApp();

    const res = await request(app).get("/api/ping").set("Authorization", `Bearer ${created.token}`);
    expect(res.status).toBe(200);

    const rows = await eventsFor(created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "success", method: "GET", route: "/api/ping", keyId: created.id });
    // No token or key hash anywhere in the row.
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain(created.token);
    expect(serialized).not.toContain(hashBearerToken(created.token));
  });

  it("logs a revoked-key attempt as outcome=revoked, attributed to the key id", async () => {
    const boardAuth = boardAuthService(db);
    const created = await boardAuth.createNamedBoardApiKey({ userId: operatorUserId, name: "revoked-key" });
    await boardAuth.revokeBoardApiKey(created.id);
    const app = buildApp();

    const res = await request(app).get("/api/ping").set("Authorization", `Bearer ${created.token}`);
    expect(res.status).toBe(200); // falls through to unauthenticated, route itself is open
    const rows = await eventsFor(created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("revoked");
  });

  it("logs an expired-key attempt as outcome=expired", async () => {
    const boardAuth = boardAuthService(db);
    const created = await boardAuth.createNamedBoardApiKey({
      userId: operatorUserId,
      name: "expired-key",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const app = buildApp();

    await request(app).get("/api/ping").set("Authorization", `Bearer ${created.token}`);
    const rows = await eventsFor(created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("expired");
  });

  it("logs an unrecognised board-shaped token as outcome=bad_key with no key id", async () => {
    const app = buildApp();
    await request(app).get("/api/ping").set("Authorization", `Bearer pcp_board_${"0".repeat(48)}`);
    const rows = await eventsFor(null);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("bad_key");
    expect(rows[0].keyId).toBeNull();
  });

  it("does not log non-board bearer tokens (avoids polluting the board-key log)", async () => {
    const app = buildApp();
    await request(app).get("/api/ping").set("Authorization", `Bearer not-a-board-token-at-all`);
    const rows = await db.select().from(boardApiKeyAuthEvents);
    expect(rows).toHaveLength(0);
  });

  it("documented per-key/date-range query returns the expected rows", async () => {
    const boardAuth = boardAuthService(db);
    const created = await boardAuth.createNamedBoardApiKey({ userId: operatorUserId, name: "query-key" });
    const app = buildApp();
    await request(app).get("/api/ping").set("Authorization", `Bearer ${created.token}`);
    await boardAuth.revokeBoardApiKey(created.id);
    await request(app).get("/api/ping").set("Authorization", `Bearer ${created.token}`);

    // The query documented in the PR description: "what did key X do, from
    // where, in date range Y?" The date bounds run IN the SQL (and(gte, lte)),
    // not as a post-filter, so this test exercises the statement an
    // investigator would actually run. A seeded out-of-range row proves the
    // database, not JavaScript, applies the bounds.
    const now = Date.now();
    await db.insert(boardApiKeyAuthEvents).values({
      keyId: created.id,
      outcome: "success",
      method: "GET",
      route: "/api/ping",
      createdAt: new Date(now - 10 * 60_000),
    });
    const from = new Date(now - 60_000);
    const to = new Date(now + 60_000);
    const rows = await db
      .select({
        createdAt: boardApiKeyAuthEvents.createdAt,
        outcome: boardApiKeyAuthEvents.outcome,
        sourceIp: boardApiKeyAuthEvents.sourceIp,
        route: boardApiKeyAuthEvents.route,
      })
      .from(boardApiKeyAuthEvents)
      .where(
        and(
          eq(boardApiKeyAuthEvents.keyId, created.id),
          gte(boardApiKeyAuthEvents.createdAt, from),
          lte(boardApiKeyAuthEvents.createdAt, to),
        ),
      );
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.createdAt >= from && r.createdAt <= to)).toBe(true);
    expect(rows.map((r) => r.outcome).sort()).toEqual(["revoked", "success"]);
  });

  it("retention prunes rows past the TTL and keeps fresh ones", async () => {
    const now = Date.now();
    await db.insert(boardApiKeyAuthEvents).values([
      {
        keyId: null,
        outcome: "bad_key",
        method: "GET",
        route: "/api/ping",
        createdAt: new Date(now - (DEFAULT_BOARD_API_KEY_AUTH_EVENT_RETENTION_DAYS + 5) * 24 * 60 * 60 * 1_000),
      },
      {
        keyId: null,
        outcome: "bad_key",
        method: "GET",
        route: "/api/ping",
        createdAt: new Date(now - 60_000),
      },
    ]);

    const result = await pruneBoardApiKeyAuthEvents(db, { now: new Date(now) });
    expect(result.agePrune.deleted).toBe(1);
    const remaining = await db.select().from(boardApiKeyAuthEvents);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].createdAt.getTime()).toBeGreaterThanOrEqual(now - 60_000);
  });

  it("caps attacker-chosen fields at insert (user agent 256, route 512)", async () => {
    const boardAuth = boardAuthService(db);
    const created = await boardAuth.createNamedBoardApiKey({ userId: operatorUserId, name: "truncate-key" });
    const app = buildApp();

    const longPad = "a".repeat(600);
    const res = await request(app)
      .get(`/api/ping/${longPad}`)
      .set("Authorization", `Bearer ${created.token}`)
      .set("User-Agent", "A".repeat(8_000));
    expect(res.status).toBe(200);

    const rows = await eventsFor(created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].userAgent).toHaveLength(256);
    expect(rows[0].route!.length).toBeLessThanOrEqual(512);
    expect(rows[0].route).toContain("/api/ping/");
  });

  it("records the socket peer, not a spoofed X-Forwarded-For, when no allowlist is set", async () => {
    const boardAuth = boardAuthService(db);
    const created = await boardAuth.createNamedBoardApiKey({ userId: operatorUserId, name: "spoof-key" });
    const app = buildApp();

    const res = await request(app)
      .get("/api/ping")
      .set("Authorization", `Bearer ${created.token}`)
      .set("X-Forwarded-For", "9.9.9.9, 10.10.10.10");
    expect(res.status).toBe(200);

    const rows = await eventsFor(created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceIp).toBeTruthy();
    expect(rows[0].sourceIp).not.toContain("9.9.9.9");
    expect(rows[0].sourceIp).not.toContain("10.10.10.10");
  });

  it("derives the client hop from XFF only when the peer is an allowlisted proxy", async () => {
    const boardAuth = boardAuthService(db);
    const created = await boardAuth.createNamedBoardApiKey({ userId: operatorUserId, name: "allowlist-key" });
    // The supertest peer connects over loopback; declaring loopback allowlisted
    // is the operator statement under test.
    const app = buildApp({ trustedProxies: ["127.0.0.1", "::1", "::ffff:127.0.0.1"] });

    const res = await request(app)
      .get("/api/ping")
      .set("Authorization", `Bearer ${created.token}`)
      .set("X-Forwarded-For", "9.9.9.9, 10.10.10.10");
    expect(res.status).toBe(200);

    const rows = await eventsFor(created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceIp).toBe("10.10.10.10");
  });

  it("throttles unattributed bad_key rows to one per source per window", async () => {
    const app = buildApp();
    for (let i = 0; i < 5; i++) {
      await request(app)
        .get("/api/ping")
        .set("Authorization", `Bearer pcp_board_${"0".repeat(48)}`);
    }
    const rows = await eventsFor(null);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("bad_key");
    expect(rows[0].suppressedCount).toBe(0);
    expect(rows[0].sourceIp).toBeTruthy();
  });
});
