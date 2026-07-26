import type { AddressInfo } from "node:net";
import express from "express";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { requestQueryCancellation } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping request query cancellation middleware tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

describeEmbeddedPostgres("request query cancellation middleware", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let observer!: ReturnType<typeof createDb>;
  let appDb!: ReturnType<typeof createDb>;
  let baseUrl!: string;
  let server!: ReturnType<express.Express["listen"]>;
  /** Whatever the abandoned handler's query threw, so the test can inspect it. */
  const handlerErrors: unknown[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-request-query-cancellation-");
    observer = createDb(tempDb.connectionString);

    // A single-connection pool with statement_timeout disabled: a follow-up
    // request can only get a connection because the abandoned query was
    // cancelled, not because a timeout expired.
    process.env.PAPERCLIP_DB_POOL_MAX = "1";
    process.env.PAPERCLIP_DB_STATEMENT_TIMEOUT_MS = "0";
    appDb = createDb(tempDb.connectionString);
    delete process.env.PAPERCLIP_DB_POOL_MAX;
    delete process.env.PAPERCLIP_DB_STATEMENT_TIMEOUT_MS;

    const app = express();
    app.use(requestQueryCancellation);
    const slow = async (_req: express.Request, res: express.Response) => {
      try {
        await appDb.execute(sql`SELECT pg_sleep(30)`);
      } catch (error) {
        handlerErrors.push(error);
        return;
      }
      res.json({ slept: true });
    };
    app.get("/slow", slow);
    app.post("/slow", slow);
    app.get("/quick", async (_req, res) => {
      res.json(await appDb.execute(sql`SELECT 1 AS ok`));
    });

    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await (appDb as unknown as { $client: { end(): Promise<void> } })?.$client.end();
    await (observer as unknown as { $client: { end(): Promise<void> } })?.$client.end();
    await tempDb?.cleanup();
  });

  /** The `pg_stat_activity` evidence: backends still executing a pg_sleep. */
  async function activeSleeps(): Promise<Array<{ pid: number }>> {
    return observer.execute<{ pid: number }>(sql`
      SELECT pid
      FROM pg_stat_activity
      WHERE state = 'active'
        AND pid <> pg_backend_pid()
        AND query LIKE '%pg_sleep%'
    `);
  }

  /** Sends a request and hangs up once its query is running on the server. */
  async function abandonRequest(method: "GET" | "POST"): Promise<void> {
    const abortController = new AbortController();
    const inFlight = fetch(`${baseUrl}/slow`, { method, signal: abortController.signal });
    await waitFor(async () => (await activeSleeps()).length === 1);
    abortController.abort();
    await expect(inFlight).rejects.toThrow();
  }

  it("cancels the query of a GET the client hung up on, freeing the pool connection", async () => {
    handlerErrors.length = 0;
    await abandonRequest("GET");

    const abortedAt = Date.now();
    await waitFor(async () => (await activeSleeps()).length === 0);
    expect(Date.now() - abortedAt).toBeLessThan(5_000);
    expect(handlerErrors).toHaveLength(1);
    expect(handlerErrors[0]).toMatchObject({ cause: { code: "57014" } });

    // The pool connection came back, and normal requests still work.
    const response = await fetch(`${baseUrl}/quick`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([{ ok: 1 }]);
  }, 60_000);

  it("lets an abandoned mutation finish instead of cancelling it mid-write", async () => {
    handlerErrors.length = 0;
    await abandonRequest("POST");

    // Still running a second later: the middleware left it alone. Cancelling a
    // mutation halfway through is worse than paying for the abandoned work.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const stillRunning = await activeSleeps();
    expect(stillRunning).toHaveLength(1);
    expect(handlerErrors).toHaveLength(0);

    // Nothing else would end this 30s sleep, and the single pool connection it
    // holds would hang teardown.
    await observer.execute(sql`SELECT pg_cancel_backend(${stillRunning[0].pid})`);
    await waitFor(async () => (await activeSleeps()).length === 0);
  }, 60_000);
});
