import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resetEmbeddedPostgresTestDatabase } from "./helpers/reset-test-database.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  HOST_MAX_CONCURRENT_RUNS_ENV_VAR,
  HOST_MAX_CONCURRENT_RUNS_MAX,
  defaultHostMaxConcurrentRuns,
  resolveHostRunCeiling,
} from "../services/host-run-ceiling.ts";

describe("host run ceiling arithmetic", () => {
  it("defaults to ceil(vCPU/2)", () => {
    expect(defaultHostMaxConcurrentRuns(8)).toBe(4);
    expect(defaultHostMaxConcurrentRuns(4)).toBe(2);
    expect(defaultHostMaxConcurrentRuns(3)).toBe(2);
  });

  it("never returns a ceiling below 1, even on a fractional or nonsensical vCPU count", () => {
    expect(defaultHostMaxConcurrentRuns(1)).toBe(1);
    expect(defaultHostMaxConcurrentRuns(0)).toBe(1);
    expect(defaultHostMaxConcurrentRuns(Number.NaN)).toBe(1);
  });

  it("clamps an absurdly large vCPU count to the max", () => {
    expect(defaultHostMaxConcurrentRuns(4096)).toBe(HOST_MAX_CONCURRENT_RUNS_MAX);
  });

  it("falls back to the vCPU default when the env var is unset or blank", () => {
    expect(resolveHostRunCeiling(undefined, 8)).toMatchObject({ value: 4, source: "default" });
    expect(resolveHostRunCeiling("   ", 8)).toMatchObject({ value: 4, source: "default" });
  });

  it("honours a valid env override and clamps it", () => {
    expect(resolveHostRunCeiling("2", 8)).toMatchObject({ value: 2, source: "env" });
    expect(resolveHostRunCeiling("999", 8)).toMatchObject({
      value: HOST_MAX_CONCURRENT_RUNS_MAX,
      source: "env",
    });
  });

  it("reports, rather than silently accepting, an unusable env value", () => {
    for (const raw of ["0", "-3", "abc", "1e-9"]) {
      expect(resolveHostRunCeiling(raw, 8)).toMatchObject({
        value: 4,
        source: "default",
        invalidEnvValue: raw,
      });
    }
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres host-run-ceiling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("host-wide concurrent-run ceiling", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-host-run-ceiling-");
    db = createDb(tempDb.connectionString);
  }, 45_000);

  afterEach(async () => {
    await resetEmbeddedPostgresTestDatabase(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function buildHeartbeat(hostCeiling: number) {
    return heartbeatService(db, {
      runtimeEnv: { [HOST_MAX_CONCURRENT_RUNS_ENV_VAR]: String(hostCeiling) },
    });
  }

  async function seedAgent(input: { maxConcurrentRuns?: number } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent${agentId.slice(0, 8)}`,
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: input.maxConcurrentRuns ?? 20 },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status: "queued" | "running";
  }) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      contextSnapshot: {},
    });
    return id;
  }

  async function statusesOf(runIds: string[]) {
    const rows = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, runIds));
    return new Map(rows.map((row) => [row.id, row.status]));
  }

  it("AC4: agents dispatching concurrently cannot collectively exceed the host ceiling", async () => {
    const hostCeiling = 2;
    const heartbeat = buildHeartbeat(hostCeiling);

    // Six agents so the admission decisions genuinely interleave. A claim's UPDATE is
    // invisible to a concurrent reader until it commits, so a DB count on its own admits
    // every agent that reads before the first commit lands; the in-flight reservation taken
    // under the admission lock is what closes that window.
    const contenders = await Promise.all(Array.from({ length: 6 }, () => seedAgent()));
    const queuedRunIds = [];
    for (const contender of contenders) {
      queuedRunIds.push(await seedRun({ ...contender, status: "queued" }));
    }

    const claimedPerAgent = await Promise.all(
      contenders.map((contender) => heartbeat.startNextQueuedRunForAgent(contender.agentId)),
    );

    // Asserted on the admission decisions themselves rather than a later DB snapshot: the
    // winners' executions are fire-and-forget and would move rows out from under a poll.
    const claimedRunIds = claimedPerAgent.flat().map((run) => run.id);
    expect(claimedRunIds).toHaveLength(hostCeiling);
    expect(new Set(claimedRunIds).size).toBe(hostCeiling);
    for (const claimedRunId of claimedRunIds) expect(queuedRunIds).toContain(claimedRunId);
  });

  it("AC2: a run refused by the ceiling stays queued, is observable, and is dispatched once a slot frees", async () => {
    const heartbeat = buildHeartbeat(1);
    const occupant = await seedAgent();
    const occupantRunId = await seedRun({ ...occupant, status: "running" });

    const waiting = await seedAgent();
    const waitingRunId = await seedRun({ ...waiting, status: "queued" });

    expect(await heartbeat.startNextQueuedRunForAgent(waiting.agentId)).toEqual([]);
    expect((await statusesOf([waitingRunId])).get(waitingRunId)).toBe("queued");

    const deferredState = await heartbeat.getHostRunCeilingState();
    expect(deferredState).toMatchObject({
      maxConcurrentRuns: 1,
      source: "env",
      hostRunningCount: 1,
      deferralCount: 1,
      inFlightReservations: 0,
    });
    expect(deferredState.deferredAgentIds).toContain(waiting.agentId);

    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, occupantRunId));

    const claimed = await heartbeat.startNextQueuedRunForAgent(waiting.agentId);
    expect(claimed.map((run) => run.id)).toEqual([waitingRunId]);
  });

  it("AC5: repeated deferred dispatch passes converge and leak no slots", async () => {
    const heartbeat = buildHeartbeat(1);
    const occupant = await seedAgent();
    await seedRun({ ...occupant, status: "running" });

    const waiting = await seedAgent();
    const waitingRunId = await seedRun({ ...waiting, status: "queued" });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await heartbeat.startNextQueuedRunForAgent(waiting.agentId)).toEqual([]);
    }

    const state = await heartbeat.getHostRunCeilingState();
    // A leaked reservation would permanently shrink the host budget across restarts of the
    // dispatch loop, which is exactly the failure this asserts against.
    expect(state.inFlightReservations).toBe(0);
    expect(state.deferralCount).toBe(3);
    expect(state.deferredAgentIds).toEqual([waiting.agentId]);
    expect((await statusesOf([waitingRunId])).get(waitingRunId)).toBe("queued");
  });

  it("AC3: a hot agent cannot monopolise the host budget while another agent has queued work", async () => {
    const heartbeat = buildHeartbeat(2);
    const hot = await seedAgent({ maxConcurrentRuns: 20 });
    const other = await seedAgent({ maxConcurrentRuns: 20 });
    for (let i = 0; i < 3; i += 1) await seedRun({ ...hot, status: "queued" });
    await seedRun({ ...other, status: "queued" });

    // Two contending agents against a ceiling of 2 means a fair share of one run each, so
    // the hot agent takes 1 of its 3 queued runs rather than the whole host budget.
    const claimed = await heartbeat.startNextQueuedRunForAgent(hot.agentId);
    expect(claimed).toHaveLength(1);

    // Still throttled by host-wide scarcity, so it must be re-offered a slot later.
    const state = await heartbeat.getHostRunCeilingState();
    expect(state.deferredAgentIds).toContain(hot.agentId);
  });

  it("AC1: the ceiling is enforced across companies, not just within one", async () => {
    const heartbeat = buildHeartbeat(1);
    const first = await seedAgent();
    const second = await seedAgent();
    expect(first.companyId).not.toBe(second.companyId);

    await seedRun({ ...first, status: "running" });
    const blockedRunId = await seedRun({ ...second, status: "queued" });

    expect(await heartbeat.startNextQueuedRunForAgent(second.agentId)).toEqual([]);
    expect((await statusesOf([blockedRunId])).get(blockedRunId)).toBe("queued");
  });
});
