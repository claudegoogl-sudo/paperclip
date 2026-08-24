import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("activity_log search index migration (0140)", () => {
  it(
    "creates the composite index that serves per-issue last-activity lookups",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("activity-log-idx-");
      cleanups.push(database.cleanup);

      await applyPendingMigrations(database.connectionString);

      const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      try {
        const indexes = await sql<{ indexdef: string }[]>`
          SELECT indexdef
          FROM pg_indexes
          WHERE tablename = 'activity_log'
            AND indexname = 'activity_log_company_entity_created_idx'
        `;
        expect(indexes).toHaveLength(1);
        for (const column of ["company_id", "entity_type", "entity_id", "created_at"]) {
          expect(indexes[0].indexdef).toContain(column);
        }

        await applyPendingMigrations(database.connectionString);
        const state = await inspectMigrations(database.connectionString);
        expect(state.status).toBe("upToDate");
      } finally {
        await sql.end();
      }
    },
    180_000,
  );
});
