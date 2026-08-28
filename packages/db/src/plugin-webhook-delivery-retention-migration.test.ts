import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// Migration 0234 makes plugin_webhook_deliveries prunable on an age + max-rows
// basis by installing partial indexes that keep the prune predicates off a
// Seq Scan. It must NOT change any schema column or constraint; only indexes.

const MIGRATION_URL = new URL(
  "./migrations/0234_plugin_webhook_deliveries_retention.sql",
  import.meta.url,
);

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createMigratedDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-webhook-retention-");
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
    `Skipping embedded Postgres plugin_webhook_deliveries retention migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("0234 partial index predicates match the retention service's allowlist", () => {
  // If these drift, the partial index predicate no longer implies the prune
  // predicate and Postgres silently falls back to a Seq Scan.
  it("declares a partial index for each prunable status", async () => {
    const migrationSql = await readFile(MIGRATION_URL, "utf8");

    // The success age-prune index.
    const successPredicate = migrationSql.match(
      /"plugin_webhook_deliveries_success_retention_idx"[^;]*WHERE "status" = 'success'/s,
    );
    expect(successPredicate, "success retention index with WHERE status = 'success' must exist").not.toBeNull();

    // The failed age-prune index.
    const failedPredicate = migrationSql.match(
      /"plugin_webhook_deliveries_failed_retention_idx"[^;]*WHERE "status" = 'failed'/s,
    );
    expect(failedPredicate, "failed retention index with WHERE status = 'failed' must exist").not.toBeNull();
  });
});

describeEmbeddedPostgres("0234 plugin webhook deliveries retention migration", () => {
  it(
    "serves every prune predicate from an index instead of a Seq Scan",
    async () => {
      const connectionString = await createMigratedDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        // Force the planner to prefer indexes even on a tiny table, so this
        // asserts the partial predicates actually match rather than asserting
        // the planner's small-table preference.
        await sql.unsafe(`SET enable_seqscan = off`);

        const successPlan = (
          await sql.unsafe<{ "QUERY PLAN": string }[]>(
            `EXPLAIN SELECT id FROM plugin_webhook_deliveries
              WHERE status = 'success'
                AND created_at < now() - interval '3 days'
              ORDER BY created_at LIMIT 1000`,
          )
        )
          .map((row) => row["QUERY PLAN"])
          .join("\n");
        expect(successPlan).toContain("plugin_webhook_deliveries_success_retention_idx");

        const failedPlan = (
          await sql.unsafe<{ "QUERY PLAN": string }[]>(
            `EXPLAIN SELECT id FROM plugin_webhook_deliveries
              WHERE status = 'failed'
                AND created_at < now() - interval '30 days'
              ORDER BY created_at LIMIT 1000`,
          )
        )
          .map((row) => row["QUERY PLAN"])
          .join("\n");
        expect(failedPlan).toContain("plugin_webhook_deliveries_failed_retention_idx");

        // Size prune reads success rows that are still WITHIN their age window
        // (so the age prune did not delete them) but must be evicted to fit
        // under the cap. The same partial index serves this because the
        // predicate is on (status, created_at) regardless of operator.
        const sizeSuccessPlan = (
          await sql.unsafe<{ "QUERY PLAN": string }[]>(
            `EXPLAIN SELECT id FROM plugin_webhook_deliveries
              WHERE status = 'success'
                AND created_at >= now() - interval '3 days'
              ORDER BY created_at LIMIT 1000`,
          )
        )
          .map((row) => row["QUERY PLAN"])
          .join("\n");
        expect(sizeSuccessPlan).toContain("plugin_webhook_deliveries_success_retention_idx");

        const sizeFailedPlan = (
          await sql.unsafe<{ "QUERY PLAN": string }[]>(
            `EXPLAIN SELECT id FROM plugin_webhook_deliveries
              WHERE status = 'failed'
                AND created_at >= now() - interval '30 days'
              ORDER BY created_at LIMIT 1000`,
          )
        )
          .map((row) => row["QUERY PLAN"])
          .join("\n");
        expect(sizeFailedPlan).toContain("plugin_webhook_deliveries_failed_retention_idx");
      } finally {
        await sql.end();
      }
    },
    180_000,
  );

  it(
    "is re-runnable (CREATE INDEX IF NOT EXISTS converges)",
    async () => {
      const connectionString = await createMigratedDatabase();
      const migrationSql = await readFile(MIGRATION_URL, "utf8");

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        for (let i = 0; i < 2; i += 1) {
          await expect(sql.unsafe(migrationSql)).resolves.toBeDefined();
        }
        const indexes = await sql.unsafe<{ indexname: string }[]>(
          `SELECT indexname FROM pg_indexes
            WHERE schemaname = 'public'
              AND indexname IN (
                'plugin_webhook_deliveries_success_retention_idx',
                'plugin_webhook_deliveries_failed_retention_idx'
              )`,
        );
        expect(indexes).toHaveLength(2);
      } finally {
        await sql.end();
      }
    },
    180_000,
  );
});
