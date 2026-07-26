import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import {
  createQueryCancellationScope,
  type QueryCancellationScope,
} from "./query-cancellation.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping query cancellation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type ClosableDb = ReturnType<typeof createDb> & { $client: { end(): Promise<void> } };

/**
 * A drizzle query builder only reaches the database when it is awaited, so the
 * await has to happen inside the scope — awaiting it outside would create the
 * query outside the scope and quietly opt it out of cancellation.
 */
function runInScope<T>(scope: QueryCancellationScope, query: () => Promise<T>): Promise<T> {
  return scope.run(async () => await query());
}

/**
 * Drizzle wraps a driver failure in a `DrizzleQueryError`, so the SQLSTATE that
 * proves postgres cancelled the statement (`57014`) sits on `.cause`.
 */
async function expectCancelled(query: Promise<unknown>): Promise<void> {
  await expect(query).rejects.toMatchObject({ cause: { code: "57014" } });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

describeEmbeddedPostgres("request-scoped query cancellation", () => {
  let connectionString!: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let observer!: postgres.Sql;
  const openDbs: ClosableDb[] = [];
  const envBackup = {
    max: process.env.PAPERCLIP_DB_POOL_MAX,
    timeout: process.env.PAPERCLIP_DB_STATEMENT_TIMEOUT_MS,
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-query-cancellation-");
    connectionString = tempDb.connectionString;
    observer = postgres(connectionString, { max: 1, onnotice: () => {} });
  }, 60_000);

  afterAll(async () => {
    await observer?.end();
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await Promise.all(openDbs.splice(0).map((db) => db.$client.end()));
    process.env.PAPERCLIP_DB_POOL_MAX = envBackup.max;
    process.env.PAPERCLIP_DB_STATEMENT_TIMEOUT_MS = envBackup.timeout;
  });

  /**
   * A single-connection pool with statement_timeout disabled: any connection that
   * comes free has to come free because the query was cancelled, not because a
   * timeout expired.
   */
  function createSingleConnectionDb(): ClosableDb {
    process.env.PAPERCLIP_DB_POOL_MAX = "1";
    process.env.PAPERCLIP_DB_STATEMENT_TIMEOUT_MS = "0";
    const db = createDb(connectionString) as ClosableDb;
    openDbs.push(db);
    return db;
  }

  /** The `pg_stat_activity` evidence: backends still executing a pg_sleep. */
  async function activeSleeps(): Promise<Array<{ pid: number }>> {
    return observer<{ pid: number }[]>`
      SELECT pid
      FROM pg_stat_activity
      WHERE state = 'active'
        AND pid <> pg_backend_pid()
        AND query LIKE '%pg_sleep%'
    `;
  }

  it("cancels an in-flight query and frees its backend when the scope aborts", async () => {
    const db = createSingleConnectionDb();
    const abortController = new AbortController();
    const scope = createQueryCancellationScope(abortController.signal);

    const abandoned = runInScope(scope, () => db.execute(sql`SELECT pg_sleep(30)`));
    await waitFor(async () => (await activeSleeps()).length === 1);

    const abortedAt = Date.now();
    abortController.abort();

    await expectCancelled(abandoned);
    expect(Date.now() - abortedAt).toBeLessThan(5_000);
    expect(scope.cancelledQueryCount).toBe(1);
    await waitFor(async () => (await activeSleeps()).length === 0);
  }, 60_000);

  it("hands the freed pool connection to a query that was waiting for it", async () => {
    const db = createSingleConnectionDb();
    const abortController = new AbortController();
    const scope = createQueryCancellationScope(abortController.signal);

    const abandoned = runInScope(scope, () => db.execute(sql`SELECT pg_sleep(30)`));
    await waitFor(async () => (await activeSleeps()).length === 1);

    let waiterSettled = false;
    const waiter = db
      .execute(sql`SELECT 1 AS ok`)
      .then((rows) => {
        waiterSettled = true;
        return rows;
      });

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(waiterSettled).toBe(false);

    abortController.abort();

    await expectCancelled(abandoned);
    expect(await waiter).toMatchObject([{ ok: 1 }]);
  }, 60_000);

  it("cancels queries a handler starts after its scope already aborted", async () => {
    const db = createSingleConnectionDb();
    const abortController = new AbortController();
    const scope = createQueryCancellationScope(abortController.signal);
    abortController.abort();

    await expectCancelled(runInScope(scope, () => db.execute(sql`SELECT pg_sleep(30)`)));
    await waitFor(async () => (await activeSleeps()).length === 0);
    // The pool connection is not stranded by that cancellation.
    expect(await db.execute(sql`SELECT 1 AS ok`)).toMatchObject([{ ok: 1 }]);
  }, 60_000);

  it("leaves a query that already finished alone when the scope later aborts", async () => {
    const db = createSingleConnectionDb();
    const abortController = new AbortController();
    const scope = createQueryCancellationScope(abortController.signal);

    expect(await runInScope(scope, () => db.execute(sql`SELECT 1 AS ok`))).toMatchObject([
      { ok: 1 },
    ]);

    abortController.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(scope.cancelledQueryCount).toBe(0);
    expect(await db.execute(sql`SELECT 2 AS ok`)).toMatchObject([{ ok: 2 }]);
  }, 60_000);

  it("does not touch queries issued outside any scope", async () => {
    const db = createSingleConnectionDb();
    const abortController = new AbortController();
    createQueryCancellationScope(abortController.signal);

    const unscoped = db.execute(sql`SELECT pg_sleep(0.5), 3 AS ok`);
    abortController.abort();

    expect(await unscoped).toMatchObject([{ ok: 3 }]);
  }, 60_000);
});
