import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// Regression test: heartbeat_runs / agent_wakeup_requests were
// filtered on `context_snapshot ->> 'issueId'` / `payload ->> 'issueId'` with
// no supporting index, forcing a Seq Scan that detoasted every row's (large)
// JSONB column. Migration 0142 adds expression indexes for both predicates.
// This test proves the planner actually picks the index for the exact
// predicate shape used by the ~20 run-checkout call sites, not just that the
// index exists in pg_indexes.

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat_runs / agent_wakeup_requests issueId index migration (0142)", () => {
  it(
    "creates both company-scoped issueId expression indexes",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("heartbeat-issue-idx-");
      cleanups.push(database.cleanup);

      await applyPendingMigrations(database.connectionString);

      const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      try {
        const runIdx = await sql<{ indexdef: string }[]>`
          SELECT indexdef
          FROM pg_indexes
          WHERE tablename = 'heartbeat_runs'
            AND indexname = 'heartbeat_runs_company_context_issue_idx'
        `;
        expect(runIdx).toHaveLength(1);
        expect(runIdx[0].indexdef).toContain("company_id");
        expect(runIdx[0].indexdef).toContain("context_snapshot");
        expect(runIdx[0].indexdef).toContain("issueId");

        const wakeupIdx = await sql<{ indexdef: string }[]>`
          SELECT indexdef
          FROM pg_indexes
          WHERE tablename = 'agent_wakeup_requests'
            AND indexname = 'agent_wakeup_requests_company_payload_issue_idx'
        `;
        expect(wakeupIdx).toHaveLength(1);
        expect(wakeupIdx[0].indexdef).toContain("company_id");
        expect(wakeupIdx[0].indexdef).toContain("payload");
        expect(wakeupIdx[0].indexdef).toContain("issueId");

        // Idempotency: the board may have hand-applied CREATE INDEX CONCURRENTLY
        // as an immediate mitigation on the live DB before this migration ships.
        await applyPendingMigrations(database.connectionString);
        const state = await inspectMigrations(database.connectionString);
        expect(state.status).toBe("upToDate");
      } finally {
        await sql.end();
      }
    },
    180_000,
  );

  it(
    "planner uses an Index/Bitmap Index Scan, not a Seq Scan, for the run-checkout predicate",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("heartbeat-issue-idx-plan-");
      cleanups.push(database.cleanup);

      await applyPendingMigrations(database.connectionString);

      const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      try {
        const [company] = await sql<{ id: string }[]>`
          INSERT INTO "companies" ("name") VALUES ('issueId idx test co') RETURNING id
        `;
        const [agent] = await sql<{ id: string }[]>`
          INSERT INTO "agents" ("company_id", "name") VALUES (${company.id}, 'issueId idx test agent') RETURNING id
        `;

        // Bulk-seed enough rows that the predicate is realistically selective
        // (this is what makes the planner prefer the index over a Seq Scan --
        // a handful of rows would never tip the cost estimate either way).
        await sql`
          INSERT INTO "heartbeat_runs" ("company_id", "agent_id", "status", "context_snapshot")
          SELECT ${company.id}, ${agent.id}, 'queued',
            jsonb_build_object('issueId', 'PLA-filler-' || gs, 'wakeReason', 'heartbeat_timer')
          FROM generate_series(1, 3000) AS gs
        `;
        await sql`
          INSERT INTO "agent_wakeup_requests" ("company_id", "agent_id", "source", "status", "payload")
          SELECT ${company.id}, ${agent.id}, 'heartbeat_timer', 'queued',
            jsonb_build_object('issueId', 'PLA-filler-' || gs)
          FROM generate_series(1, 3000) AS gs
        `;

        const targetIssueId = "issue-idx-target-issue";
        const [targetRun] = await sql<{ id: string }[]>`
          INSERT INTO "heartbeat_runs" ("company_id", "agent_id", "status", "context_snapshot")
          VALUES (${company.id}, ${agent.id}, 'running', jsonb_build_object('issueId', ${targetIssueId}))
          RETURNING id
        `;
        await sql`
          INSERT INTO "agent_wakeup_requests" ("company_id", "agent_id", "source", "status", "payload")
          VALUES (${company.id}, ${agent.id}, 'heartbeat_timer', 'deferred_issue_execution',
            jsonb_build_object('issueId', ${targetIssueId}))
        `;

        await sql`ANALYZE "heartbeat_runs"`;
        await sql`ANALYZE "agent_wakeup_requests"`;

        const runPlan = await sql<{ "QUERY PLAN": string }[]>`
          EXPLAIN
          SELECT id FROM "heartbeat_runs"
          WHERE "company_id" = ${company.id}
            AND "status" IN ('queued', 'running', 'scheduled_retry', 'cancelled')
            AND "context_snapshot" ->> 'issueId' = ${targetIssueId}
        `;
        const runPlanText = runPlan.map((row) => row["QUERY PLAN"]).join("\n");
        expect(runPlanText).toMatch(/Index Scan|Bitmap Index Scan/);
        expect(runPlanText).not.toMatch(/Seq Scan on heartbeat_runs/);

        const wakeupPlan = await sql<{ "QUERY PLAN": string }[]>`
          EXPLAIN
          SELECT id FROM "agent_wakeup_requests"
          WHERE "company_id" = ${company.id}
            AND "status" = 'deferred_issue_execution'
            AND "payload" ->> 'issueId' = ${targetIssueId}
        `;
        const wakeupPlanText = wakeupPlan.map((row) => row["QUERY PLAN"]).join("\n");
        expect(wakeupPlanText).toMatch(/Index Scan|Bitmap Index Scan/);
        expect(wakeupPlanText).not.toMatch(/Seq Scan on agent_wakeup_requests/);

        // Sanity: the row we're proving the plan finds is actually the seeded target.
        const [found] = await sql<{ id: string }[]>`
          SELECT id FROM "heartbeat_runs"
          WHERE "company_id" = ${company.id}
            AND "context_snapshot" ->> 'issueId' = ${targetIssueId}
        `;
        expect(found?.id).toBe(targetRun.id);
      } finally {
        await sql.end();
      }
    },
    180_000,
  );
});
