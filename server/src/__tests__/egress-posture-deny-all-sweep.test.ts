/**
 * A binding born enforcing with an empty allowlist is deny-all for that secret,
 * and before this change nothing surfaced it — the first symptom would have been
 * a denied call in production.
 *
 * These cases pin the two halves of the fix:
 *   - the derived `posture` on the operator review payload names the state, so a
 *     surface does not have to re-derive it from `enforced` + `allowedEgress`;
 *   - the sweep writes a `secret.egress_posture_deny_all` event to `activity_log`
 *     (rendered by the existing company Activity screen) for every binding in
 *     that state, whatever path put it there.
 *
 * The `enforceBindingEgress` empty-allowlist guard is deliberately NOT touched;
 * the last case pins that it still refuses, per the CTO adjudication.
 */

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  companySecretBindings,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { secretRoutes } from "../routes/secrets.js";
import { errorHandler } from "../middleware/index.js";
import {
  EGRESS_POSTURE_DENY_ALL_ACTION,
  egressPostureFor,
  sweepDenyAllEgressBindings,
} from "../services/egress-posture.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping egress posture sweep tests: ${support.reason ?? "unsupported environment"}`);
}

describe("egressPostureFor", () => {
  it("names deny-all separately from enforcing", () => {
    expect(egressPostureFor({ egressAllowlistEnforced: false, allowedEgress: [] })).toBe("log_only");
    expect(egressPostureFor({ egressAllowlistEnforced: false, allowedEgress: ["https://a.example"] }))
      .toBe("log_only");
    expect(egressPostureFor({ egressAllowlistEnforced: true, allowedEgress: [] })).toBe("deny_all");
    expect(egressPostureFor({ egressAllowlistEnforced: true, allowedEgress: ["https://a.example"] }))
      .toBe("enforcing");
  });
});

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

