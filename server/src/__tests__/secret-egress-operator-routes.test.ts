/**
 * PLA-735 — operator-only egress review + per-binding enforce-flip routes,
 * against a real DB. Pins the SecurityEngineer acceptance criteria at the HTTP
 * boundary:
 *   AC1  operator-authenticated only — an agent JWT is rejected (EG1-provenance)
 *   AC2  per-binding flip only — enforcing one binding leaves siblings log-only
 *   AC3  harvested origins are UNCHECKED suggestions, never auto-applied
 *   AC5  company-scoped (BOLA) on every read/write
 */

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  companySecretBindings,
  companySecrets,
  createDb,
  egressWouldDenyObservations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { secretRoutes } from "../routes/secrets.js";
import { errorHandler } from "../middleware/index.js";
import { recordEgressWouldDeny } from "../services/egress-harvest.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping PLA-735 operator egress route tests: ${support.reason ?? "unsupported environment"}`);
}

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "operator-user",
    userName: null,
    userEmail: null,
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "admin", status: "active" }],
  } as Express.Request["actor"];
}

function agentActor(companyId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: "agent-1",
    companyId,
    runId: randomUUID(),
  } as Express.Request["actor"];
}

describeDb("PLA-735 operator egress routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-egress-op-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // activity_log FKs companies (the write routes log here), so clear it first.
    await db.delete(activityLog);
    await db.delete(egressWouldDenyObservations);
    await db.delete(companySecretBindings);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany(prefix: string): Promise<string> {
    const companyId = randomUUID();
    await db
      .insert(companies)
      .values({ id: companyId, name: `co-${prefix}`, issuePrefix: prefix.toUpperCase().slice(0, 6) })
      .onConflictDoNothing();
    return companyId;
  }

  async function seedBinding(companyId: string): Promise<string> {
    const secretId = randomUUID();
    await db.insert(companySecrets).values({
      id: secretId,
      companyId,
      key: `k-${secretId.slice(0, 8)}`,
      name: `n-${secretId.slice(0, 8)}`,
    });
    const bindingId = randomUUID();
    await db.insert(companySecretBindings).values({
      id: bindingId,
      companyId,
      secretId,
      targetType: "agent",
      targetId: `t-${bindingId.slice(0, 8)}`,
      configPath: `cfg.${bindingId.slice(0, 8)}`,
      // Migrated-to-log-only posture: enforcement off, allowlist empty.
      egressAllowlistEnforced: false,
      allowedEgress: [],
    });
    return bindingId;
  }

  it("AC1: rejects an agent JWT on read and both writes (403, EG1-provenance)", async () => {
    const companyId = await seedCompany("aaa");
    const bindingId = await seedBinding(companyId);
    const app = appFor(agentActor(companyId));

    const review = await request(app).get(`/api/companies/${companyId}/secret-egress-bindings`);
    const setList = await request(app)
      .post(`/api/companies/${companyId}/secret-egress-bindings/${bindingId}/allowlist`)
      .send({ allowedEgress: ["https://api.example.com"] });
    const enforce = await request(app)
      .post(`/api/companies/${companyId}/secret-egress-bindings/${bindingId}/enforce`)
      .send({});

    expect(review.status, JSON.stringify(review.body)).toBe(403);
    expect(setList.status, JSON.stringify(setList.body)).toBe(403);
    expect(enforce.status, JSON.stringify(enforce.body)).toBe(403);

    // And no write leaked through: still log-only with an empty allowlist.
    const row = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.id, bindingId))
      .then((rows) => rows[0]);
    expect(row.egressAllowlistEnforced).toBe(false);
    expect(row.allowedEgress).toEqual([]);
  });

  it("AC3: review returns harvested origins as separate UNCHECKED suggestions, allowlist untouched", async () => {
    const companyId = await seedCompany("bbb");
    const bindingId = await seedBinding(companyId);
    await recordEgressWouldDeny(db, { companyId, bindingIds: [bindingId], origin: "https://harvested.example" });
    await recordEgressWouldDeny(db, { companyId, bindingIds: [bindingId], origin: "https://harvested.example" });

    const res = await request(appFor(boardActor(companyId))).get(
      `/api/companies/${companyId}/secret-egress-bindings`,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const binding = res.body.bindings.find((b: { id: string }) => b.id === bindingId);
    expect(binding).toBeDefined();
    // Suggestions live in their own field and are never merged into the allowlist.
    expect(binding.allowedEgress).toEqual([]);
    expect(binding.suggestions).toHaveLength(1);
    expect(binding.suggestions[0].origin).toBe("https://harvested.example");
    expect(binding.suggestions[0].count).toBe(2);
    // Hard guarantee: nothing is pre-checked.
    expect(binding.suggestions[0].selected).toBe(false);
  });

  it("AC2: enforce flips ONE binding, leaving a sibling binding log-only", async () => {
    const companyId = await seedCompany("ccc");
    const bindingA = await seedBinding(companyId);
    const bindingB = await seedBinding(companyId);
    const app = appFor(boardActor(companyId));

    // Operator affirmatively seeds A's allowlist, then flips only A.
    const setRes = await request(app)
      .post(`/api/companies/${companyId}/secret-egress-bindings/${bindingA}/allowlist`)
      .send({ allowedEgress: ["https://api.example.com"] });
    expect(setRes.status, JSON.stringify(setRes.body)).toBe(200);

    const enforceRes = await request(app)
      .post(`/api/companies/${companyId}/secret-egress-bindings/${bindingA}/enforce`)
      .send({});
    expect(enforceRes.status, JSON.stringify(enforceRes.body)).toBe(200);

    const rows = await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId));
    const a = rows.find((r) => r.id === bindingA)!;
    const b = rows.find((r) => r.id === bindingB)!;
    expect(a.egressAllowlistEnforced).toBe(true);
    expect(a.allowedEgress).toEqual(["https://api.example.com"]);
    // The sibling is untouched — no breakage cliff.
    expect(b.egressAllowlistEnforced).toBe(false);
  });

  it("AC2: enforcing an empty allowlist is refused (409) unless allowEmpty", async () => {
    const companyId = await seedCompany("ddd");
    const bindingId = await seedBinding(companyId);
    const app = appFor(boardActor(companyId));

    const refused = await request(app)
      .post(`/api/companies/${companyId}/secret-egress-bindings/${bindingId}/enforce`)
      .send({});
    expect(refused.status).toBe(409);

    const allowed = await request(app)
      .post(`/api/companies/${companyId}/secret-egress-bindings/${bindingId}/enforce`)
      .send({ allowEmpty: true });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  });

  it("AC5: a board user cannot reach another company's binding (BOLA)", async () => {
    const companyA = await seedCompany("eee");
    const companyB = await seedCompany("fff");
    const bindingB = await seedBinding(companyB);

    // Actor only belongs to companyA. Path under companyA but binding from B:
    // assertCompanyAccess passes (path == A) yet loadOwnedBinding 404s the foreign binding.
    const appA = appFor(boardActor(companyA));
    const crossBinding = await request(appA)
      .post(`/api/companies/${companyA}/secret-egress-bindings/${bindingB}/enforce`)
      .send({ allowEmpty: true });
    expect(crossBinding.status, JSON.stringify(crossBinding.body)).toBe(404);

    // Path under companyB (which the actor does NOT belong to): assertCompanyAccess 403s.
    const crossCompany = await request(appA).get(`/api/companies/${companyB}/secret-egress-bindings`);
    expect(crossCompany.status, JSON.stringify(crossCompany.body)).toBe(403);
  });
});
