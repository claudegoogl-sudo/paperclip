import { sql } from "drizzle-orm";
import type { createDb } from "@paperclipai/db";

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
// Deliberately NOT retried: a tolerated-and-retried FK violation here is the same
// race with a longer fuse, not a fix.
export async function resetEmbeddedPostgresTestDatabase(
  db: ReturnType<typeof createDb>,
): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE companies RESTART IDENTITY CASCADE`);
}
