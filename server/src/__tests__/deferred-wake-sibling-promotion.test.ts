import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { recoveryService } from "../services/recovery/service.ts";
import { runningProcesses } from "../adapters/index.ts";

// The promotion paths kick the promoted agent's queue, which dispatches through
// the server adapter; mock it so no real process spawns in tests.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Deferred-wake sibling promotion test run.",
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
    `Skipping deferred-wake sibling promotion tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("deferred issue-execution wake promotion", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let recovery!: ReturnType<typeof recoveryService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deferred-wake-promotion-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    recovery = recoveryService(db, { enqueueWakeup: async () => null });
  }, 30_000);

  afterEach(async () => {
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const runIds = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .then((runs) => runs.map((run) => run.id));
    await Promise.all(runIds.map((runId) => heartbeat.waitForRunExecutionDrain(runId)));
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Deferred-wake sibling promotion test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The dispatch/execute paths write many dependent rows (runtime state,
    // leases, events...). Truncate the company root with CASCADE so every
    // transitive dependent is cleared regardless of what the run touched.
    await db.execute(sql.raw(`TRUNCATE companies CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function waitForCondition(fn: () => Promise<boolean> | boolean, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await fn()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return Boolean(await fn());
  }

  async function seedAgent(companyId: string, name: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
      ...overrides,
    });
    return agentId;
  }

  async function seedIssue(companyId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fixture issue",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      ...overrides,
    });
    return issueId;
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    contextIssueId: string | null,
    status: "queued" | "running" = "running",
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status,
      contextSnapshot: contextIssueId ? { issueId: contextIssueId, taskId: contextIssueId } : {},
    });
    return runId;
  }

  async function lockIssueToRun(issueId: string, runId: string, nameKey = "holder") {
    await db
      .update(issues)
      .set({
        executionRunId: runId,
        executionAgentNameKey: nameKey,
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, issueId));
  }

  async function seedDeferredWake(
    companyId: string,
    agentId: string,
    issueId: string,
    overrides: Partial<typeof agentWakeupRequests.$inferInsert> = {},
  ) {
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: { issueId, wakeReason: "issue_assigned" },
      },
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      ...overrides,
    });
    return wakeId;
  }

  const runForWake = async (wakeId: string) =>
    db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.wakeupRequestId, wakeId))
      .then((rows) => rows);

  const wakeById = async (wakeId: string) =>
    db
      .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId))
      .then((rows) => rows[0] ?? null);

  it("promotes a deferred wake on a sibling issue in the same finalization, not only for the context issue", async () => {
    // Repro shaped like the reported incident: a run whose contextSnapshot
    // points at issue A holds the execution lock on sibling issue B (legacy-run
    // fallback), and another agent's wake on B was parked as
    // deferred_issue_execution. When the run finalizes, B's wake must be
    // promoted in the SAME finalization instead of stranding forever.
    const companyId = await seedCompany();
    const holderAgentId = await seedAgent(companyId, "Holder");
    const workerAgentId = await seedAgent(companyId, "Worker");

    const contextIssueId = await seedIssue(companyId);
    const siblingIssueId = await seedIssue(companyId, {
      status: "todo",
      assigneeAgentId: workerAgentId,
    });

    const runId = await seedRun(companyId, holderAgentId, contextIssueId);
    await lockIssueToRun(contextIssueId, runId);
    await lockIssueToRun(siblingIssueId, runId);

    const wakeId = await seedDeferredWake(companyId, workerAgentId, siblingIssueId);

    await heartbeat.cancelRun(runId);

    const wakeAfter = await wakeById(wakeId);
    expect(wakeAfter).not.toBeNull();
    expect(wakeAfter?.status).not.toBe("deferred_issue_execution");

    const promotedRuns = await runForWake(wakeId);
    expect(promotedRuns).toHaveLength(1);
    expect(promotedRuns[0]?.agentId).toBe(workerAgentId);
    expect((promotedRuns[0]?.contextSnapshot as Record<string, unknown>).issueId).toBe(siblingIssueId);
    // The finalization kick must actually dispatch the promoted run, not just
    // queue it — the reported symptom was the assignee never waking.
    await waitForCondition(() => mockAdapterExecute.mock.calls.length > 0);
    expect(mockAdapterExecute).toHaveBeenCalled();
  });

  it("still promotes a deferred wake on the context issue (legacy single-issue path unchanged)", async () => {
    const companyId = await seedCompany();
    const holderAgentId = await seedAgent(companyId, "Holder");
    const workerAgentId = await seedAgent(companyId, "Worker");

    const contextIssueId = await seedIssue(companyId, { assigneeAgentId: workerAgentId });
    const runId = await seedRun(companyId, holderAgentId, contextIssueId);
    await lockIssueToRun(contextIssueId, runId);

    const wakeId = await seedDeferredWake(companyId, workerAgentId, contextIssueId);

    await heartbeat.cancelRun(runId);

    const wakeAfter = await wakeById(wakeId);
    expect(wakeAfter?.status).not.toBe("deferred_issue_execution");
    const promotedRuns = await runForWake(wakeId);
    expect(promotedRuns).toHaveLength(1);
    expect((promotedRuns[0]?.contextSnapshot as Record<string, unknown>).issueId).toBe(contextIssueId);
  });

  it("does not steal a sibling issue whose execution lock moved to a live retry run", async () => {
    // Split-UPDATE retry contract: the retry run owns executionRunId while the
    // finalizing run stays pinned in checkoutRunId. The deferred wake must wait
    // for the RETRY's finalization, not be promoted underneath it.
    const companyId = await seedCompany();
    const holderAgentId = await seedAgent(companyId, "Holder");
    const workerAgentId = await seedAgent(companyId, "Worker");
    const retryAgentId = await seedAgent(companyId, "Retrier");

    const contextIssueId = await seedIssue(companyId);
    const siblingIssueId = await seedIssue(companyId, { assigneeAgentId: workerAgentId });

    const runId = await seedRun(companyId, holderAgentId, contextIssueId);
    const retryRunId = await seedRun(companyId, retryAgentId, siblingIssueId, "queued");
    await lockIssueToRun(contextIssueId, runId);
    await db
      .update(issues)
      .set({
        executionRunId: retryRunId,
        executionAgentNameKey: "retrier",
        executionLockedAt: new Date(),
        checkoutRunId: runId,
      })
      .where(eq(issues.id, siblingIssueId));

    const wakeId = await seedDeferredWake(companyId, workerAgentId, siblingIssueId);

    await heartbeat.cancelRun(runId);

    const wakeAfter = await wakeById(wakeId);
    expect(wakeAfter?.status).toBe("deferred_issue_execution");
    expect(await runForWake(wakeId)).toHaveLength(0);

    const [siblingAfter] = await db.select().from(issues).where(eq(issues.id, siblingIssueId));
    expect(siblingAfter?.executionRunId).toBe(retryRunId);

    // Terminalize the retry run so teardown does not wait on it.
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, retryRunId));
  });

  it("sweep promotes a stranded wake exactly once and a second pass is a no-op", async () => {
    const companyId = await seedCompany();
    const workerAgentId = await seedAgent(companyId, "Worker");
    const issueId = await seedIssue(companyId, { status: "todo", assigneeAgentId: workerAgentId });

    const wakeId = await seedDeferredWake(companyId, workerAgentId, issueId);

    const firstPass = await heartbeat.sweepStrandedDeferredWakes();
    expect(firstPass.promoted).toBe(1);
    expect(firstPass.wakeIds).toContain(wakeId);

    const wakeAfterFirst = await wakeById(wakeId);
    expect(wakeAfterFirst?.status).not.toBe("deferred_issue_execution");
    const promotedRuns = await runForWake(wakeId);
    expect(promotedRuns).toHaveLength(1);
    expect(promotedRuns[0]?.agentId).toBe(workerAgentId);

    const secondPass = await heartbeat.sweepStrandedDeferredWakes();
    expect(secondPass.promoted).toBe(0);
    expect(secondPass.resolved).toBe(0);
    expect(await runForWake(wakeId)).toHaveLength(1);
  });

  it("sweep resolves a stranded wake whose deferred agent is not invokable", async () => {
    const companyId = await seedCompany();
    const pausedAgentId = await seedAgent(companyId, "Paused", { status: "paused" });
    const issueId = await seedIssue(companyId, { status: "todo", assigneeAgentId: pausedAgentId });

    const wakeId = await seedDeferredWake(companyId, pausedAgentId, issueId);

    const sweep = await heartbeat.sweepStrandedDeferredWakes();
    expect(sweep.resolved).toBeGreaterThanOrEqual(1);
    expect(sweep.promoted).toBe(0);

    const wakeAfter = await wakeById(wakeId);
    expect(wakeAfter?.status).toBe("failed");
    expect(await runForWake(wakeId)).toHaveLength(0);
  });

  it("sweep un-suppresses recovery: phantom coverage clears and the reconciler acts", async () => {
    const companyId = await seedCompany();
    const workerAgentId = await seedAgent(companyId, "Worker");
    const issueId = await seedIssue(companyId, { status: "todo", assigneeAgentId: workerAgentId });

    const wakeId = await seedDeferredWake(companyId, workerAgentId, issueId);

    // The stranded wake counts as execution-path coverage, so the stranded-issue
    // reconciler deliberately skips the otherwise-stranded issue.
    expect(await recovery.hasActiveExecutionPath(companyId, issueId)).toBe(true);
    const before = await recovery.reconcileStrandedAssignedIssues();
    expect(before.issueIds).not.toContain(issueId);

    // The deferred agent goes away before the wake ever gets promoted.
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, workerAgentId));

    const sweep = await heartbeat.sweepStrandedDeferredWakes();
    expect(sweep.promoted).toBe(0);
    expect(sweep.resolved).toBeGreaterThanOrEqual(1);
    expect(await runForWake(wakeId)).toHaveLength(0);

    // Phantom coverage is gone: the execution path is clear ...
    expect(await recovery.hasActiveExecutionPath(companyId, issueId)).toBe(false);
    // ... and the reconciler acts on the now visibly stranded issue
    // (the original assignee is not invokable, so it cannot be requeued).
    const after = await recovery.reconcileStrandedAssignedIssues();
    expect(after.escalated).toBeGreaterThanOrEqual(1);
    expect(after.issueIds).toContain(issueId);
  });
});