describeDb("deny-all egress posture is surfaced to an operator", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pla2121-sweep-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companySecretBindings);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix: string): Promise<string> {
    const companyId = randomUUID();
    await db
      .insert(companies)
      .values({ id: companyId, name: `co-${prefix}`, issuePrefix: prefix.toUpperCase().slice(0, 6) })
      .onConflictDoNothing();
    return companyId;
  }

  /** Inserts a binding with NO posture columns set, so it is born from the column DEFAULT. */
  async function seedBornEnforcingBinding(companyId: string): Promise<string> {
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
    });
    return bindingId;
  }

  async function denyAllEvents(bindingId: string) {
    return db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.action, EGRESS_POSTURE_DENY_ALL_ACTION),
          eq(activityLog.entityId, bindingId),
        ),
      );
  }

  it("announces a binding born enforcing with an empty allowlist", async () => {
    const companyId = await seedCompany("aaa");
    const bindingId = await seedBornEnforcingBinding(companyId);

    const result = await sweepDenyAllEgressBindings(db);

    expect(result).toEqual({ scanned: 1, announced: 1 });
    const events = await denyAllEvents(bindingId);
    expect(events).toHaveLength(1);
    expect(events[0]?.entityType).toBe("secret_binding");
    expect(events[0]?.companyId).toBe(companyId);
    expect(events[0]?.details?.posture).toBe("deny_all");
  });

  it("does not re-announce a standing deny-all state on every sweep", async () => {
    const companyId = await seedCompany("bbb");
    const bindingId = await seedBornEnforcingBinding(companyId);

    await sweepDenyAllEgressBindings(db);
    const second = await sweepDenyAllEgressBindings(db);

    expect(second).toEqual({ scanned: 1, announced: 0 });
    expect(await denyAllEvents(bindingId)).toHaveLength(1);
  });

  it("does not re-announce for a non-posture edit such as a rename", async () => {
    const companyId = await seedCompany("ccc");
    const bindingId = await seedBornEnforcingBinding(companyId);
    await sweepDenyAllEgressBindings(db);

    await db
      .update(companySecretBindings)
      .set({ label: "renamed", updatedAt: new Date(Date.now() + 60_000) })
      .where(eq(companySecretBindings.id, bindingId));

    expect(await sweepDenyAllEgressBindings(db)).toEqual({ scanned: 1, announced: 0 });
    expect(await denyAllEvents(bindingId)).toHaveLength(1);
  });

  it("re-announces after a posture change that never bumps updated_at", async () => {
    // The regression this pins: dedup used to key on `updatedAt`, but the write
    // that motivated this change -- `UPDATE company_secret_bindings SET
    // egress_allowlist_enforced = false` at the tail of migration 0138 -- does not
    // touch `updated_at`. A binding leaving and re-entering deny-all by that class
    // of write would stay silent forever after its first announcement.
    const companyId = await seedCompany("ggg");
    const bindingId = await seedBornEnforcingBinding(companyId);
    await sweepDenyAllEgressBindings(db);
    expect(await denyAllEvents(bindingId)).toHaveLength(1);

    const before = await db
      .select({ updatedAt: companySecretBindings.updatedAt })
      .from(companySecretBindings)
      .where(eq(companySecretBindings.id, bindingId))
      .then((rows) => rows[0]!.updatedAt);

    // Raw SQL, no application involvement, no `updated_at` bump: out of deny-all
    // and straight back into it.
    await db.execute(
      sql`UPDATE company_secret_bindings SET allowed_egress = ARRAY['https://api.example.com']
          WHERE id = ${bindingId}`,
    );
    await db.execute(
      sql`UPDATE company_secret_bindings SET allowed_egress = '{}' WHERE id = ${bindingId}`,
    );

    const after = await db
      .select({ updatedAt: companySecretBindings.updatedAt })
      .from(companySecretBindings)
      .where(eq(companySecretBindings.id, bindingId))
      .then((rows) => rows[0]!.updatedAt);
    expect(after.getTime()).toBe(before.getTime());

    expect(await sweepDenyAllEgressBindings(db)).toEqual({ scanned: 1, announced: 1 });
    expect(await denyAllEvents(bindingId)).toHaveLength(2);
  });

  it("ignores bindings that are log-only or enforcing with a non-empty allowlist", async () => {
    const companyId = await seedCompany("ddd");
    const logOnly = await seedBornEnforcingBinding(companyId);
    const enforcing = await seedBornEnforcingBinding(companyId);
    await db
      .update(companySecretBindings)
      .set({ egressAllowlistEnforced: false })
      .where(eq(companySecretBindings.id, logOnly));
    await db
      .update(companySecretBindings)
      .set({ allowedEgress: ["https://api.example.com"] })
      .where(eq(companySecretBindings.id, enforcing));

    expect(await sweepDenyAllEgressBindings(db)).toEqual({ scanned: 0, announced: 0 });
    expect(await denyAllEvents(logOnly)).toHaveLength(0);
    expect(await denyAllEvents(enforcing)).toHaveLength(0);
  });

  it("returns the derived posture on the operator review payload", async () => {
    const companyId = await seedCompany("eee");
    await seedBornEnforcingBinding(companyId);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = boardActor(companyId);
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);

    const res = await request(app).get(`/api/companies/${companyId}/secret-egress-bindings`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.bindings).toHaveLength(1);
    expect(res.body.bindings[0].posture).toBe("deny_all");
    expect(res.body.bindings[0].egressAllowlistEnforced).toBe(true);
    expect(res.body.bindings[0].allowedEgress).toEqual([]);
  });

  it("leaves the enforceBindingEgress empty-allowlist guard refusing (CTO adjudication)", async () => {
    const companyId = await seedCompany("fff");
    const bindingId = await seedBornEnforcingBinding(companyId);
    await db
      .update(companySecretBindings)
      .set({ egressAllowlistEnforced: false })
      .where(eq(companySecretBindings.id, bindingId));

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = boardActor(companyId);
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/companies/${companyId}/secret-egress-bindings/${bindingId}/enforce`)
      .send({});

    expect(res.status).toBe(409);
    const row = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.id, bindingId))
      .then((rows) => rows[0]);
    expect(row.egressAllowlistEnforced).toBe(false);
  });
});
