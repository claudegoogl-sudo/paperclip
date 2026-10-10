import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resetEmbeddedPostgresTestDatabase } from "./helpers/reset-test-database.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  INSTANCE_ADMISSION_HOLD_MAX_MS,
  instanceAdmissionHoldService,
} from "../services/instance-admission-hold.ts";
import { usageLimitParkService } from "../services/usage-limit-park.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres instance admission hold tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const ACTOR = { actorType: "user", actorId: "admin-1" };

// The operator admission hold is admission-only: while held, a wake creates a
// queued run that STAYS queued (not cancelled, not skipped); running runs are
// not touched; clear or expiry lets the queued run start; nothing in the run
// lifecycle (e.g. a successful run clearing the usage-limit park) clears it.
describeEmbeddedPostgres("instance admission hold", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let hold!: ReturnType<typeof instanceAdmissionHoldService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-instance-admission-hold-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    hold = instanceAdmissionHoldService(db);
  }, 45_000);

  // Clear/expiry tests let a real claim fire a background executeRun; TRUNCATE
  // CASCADE avoids racing its writes (see usage-limit-park-admission.test.ts).
  afterEach(async () => {
    // instance_admission_holds has no FK to companies, so the TRUNCATE ...
    // CASCADE reset does not reach it; clear it explicitly so no hold leaks.
    await hold.clear(ACTOR);
    await resetEmbeddedPostgresTestDatabase(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function wake(agentId: string) {
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      reason: "manual_test_wake",
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    expect(run).not.toBeNull();
    return run!.id;
  }

  async function statusOf(runId: string) {
    return db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.status ?? null);
  }

  async function waitUntilNotQueued(runId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let status = await statusOf(runId);
    while (status === "queued" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = await statusOf(runId);
    }
    return status;
  }

  it("while held, a new wake creates a queued run that stays queued (not cancelled, not skipped)", async () => {
    await hold.set({ holdUntil: new Date(Date.now() + 10 * 60_000), reason: "drain", ...ACTOR });
    const { agentId } = await seedAgent();
    const runId = await wake(agentId);

    expect(await statusOf(runId)).toBe("queued");
    // The periodic sweep path must not start it either.
    await heartbeat.resumeQueuedRuns();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await statusOf(runId)).toBe("queued");
  });

  it("does not touch a run that is already running", async () => {
    const { companyId, agentId } = await seedAgent();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", startedAt: new Date() });

    await heartbeat.setInstanceAdmissionHold({ holdUntil: new Date(Date.now() + 10 * 60_000), reason: "drain", ...ACTOR });
    await heartbeat.resumeQueuedRuns();
    expect(await statusOf(runId)).toBe("running");
    await heartbeat.clearInstanceAdmissionHold(ACTOR);
    expect(await statusOf(runId)).toBe("running");
  });

  it("clear starts the queued run with no further action", async () => {
    await hold.set({ holdUntil: new Date(Date.now() + 10 * 60_000), reason: "drain", ...ACTOR });
    const { agentId } = await seedAgent();
    const runId = await wake(agentId);
    expect(await statusOf(runId)).toBe("queued");

    const state = await heartbeat.clearInstanceAdmissionHold(ACTOR);
    expect(state.held).toBe(false);
    expect(await waitUntilNotQueued(runId)).not.toBe("queued");
    expect(await statusOf(runId)).not.toBe("cancelled");
  });

  it("expiry starts the queued run on the next sweep with no manual clear", async () => {
    await hold.set({ holdUntil: new Date(Date.now() + 1_500), reason: "drain", ...ACTOR });
    const { agentId } = await seedAgent();
    const runId = await wake(agentId);
    expect(await statusOf(runId)).toBe("queued");

    await new Promise((resolve) => setTimeout(resolve, 1_700));
    expect(await hold.isHeld()).toBe(false);
    // What the periodic scheduler tick does.
    await heartbeat.resumeQueuedRuns();
    expect(await waitUntilNotQueued(runId)).not.toBe("queued");
  });

  it("a successful run clearing the usage-limit park does not clear the hold", async () => {
    await hold.set({ holdUntil: new Date(Date.now() + 10 * 60_000), reason: "drain", ...ACTOR });
    // The exact call heartbeat.ts makes on a successful run.
    await usageLimitParkService(db).clear({ reason: "run_succeeded" });
    expect(await hold.isHeld()).toBe(true);
  });

  it("boot with the hold set: a fresh service instance keeps queued runs waiting; the orphan reap leaves them alone", async () => {
    await hold.set({ holdUntil: new Date(Date.now() + 10 * 60_000), reason: "drain", ...ACTOR });
    const { agentId } = await seedAgent();
    const runId = await wake(agentId);

    // Simulate the restarted process: new service instance, startup reap, then
    // the startup resume path.
    const rebooted = heartbeatService(db);
    await rebooted.reapOrphanedRuns({ staleThresholdMs: 0 });
    await rebooted.resumeQueuedRuns();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await statusOf(runId)).toBe("queued");

    await rebooted.clearInstanceAdmissionHold(ACTOR);
    expect(await waitUntilNotQueued(runId)).not.toBe("queued");
  });

  it("caps holdUntil at now + 60 min and is re-runnable", async () => {
    const before = Date.now();
    const state = await hold.set({ holdUntil: new Date(before + 5 * 60 * 60_000), reason: "drain", ...ACTOR });
    expect(state.held).toBe(true);
    expect(state.holdUntil!.getTime()).toBeLessThanOrEqual(Date.now() + INSTANCE_ADMISSION_HOLD_MAX_MS);
    expect(state.holdUntil!.getTime()).toBeGreaterThanOrEqual(before + INSTANCE_ADMISSION_HOLD_MAX_MS - 1_000);

    await hold.clear(ACTOR);
    const cleared = await hold.clear(ACTOR);
    expect(cleared.held).toBe(false);
  });
});
