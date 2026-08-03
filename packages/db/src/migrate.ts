import {
  applyPendingMigrations,
  assertSourceTreeMigrationAllowed,
  inspectMigrationPreflight,
  inspectMigrations,
  type MigrationPreflight,
} from "./client.js";
import { resolveMigrationConnection } from "./migration-runtime.js";

function logMigrationPreflight(preflight: MigrationPreflight): void {
  console.log(`Pending migrations: ${preflight.pending.length}`);
  for (const entry of preflight.pending) {
    console.log(`  pending ${entry.migrationFile} sha256=${entry.hash}`);
  }
  for (const entry of preflight.drift) {
    console.warn(
      `WARNING: migration identity drift for ${entry.migrationFile}: ` +
        `recorded hash ${entry.recordedHash} but current file hashes ${entry.currentHash}. ` +
        `The migration file's contents changed after it was recorded as applied.`,
    );
  }
  for (const migrationFile of preflight.unverifiable) {
    console.warn(
      `WARNING: cannot verify migration identity for ${migrationFile}: it is recorded as applied ` +
        `but this cluster has no identity binding for it, so a content swap cannot be ruled out.`,
    );
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run") || process.argv.includes("--check");
  const resolved = await resolveMigrationConnection();

  console.log(`Migrating database via ${resolved.source}`);

  try {
    const preflight = await inspectMigrationPreflight(resolved.connectionString);
    logMigrationPreflight(preflight);

    if (dryRun) {
      if (preflight.pending.length > 0) {
        console.log("Dry run: pending migrations were NOT applied.");
        process.exitCode = 1;
      } else {
        console.log("Dry run: database is up to date.");
      }
      return;
    }

    if (preflight.pending.length === 0) {
      console.log("No pending migrations");
      return;
    }

    // Guard the apply path only (dry-run above and db:status are read-only and
    // ungated): refuse to migrate an explicitly configured external cluster that
    // looks like production unless the operator has named it in the opt-in.
    await assertSourceTreeMigrationAllowed({
      mode: resolved.mode,
      connectionString: resolved.connectionString,
    });

    console.log(`Applying ${preflight.pending.length} pending migration(s)...`);
    await applyPendingMigrations(resolved.connectionString);

    const after = await inspectMigrations(resolved.connectionString);
    if (after.status !== "upToDate") {
      throw new Error(`Migrations incomplete: ${after.pendingMigrations.join(", ")}`);
    }
    console.log("Migrations complete");
  } finally {
    await resolved.stop();
  }
}

await main();
