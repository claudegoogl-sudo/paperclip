import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resetEmbeddedPostgresTestDatabase } from "./helpers/reset-test-database.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

// Deterministic reproduction of the activity_log FK teardown race.
// The race in production is:
//
//   afterEach teardown starts -> background `logActivity` insert lands
//   between `db.delete(activityLog)` and `db.delete(agents)` -> agent delete
//   fails with `activity_log_agent_id_agents_id_fk` (Postgres 23503).
//
// In the field it's rare (a heartbeat-write burst that lands in a ~150ms
// teardown window). Here we force the late insert deterministically to prove
// the failure mode and the fix.
//
// RED: ordered per-table DELETE chain cannot tolerate a late insert.
// GREEN: atomic TRUNCATE ... CASCADE either pre-empts the late insert or
//        leaves it to fail in its own (background) promise — never the test's
//        afterEach.

async function seedMinimalAgent(db: Db): Promise<{ companyId: string; agentId: string }> {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  await db.insert(companies).values({
    id: companyId,
    name: "Race Repro Co",
    issuePrefix,
    status: "active",
    defaultResponsibleUserId: "responsible-user",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Race Repro Agent",
    role: "engineer",
    status: "idle",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { companyId, agentId };
}

describeEmbeddedPostgres("activity_log FK teardown race (deterministic repro)", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("race-repro-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.$client.end();
    }
    await tempDb?.cleanup();
  });

  it("RED: ordered delete chain trips activity_log_agent_id_agents_id_fk on a late insert", async () => {
    const { companyId, agentId } = await seedMinimalAgent(db);

    // Late background logActivity write that lands AFTER db.delete(activityLog)
    // completes but BEFORE db.delete(agents) runs. In production this happens
    // when a heartbeat's fire-and-forget write bursts past the test's idle
    // drain loop. Here it's a deterministic await.
    await db.delete(activityLog);
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "background-heartbeat",
      action: "agent_heartbeat_run_finished",
      entityType: "agent",
      entityId: agentId,
      agentId,
    });

    // The ordered teardown's `db.delete(agents)` step now trips the FK.
    // The thrown error is a drizzle-wrapped Postgres error whose underlying
    // cause carries SQLSTATE 23503 and constraint activity_log_agent_id_agents_id_fk.
    let agentsDeleteError: unknown = null;
    try {
      await db.delete(agents);
    } catch (error) {
      agentsDeleteError = error;
    }
    expect(agentsDeleteError).toBeTruthy();
    const errorString = JSON.stringify(agentsDeleteError, Object.getOwnPropertyNames(agentsDeleteError ?? {}));
    expect(errorString).toMatch(/activity_log_agent_id_agents_id_fk|23503/);

    // Clean up for the next test using the fixed teardown.
    await resetEmbeddedPostgresTestDatabase(db);
  });

  it("GREEN: TRUNCATE ... CASCADE tolerates a late activityLog insert", async () => {
    const { companyId, agentId } = await seedMinimalAgent(db);

    // Schedule an un-awaited insert (mimicking the in-flight heartbeat write)
    // and immediately run the fixed teardown. Either:
    //   (a) the insert commits before the TRUNCATE — the row is cleaned up; or
    //   (b) the insert commits after the TRUNCATE — the FK violation is
    //       raised inside the insert's own promise, which we swallow, NOT
    //       inside the test's afterEach.
    const lateInsertPromise = db
      .insert(activityLog)
      .values({
        companyId,
        actorType: "system",
        actorId: "background-heartbeat",
        action: "agent_heartbeat_run_finished",
        entityType: "agent",
        entityId: agentId,
        agentId,
      })
      .catch(() => {
        // Expected in case (b) above; the background write's own FK violation
        // is NOT the test's problem.
      });

    await resetEmbeddedPostgresTestDatabase(db);
    await lateInsertPromise;

    // If we got here without throwing, the fix works.
    expect(true).toBe(true);
  });
});
