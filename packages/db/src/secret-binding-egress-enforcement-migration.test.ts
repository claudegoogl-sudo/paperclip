import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// Regression test for migration identity drift.
//
// The runner identifies a migration by sha256 over the WHOLE file, comments
// included, and dedupes on that hash alone. A comment-only rewrite of an
// already-released migration therefore gives it a new identity and re-applies
// it against databases that already ran it. 0138 ended in an unconditional
// `UPDATE company_secret_bindings SET egress_allowlist_enforced = false`, so
// the re-apply silently turned egress allowlist enforcement OFF for every
// binding in every company -- including bindings that were born enforcing.
// This happened on the production database: four bindings lost enforcement.
//
// These tests pin both halves of the contract: re-applying 0138 must not touch
// an existing enforcement flag, and a genuine first install must still perform
// the log-only rollout flip.

const MIGRATION_URL = new URL(
  "./migrations/0138_secret_binding_egress_allowlist.sql",
  import.meta.url,
);

/**
 * Mirrors the runner's splitter (`splitMigrationStatements` in client.ts):
 * it splits on the drizzle statement breakpoint only, never on `;`, which is
 * what makes a `DO $$ ... $$;` block safe inside a migration.
 */
function splitMigrationStatements(content: string): string[] {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function reapplyMigration0138(sql: postgres.Sql): Promise<void> {
  const content = await readFile(MIGRATION_URL, "utf8");
  for (const statement of splitMigrationStatements(content)) {
    await sql.unsafe(statement);
  }
}

async function seedBinding(
  sql: postgres.Sql,
  label: string,
): Promise<{ companyId: string; secretId: string; bindingId: string }> {
  const [company] = await sql<{ id: string }[]>`
    INSERT INTO companies (name)
    VALUES (${`egress-${label}`})
    RETURNING id
  `;
  const [secret] = await sql<{ id: string }[]>`
    INSERT INTO company_secrets (company_id, key, name)
    VALUES (${company.id}, ${`KEY_${label}`}, ${`secret-${label}`})
    RETURNING id
  `;
  const [binding] = await sql<{ id: string }[]>`
    INSERT INTO company_secret_bindings (company_id, secret_id, target_type, target_id, config_path)
    VALUES (${company.id}, ${secret.id}, 'plugin', ${`plugin-${label}`}, ${`path.${label}`})
    RETURNING id
  `;
  return { companyId: company.id, secretId: secret.id, bindingId: binding.id };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("secret binding egress enforcement migration (0138) converges", () => {
  it(
    "re-applying 0138 leaves an enforcing binding enforcing",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("egress-enforce-converge-");
      cleanups.push(database.cleanup);
      await applyPendingMigrations(database.connectionString);

      const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      try {
        // Born enforcing: the column DEFAULT is true and no insert path names
        // the column, which is exactly how the four production bindings that
        // lost enforcement came to be enforcing.
        const { bindingId } = await seedBinding(sql, "converge");
        const [before] = await sql<{ egress_allowlist_enforced: boolean }[]>`
          SELECT egress_allowlist_enforced FROM company_secret_bindings WHERE id = ${bindingId}
        `;
        expect(before.egress_allowlist_enforced).toBe(true);

        // Simulate the hash-drift re-run: the runner replays this file's
        // statements against a database that already ran it.
        await reapplyMigration0138(sql);

        const [after] = await sql<{ egress_allowlist_enforced: boolean }[]>`
          SELECT egress_allowlist_enforced FROM company_secret_bindings WHERE id = ${bindingId}
        `;
        expect(after.egress_allowlist_enforced).toBe(true);
      } finally {
        await sql.end();
      }
    },
    180_000,
  );

  it(
    "still performs the log-only rollout flip when it actually adds the column",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("egress-enforce-rollout-");
      cleanups.push(database.cleanup);
      await applyPendingMigrations(database.connectionString);

      const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      try {
        // Recreate the pre-0138 shape so the migration takes its first-install
        // branch: the column must be absent BEFORE the rows exist, otherwise
        // this test would not exercise the rollout path at all.
        await sql.unsafe(
          `ALTER TABLE "company_secret_bindings" DROP COLUMN "egress_allowlist_enforced", DROP COLUMN "allowed_egress"`,
        );
        const { bindingId } = await seedBinding(sql, "rollout");

        await reapplyMigration0138(sql);

        const [row] = await sql<{ egress_allowlist_enforced: boolean; allowed_egress: string[] }[]>`
          SELECT egress_allowlist_enforced, allowed_egress
          FROM company_secret_bindings WHERE id = ${bindingId}
        `;
        // Pre-existing rows go log-only so the rollout does not instantly break
        // live bindings -- the whole point of the migration.
        expect(row.egress_allowlist_enforced).toBe(false);
        expect(row.allowed_egress).toEqual([]);
      } finally {
        await sql.end();
      }
    },
    180_000,
  );
});
