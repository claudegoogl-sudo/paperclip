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

// The migration whose contents we pretend were swapped out from under an
// unchanged version. `company_logos` is created here, so dropping that table
// makes the migration pending again.
const DRIFT_TARGET = "0030_rich_magneto.sql";
// An *earlier* applied migration whose journal row we scrub to shift ordinals.
// This is the exact attack that defeated the old ordinal-based detector; the
// identity-table detector must survive it.
const EARLIER_MIGRATION = "0020_white_anita_blake.sql";
const BOGUS_HASH = "0".repeat(64);

// The most recently applied migration. A rebuilt package swaps the newest file
// most often, and it is the one position where a live `count(*)` of journal rows
// cannot classify a pending file as previously-applied — its own row is the one
// that went missing.
async function latestMigrationFile(): Promise<string> {
  const journal = JSON.parse(
    await fs.promises.readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const latest = [...journal.entries].sort((left, right) => left.idx - right.idx).at(-1);
  if (!latest) throw new Error("migration journal is empty");
  return `${latest.tag}.sql`;
}

// A cluster that predates identity tracking entirely: production's shape, and
// the state every existing deployment is in on the first boot after this ships.
async function dropIdentityTracking(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`DROP TABLE "drizzle"."migration_file_identity"`);
  await sql.unsafe(`DROP TABLE "drizzle"."migration_identity_watermark"`);
}

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

