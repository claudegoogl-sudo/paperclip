import { sql } from "drizzle-orm";
import type { createDb } from "@paperclipai/db";
import { retryOnTransientPgError } from "../../services/pg-retry.js";

// Every embedded-Postgres test table FK-chains (transitively) up to `companies`,
// so TRUNCATE ... CASCADE from that one root clears the whole per-test dataset in
// a single atomic statement. This matters when the suite under test exercises a
// production path that keeps writing in the background after the test function
// returns (e.g. a fire-and-forget `void executeRun(...)`, or a heartbeat worker
// loop) — reproduced in several test suites. An ordered per-table `db.delete(...)`
// chain races that write burst: deleting a parent table out from under a
// still-in-flight child insert trips an FK violation (23503) and fails the
// test's afterEach outright. TRUNCATE CASCADE removes that ordering race, since
// a write that lands after the truncate just hits its own FK violation inside
// the production code, which already swallows it (it's a background task, not
// the test's call stack).
//
// TRUNCATE CASCADE isn't immune to *lock* contention, though: it takes an
// ACCESS EXCLUSIVE lock across every cascaded table in one statement, and a
// concurrent background transaction that's mid-way through inserting across
// those same tables (in a different acquisition order) can deadlock against it
// (SQLSTATE 40P01) — reproduced against a suite that spawns real background
// recovery work. That's ordinary Postgres lock contention, not the FK-ordering
// race above: Postgres itself picks a victim and rolls it back, so retrying is
// guaranteed to make progress. Reuse the same bounded retry the mutation routes
// already use for this (see services/pg-retry.ts) rather than inventing a
// second copy.
export async function resetEmbeddedPostgresTestDatabase(
  db: ReturnType<typeof createDb>,
): Promise<void> {
  await retryOnTransientPgError(
    () => db.execute(sql`TRUNCATE TABLE companies RESTART IDENTITY CASCADE`),
    { label: "test_db_reset" },
  );
}
