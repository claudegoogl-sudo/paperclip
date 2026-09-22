import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resetEmbeddedPostgresTestDatabase } from "./helpers/reset-test-database.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  RUN_ADMISSION_MEMORY_CGROUP_DIR_ENV_VAR,
  RUN_ADMISSION_MEMORY_PCT_ENV_VAR,
} from "../services/run-admission-memory-pressure.ts";
import { HOST_MAX_CONCURRENT_RUNS_ENV_VAR } from "../services/host-run-ceiling.ts";

// The gate test claims queued runs through the real dispatch path; mock the
// adapter so no real agent process ever spawns.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Run-admission memory-pressure gate test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run-admission memory-pressure gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const tempDirs: string[] = [];
// Restored in afterEach so a failed assertion cannot leak a silenced logger into
// the next test. Only tests that need it install the spy.
let warnSpy: MockInstance | null = null;

async function makeCgroupFixture(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-run-admission-gate-"));
  tempDirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body);
  }
  return dir;
}

describeEmbeddedPostgres("memory-pressure-aware run admission", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-admission-mem-gate-");
    db = createDb(tempDb.connectionString);
  }, 45_000);

  afterEach(async () => {
    warnSpy?.mockRestore();
    warnSpy = null;
    await resetEmbeddedPostgresTestDatabase(db);
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function buildHeartbeat(cgroupDir: string | null, memoryPct?: string) {
    return heartbeatService(db, {
      runtimeEnv: {
        [HOST_MAX_CONCURRENT_RUNS_ENV_VAR]: "8",
        ...(cgroupDir === null ? {} : { [RUN_ADMISSION_MEMORY_CGROUP_DIR_ENV_VAR]: cgroupDir }),
        ...(memoryPct === undefined ? {} : { [RUN_ADMISSION_MEMORY_PCT_ENV_VAR]: memoryPct }),
      },
    });
  }

  async function seedAgentWithQueuedRun() {
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
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 20 } },
      permissions: {},
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "queued",
      contextSnapshot: {},
    });
    return { companyId, agentId, runId };
  }

  async function statusOf(runId: string) {
    const rows = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    return rows[0]?.status ?? null;
  }

  it("AC1: dispatch defers under cgroup memory pressure through the existing deferral machinery, observably", async () => {
    // 95% of the effective soft limit (memory.high), above the 90% threshold. The
    // host ceiling is 8 with nothing running, so the ONLY thing refusing admission
    // is the new memory-pressure gate.
    const cgroupDir = await makeCgroupFixture({
      "memory.current": "9500000000\n",
      "memory.high": "10000000000\n",
      "memory.max": "12000000000\n",
      "memory.events": "low 0\nhigh 7\nmax 1\noom 0\noom_kill 0\n",
    });
    const heartbeat = buildHeartbeat(cgroupDir, "90");
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { agentId, runId } = await seedAgentWithQueuedRun();

    expect(await heartbeat.startNextQueuedRunForAgent(agentId)).toEqual([]);

    // The refused run stays queued — it was deferred, not cancelled or failed.
    expect(await statusOf(runId)).toBe("queued");

    // The ceiling-state surface distinguishes memory backoff from ceiling throttling.
    const state = await heartbeat.getHostRunCeilingState();
    expect(state).toMatchObject({
      maxConcurrentRuns: 8,
      hostRunningCount: 0,
      inFlightReservations: 0,
      deferralCount: 1,
      deferralsByMemory: 1,
      memoryPressurePct: 95,
      memoryPressureAvailable: true,
      runAdmissionMemoryPct: 90,
    });
    expect(state.deferredAgentIds).toContain(agentId);

    // One warn line with the numbers, via the existing deferral logger, so the
    // backoff is visible in logs and not only in state.
    const memoryWarns = warnSpy.mock.calls.filter(
      ([, message]) => message === "heartbeat dispatch deferred by cgroup memory pressure",
    );
    expect(memoryWarns).toHaveLength(1);
    expect(memoryWarns[0]?.[0]).toMatchObject({
      deferralReason: "memory_pressure",
      memoryPressurePct: 95,
      memoryPressureThresholdPct: 90,
      memoryCurrentBytes: 9_500_000_000,
      effectiveMemoryLimitBytes: 10_000_000_000,
      memoryEventsHigh: 7,
    });
  });

  it("a memory-deferred run dispatches once pressure falls back below the threshold", async () => {
    const cgroupDir = await makeCgroupFixture({
      "memory.current": "9500000000\n",
      "memory.high": "10000000000\n",
      "memory.max": "12000000000\n",
    });
    const pressured = buildHeartbeat(cgroupDir, "90");
    const { agentId, runId } = await seedAgentWithQueuedRun();
    expect(await pressured.startNextQueuedRunForAgent(agentId)).toEqual([]);

    // Pressure drops to 40% of the soft limit. A fresh service instance samples
    // the rewritten fixture immediately (no stale TTL cache to wait out).
    await writeFile(join(cgroupDir, "memory.current"), "4000000000\n");
    const recovered = buildHeartbeat(cgroupDir, "90");

    const claimed = await recovered.startNextQueuedRunForAgent(agentId);
    expect(claimed.map((run) => run.id)).toEqual([runId]);

    const state = await recovered.getHostRunCeilingState();
    expect(state).toMatchObject({ memoryPressurePct: 40, deferralsByMemory: 0, deferralCount: 0 });
  });

  it("AC2: absent cgroup v2 memory files are a strict no-op — dispatch proceeds unchanged", async () => {
    // A directory that exists but carries no cgroup v2 memory files: the exact
    // state on macOS, Windows, and minimal CI containers.
    const emptyDir = await makeCgroupFixture({});
    const heartbeat = buildHeartbeat(emptyDir, "90");
    const { agentId, runId } = await seedAgentWithQueuedRun();

    const claimed = await heartbeat.startNextQueuedRunForAgent(agentId);
    expect(claimed.map((run) => run.id)).toEqual([runId]);

    const state = await heartbeat.getHostRunCeilingState();
    expect(state).toMatchObject({
      memoryPressureAvailable: false,
      memoryPressurePct: null,
      deferralsByMemory: 0,
      deferralCount: 0,
    });
  });

  it("AC2: no effective limit set (both limits max) is also a no-op", async () => {
    const cgroupDir = await makeCgroupFixture({
      "memory.current": "999999999999\n",
      "memory.high": "max\n",
      "memory.max": "max\n",
    });
    const heartbeat = buildHeartbeat(cgroupDir, "90");
    const { agentId, runId } = await seedAgentWithQueuedRun();

    const claimed = await heartbeat.startNextQueuedRunForAgent(agentId);
    expect(claimed.map((run) => run.id)).toEqual([runId]);
    expect(await (await heartbeat.getHostRunCeilingState()).deferralsByMemory).toBe(0);
  });

  it("the threshold is env-tunable: a lower threshold defers at a lower pressure", async () => {
    const cgroupDir = await makeCgroupFixture({
      "memory.current": "6000000000\n",
      "memory.high": "10000000000\n",
      "memory.max": "12000000000\n",
    });
    // 60% pressure: above a 50% threshold, below the 90% default.
    const heartbeat = buildHeartbeat(cgroupDir, "50");
    const { agentId, runId } = await seedAgentWithQueuedRun();

    expect(await heartbeat.startNextQueuedRunForAgent(agentId)).toEqual([]);
    expect(await statusOf(runId)).toBe("queued");
    await expect(heartbeat.getHostRunCeilingState()).resolves.toMatchObject({
      memoryPressurePct: 60,
      runAdmissionMemoryPct: 50,
      deferralsByMemory: 1,
    });
  });
});