async function withSql<T>(
  connectionString: string,
  fn: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
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
    "reports drift when a pending file's recorded identity hash differs from disk",
    async () => {
      const connectionString = await createTempDatabase();

      // Fully migrated by the harness: nothing pending, nothing drifting.
      const clean = await inspectMigrationPreflight(connectionString);
      expect(clean.pending).toEqual([]);
      expect(clean.drift).toEqual([]);
      expect(clean.unverifiable).toEqual([]);

      const realHash = await migrationHash(DRIFT_TARGET);
      await withSql(connectionString, async (sql) => {
        // Model an out-of-band content swap: the identity recorded when the file
        // was first applied no longer matches the file now on disk.
        await sql.unsafe(
          `UPDATE "drizzle"."migration_file_identity" SET hash = $1 WHERE name = $2`,
          [BOGUS_HASH, DRIFT_TARGET],
        );
        // Scrub the journal row and drop the table so the migration is pending
        // again and the runner would re-apply it.
        await sql.unsafe(`DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = $1`, [
          realHash,
        ]);
        await sql.unsafe(`DROP TABLE "company_logos"`);
      });

      const preflight = await inspectMigrationPreflight(connectionString);
      expect(preflight.pending.map((entry) => entry.migrationFile)).toContain(DRIFT_TARGET);
      expect(preflight.drift).toEqual([
        { migrationFile: DRIFT_TARGET, recordedHash: BOGUS_HASH, currentHash: realHash },
      ]);
      expect(preflight.unverifiable).toEqual([]);
    },
    40_000,
  );

  it(
    "still detects drift after an earlier journal row is scrubbed (ordinal-shift attack)",
    async () => {
      // This is the incident regression: the old ordinal-based detector could be
      // defeated by deleting an *earlier* __drizzle_migrations row, which shifted
      // ordinals so the swapped file looked like an orphan and its drift was
      // swallowed. The identity table is an exact per-name lookup, so scrubbing
      // any number of journal rows cannot hide the swap.
      const connectionString = await createTempDatabase();

      const driftHash = await migrationHash(DRIFT_TARGET);
      const earlierHash = await migrationHash(EARLIER_MIGRATION);
      await withSql(connectionString, async (sql) => {
        await sql.unsafe(
          `UPDATE "drizzle"."migration_file_identity" SET hash = $1 WHERE name = $2`,
          [BOGUS_HASH, DRIFT_TARGET],
        );
        // Make the swapped migration pending again.
        await sql.unsafe(`DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = $1`, [
          driftHash,
        ]);
        await sql.unsafe(`DROP TABLE "company_logos"`);
        // Scrub an earlier journal row to shift ordinals — the attack that hid
        // the swap under the old detector.
        await sql.unsafe(`DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = $1`, [
          earlierHash,
        ]);
      });

      const preflight = await inspectMigrationPreflight(connectionString);
      const driftFiles = preflight.drift.map((entry) => entry.migrationFile);
      // The swapped file is still reported as drift despite the shifted ordinals.
      expect(driftFiles).toContain(DRIFT_TARGET);
      expect(preflight.drift).toEqual([
        { migrationFile: DRIFT_TARGET, recordedHash: BOGUS_HASH, currentHash: driftHash },
      ]);
      // The scrubbed earlier migration's content still matches its recorded
      // identity, so it is not misreported as drift.
      expect(driftFiles).not.toContain(EARLIER_MIGRATION);
      expect(preflight.unverifiable).toEqual([]);
    },
    40_000,
  );

  it(
    "stays silent for a legitimately missing migration row (no false drift on deletion)",
    async () => {
      const connectionString = await createTempDatabase();

      const realHash = await migrationHash(DRIFT_TARGET);
      await withSql(connectionString, async (sql) => {
        // Delete the row and drop its table so the migration is genuinely
        // pending again. Its content still matches the recorded identity, so this
        // must NOT be reported as identity drift, nor as unverifiable.
        await sql.unsafe(`DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = $1`, [
          realHash,
        ]);
        await sql.unsafe(`DROP TABLE "company_logos"`);
      });

      const preflight = await inspectMigrationPreflight(connectionString);
      expect(preflight.pending.map((entry) => entry.migrationFile)).toEqual([DRIFT_TARGET]);
      expect(preflight.drift).toEqual([]);
      expect(preflight.unverifiable).toEqual([]);
    },
    40_000,
  );

  it(
    "reports unverifiable when a pending file has no recorded identity",
    async () => {
      const connectionString = await createTempDatabase();

      const realHash = await migrationHash(DRIFT_TARGET);
      await withSql(connectionString, async (sql) => {
        // Simulate a cluster that predates identity tracking: the file was
        // applied (journal + table) but no identity was ever bound. Removing the
        // identity row while leaving the journal untouched, then dropping the
        // table so the file is pending, models exactly that undecidable state.
        await sql.unsafe(`DELETE FROM "drizzle"."migration_file_identity" WHERE name = $1`, [
          DRIFT_TARGET,
        ]);
        await sql.unsafe(`DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = $1`, [
          realHash,
        ]);
        await sql.unsafe(`DROP TABLE "company_logos"`);
      });

      const preflight = await inspectMigrationPreflight(connectionString);
      expect(preflight.pending.map((entry) => entry.migrationFile)).toEqual([DRIFT_TARGET]);
      // Cannot rule out a swap, but cannot confirm one either: neither clean nor
      // drift, but explicitly undecidable.
      expect(preflight.drift).toEqual([]);
      expect(preflight.unverifiable).toEqual([DRIFT_TARGET]);
    },
    40_000,
  );

  it(
    "reports unverifiable on a cluster with no identity table at all",
    async () => {
      const connectionString = await createTempDatabase();

      const realHash = await migrationHash(DRIFT_TARGET);
      await withSql(connectionString, async (sql) => {
        await dropIdentityTracking(sql);
        await sql.unsafe(`DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = $1`, [
          realHash,
        ]);
        await sql.unsafe(`DROP TABLE "company_logos"`);
      });

      const preflight = await inspectMigrationPreflight(connectionString);
      expect(preflight.pending.map((entry) => entry.migrationFile)).toEqual([DRIFT_TARGET]);
      expect(preflight.drift).toEqual([]);
      expect(preflight.unverifiable).toEqual([DRIFT_TARGET]);
    },
    40_000,
  );

  it(
    "reports unverifiable for the most recently applied file with no identity table",
    async () => {
      // The blind spot a live journal `count(*)` leaves: this file is pending
      // *because* its own journal row is gone, so its ordinal always equals the
      // remaining row count and never falls inside it. Reported clean before the
      // frozen watermark, on exactly the cluster shape production is in.
      const connectionString = await createTempDatabase();

      const latestFile = await latestMigrationFile();
      const latestHash = await migrationHash(latestFile);
      await withSql(connectionString, async (sql) => {
        await dropIdentityTracking(sql);
        await sql.unsafe(`DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = $1`, [
          latestHash,
        ]);
      });

      const preflight = await inspectMigrationPreflight(connectionString);
      expect(preflight.pending.map((entry) => entry.migrationFile)).toEqual([latestFile]);
      expect(preflight.drift).toEqual([]);
      expect(preflight.unverifiable).toEqual([latestFile]);
    },
    40_000,
  );

  it(
    "reports unverifiable for the most recently applied file when its identity is scrubbed",
    async () => {
      // Same tail blind spot with identity tracking present: deleting both the
      // identity row and the journal row leaves nothing to compare against, and
      // the frozen watermark is what still places the file inside the applied
      // range after its journal row is gone.
      const connectionString = await createTempDatabase();

      const latestFile = await latestMigrationFile();
      const latestHash = await migrationHash(latestFile);
      await withSql(connectionString, async (sql) => {
        await sql.unsafe(`DELETE FROM "drizzle"."migration_file_identity" WHERE name = $1`, [
          latestFile,
        ]);
        await sql.unsafe(`DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = $1`, [
          latestHash,
        ]);
      });

      const preflight = await inspectMigrationPreflight(connectionString);
      expect(preflight.pending.map((entry) => entry.migrationFile)).toEqual([latestFile]);
      expect(preflight.drift).toEqual([]);
      expect(preflight.unverifiable).toEqual([latestFile]);
    },
    40_000,
  );

  it(
    "records a durable audit row for migrations applied via the pending path",
    async () => {
      const connectionString = await createTempDatabase();

      const realHash = await migrationHash(DRIFT_TARGET);
      await withSql(connectionString, async (sql) => {
        await sql.unsafe(`DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = $1`, [
          realHash,
        ]);
        await sql.unsafe(`DROP TABLE "company_logos"`);
      });

      await applyPendingMigrations(connectionString);
      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      await withSql(connectionString, async (verifySql) => {
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
      });
    },
    40_000,
  );
});

