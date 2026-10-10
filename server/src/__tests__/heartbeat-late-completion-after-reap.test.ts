import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  approvals,
  authUsers,
  budgetPolicies,
  companies,
  companySecretBindings,
  companySecrets,
  companySkills,
  costEvents,
  createDb,
  documentAnnotationAnchorSnapshots,
  documentAnnotationComments,
  documentAnnotationThreads,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueDocuments,
  issuePlanDecompositions,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issueTreeHoldMembers,
  issueTreeHolds,
  issueWorkProducts,
  issues,
  plugins,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockTerminateLocalService = vi.hoisted(() => vi.fn());
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_input?: unknown) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Late completion test run finished.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("../services/local-service-supervisor.js", async () => {
  const actual = await vi.importActual<typeof import("../services/local-service-supervisor.js")>(
    "../services/local-service-supervisor.js",
  );
  mockTerminateLocalService.mockImplementation(actual.terminateLocalService);
  return {
    ...actual,
    terminateLocalService: mockTerminateLocalService,
  };
});

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

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

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres late-completion tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const REAP_TS = new Date("2026-03-19T00:05:00.000Z");

describeEmbeddedPostgres("heartbeat late completion after external interruption reap", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-late-completion-");
    db = createDb(tempDb.connectionString);
    const now = new Date();
    await db.insert(authUsers).values({
      id: "responsible-user",
      name: "Responsible User",
      email: "responsible-user@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    const localServiceSupervisor = await vi.importActual<typeof import("../services/local-service-supervisor.js")>(
      "../services/local-service-supervisor.js",
    );
    mockTerminateLocalService.mockImplementation(localServiceSupervisor.terminateLocalService);
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Late completion test run finished.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();

    const activeRuns = await db
      .select({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId })
      .from(heartbeatRuns)
      .where(or(eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.status, "running")));
    if (activeRuns.length > 0) {
      const now = new Date();
      await db
        .update(heartbeatRuns)
        .set({ status: "cancelled", finishedAt: now, updatedAt: now, processPid: null, processGroupId: null })
        .where(inArray(heartbeatRuns.id, activeRuns.map((run) => run.id)));
      const wakeupIds = activeRuns
        .map((run) => run.wakeupRequestId)
        .filter((value): value is string => typeof value === "string" && value.length > 0);
      if (wakeupIds.length > 0) {
        await db
          .update(agentWakeupRequests)
          .set({ status: "cancelled", finishedAt: now })
          .where(inArray(agentWakeupRequests.id, wakeupIds));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Deletion order mirrors the process-recovery suite: clear rows that
    // reference agents/issues/companies before their parents, with retries
    // for late inserts from winding-down executions.
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(workspaceOperations);
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(plugins);
    await db.delete(issuePlanDecompositions);
    await db.delete(issueThreadInteractions);
    await db.delete(documentAnnotationComments);
    await db.delete(documentAnnotationAnchorSnapshots);
    await db.delete(documentAnnotationThreads);
    await db.delete(issueWorkProducts);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueRecoveryActions);
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(issueComments);
      await db.delete(issueDocuments);
      try {
        await db.delete(issues);
        break;
      } catch {
        if (attempt === 4) throw new Error("Failed to clear issues during cleanup");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(budgetPolicies);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(agentWakeupRequests);
      await db.delete(agentRuntimeState);
      try {
        await db.delete(agents);
        break;
      } catch {
        if (attempt === 4) throw new Error("Failed to clear agents during cleanup");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(companySkills);
      await db.delete(workspaceOperations);
      await db.delete(executionWorkspaces);
      await db.delete(projectWorkspaces);
      await db.delete(projects);
      await db.delete(issuePlanDecompositions);
      await db.delete(issueThreadInteractions);
      await db.delete(documentAnnotationComments);
      await db.delete(documentAnnotationAnchorSnapshots);
      await db.delete(documentAnnotationThreads);
      await db.delete(issueDocuments);
      await db.delete(documentRevisions);
      await db.delete(documents);
      await db.delete(companySecretBindings);
      await db.delete(companySecrets);
      try {
        await db.delete(companies);
        break;
      } catch {
        if (attempt === 4) throw new Error("Failed to clear companies during cleanup");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedQueuedRunFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "GatewayCoder",
      role: "engineer",
      status: "idle",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {},
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {},
      processPid: null,
      processGroupId: null,
      startedAt: now,
      updatedAt: now,
    });

    return { companyId, agentId, runId, wakeupRequestId };
  }

  // Simulates the b67c6c10 shape: the graceful-shutdown drain reaps the row
  // to `interrupted` (guarded on running) while the worker is still alive,
  // then the adapter returns a clean completion afterwards.
  function mockExternalReapMidRun(input: {
    reapStatus: "interrupted" | "cancelled" | "timed_out" | "succeeded";
    resultJson?: Record<string, unknown>;
  }) {
    return async () => {
      const [active] = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.status, "running"));
      const runId = active?.id ?? "";
      await db
        .update(heartbeatRuns)
        .set({
          status: input.reapStatus,
          finishedAt: REAP_TS,
          updatedAt: REAP_TS,
          errorCode: input.reapStatus === "interrupted" ? "server_shutdown_interrupted" : null,
          error:
            input.reapStatus === "interrupted"
              ? "Interrupted by graceful server shutdown (SIGTERM)"
              : input.reapStatus === "cancelled"
                ? "Cancelled by operator"
                : input.reapStatus === "timed_out"
                  ? "Run timed out"
                  : null,
          resultJson: input.resultJson ?? null,
        })
        .where(eq(heartbeatRuns.id, runId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Worker actually finished cleanly after the external reap.",
        provider: "test",
        model: "test-model",
      };
    };
  }

  async function waitForRunToSettle(
    heartbeat: ReturnType<typeof heartbeatService>,
    runId: string,
    timeoutMs = 5_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (!run || (run.status !== "queued" && run.status !== "running")) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return heartbeat.getRun(runId);
  }

  // Unlike waitForRunToSettle, this waits for a specific terminal outcome —
  // an external reap makes the row terminal (interrupted) mid-execution, so
  // "not queued/running" is not enough to know the finalization finished.
  async function waitForRunStatus(
    heartbeat: ReturnType<typeof heartbeatService>,
    runId: string,
    expected: string,
    timeoutMs = 5_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    let run = await heartbeat.getRun(runId);
    while (Date.now() < deadline) {
      run = await heartbeat.getRun(runId);
      if (run?.status === expected) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return run;
  }

  async function loadRunEvents(runId: string) {
    return db
      .select()
      .from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.eventType, "lifecycle")))
      .orderBy(heartbeatRunEvents.seq);
  }

  it("overwrites an externally reaped interrupted row when the worker completes cleanly (AC1/AC2)", async () => {
    mockAdapterExecute.mockImplementationOnce(
      mockExternalReapMidRun({
        reapStatus: "interrupted",
        resultJson: { reapMarker: { reason: "graceful_shutdown_drain" } },
      }),
    );

    const { runId, wakeupRequestId } = await seedQueuedRunFixture();
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    const settled = await waitForRunStatus(heartbeat, runId, "succeeded");
    expect(settled?.status).toBe("succeeded");
    expect(settled?.exitCode).toBe(0);
    expect(settled?.errorCode).toBeNull();
    expect(settled?.error).toBeNull();
    expect(settled?.finishedAt!.getTime()).toBeGreaterThan(REAP_TS.getTime());

    // AC2: reap provenance is preserved and appended to, nothing deleted.
    const resultJson = (settled?.resultJson ?? {}) as Record<string, unknown>;
    expect(resultJson.reapMarker).toEqual({ reason: "graceful_shutdown_drain" });
    expect(resultJson.completedAfterInterrupt).toMatchObject({
      reapedErrorCode: "server_shutdown_interrupted",
      reapedAt: REAP_TS.toISOString(),
      exitCode: 0,
    });

    const events = await loadRunEvents(runId);
    const provenanceEvents = events.filter((event) =>
      (event.message ?? "").startsWith("completed after reap:"),
    );
    expect(provenanceEvents).toHaveLength(1);
    expect(provenanceEvents[0]?.message).toContain("exit 0");
    expect(provenanceEvents[0]?.payload).toMatchObject({
      reapedStatus: "interrupted",
      reapedErrorCode: "server_shutdown_interrupted",
      completionStatus: "succeeded",
    });
    // The late path skips the normal "run succeeded" event so the provenance
    // entry is the single terminal lifecycle record for the re-delivery.
    expect(events.filter((event) => (event.message ?? "") === "run succeeded")).toHaveLength(0);

    // AC4 (side-effect half): the reap path already terminalized the wakeup
    // request; the late completion must not touch it again.
    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");
  });

  it.each(["cancelled", "timed_out"] as const)(
    "does not resurrect a %s row when the worker completes cleanly (AC3)",
    async (reapStatus) => {
      mockAdapterExecute.mockImplementationOnce(mockExternalReapMidRun({ reapStatus }));

      const { runId } = await seedQueuedRunFixture();
      const heartbeat = heartbeatService(db);

      await heartbeat.resumeQueuedRuns();
      const settled = await waitForRunToSettle(heartbeat, runId);
      expect(settled?.status).toBe(reapStatus);
      expect(settled?.exitCode).toBeNull();
      expect(settled?.finishedAt!.getTime()).toBe(REAP_TS.getTime());

      const resultJson = (settled?.resultJson ?? {}) as Record<string, unknown>;
      expect(resultJson.completedAfterInterrupt).toBeUndefined();

      const events = await loadRunEvents(runId);
      expect(events.filter((event) => (event.message ?? "").startsWith("completed after reap:"))).toHaveLength(0);
    },
  );

  it("converges when a completion is re-delivered after the row was already finalized (AC4)", async () => {
    const priorProvenance = {
      completedAfterInterrupt: {
        reapedErrorCode: "server_shutdown_interrupted",
        reapedAt: REAP_TS.toISOString(),
        completedAt: "2026-03-19T00:06:00.000Z",
        exitCode: 1,
      },
    };
    // Re-delivery arrives after another path already finalized the row with
    // its own exit code and provenance; the CAS must lose and converge.
    // The row is already terminal (exitCode 1) before the completion
    // re-delivery finalizes: the reap simulation marks it succeeded with the
    // prior provenance, then the wrapper pins the first writer's exit code.
    const inner = mockExternalReapMidRun({ reapStatus: "succeeded", resultJson: priorProvenance });
    mockAdapterExecute.mockImplementationOnce(async () => {
      const result = await inner();
      const [current] = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.status, "succeeded"));
      if (current) {
        await db
          .update(heartbeatRuns)
          .set({ exitCode: 1 })
          .where(eq(heartbeatRuns.id, current.id));
      }
      return result;
    });

    const { runId } = await seedQueuedRunFixture();
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    const settled = await waitForRunToSettle(heartbeat, runId);
    expect(settled?.status).toBe("succeeded");
    // First writer wins: the re-delivery does not flip the recorded outcome.
    expect(settled?.exitCode).toBe(1);
    const resultJson = (settled?.resultJson ?? {}) as Record<string, unknown>;
    expect(resultJson.completedAfterInterrupt).toEqual(priorProvenance.completedAfterInterrupt);

    const events = await loadRunEvents(runId);
    expect(events.filter((event) => (event.message ?? "").startsWith("completed after reap:"))).toHaveLength(0);
  });
});
