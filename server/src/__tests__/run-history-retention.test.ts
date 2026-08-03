import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  pruneAgentWakeupRequests,
  pruneHeartbeatRuns,
  pruneRunHistory,
} from "../services/run-history-retention.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping run-history retention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const ANCIENT = new Date("2026-01-01T00:00:00.000Z");
const RECENT = new Date();

describeEmbeddedPostgres("run history retention", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-retention-");
    db = createDb(tempDb.connectionString);
    const [company] = await db.insert(companies).values({ name: "Retention Co" }).returning();
    companyId = company.id;
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: "Retention Agent" })
      .returning();
    agentId = agent.id;
  }, 60_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.update(heartbeatRuns).set({ wakeupRequestId: null });
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRun(status: string, createdAt: Date, wakeupRequestId?: string) {
    const [row] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status, createdAt, wakeupRequestId })
      .returning();
    return row;
  }

  async function seedWakeup(status: string, requestedAt: Date) {
    const [row] = await db
      .insert(agentWakeupRequests)
      .values({ companyId, agentId, source: "timer", status, requestedAt })
      .returning();
    return row;
  }

  async function runIds(): Promise<string[]> {
    return (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).map((row) => row.id);
  }

  it(
    "never deletes non-terminal rows regardless of age",
    async () => {
      const ancientRunning = await seedRun("running", ANCIENT);
      const ancientQueued = await seedRun("queued", ANCIENT);
      const ancientScheduledRetry = await seedRun("scheduled_retry", ANCIENT);
      const ancientSucceeded = await seedRun("succeeded", ANCIENT);

      const ancientClaimed = await seedWakeup("claimed", ANCIENT);
      const ancientQueuedWakeup = await seedWakeup("queued", ANCIENT);
      const ancientDeferred = await seedWakeup("deferred_issue_execution", ANCIENT);
      const ancientSkipped = await seedWakeup("skipped", ANCIENT);

      const result = await pruneRunHistory(db, { retentionDays: 14 });

      expect(result.heartbeatRuns.deleted).toBe(1);
      expect(result.agentWakeupRequests.deleted).toBe(1);

      const survivingRuns = await runIds();
      expect(survivingRuns).toContain(ancientRunning.id);
      expect(survivingRuns).toContain(ancientQueued.id);
      expect(survivingRuns).toContain(ancientScheduledRetry.id);
      expect(survivingRuns).not.toContain(ancientSucceeded.id);

      const survivingWakeups = (
        await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      ).map((row) => row.id);
      expect(survivingWakeups).toContain(ancientClaimed.id);
      expect(survivingWakeups).toContain(ancientQueuedWakeup.id);
      expect(survivingWakeups).toContain(ancientDeferred.id);
      expect(survivingWakeups).not.toContain(ancientSkipped.id);
    },
    120_000,
  );

  it(
    "keeps terminal rows that are newer than the cutoff",
    async () => {
      const recent = await seedRun("succeeded", RECENT);
      const old = await seedRun("succeeded", ANCIENT);

      await pruneHeartbeatRuns(db, { retentionDays: 14 });

      const surviving = await runIds();
      expect(surviving).toEqual([recent.id]);
      expect(surviving).not.toContain(old.id);
    },
    120_000,
  );

  it(
    "cascades heartbeat_run_events with the pruned run",
    async () => {
      const old = await seedRun("failed", ANCIENT);
      await db
        .insert(heartbeatRunEvents)
        .values({ companyId, agentId, runId: old.id, seq: 1, eventType: "stdout" });

      await pruneHeartbeatRuns(db, { retentionDays: 14 });

      const remainingEvents = await db
        .select({ id: heartbeatRunEvents.id })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, old.id));
      expect(remainingEvents).toHaveLength(0);
    },
    120_000,
  );

  it(
    "skips wakeup requests a surviving run still references",
    async () => {
      const referencedWakeup = await seedWakeup("completed", ANCIENT);
      const orphanWakeup = await seedWakeup("completed", ANCIENT);
      // A live run holding an old wakeup: the wakeup must survive so the run
      // keeps its attribution.
      await seedRun("running", ANCIENT, referencedWakeup.id);

      const result = await pruneAgentWakeupRequests(db, { retentionDays: 14 });

      expect(result.deleted).toBe(1);
      const surviving = (
        await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      ).map((row) => row.id);
      expect(surviving).toEqual([referencedWakeup.id]);
      expect(surviving).not.toContain(orphanWakeup.id);
    },
    120_000,
  );

  it(
    "converges: a second prune is a no-op",
    async () => {
      for (let i = 0; i < 5; i += 1) {
        await seedRun("succeeded", ANCIENT);
        await seedWakeup("skipped", ANCIENT);
      }

      const first = await pruneRunHistory(db, { retentionDays: 14 });
      expect(first.heartbeatRuns.deleted).toBe(5);
      expect(first.agentWakeupRequests.deleted).toBe(5);

      const second = await pruneRunHistory(db, { retentionDays: 14 });
      expect(second.heartbeatRuns.deleted).toBe(0);
      expect(second.agentWakeupRequests.deleted).toBe(0);
    },
    120_000,
  );

  it(
    "respects the per-tick batch ceiling and drains the backlog over later ticks",
    async () => {
      for (let i = 0; i < 5; i += 1) {
        await seedRun("succeeded", ANCIENT);
      }

      // 2 batches x 2 rows = 4 of the 5 eligible rows this tick.
      const first = await pruneHeartbeatRuns(db, {
        retentionDays: 14,
        batchSize: 2,
        maxBatches: 2,
      });
      expect(first.deleted).toBe(4);
      expect(first.batches).toBe(2);
      expect(first.reachedBatchCeiling).toBe(true);
      expect(await runIds()).toHaveLength(1);

      const second = await pruneHeartbeatRuns(db, {
        retentionDays: 14,
        batchSize: 2,
        maxBatches: 2,
      });
      expect(second.deleted).toBe(1);
      expect(second.reachedBatchCeiling).toBe(false);
      expect(await runIds()).toHaveLength(0);
    },
    120_000,
  );

  it(
    "reclaims table size measured off-live on the embedded database",
    async () => {
      for (let i = 0; i < 200; i += 1) {
        await seedRun("succeeded", ANCIENT);
        await seedWakeup("skipped", ANCIENT);
      }

      const measure = async () => {
        const rows = await db.execute(sql`
          SELECT relname,
                 pg_total_relation_size(c.oid)::bigint AS total_bytes,
                 (SELECT count(*) FROM heartbeat_runs) AS heartbeat_runs_rows,
                 (SELECT count(*) FROM agent_wakeup_requests) AS wakeup_rows
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND relname IN ('heartbeat_runs', 'agent_wakeup_requests')
        `);
        return rows as unknown as Array<Record<string, string>>;
      };

      const before = await measure();
      const beforeRuns = Number(before[0].heartbeat_runs_rows);
      const beforeWakeups = Number(before[0].wakeup_rows);
      expect(beforeRuns).toBe(200);
      expect(beforeWakeups).toBe(200);

      const result = await pruneRunHistory(db, { retentionDays: 14, maxBatches: 100 });
      expect(result.heartbeatRuns.deleted).toBe(200);
      expect(result.agentWakeupRequests.deleted).toBe(200);

      const after = await measure();
      expect(Number(after[0].heartbeat_runs_rows)).toBe(0);
      expect(Number(after[0].wakeup_rows)).toBe(0);
    },
    180_000,
  );
});
