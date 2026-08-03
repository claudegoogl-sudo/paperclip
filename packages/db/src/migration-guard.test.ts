import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  applyPendingMigrations,
  assertSourceTreeMigrationAllowed,
  inspectMigrationPreflight,
  inspectMigrations,
} from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";
import { ensurePostgresDatabase } from "./client.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const DRIFT_TARGET = "0030_rich_magneto.sql";

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-mig-guard-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function migrationHash(migrationFile: string): Promise<string> {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${migrationFile}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  delete process.env.PAPERCLIP_ALLOW_PROD_MIGRATE;
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres migration-guard tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("migration identity drift", () => {
  it(
    "warns when a recorded migration name has a different content hash than the file on disk",
    async () => {
      const connectionString = await createTempDatabase();
      await applyPendingMigrations(connectionString);

      // Fully migrated: nothing pending, nothing drifting.
      const clean = await inspectMigrationPreflight(connectionString);
      expect(clean.pending).toEqual([]);
      expect(clean.drift).toEqual([]);

      const realHash = await migrationHash(DRIFT_TARGET);
      const bogusHash = "0".repeat(64);
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        // Simulate an out-of-band content swap: the row for DRIFT_TARGET now
        // records a hash that no file on disk matches.
        await sql.unsafe(
          `UPDATE "drizzle"."__drizzle_migrations" SET hash = '${bogusHash}' WHERE hash = '${realHash}'`,
        );
      } finally {
        await sql.end();
      }

      const preflight = await inspectMigrationPreflight(connectionString);
      expect(preflight.pending.map((entry) => entry.migrationFile)).toContain(DRIFT_TARGET);
      expect(preflight.drift).toEqual([
        { migrationFile: DRIFT_TARGET, recordedHash: bogusHash, currentHash: realHash },
      ]);
    },
    40_000,
  );

  it(
    "stays silent for a legitimately missing migration row (no false drift on deletion)",
    async () => {
      const connectionString = await createTempDatabase();
      await applyPendingMigrations(connectionString);

      const realHash = await migrationHash(DRIFT_TARGET);
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        // Delete the row and drop its table so the migration is genuinely
        // pending again. Its content still matches the file, so this must NOT be
        // reported as identity drift even though ordinals shift.
        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${realHash}'`,
        );
        await sql.unsafe(`DROP TABLE "company_logos"`);
      } finally {
        await sql.end();
      }

      const preflight = await inspectMigrationPreflight(connectionString);
      expect(preflight.pending.map((entry) => entry.migrationFile)).toEqual([DRIFT_TARGET]);
      expect(preflight.drift).toEqual([]);
    },
    40_000,
  );

  it(
    "records a durable audit row for migrations applied via the pending path",
    async () => {
      const connectionString = await createTempDatabase();
      await applyPendingMigrations(connectionString);

      const realHash = await migrationHash(DRIFT_TARGET);
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${realHash}'`,
        );
        await sql.unsafe(`DROP TABLE "company_logos"`);
      } finally {
        await sql.end();
      }

      await applyPendingMigrations(connectionString);
      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await verifySql.unsafe<
          {
            binary_version: string;
            migration_count: number;
            migrations: Array<{ file: string; hash: string }>;
          }[]
        >(
          `SELECT binary_version, migration_count, migrations
             FROM "drizzle"."migration_apply_audit"
             ORDER BY id DESC LIMIT 1`,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.migration_count).toBe(1);
        expect(rows[0]?.binary_version.length).toBeGreaterThan(0);
        expect(rows[0]?.migrations).toEqual([{ file: DRIFT_TARGET, hash: realHash }]);
      } finally {
        await verifySql.end();
      }
    },
    40_000,
  );
});

describeEmbeddedPostgres("source-tree production-cluster guard", () => {
  it(
    "allows an empty database and refuses a populated one unless opted in",
    async () => {
      // The harness returns a fully migrated `paperclip` database. Create a
      // second, genuinely empty database on the same cluster for the
      // empty-cluster assertion.
      const populated = await createTempDatabase();
      const adminUrl = populated.replace(/\/paperclip$/, "/postgres");
      const emptyDbName = "guard_empty_db";
      await ensurePostgresDatabase(adminUrl, emptyDbName);
      const emptyUrl = populated.replace(/\/paperclip$/, `/${emptyDbName}`);

      // Empty database (no application tables): allowed.
      await expect(assertSourceTreeMigrationAllowed(emptyUrl)).resolves.toBeUndefined();

      // Populated database: refused, fails closed.
      await expect(assertSourceTreeMigrationAllowed(populated)).rejects.toThrow(
        /populated database/i,
      );

      // Explicit opt-in: proceeds even against the populated database.
      process.env.PAPERCLIP_ALLOW_PROD_MIGRATE = "1";
      await expect(assertSourceTreeMigrationAllowed(populated)).resolves.toBeUndefined();
    },
    40_000,
  );
});
