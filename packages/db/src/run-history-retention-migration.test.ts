import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  TERMINAL_HEARTBEAT_RUN_STATUSES,
  TERMINAL_WAKEUP_REQUEST_STATUSES,
} from "@paperclipai/shared";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// Migration 0143 makes terminal run history prunable. It must (a) relax the
// blocking FKs so a terminal run can actually be deleted, (b) leave the
// agent_wakeup_requests FK strict so a bad prune fails loudly, and (c) install
// partial indexes that keep the prune predicate off a Seq Scan.

const MIGRATION_URL = new URL("./migrations/0230_run_history_retention.sql", import.meta.url);

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createMigratedDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-run-retention-");
  cleanups.push(db.cleanup);
  await applyPendingMigrations(db.connectionString);
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
    `Skipping embedded Postgres run-history retention migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("0143 status lists match the shared terminal-status constants", () => {
  // If these drift, the partial index predicate no longer implies the prune
  // predicate and Postgres silently falls back to a Seq Scan.
  it("keeps the SQL index predicates in sync with the shared constants", async () => {
    const migrationSql = await readFile(MIGRATION_URL, "utf8");

    const runStatuses = migrationSql
      .match(/"heartbeat_runs_retention_idx".*?WHERE "status" IN \(([^)]*)\)/s)?.[1]
      ?.split(",")
      .map((value) => value.trim().replaceAll("'", ""));
    expect(runStatuses).toEqual([...TERMINAL_HEARTBEAT_RUN_STATUSES]);

    const wakeupStatuses = migrationSql
      .match(/"agent_wakeup_requests_retention_idx".*?WHERE "status" IN \(([^)]*)\)/s)?.[1]
      ?.split(",")
      .map((value) => value.trim().replaceAll("'", ""));
    expect(wakeupStatuses).toEqual([...TERMINAL_WAKEUP_REQUEST_STATUSES]);
  });
});

describeEmbeddedPostgres("0143 run history retention migration", () => {
  it(
    "relaxes the blocking foreign keys and keeps the wakeup FK strict",
    async () => {
      const connectionString = await createMigratedDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const rules = await sql.unsafe<{ constraint_name: string; delete_rule: string }[]>(
          `SELECT constraint_name, delete_rule
             FROM information_schema.referential_constraints
            WHERE constraint_name IN (
              'heartbeat_run_events_run_id_heartbeat_runs_id_fk',
              'cost_events_heartbeat_run_id_heartbeat_runs_id_fk',
              'finance_events_heartbeat_run_id_heartbeat_runs_id_fk',
              'agent_task_sessions_last_run_id_heartbeat_runs_id_fk',
              'heartbeat_runs_wakeup_request_id_agent_wakeup_requests_id_fk')`,
        );
        const byName = Object.fromEntries(rules.map((row) => [row.constraint_name, row.delete_rule]));

        expect(byName["heartbeat_run_events_run_id_heartbeat_runs_id_fk"]).toBe("CASCADE");
        expect(byName["cost_events_heartbeat_run_id_heartbeat_runs_id_fk"]).toBe("SET NULL");
        expect(byName["finance_events_heartbeat_run_id_heartbeat_runs_id_fk"]).toBe("SET NULL");
        expect(byName["agent_task_sessions_last_run_id_heartbeat_runs_id_fk"]).toBe("SET NULL");
        // Deliberately strict: the prune's anti-join is what protects live rows.
        expect(byName["heartbeat_runs_wakeup_request_id_agent_wakeup_requests_id_fk"]).toBe(
          "NO ACTION",
        );
      } finally {
        await sql.end();
      }
    },
    180_000,
  );

  it(
    "deleting a terminal run cascades its events and preserves financial rows",
    async () => {
      const connectionString = await createMigratedDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const [company] = await sql.unsafe<{ id: string }[]>(
          `INSERT INTO "companies" ("name") VALUES ('retention co') RETURNING id`,
        );
        const [agent] = await sql.unsafe<{ id: string }[]>(
          `INSERT INTO "agents" ("company_id", "name") VALUES ($1, 'retention agent') RETURNING id`,
          [company.id],
        );
        const [run] = await sql.unsafe<{ id: string }[]>(
          `INSERT INTO "heartbeat_runs" ("company_id", "agent_id", "status")
           VALUES ($1, $2, 'succeeded') RETURNING id`,
          [company.id, agent.id],
        );
        await sql.unsafe(
          `INSERT INTO "heartbeat_run_events" ("company_id", "run_id", "agent_id", "seq", "event_type")
           VALUES ($1, $2, $3, 1, 'stdout')`,
          [company.id, run.id, agent.id],
        );
        const [cost] = await sql.unsafe<{ id: string }[]>(
          `INSERT INTO "cost_events"
             ("company_id", "agent_id", "heartbeat_run_id", "provider", "model", "cost_cents", "occurred_at")
           VALUES ($1, $2, $3, 'anthropic', 'claude', 1234, now()) RETURNING id`,
          [company.id, agent.id, run.id],
        );
        const [session] = await sql.unsafe<{ id: string }[]>(
          `INSERT INTO "agent_task_sessions"
             ("company_id", "agent_id", "adapter_type", "task_key", "last_run_id")
           VALUES ($1, $2, 'claude_code', 'task-1', $3) RETURNING id`,
          [company.id, agent.id, run.id],
        );

        await expect(
          sql.unsafe(`DELETE FROM "heartbeat_runs" WHERE id = $1`, [run.id]),
        ).resolves.toBeDefined();

        // Per-run detail goes with the run.
        const events = await sql.unsafe(
          `SELECT 1 FROM "heartbeat_run_events" WHERE run_id = $1`,
          [run.id],
        );
        expect(events).toHaveLength(0);

        // Money and session rows survive, losing only the run back-reference.
        const [survivingCost] = await sql.unsafe<{ heartbeat_run_id: string | null }[]>(
          `SELECT heartbeat_run_id FROM "cost_events" WHERE id = $1`,
          [cost.id],
        );
        expect(survivingCost).toBeDefined();
        expect(survivingCost.heartbeat_run_id).toBeNull();

        const [survivingSession] = await sql.unsafe<{ last_run_id: string | null }[]>(
          `SELECT last_run_id FROM "agent_task_sessions" WHERE id = $1`,
          [session.id],
        );
        expect(survivingSession).toBeDefined();
        expect(survivingSession.last_run_id).toBeNull();
      } finally {
        await sql.end();
      }
    },
    180_000,
  );

  it(
    "serves both prune predicates from an index instead of a Seq Scan",
    async () => {
      const connectionString = await createMigratedDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        // Force the planner to prefer indexes even on a tiny table, so this
        // asserts the partial predicates actually match rather than asserting
        // the planner's small-table preference.
        await sql.unsafe(`SET enable_seqscan = off`);

        const runPlan = (
          await sql.unsafe<{ "QUERY PLAN": string }[]>(
            `EXPLAIN SELECT id FROM heartbeat_runs
              WHERE status IN ('succeeded', 'succeeded_dirty', 'failed', 'cancelled', 'timed_out')
                AND created_at < now() - interval '14 days'
              ORDER BY created_at LIMIT 1000`,
          )
        )
          .map((row) => row["QUERY PLAN"])
          .join("\n");
        expect(runPlan).toContain("heartbeat_runs_retention_idx");

        const wakeupPlan = (
          await sql.unsafe<{ "QUERY PLAN": string }[]>(
            `EXPLAIN SELECT id FROM agent_wakeup_requests
              WHERE status IN ('coalesced', 'skipped', 'completed', 'failed', 'cancelled')
                AND requested_at < now() - interval '14 days'
              ORDER BY requested_at LIMIT 1000`,
          )
        )
          .map((row) => row["QUERY PLAN"])
          .join("\n");
        expect(wakeupPlan).toContain("agent_wakeup_requests_retention_idx");
      } finally {
        await sql.end();
      }
    },
    180_000,
  );

  it(
    "is re-runnable (IF NOT EXISTS + DROP CONSTRAINT IF EXISTS converges)",
    async () => {
      const connectionString = await createMigratedDatabase();
      const migrationSql = await readFile(MIGRATION_URL, "utf8");

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        for (let i = 0; i < 2; i += 1) {
          await expect(sql.unsafe(migrationSql)).resolves.toBeDefined();
        }
        const [fk] = await sql.unsafe<{ delete_rule: string }[]>(
          `SELECT delete_rule FROM information_schema.referential_constraints
            WHERE constraint_name = 'heartbeat_run_events_run_id_heartbeat_runs_id_fk'`,
        );
        expect(fk?.delete_rule).toBe("CASCADE");
      } finally {
        await sql.end();
      }
    },
    180_000,
  );
});
