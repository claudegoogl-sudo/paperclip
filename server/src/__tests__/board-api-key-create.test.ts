import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authUsers, boardApiKeys, cliAuthChallenges, companies, createDb } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { registerActorContext } from "../middleware/auth.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { accessRoutes } from "../routes/access.ts";
import {
  boardAuthService,
  createBoardApiToken,
  hashBearerToken,
} from "../services/board-auth.ts";

// POST /api/board-api-keys must reject a create request that omits
// `expiresAt` or `scope` (the inverted secure-default that produced 11 live,
// unscoped, never-expiring board keys), and a board key must not be able to
// mint a successor that outlives it or is broader in scope than it.
//
// These tests drive real HTTP requests through the SAME `accessRoutes` +
// `registerActorContext` wiring `createApp` uses (not a hand-rolled stand-in
// route and not a direct call into the zod schema), so a regression in the
// route itself -- not just the validator -- goes red here.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping board API key create tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("POST /api/board-api-keys secure defaults", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const operatorUserId = "operator-user-create";

  function buildApp() {
    const app = express();
    app.use(express.json());
    registerActorContext(app, db, { deploymentMode: "authenticated" });
    app.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "local",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use("/api", (_req, res) => res.status(404).json({ ok: false }));
    app.use(errorHandler);
    return app;
  }

  async function createKey(scope: "plugin_ops" | "standard", expiresAt: Date) {
    return boardAuthService(db).createNamedBoardApiKey({
      userId: operatorUserId,
      name: `test-${scope}-${randomUUID().slice(0, 8)}`,
      scope: { kind: scope },
      expiresAt,
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-key-create-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    const now = new Date();
    await db.insert(authUsers).values({
      id: operatorUserId,
      name: "Operator",
      email: "operator-create@example.com",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(async () => {
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // AC1/AC2/AC6: {name} alone is today's default-permissive shape. Must 4xx.
  it("rejects a create request with only {name}", async () => {
    const app = buildApp();
    const key = await createKey("standard", new Date(Date.now() + 60 * 60 * 1000));

    const res = await request(app)
      .post("/api/board-api-keys")
      .set("authorization", `Bearer ${key.token}`)
      .send({ name: "no-scope-no-expiry" });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("rejects a create request with expiresAt omitted but scope present", async () => {
    const app = buildApp();
    const key = await createKey("standard", new Date(Date.now() + 60 * 60 * 1000));

    const res = await request(app)
      .post("/api/board-api-keys")
      .set("authorization", `Bearer ${key.token}`)
      .send({ name: "no-expiry", scope: { kind: "plugin_ops" } });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("rejects a create request with scope omitted but expiresAt present", async () => {
    const app = buildApp();
    const key = await createKey("standard", new Date(Date.now() + 60 * 60 * 1000));

    const res = await request(app)
      .post("/api/board-api-keys")
      .set("authorization", `Bearer ${key.token}`)
      .send({ name: "no-scope", expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // AC6: a successful create always persists non-null scope_config AND
  // non-null expires_at.
  it("a successful create always persists non-null scope and expiresAt", async () => {
    const app = buildApp();
    const key = await createKey("standard", new Date(Date.now() + 60 * 24 * 60 * 60 * 1000));
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const res = await request(app)
      .post("/api/board-api-keys")
      .set("authorization", `Bearer ${key.token}`)
      .send({ name: "scoped-successor", scope: { kind: "plugin_ops" }, expiresAt });

    expect(res.status).toBe(201);
    expect(res.body.scope).toEqual({ kind: "plugin_ops" });
    expect(res.body.expiresAt).not.toBeNull();
  });

  // AC3: a genuine full-board key stays possible, but only with a short TTL.
  it("rejects scope: standard with a TTL longer than 24 hours", async () => {
    const app = buildApp();
    const key = await createKey("standard", new Date(Date.now() + 60 * 60 * 1000));
    const farExpiry = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

    const res = await request(app)
      .post("/api/board-api-keys")
      .set("authorization", `Bearer ${key.token}`)
      .send({ name: "eternal-owner-key", scope: { kind: "standard" }, expiresAt: farExpiry });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("accepts scope: standard with a short TTL", async () => {
    const app = buildApp();
    const key = await createKey("standard", new Date(Date.now() + 2 * 60 * 60 * 1000));
    const shortExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const res = await request(app)
      .post("/api/board-api-keys")
      .set("authorization", `Bearer ${key.token}`)
      .send({ name: "deliberate-owner-key", scope: { kind: "standard" }, expiresAt: shortExpiry });

    expect(res.status).toBe(201);
    expect(res.body.scope).toEqual({ kind: "standard" });
  });

  // AC5: privilege ceiling on expiry -- a board key cannot mint a successor
  // that outlives it, even when scope stays the same or narrows.
  it("rejects a successor with a later expiry than the minting key itself", async () => {
    const app = buildApp();
    const mintingExpiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const key = await createKey("plugin_ops", mintingExpiresAt);
    const laterExpiry = new Date(mintingExpiresAt.getTime() + 24 * 60 * 60 * 1000).toISOString();

    const res = await request(app)
      .post("/api/board-api-keys")
      .set("authorization", `Bearer ${key.token}`)
      .send({ name: "outlives-parent", scope: { kind: "plugin_ops" }, expiresAt: laterExpiry });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "board_key_privilege_ceiling" });
  });

  it("accepts a successor with an earlier expiry than the minting key itself", async () => {
    const app = buildApp();
    const mintingExpiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const key = await createKey("plugin_ops", mintingExpiresAt);
    const earlierExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const res = await request(app)
      .post("/api/board-api-keys")
      .set("authorization", `Bearer ${key.token}`)
      .send({ name: "shorter-lived-child", scope: { kind: "plugin_ops" }, expiresAt: earlierExpiry });

    expect(res.status).toBe(201);
  });

  // The second mint path: CLI auth-challenge approval. A challenge started
  // WITHOUT `requestedKeyScope` must mint a plugin_ops-scoped key, never a
  // null-scoped (full-authority) one. Red before the fail-closed default,
  // because the mint site wrote scopeConfig = NULL.
  it("CLI auth challenge approval mints a plugin_ops key when requestedKeyScope was omitted", async () => {
    const approverId = "approver-user-challenge";
    await db.insert(authUsers).values({
      id: approverId,
      name: "Approver",
      email: "approver-challenge@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const service = boardAuthService(db);

    const { challenge, challengeSecret } = await service.createCliAuthChallenge({
      command: "paperclipai connect",
      requestedAccess: "board",
    });
    // The challenge row itself is self-describing: the pending scope is the
    // narrowest scope, not null.
    expect(challenge.pendingKeyScopeConfig).toEqual({ kind: "plugin_ops" });

    const result = await service.approveCliAuthChallenge(challenge.id, challengeSecret, approverId);
    expect(result.status).toBe("approved");

    const [minted] = await db
      .select()
      .from(boardApiKeys)
      .where(eq(boardApiKeys.id, result.challenge.boardApiKeyId!));
    expect(minted.scopeConfig).toEqual({ kind: "plugin_ops" });
    expect(minted.expiresAt).not.toBeNull();
  });

  // Legacy pending rows persisted before challenge-creation normalization
  // carry pendingKeyScopeConfig = NULL. Approval must still fail closed to
  // the narrowest scope at the mint site.
  it("CLI auth challenge approval of a legacy NULL-scope pending row mints plugin_ops, not null", async () => {
    const approverId = "approver-user-legacy-challenge";
    await db.insert(authUsers).values({
      id: approverId,
      name: "Approver",
      email: "approver-legacy-challenge@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const legacySecret = "legacy-challenge-secret";
    const legacyPendingToken = createBoardApiToken();
    const [legacyRow] = await db
      .insert(cliAuthChallenges)
      .values({
        secretHash: hashBearerToken(legacySecret),
        command: "paperclipai connect",
        clientName: "legacy client",
        requestedAccess: "board",
        pendingKeyHash: hashBearerToken(legacyPendingToken),
        pendingKeyName: "legacy client (board)",
        pendingKeyScopeConfig: null,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      })
      .returning();

    const result = await boardAuthService(db).approveCliAuthChallenge(
      legacyRow.id,
      legacySecret,
      approverId,
    );
    expect(result.status).toBe("approved");

    const [minted] = await db
      .select()
      .from(boardApiKeys)
      .where(eq(boardApiKeys.id, result.challenge.boardApiKeyId!));
    expect(minted.scopeConfig).toEqual({ kind: "plugin_ops" });
    expect(minted.scopeConfig).not.toBeNull();
    expect(minted.expiresAt).not.toBeNull();
  });
});
