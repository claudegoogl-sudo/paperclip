import { sql } from "drizzle-orm";
import type { createDb } from "@paperclipai/db";
import { retryOnTransientPgError } from "../../services/pg-retry.js";

// Every embedded-Postgres test table FK-chains (transitively) up to `companies`,
// so TRUNCATE ... CASCADE from that one root clears the whole per-test dataset in
// a single atomic statement. This matters when the suite under test exercises a
// production path that keeps writing in the background after the test function
// returns (e.g. a fire-and-forget `void executeRun(...)`, or a heartbeat worker
// loop) — reproduced in two separate test suites. An ordered per-table `db.delete(...)` chain
// races that write burst: deleting a parent table out from under a still-in-flight
// child insert trips an FK violation (23503) and fails the test's afterEach
// outright. TRUNCATE CASCADE has no such ordering to race — a write that lands
// after the truncate just hits its own FK violation inside the production code,
// which already swallows it (it's a background task, not the test's call stack).
//
// FK violations (23503) are still deliberately NOT retried: a tolerated-and-retried
// FK violation here is the same race with a longer fuse, not a fix.
//
// A deadlock (40P01) is a different animal and IS retried via
// retryOnTransientPgError: TRUNCATE grabs an AccessExclusiveLock on `companies`
// and every cascade table, so a background write burst that already holds a
// RowShareLock on a child table and is reaching for `companies` deadlocks
// against it. Postgres picks a victim and rolls it back whole — nothing from the
// aborted statement lands — so re-issuing the idempotent TRUNCATE once the burst
// drains is correct, not a papered-over race. retryOnTransientPgError only
// retries 40P01/40001 (never 23503), so the FK stance above is untouched.
export async function resetEmbeddedPostgresTestDatabase(
  db: ReturnType<typeof createDb>,
): Promise<void> {
  await retryOnTransientPgError(
    () => db.execute(sql`TRUNCATE TABLE companies RESTART IDENTITY CASCADE`),
    { label: "reset_test_database" },
  );
}
