import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// Regression for PLA-644: activity_log.runId must use ON DELETE SET NULL so that
// deleting a heartbeat_runs row (e.g. admin removes an agent/company while a run is
// still completing and writing activity_log) does not raise
// "violates foreign key constraint activity_log_run_id_heartbeat_runs_id_fk" (SQLSTATE 23503).

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-activitylog-fk-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres activity_log FK tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("activity_log.run_id ON DELETE SET NULL", () => {
  it(
    "deleting a referenced heartbeat_run sets activity_log.run_id to NULL instead of raising 23503",
    async () => {
      const connectionString = await createTempDatabase();
      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        // The FK must be declared with ON DELETE SET NULL after migration 0103.
        const [fk] = await sql.unsafe<{ delete_rule: string }[]>(
          `SELECT rc.delete_rule
             FROM information_schema.referential_constraints rc
            WHERE rc.constraint_name = 'activity_log_run_id_heartbeat_runs_id_fk'`,
        );
        expect(fk?.delete_rule).toBe("SET NULL");

        const [company] = await sql.unsafe<{ id: string }[]>(
          `INSERT INTO "companies" ("name") VALUES ('PLA-644 FK test co') RETURNING id`,
        );
        const [agent] = await sql.unsafe<{ id: string }[]>(
          `INSERT INTO "agents" ("company_id", "name") VALUES ($1, 'PLA-644 FK test agent') RETURNING id`,
          [company.id],
        );
        const [run] = await sql.unsafe<{ id: string }[]>(
          `INSERT INTO "heartbeat_runs" ("company_id", "agent_id") VALUES ($1, $2) RETURNING id`,
          [company.id, agent.id],
        );
        const [logRow] = await sql.unsafe<{ id: string }[]>(
          `INSERT INTO "activity_log"
             ("company_id", "actor_type", "actor_id", "action", "entity_type", "entity_id", "run_id")
           VALUES ($1, 'agent', $2, 'heartbeat.completed', 'heartbeat_run', $3, $4)
           RETURNING id`,
          [company.id, agent.id, run.id, run.id],
        );

        // Deleting the parent run while a child activity_log row references it must NOT raise 23503.
        await expect(
          sql.unsafe(`DELETE FROM "heartbeat_runs" WHERE id = $1`, [run.id]),
        ).resolves.toBeDefined();

        // The audit row survives with run_id nulled out.
        const [survivor] = await sql.unsafe<{ id: string; run_id: string | null }[]>(
          `SELECT id, run_id FROM "activity_log" WHERE id = $1`,
          [logRow.id],
        );
        expect(survivor).toBeDefined();
        expect(survivor.run_id).toBeNull();
      } finally {
        await sql.end();
      }
    },
    120_000,
  );

  it(
    "migration 0103 is re-runnable (DROP CONSTRAINT IF EXISTS + ADD converges)",
    async () => {
      const connectionString = await createTempDatabase();
      await applyPendingMigrations(connectionString);

      const migrationSql = await readFile(
        new URL("./migrations/0125_activity_log_run_id_set_null.sql", import.meta.url),
        "utf8",
      );

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        // Re-apply the migration body a second time; the IF EXISTS drop + re-add must not error.
        for (let i = 0; i < 2; i += 1) {
          await expect(sql.unsafe(migrationSql)).resolves.toBeDefined();
        }

        const [fk] = await sql.unsafe<{ delete_rule: string }[]>(
          `SELECT rc.delete_rule
             FROM information_schema.referential_constraints rc
            WHERE rc.constraint_name = 'activity_log_run_id_heartbeat_runs_id_fk'`,
        );
        expect(fk?.delete_rule).toBe("SET NULL");
      } finally {
        await sql.end();
      }
    },
    120_000,
  );
});
