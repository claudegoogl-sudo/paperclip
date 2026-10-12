/**
 * `paperclip.actor` stamping on company_secret_bindings writes, against a real
 * DB. The posture-audit trigger (migration 0239) records
 * `current_setting('paperclip.actor', true)`; these tests pin that an
 * authenticated write records `<actorType>:<actorId>`, that writes with no
 * request actor stay NULL, and that the transaction-local GUC does not leak to
 * the next transaction on the same pooled connection.
 */

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, companySecretBindings, companySecrets, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { secretRoutes } from "../routes/secrets.js";
import { errorHandler } from "../middleware/index.js";
import {
  actorProvenanceMiddleware,
  auditActorFromRequestActor,
  runWithActorProvenance,
} from "../middleware/actor-context.js";
import { secretService } from "../services/secrets.js";
import { stampSecretBindingAuditActor } from "../services/secret-binding-audit-actor.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping secret-binding audit actor tests: ${support.reason ?? "unsupported environment"}`);
}

function sessionBoardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "operator-user",
    userName: null,
    userEmail: "operator@example.com",
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "admin", status: "active" }],
  } as Express.Request["actor"];
}

describe("auditActorFromRequestActor", () => {
  it("keeps only actor type + id", () => {
    expect(auditActorFromRequestActor({ type: "board", userId: "u1" })).toBe("user:u1");
    expect(auditActorFromRequestActor({ type: "agent", agentId: "a1" })).toBe("agent:a1");
    expect(auditActorFromRequestActor({ type: "none" })).toBeNull();
    expect(auditActorFromRequestActor({ type: "board", userId: null })).toBeNull();
    expect(auditActorFromRequestActor(undefined)).toBeNull();
    const value = auditActorFromRequestActor({
      type: "board",
      userId: "u1",
      userEmail: "x@example.com",
      keyId: "k1",
    } as never);
    expect(value).toBe("user:u1");
  });
});

describeDb("secret binding posture audit actor", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-binding-audit-actor-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(prefix: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `co-${prefix}`, issuePrefix: prefix.toUpperCase() });
    const secretId = randomUUID();
    await db.insert(companySecrets).values({
      id: secretId,
      companyId,
      key: `k-${secretId.slice(0, 8)}`,
      name: `n-${secretId.slice(0, 8)}`,
    });
    return { companyId, secretId };
  }

  async function seedBinding(companyId: string, secretId: string) {
    const bindingId = randomUUID();
    await db.insert(companySecretBindings).values({
      id: bindingId,
      companyId,
      secretId,
      targetType: "agent",
      targetId: randomUUID(),
      configPath: `cfg.${bindingId.slice(0, 8)}`,
      egressAllowlistEnforced: false,
      allowedEgress: [],
    });
    return bindingId;
  }

  async function auditRows(bindingId: string) {
    const result = await db.execute(
      sql`select op, new_enforced, actor from company_secret_binding_posture_audit
          where binding_id = ${bindingId} order by changed_at, id`,
    );
    return Array.from(result as unknown as Array<{ op: string; new_enforced: boolean | null; actor: string | null }>);
  }

  it("AC1: the /enforce route records the request actor on the audit row", async () => {
    const { companyId, secretId } = await seed("aua");
    const bindingId = await seedBinding(companyId, secretId);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = sessionBoardActor(companyId);
      next();
    });
    app.use(actorProvenanceMiddleware());
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/companies/${companyId}/secret-egress-bindings/${bindingId}/enforce`)
      .send({ allowEmpty: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const rows = await auditRows(bindingId);
    // Seed insert ran with no request actor -> NULL; the flip carries the actor.
    expect(rows).toEqual([
      { op: "insert", new_enforced: false, actor: null },
      { op: "update", new_enforced: true, actor: "user:operator-user" },
    ]);
    // AC4: type + id only — no email, key id, or token.
    expect(rows[1]!.actor).not.toContain("@");
  });

  it("a binding write with no request actor (boot / migration / background) stays NULL", async () => {
    const { companyId, secretId } = await seed("aub");
    const bindingId = await seedBinding(companyId, secretId);
    await secretService(db).enforceBindingEgress({ companyId, bindingId, allowEmpty: true });
    const rows = await auditRows(bindingId);
    expect(rows.map((r) => r.actor)).toEqual([null, null]);
  });

  it("AC2: the delete+reinsert sync path stamps the actor on every row it writes", async () => {
    const { companyId, secretId } = await seed("auc");
    const targetId = randomUUID();
    const svc = secretService(db);
    await runWithActorProvenance(
      { source: "agent_jwt", keyId: null, auditActor: "agent:agent-7" },
      () =>
        svc.syncSecretRefsForTarget(companyId, { targetType: "agent", targetId }, [
          { secretId, configPath: "env.API_KEY" },
        ]),
    );
    const [binding] = await db
      .select({ id: companySecretBindings.id })
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, targetId));
    expect(binding).toBeTruthy();
    const rows = await auditRows(binding!.id);
    expect(rows).toEqual([{ op: "insert", new_enforced: true, actor: "agent:agent-7" }]);
  });

  it("AC3: the transaction-local GUC does not leak to the next transaction on one connection", async () => {
    const { companyId, secretId } = await seed("aud");
    const bindingA = randomUUID();
    const bindingB = randomUUID();
    // Pool of ONE: both transactions must run on the same physical connection.
    const single = createDb(tempDb!.connectionString, { maxConnections: 1 });
    const insertBinding = (tx: Parameters<Parameters<typeof single.transaction>[0]>[0], id: string) =>
      tx.insert(companySecretBindings).values({
        id,
        companyId,
        secretId,
        targetType: "agent",
        targetId: randomUUID(),
        configPath: `cfg.${id.slice(0, 8)}`,
      });
    const backendPid = async (tx: { execute: typeof single.execute }) => {
      const rows = Array.from((await tx.execute(sql`select pg_backend_pid() as pid`)) as unknown as Array<{ pid: number }>);
      return rows[0]!.pid;
    };
    const pids: number[] = [];
    let guc2: unknown = "unset";
    await single.transaction(async (tx) => {
      pids.push(await backendPid(tx));
      await stampSecretBindingAuditActor(tx, "user:operator-user");
      await insertBinding(tx, bindingA);
    });
    await single.transaction(async (tx) => {
      pids.push(await backendPid(tx));
      const rows = Array.from((await tx.execute(
        sql`select current_setting('paperclip.actor', true) as v`,
      )) as unknown as Array<{ v: string | null }>);
      guc2 = rows[0]!.v;
      await insertBinding(tx, bindingB);
    });
    expect(pids[0]).toBe(pids[1]);
    // Session-level value never set -> nothing to leak.
    expect(guc2 === null || guc2 === "").toBe(true);
    expect((await auditRows(bindingA)).map((r) => r.actor)).toEqual(["user:operator-user"]);
    expect((await auditRows(bindingB)).map((r) => r.actor)).toEqual([null]);
  });
});