describeEmbeddedPostgres("source-tree production-cluster guard", () => {
  it(
    "never guards the embedded dev cluster, even when populated",
    async () => {
      const populated = await createTempDatabase();
      // The embedded cluster is the ordinary dev loop: routine `pnpm db:migrate`
      // must never trip the guard regardless of how many tables it holds.
      await expect(
        assertSourceTreeMigrationAllowed({
          mode: "embedded-postgres",
          connectionString: populated,
        }),
      ).resolves.toBeUndefined();
    },
    40_000,
  );

  it(
    "refuses an explicit external cluster that is populated unless opted in by name",
    async () => {
      const populated = await createTempDatabase();
      const adminUrl = populated.replace(/\/paperclip$/, "/postgres");
      const emptyDbName = "guard_empty_db";
      await ensurePostgresDatabase(adminUrl, emptyDbName);
      const emptyUrl = populated.replace(/\/paperclip$/, `/${emptyDbName}`);

      // Empty external database (no application tables): allowed.
      await expect(
        assertSourceTreeMigrationAllowed({ mode: "postgres", connectionString: emptyUrl }),
      ).resolves.toBeUndefined();

      // Populated external database: refused, fails closed.
      await expect(
        assertSourceTreeMigrationAllowed({ mode: "postgres", connectionString: populated }),
      ).rejects.toThrow(/production cluster/i);

      // A bare truthy opt-in does not authorise: it must name the exact database.
      process.env.PAPERCLIP_ALLOW_PROD_MIGRATE = "1";
      await expect(
        assertSourceTreeMigrationAllowed({ mode: "postgres", connectionString: populated }),
      ).rejects.toThrow(/production cluster/i);

      // An opt-in naming a *different* database does not authorise this one.
      process.env.PAPERCLIP_ALLOW_PROD_MIGRATE = emptyDbName;
      await expect(
        assertSourceTreeMigrationAllowed({ mode: "postgres", connectionString: populated }),
      ).rejects.toThrow(/production cluster/i);

      // Opt-in naming this exact database: proceeds.
      process.env.PAPERCLIP_ALLOW_PROD_MIGRATE = "paperclip";
      await expect(
        assertSourceTreeMigrationAllowed({ mode: "postgres", connectionString: populated }),
      ).resolves.toBeUndefined();
    },
    40_000,
  );
});
