import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeState,
  agentTaskSessions,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

// The adapter's returned prompt-bundle key. Tests mutate this between wakes to
// mirror a charter/instructions edit changing the freshly-computed bundle key.
let adapterPromptBundleKey = "bundle-A";
// The sessionParams each adapter.execute() call received on its `runtime` input.
// Index i is the i-th call's runtime.sessionParams (null when none was resumed).
const observedRuntimeSessionParams: Array<Record<string, unknown> | null> = [];

const mockAdapterExecute = vi.hoisted(() => vi.fn());

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
    `Skipping embedded Postgres system-session prompt-bundle tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function installAdapterMock() {
  mockAdapterExecute.mockReset();
  mockAdapterExecute.mockImplementation(async (input: any) => {
    observedRuntimeSessionParams.push((input?.runtime?.sessionParams ?? null) as Record<string, unknown> | null);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "System-session prompt-bundle test run.",
      provider: "test",
      model: "test-model",
      // System/heartbeat session-resume params. promptBundleKey is what the
      // claude-local adapter's resume guard compares against on the next wake.
      sessionParams: { sessionId: "sys-session-1", promptBundleKey: adapterPromptBundleKey },
    };
  });
}

async function cleanupFixture(db: ReturnType<typeof createDb>) {
  // Heartbeat finalize writes (runtime state / task session upserts, thread
  // comments) can land shortly after a run flips to succeeded. Retry the
  // truncate so a late write racing the delete doesn't fail teardown.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await db.execute(sql.raw(`
        TRUNCATE TABLE
          "issue_comments",
          "issues",
          "heartbeat_run_events",
          "cost_events",
          "activity_log",
          "heartbeat_runs",
          "agent_wakeup_requests",
          "agent_task_sessions",
          "agent_runtime_state",
          "agents",
          "companies"
        RESTART IDENTITY CASCADE
      `));
      return;
    } catch (error) {
      const isLateWriteRace =
        error instanceof Error &&
        (error.message.includes("foreign key constraint") || error.message.includes("_fk"));
      if (!isLateWriteRace || attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat system-session prompt-bundle resume params", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-sys-session-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    adapterPromptBundleKey = "bundle-A";
    observedRuntimeSessionParams.length = 0;
    runningProcesses.clear();
    // Require several consecutive idle polls: a run's status flips to succeeded
    // just before its finalize writes commit, so a single idle read is not proof
    // the finalize tail has drained.
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      const active = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!active) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await cleanupFixture(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(): Promise<{ companyId: string; agentId: string }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SystemSessionAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function waitForNoActiveRuns() {
    await waitForCondition(async () => {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      return !runs.some((run) => run.status === "queued" || run.status === "running");
    });
  }

  // Drives one system/heartbeat wake to completion. The run's status flips to
  // succeeded *before* updateRuntimeState commits the session params, so waiting
  // on run status alone races the persist. Wait until the stored params reflect
  // this wake's key, which is exactly the finalize write under test.
  async function systemWakeAndFinish(agentId: string, expectedKey: string) {
    installAdapterMock();
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual" });
    expect(run).not.toBeNull();
    await waitForCondition(async () => {
      const [row] = await db
        .select({ params: agentRuntimeState.sessionParamsJson })
        .from(agentRuntimeState)
        .where(eq(agentRuntimeState.agentId, agentId));
      return (row?.params as Record<string, unknown> | null)?.promptBundleKey === expectedKey;
    });
    await waitForNoActiveRuns();
    return run!;
  }

  it("persists a system session's resume params and feeds the stored promptBundleKey back into runtime.sessionParams on the next wake", async () => {
    const { agentId } = await seedAgent();

    // Wake #1: no session stored yet, so the adapter resumes nothing.
    await systemWakeAndFinish(agentId, "bundle-A");
    expect(observedRuntimeSessionParams[0]).toBeNull();

    // The system session's params (incl. promptBundleKey) must land on
    // agent_runtime_state — the home the system/heartbeat session never had, so
    // the adapter's resume guard finally has a stored key to compare against.
    const [runtimeAfterFirst] = await db
      .select({ params: agentRuntimeState.sessionParamsJson })
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    expect(runtimeAfterFirst?.params).toMatchObject({
      sessionId: "sys-session-1",
      promptBundleKey: "bundle-A",
    });

    // System sessions have no per-issue row; the params live only on runtime state.
    const taskSessions = await db
      .select({ id: agentTaskSessions.id })
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.agentId, agentId));
    expect(taskSessions).toHaveLength(0);

    // Wake #2 (unchanged charter): the stored promptBundleKey flows back into
    // runtime.sessionParams. The guard compares this against the fresh bundle
    // key — equal here, so the session resumes (stays true when unchanged).
    await systemWakeAndFinish(agentId, "bundle-A");
    expect(observedRuntimeSessionParams[1]).toMatchObject({
      sessionId: "sys-session-1",
      promptBundleKey: "bundle-A",
    });
  });

  it("surfaces a changed promptBundleKey on the next wake so the resume guard can bust the pinned session", async () => {
    const { agentId } = await seedAgent();

    // Wake #1 stores promptBundleKey "bundle-A".
    await systemWakeAndFinish(agentId, "bundle-A");

    // Charter/instructions edit → the freshly-computed bundle key changes. The
    // adapter now reports "bundle-B" going forward.
    adapterPromptBundleKey = "bundle-B";

    // Wake #2: the guard receives the PREVIOUSLY stored "bundle-A" on
    // runtime.sessionParams and compares it against the fresh key. They differ,
    // so hasMatchingPromptBundle → false and the pinned session is busted. This
    // is the exact input that was always empty before the fix.
    await systemWakeAndFinish(agentId, "bundle-B");
    expect(observedRuntimeSessionParams[1]).toMatchObject({ promptBundleKey: "bundle-A" });

    // After wake #2 finishes, the new key is persisted for subsequent wakes.
    const [runtimeAfterSecond] = await db
      .select({ params: agentRuntimeState.sessionParamsJson })
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    expect(runtimeAfterSecond?.params).toMatchObject({ promptBundleKey: "bundle-B" });
  });

  it("does not touch agent_runtime_state.session_params_json for per-issue runs (those persist in agent_task_sessions)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Per-issue work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    installAdapterMock();
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
    });
    expect(run).not.toBeNull();
    // The task-session upsert is the finalize write under test; wait for the row
    // rather than run status (status flips succeeded before the upsert commits).
    await waitForCondition(async () => {
      const rows = await db
        .select({ id: agentTaskSessions.id })
        .from(agentTaskSessions)
        .where(eq(agentTaskSessions.agentId, agentId));
      return rows.length > 0;
    });
    await waitForNoActiveRuns();

    // Per-issue params live in agent_task_sessions; the system-session column
    // stays untouched (null) — no behaviour change for per-issue sessions.
    const [runtime] = await db
      .select({ params: agentRuntimeState.sessionParamsJson })
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    expect(runtime?.params ?? null).toBeNull();

    const taskSessions = await db
      .select({ params: agentTaskSessions.sessionParamsJson })
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.agentId, agentId));
    expect(taskSessions).toHaveLength(1);
    expect(taskSessions[0]?.params).toMatchObject({ promptBundleKey: "bundle-A" });
  });
});
