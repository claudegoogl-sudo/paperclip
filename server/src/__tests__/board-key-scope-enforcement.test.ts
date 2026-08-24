import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authUsers, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { registerActorContext } from "../middleware/auth.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { boardAuthService } from "../services/board-auth.ts";

// A board API key with scope { kind: "plugin_ops" } that tries to reach a
// board route outside its scope must get 403. The test also covers the
// positive direction (scoped key DOES reach plugin install + issue comment)
// so the allowlist's failure mode is observable, and it includes the three
// secret-egress binding routes (review, allowlist seed, enforce-flip) as
// named negative cases so that the separation-of-duties boundary regression
// is caught here, not in a separate egress-review suite.
//
// The suite drives real HTTP requests authenticated by a real, DB-backed
// board API key through the same registerActorContext chain createApp uses —
// not a hand-rolled copy — so dropping the scope middleware from
// registerActorContext makes this test red instead of letting production
// silently let scoped keys reach any route.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping board-key scope enforcement tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("board API key scope enforcement", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let pluginId!: string;
  let bindingId!: string;
  let issueId!: string;
  const operatorUserId = "operator-user-scope";

  function buildApp() {
    const app = express();
    app.use(express.json());
    // The exact registration path createApp uses. If enforceBoardKeyScope
    // is ever dropped from registerActorContext, this case's assertions go
    // red on the negative-path tests (the 403s stop firing).
    registerActorContext(app, db, { deploymentMode: "authenticated" });

    // --- Stand-in routes the test exercises. They don't do the real work;
    // each one ends in the same auth gate the production route uses, so the
    // scope middleware is the only thing that can return 403 before the
    // handler runs. ---

    // Plugin install — assertInstanceAdmin in prod.
    app.post("/api/plugins/install", (_req, res) => res.json({ ok: true, route: "install" }));

    // Plugin enable/disable/upgrade/config — assertInstanceAdmin in prod.
    app.post("/api/plugins/:pluginId/:action", (req, res) => {
      const action = req.params.action as string;
      if (!["enable", "disable", "upgrade", "config", "bridge"].includes(action)) {
        return res.status(404).json({ ok: false });
      }
      return res.json({ ok: true, route: `plugins.${action}` });
    });

    // Issue comment — the only mutation plugin_ops allows on issues.
    app.post("/api/issues/:issueId/comments", (_req, res) =>
      res.json({ ok: true, route: "issue.comment" }),
    );

    // Secret-egress binding review + allowlist seed + enforce-flip — all
    // assertBoard in prod, all reachable today by any board key. These are the
    // routes the scope taxonomy must keep a plugin_ops key off.
    app.get("/api/companies/:companyId/secret-egress-bindings", (_req, res) =>
      res.json({ ok: true, route: "egress.review" }),
    );
    app.post(
      "/api/companies/:companyId/secret-egress-bindings/:bindingId/allowlist",
      (_req, res) => res.json({ ok: true, route: "egress.allowlist" }),
    );
    app.post(
      "/api/companies/:companyId/secret-egress-bindings/:bindingId/enforce",
      (_req, res) => res.json({ ok: true, route: "egress.enforce" }),
    );

    // Instance settings — assertCanManageInstanceSettings in prod. The owner
    // user IS the instance admin, so without scope enforcement this passes.
    // That is the "credential that exists to run paperclip plugin install
    // also clears assertCanManageInstanceSettings" gap this scope work closes.
    app.patch("/api/instance/settings", (_req, res) =>
      res.json({ ok: true, route: "instance.settings" }),
    );

    // Generic catch-all so unmatched routes 404 instead of hanging.
    app.use("/api", (_req, res) => res.status(404).json({ ok: false }));

    // Same error handler shape prod uses so HttpError details (the `code`
    // field on a board_key_scope_violation 403) reach the response body —
    // without this, supertest sees `{}` and the assertion on `code` fails
    // for the wrong reason.
    app.use(errorHandler);

    return app;
  }

  async function createKey(scope: "plugin_ops" | "standard" | null) {
    return boardAuthService(db).createNamedBoardApiKey({
      userId: operatorUserId,
      name: `test-${scope ?? "null"}-${randomUUID().slice(0, 8)}`,
      scope: scope === null ? null : { kind: scope },
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-key-scope-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    companyId = randomUUID();
    pluginId = randomUUID();
    bindingId = randomUUID();
    issueId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({
      id: operatorUserId,
      name: "Operator",
      email: "operator-scope@example.com",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Scope",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  });

  afterEach(async () => {
    // Clean in dependency order: authUsers cascades to board_api_keys, so we
    // only need to clear the parent rows.
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("a plugin_ops-scoped key reaches plugin install (positive control)", async () => {
    const app = buildApp();
    const key = await createKey("plugin_ops");
    const res = await request(app)
      .post("/api/plugins/install")
      .set("authorization", `Bearer ${key.token}`)
      .send({ pluginId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ route: "install" });
  });

  it("a plugin_ops-scoped key reaches plugin enable / disable / upgrade / config", async () => {
    const app = buildApp();
    const key = await createKey("plugin_ops");
    for (const action of ["enable", "disable", "upgrade", "config"] as const) {
      const res = await request(app)
        .post(`/api/plugins/${pluginId}/${action}`)
        .set("authorization", `Bearer ${key.token}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ route: `plugins.${action}` });
    }
  });

  it("a plugin_ops-scoped key reaches issue comment", async () => {
    const app = buildApp();
    const key = await createKey("plugin_ops");
    const res = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set("authorization", `Bearer ${key.token}`)
      .send({ body: "ok" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ route: "issue.comment" });
  });

  // Three egress routes the separation-of-duties boundary is built on. A
  // plugin_ops key must 403 on all three.
  it("a plugin_ops-scoped key 403s on the three secret-egress binding routes", async () => {
    const app = buildApp();
    const key = await createKey("plugin_ops");

    const review = await request(app)
      .get(`/api/companies/${companyId}/secret-egress-bindings`)
      .set("authorization", `Bearer ${key.token}`);
    expect(review.status).toBe(403);
    expect(review.body).toMatchObject({ code: "board_key_scope_violation" });

    const allowlist = await request(app)
      .post(`/api/companies/${companyId}/secret-egress-bindings/${bindingId}/allowlist`)
      .set("authorization", `Bearer ${key.token}`)
      .send({ allowedEgress: [] });
    expect(allowlist.status).toBe(403);
    expect(allowlist.body).toMatchObject({ code: "board_key_scope_violation" });

    const enforce = await request(app)
      .post(`/api/companies/${companyId}/secret-egress-bindings/${bindingId}/enforce`)
      .set("authorization", `Bearer ${key.token}`)
      .send({ allowEmpty: false });
    expect(enforce.status).toBe(403);
    expect(enforce.body).toMatchObject({ code: "board_key_scope_violation" });
  });

  it("a plugin_ops-scoped key 403s on PATCH /api/instance/settings (the assertCanManageInstanceSettings gap)", async () => {
    const app = buildApp();
    const key = await createKey("plugin_ops");
    const res = await request(app)
      .patch("/api/instance/settings")
      .set("authorization", `Bearer ${key.token}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "board_key_scope_violation" });
  });

  // Negative control — the same routes an unscoped owner key still reaches.
  // This pins the no-behaviour-change-on-deploy requirement (AC1): existing
  // keys with NULL scope keep their full authority. If scope enforcement ever
  // becomes over-eager, this test goes red on the 200s.
  it("an unscoped board key still reaches the egress + instance-settings routes (no-behaviour-change)", async () => {
    const app = buildApp();
    const key = await createKey(null);

    const review = await request(app)
      .get(`/api/companies/${companyId}/secret-egress-bindings`)
      .set("authorization", `Bearer ${key.token}`);
    expect(review.status).toBe(200);

    const enforce = await request(app)
      .post(`/api/companies/${companyId}/secret-egress-bindings/${bindingId}/enforce`)
      .set("authorization", `Bearer ${key.token}`)
      .send({ allowEmpty: false });
    expect(enforce.status).toBe(200);

    const settings = await request(app)
      .patch("/api/instance/settings")
      .set("authorization", `Bearer ${key.token}`)
      .send({});
    expect(settings.status).toBe(200);
  });

  // AC4 server-side half: a plugin_ops key cannot mint an unscoped successor.
  // Even if the body asks for scope=standard, the middleware force-inherits the
  // acting scope. This is the second mint-site closure — a hand-rolled client
  // talking to a new server cannot escalate through a scoped credential.
  it("a plugin_ops-scoped key cannot mint an unscoped successor (force-inheritance)", async () => {
    // Use a dedicated app rather than buildApp() so the board-api-keys route
    // can be registered before the catch-all (otherwise the 404 catch-all
    // wins on registration order and the test goes red for the wrong reason).
    const app = express();
    app.use(express.json());
    registerActorContext(app, db, { deploymentMode: "authenticated" });
    app.post("/api/board-api-keys", (req, res) =>
      res.status(201).json({ ok: true, scope: req.body.scope }),
    );
    app.use(errorHandler);

    const key = await createKey("plugin_ops");

    const res = await request(app)
      .post("/api/board-api-keys")
      .set("authorization", `Bearer ${key.token}`)
      .send({ name: "successor", scope: { kind: "standard" } });

    expect(res.status).toBe(201);
    expect(res.body.scope).toEqual({ kind: "plugin_ops" });
  });
});
