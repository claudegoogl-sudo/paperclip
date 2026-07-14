import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// Regression for PLA-806: a background/service plugin secret resolve carries a
// host-minted SYNTHETIC runId that is NOT a row in heartbeat_runs. Writing that
// id into activity_log.run_id violates activity_log_run_id_heartbeat_runs_id_fk
// (SQLSTATE 23503), so the best-effort audit insert is silently dropped and the
// security/compliance trail loses the who/when/why of background secret access.
//
// The host fix writes those audit rows with run_id = NULL and preserves the
// synthetic id under details.backgroundRunId (+ details.runContextKind). This
// suite proves, at the persistence layer:
//   (a) the synthetic id WOULD be dropped if written to run_id (root cause), and
//       the NULL-run + details shape persists durably and is queryable; and
//   (b) a real heartbeat_runs id still populates run_id (foreground unchanged).

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-bgrun-audit-");
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
    `Skipping embedded Postgres background-run audit tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("activity_log durable background secret-resolve audit (PLA-806)", () => {
  it(
    "a synthetic (non-heartbeat) runId in run_id raises 23503, but run_id=NULL + details.backgroundRunId persists durably",
    async () => {
      const connectionString = await createTempDatabase();
      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const [company] = await sql.unsafe<{ id: string }[]>(
          `INSERT INTO "companies" ("name") VALUES ('PLA-806 bg-audit co') RETURNING id`,
        );

        // A host-minted background runId that is NOT a heartbeat_runs row.
        const syntheticRunId = "00000000-0000-4000-8000-00000000feed";

        // Root cause: writing the synthetic id into run_id violates the FK.
        await expect(
          sql.unsafe(
            `INSERT INTO "activity_log"
               ("company_id", "actor_type", "actor_id", "action", "entity_type", "entity_id", "run_id")
             VALUES ($1, 'plugin', 'plugin-db-messenger', 'secret.resolved', 'company_secret', $2, $3)`,
            [company.id, "11111111-1111-4111-8111-111111111111", syntheticRunId],
          ),
        ).rejects.toMatchObject({ code: "23503" });

        // The fix shape: run_id = NULL, synthetic id preserved in details. This
        // insert must succeed and the row must be durably queryable.
        const [logRow] = await sql.unsafe<{ id: string }[]>(
          `INSERT INTO "activity_log"
             ("company_id", "actor_type", "actor_id", "action", "entity_type", "entity_id", "run_id", "details")
           VALUES ($1, 'plugin', 'plugin-db-messenger', 'secret.resolved', 'company_secret', $2, NULL,
                   jsonb_build_object('outcome', 'allowed', 'backgroundRunId', $3::text, 'runContextKind', 'background'))
           RETURNING id`,
          [company.id, "11111111-1111-4111-8111-111111111111", syntheticRunId],
        );

        // Extract via the jsonb ->> operator so the assertion is independent of
        // driver-side JSON parsing (and proves details is a jsonb object).
        const [survivor] = await sql.unsafe<
          {
            id: string;
            run_id: string | null;
            background_run_id: string | null;
            run_context_kind: string | null;
            outcome: string | null;
          }[]
        >(
          `SELECT id, run_id,
                  details->>'backgroundRunId' AS background_run_id,
                  details->>'runContextKind' AS run_context_kind,
                  details->>'outcome' AS outcome
             FROM "activity_log" WHERE id = $1`,
          [logRow.id],
        );

        expect(survivor).toBeDefined();
        expect(survivor.run_id).toBeNull();
        // Attribution is preserved: the synthetic id is recoverable from details.
        expect(survivor.background_run_id).toBe(syntheticRunId);
        expect(survivor.run_context_kind).toBe("background");
        expect(survivor.outcome).toBe("allowed");
      } finally {
        await sql.end();
      }
    },
    120_000,
  );

  it(
    "a real heartbeat_runs id still populates run_id (foreground dispatch unchanged)",
    async () => {
      const connectionString = await createTempDatabase();
      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const [company] = await sql.unsafe<{ id: string }[]>(
          `INSERT INTO "companies" ("name") VALUES ('PLA-806 fg-audit co') RETURNING id`,
        );
        const [agent] = await sql.unsafe<{ id: string }[]>(
          `INSERT INTO "agents" ("company_id", "name") VALUES ($1, 'PLA-806 fg agent') RETURNING id`,
          [company.id],
        );
        const [run] = await sql.unsafe<{ id: string }[]>(
          `INSERT INTO "heartbeat_runs" ("company_id", "agent_id") VALUES ($1, $2) RETURNING id`,
          [company.id, agent.id],
        );

        const [logRow] = await sql.unsafe<{ id: string }[]>(
          `INSERT INTO "activity_log"
             ("company_id", "actor_type", "actor_id", "action", "entity_type", "entity_id", "agent_id", "run_id", "details")
           VALUES ($1, 'plugin', 'plugin-db-messenger', 'secret.resolved', 'company_secret', $2, $3, $4, $5)
           RETURNING id`,
          [
            company.id,
            "11111111-1111-4111-8111-111111111111",
            agent.id,
            run.id,
            JSON.stringify({ outcome: "allowed" }),
          ],
        );

        const [row] = await sql.unsafe<
          { id: string; run_id: string | null; details: Record<string, unknown> }[]
        >(`SELECT id, run_id, details FROM "activity_log" WHERE id = $1`, [logRow.id]);

        expect(row.run_id).toBe(run.id);
        // The synthetic-run markers are absent on the foreground path.
        expect(row.details.backgroundRunId).toBeUndefined();
        expect(row.details.runContextKind).toBeUndefined();
      } finally {
        await sql.end();
      }
    },
    120_000,
  );
});
