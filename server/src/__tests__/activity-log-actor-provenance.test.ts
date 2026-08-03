import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, authUsers, companies, createDb } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logActivity } from "../services/activity-log.ts";
import { actorMiddleware, registerActorContext } from "../middleware/auth.ts";
import { actorProvenanceMiddleware } from "../middleware/actor-context.ts";
import { boardAuthService } from "../services/board-auth.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping activity-log actor provenance tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// AC5. The provenance columns are only worth anything if a *real request* carries
// the acting credential's identity all the way from auth into the activity_log
// row. So this suite drives HTTP requests, authenticated by a real board API key
// or an interactive session, into a route that calls the real logActivity.
//
// The "correct" case registers its middleware through the SAME
// registerActorContext helper app.ts uses in createApp — not a hand-rolled copy
// of the chain. That is what makes the CTO's failure mode fail loudly: deleting
// the provenance registration turns this test red instead of letting production
// silently write NULL provenance forever. Two further cases break the chain
// (omit the provenance middleware; run it before actorMiddleware) to pin the
// "must run after actorMiddleware" ordering contract the helper depends on.
describeEmbeddedPostgres("activity_log actor provenance via the request middleware chain (AC5)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  const operatorUserId = "operator-user";

  type ChainOrder = "correct" | "no-provenance" | "provenance-before-actor";

  // The session user resolved when a request arrives without a bearer token, the
  // interactive-dashboard case. Board-key requests carry a bearer token and never
  // reach this resolver.
  const resolveSession = async () => ({
    session: { id: "session-1", userId: operatorUserId },
    user: { id: operatorUserId, name: "Operator", email: "operator@example.com" },
  });

  function buildApp(order: ChainOrder) {
    const app = express();
    app.use(express.json());
    if (order === "correct") {
      // The exact registration path createApp uses. If the provenance
      // registration is ever dropped from registerActorContext, this case's
      // assertions go red.
      registerActorContext(app, db, { deploymentMode: "authenticated", resolveSession });
    } else if (order === "no-provenance") {
      app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession }));
    } else {
      const actor = actorMiddleware(db, { deploymentMode: "authenticated", resolveSession });
      const provenance = actorProvenanceMiddleware();
      // Wrong order: provenance captured before actorMiddleware has populated
      // req.actor, so it binds nulls. Guards the "must run after actorMiddleware"
      // requirement documented on the middleware.
      app.use(provenance);
      app.use(actor);
    }
    app.post("/log", async (req, res) => {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: "operator",
        action: String(req.body.action),
        entityType: "company",
        entityId: companyId,
      });
      res.json({ ok: true, actorSource: req.actor?.source ?? null });
    });
    return app;
  }

  async function rowFor(action: string) {
    const rows = await db
      .select({
        action: activityLog.action,
        actorSource: activityLog.actorSource,
        actorKeyId: activityLog.actorKeyId,
      })
      .from(activityLog)
      .where(eq(activityLog.action, action));
    return rows[0] ?? null;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-provenance-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    companyId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({
      id: operatorUserId,
      name: "Operator",
      email: "operator@example.com",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("records board_key source + keyId and session source distinctly, driven through the real chain", async () => {
    const app = buildApp("correct");

    // A real, DB-backed board API key — the credential an agent would present out
    // of ~/.paperclip/auth.json. The token value never leaves this test; only its
    // key id (a UUID) is what we assert reaches the log.
    const key = await boardAuthService(db).createNamedBoardApiKey({
      userId: operatorUserId,
      name: "operator board key",
    });

    const boardRes = await request(app)
      .post("/log")
      .set("authorization", `Bearer ${key.token}`)
      .send({ action: "test.board_key_write" });
    expect(boardRes.status).toBe(200);
    expect(boardRes.body.actorSource).toBe("board_key");

    // No bearer token → resolved as an interactive dashboard session.
    const sessionRes = await request(app)
      .post("/log")
      .send({ action: "test.session_write" });
    expect(sessionRes.status).toBe(200);
    expect(sessionRes.body.actorSource).toBe("session");

    const boardRow = await rowFor("test.board_key_write");
    const sessionRow = await rowFor("test.session_write");

    // A board-key-authenticated write is now distinguishable after the fact, with
    // the credential id captured.
    expect(boardRow).toMatchObject({ actorSource: "board_key", actorKeyId: key.id });
    // An interactive dashboard click carries source but no board credential id.
    expect(sessionRow).toMatchObject({ actorSource: "session", actorKeyId: null });
    // The two credential classes differ exactly as they must.
    expect(boardRow?.actorSource).not.toBe(sessionRow?.actorSource);
  });

  it("records null provenance for background work with no request context", async () => {
    // Heartbeats, plugin workers and migrations run outside any HTTP request, so
    // there is no AsyncLocalStorage context — null/null, itself meaningful.
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "system",
      action: "test.background_write",
      entityType: "company",
      entityId: companyId,
    });

    expect(await rowFor("test.background_write")).toMatchObject({
      actorSource: null,
      actorKeyId: null,
    });
  });

  it("captures nothing when actorProvenanceMiddleware is removed from the chain (it is load-bearing)", async () => {
    // Negative control for the CTO's concern: if app.ts ever drops
    // `app.use(actorProvenanceMiddleware())`, provenance stops reaching the log
    // even for a fully-authenticated board_key request. This case makes that
    // regression fail a test instead of passing silently.
    const app = buildApp("no-provenance");
    const key = await boardAuthService(db).createNamedBoardApiKey({
      userId: operatorUserId,
      name: "operator board key",
    });

    const res = await request(app)
      .post("/log")
      .set("authorization", `Bearer ${key.token}`)
      .send({ action: "test.no_provenance_write" });
    expect(res.status).toBe(200);
    // The request WAS a board_key request…
    expect(res.body.actorSource).toBe("board_key");
    // …but with no provenance middleware, the log records nothing.
    expect(await rowFor("test.no_provenance_write")).toMatchObject({
      actorSource: null,
      actorKeyId: null,
    });
  });

  it("captures nothing when the provenance middleware runs before actorMiddleware (ordering guard)", async () => {
    const app = buildApp("provenance-before-actor");
    const key = await boardAuthService(db).createNamedBoardApiKey({
      userId: operatorUserId,
      name: "operator board key",
    });

    const res = await request(app)
      .post("/log")
      .set("authorization", `Bearer ${key.token}`)
      .send({ action: "test.misordered_write" });
    expect(res.status).toBe(200);
    expect(res.body.actorSource).toBe("board_key");
    // req.actor was not yet populated when provenance bound the ALS context.
    expect(await rowFor("test.misordered_write")).toMatchObject({
      actorSource: null,
      actorKeyId: null,
    });
  });
});
