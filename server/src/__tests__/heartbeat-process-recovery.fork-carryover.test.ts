import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, or, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  approvals,
  authUsers,
  budgetPolicies,
  companySecretBindings,
  companySecrets,
  companySkills,
  companies,
  costEvents,
  documentAnnotationAnchorSnapshots,
  documentAnnotationComments,
  documentAnnotationThreads,
  createDb,
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
  projects,
  projectWorkspaces,
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
    summary: "Recovered stranded heartbeat work.",
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

import {
  INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
  heartbeatService,
  redactDetectedSuccessfulRunProgressSummaryForBoard,
  redactSuccessfulRunHandoffEvidence,
} from "../services/heartbeat.ts";
import {
  markServerShutdownStarted,
  readLastServerShutdownBoundary,
  resetServerShutdownMemoryForTests,
  resolveServerShutdownBoundaryPath,
} from "../services/server-shutdown-state.js";
import {
  readHotRestartIntent,
  resolveLegacyHotRestartIntentPath,
  resolveHotRestartReportPath,
  writeHotRestartIntent,
} from "../services/hot-restart.ts";
import { secretService } from "../services/secrets.ts";
import {
  SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
  noticeMetadataReferencesRecoveryAction,
} from "../services/recovery/index.ts";
import { collectDispositionRepairSourceState } from "../services/recovery/disposition-repair.ts";
import {
  UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON,
  UNMANAGED_BACKGROUND_TASK_STOP_REASON,
} from "@paperclipai/adapter-utils/server-utils";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function commentMetadataRows(comment: { metadata?: unknown } | null | undefined) {
  const metadata = comment?.metadata as { sections?: Array<{ rows?: unknown[] }> } | null | undefined;
  return (metadata?.sections ?? []).flatMap((section) => section.rows ?? []) as Array<Record<string, unknown>>;
}

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

function isPidAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

async function waitForRunToSettle(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

async function waitForValue<T>(
  read: () => Promise<T | null | undefined>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  let latest: T | null | undefined = null;
  while (Date.now() < deadline) {
    latest = await read();
    if (latest) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return latest ?? null;
}

async function waitForHeartbeatIdle(
  db: ReturnType<typeof createDb>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await db
      .select({
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns);
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function cancelActiveRunsForCleanup(
  db: ReturnType<typeof createDb>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const activeRuns = await db
      .select({
        id: heartbeatRuns.id,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(
        or(
          eq(heartbeatRuns.status, "queued"),
          eq(heartbeatRuns.status, "running"),
        ),
      );

    if (activeRuns.length === 0) return;

    const now = new Date();
    const runIds = activeRuns.map((run) => run.id);
    const wakeupRequestIds = activeRuns
      .map((run) => run.wakeupRequestId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: now,
        updatedAt: now,
        errorCode: "test_cleanup",
        error: "Cancelled by heartbeat-process-recovery test cleanup",
        processPid: null,
        processGroupId: null,
      })
      .where(inArray(heartbeatRuns.id, runIds));

    if (wakeupRequestIds.length > 0) {
      await db
        .update(agentWakeupRequests)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: "Cancelled by heartbeat-process-recovery test cleanup",
        })
        .where(inArray(agentWakeupRequests.id, wakeupRequestIds));
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function spawnOrphanedProcessGroup() {
  const leader = spawn(
    process.execPath,
    [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "process.stdout.write(String(child.pid));",
        "setTimeout(() => process.exit(0), 25);",
      ].join(" "),
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );

  let stdout = "";
  leader.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });

  await new Promise<void>((resolve, reject) => {
    leader.once("error", reject);
    leader.once("exit", () => resolve());
  });

  const descendantPid = Number.parseInt(stdout.trim(), 10);
  if (!Number.isInteger(descendantPid) || descendantPid <= 0) {
    throw new Error(`Failed to capture orphaned descendant pid from detached process group: ${stdout}`);
  }

  return {
    processPid: leader.pid ?? null,
    processGroupId: leader.pid ?? null,
    descendantPid,
  };
}

describeEmbeddedPostgres("heartbeat orphaned process recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const childProcesses = new Set<ChildProcess>();
  const cleanupPids = new Set<number>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-");
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
    // A leaked in-process shutdown flag would reclassify every
    // later run in this suite as shutdown-interrupted. Memory only — never
    // touch the persisted marker, which may belong to a live instance.
    resetServerShutdownMemoryForTests();
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
      summary: "Recovered stranded heartbeat work.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    await cancelActiveRunsForCleanup(db, 5_000);
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({
          status: heartbeatRuns.status,
          processPid: heartbeatRuns.processPid,
          processGroupId: heartbeatRuns.processGroupId,
        })
        .from(heartbeatRuns);
      const managedExecutionStillActive = runs.some(
        (run) =>
          (run.status === "queued" || run.status === "running") &&
          !run.processPid &&
          !run.processGroupId,
      );
      if (!managedExecutionStillActive) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await waitForHeartbeatIdle(db, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.delete(activityLog);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(costEvents);
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
    await db.delete(issueThreadInteractions);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(issueComments);
      await db.delete(issueDocuments);
      try {
        await db.delete(issues);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(activityLog);
      await db.delete(heartbeatRunEvents);
      try {
        await db.delete(heartbeatRuns);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(agentWakeupRequests);
    await db.delete(budgetPolicies);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // A still-alive recovery child process can insert a new wakeup request
      // or runtime-state row after the first delete. Re-clear both rows each
      // attempt so a late insert cannot hold the agents foreign key.
      await db.delete(agentWakeupRequests);
      await db.delete(agentRuntimeState);
      try {
        await db.delete(agents);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
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
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedRunFixture(input?: {
    adapterType?: string;
    agentStatus?: "paused" | "idle" | "running";
    runStatus?: "running" | "queued" | "failed";
    processPid?: number | null;
    processGroupId?: number | null;
    processLossRetryCount?: number;
    includeIssue?: boolean;
    runErrorCode?: string | null;
    runError?: string | null;
    contextSnapshot?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
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
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "paused",
      adapterType: input?.adapterType ?? "codex_local",
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
      payload: input?.includeIssue === false ? {} : { issueId },
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
      status: input?.runStatus ?? "running",
      wakeupRequestId,
      contextSnapshot: input?.includeIssue === false
        ? input?.contextSnapshot ?? {}
        : { ...(input?.contextSnapshot ?? {}), issueId },
      processPid: input?.processPid ?? null,
      processGroupId: input?.processGroupId ?? null,
      processLossRetryCount: input?.processLossRetryCount ?? 0,
      errorCode: input?.runErrorCode ?? null,
      error: input?.runError ?? null,
      startedAt: now,
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    if (input?.includeIssue !== false) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Recover local adapter after lost process",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        responsibleUserId: "responsible-user",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  async function seedEnvironmentLeaseFixture(input: {
    companyId: string;
    runId: string;
    issueId: string;
    provider?: string;
  }) {
    const environmentId = randomUUID();
    const leaseId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");

    await db.insert(environments).values({
      id: environmentId,
      companyId: input.companyId,
      name: "Local test environment",
      driver: "local",
      status: "active",
      config: {},
      metadata: null,
    });

    await db.insert(environmentLeases).values({
      id: leaseId,
      companyId: input.companyId,
      environmentId,
      issueId: input.issueId,
      heartbeatRunId: input.runId,
      status: "active",
      leasePolicy: "ephemeral",
      provider: input.provider ?? "local",
      providerLeaseId: null,
      acquiredAt: now,
      lastUsedAt: now,
      metadata: {
        driver: "local",
      },
      createdAt: now,
      updatedAt: now,
    });

    return { environmentId, leaseId };
  }

  async function seedStrandedIssueFixture(input: {
    status: "todo" | "in_progress";
    runStatus: "failed" | "timed_out" | "cancelled" | "succeeded";
    retryReason?: "assignment_recovery" | "issue_continuation_needed" | "execution_review_participant_recovery" | null;
    runSource?: string | null;
    assignToUser?: boolean;
    activePauseHold?: boolean;
    livenessState?: "completed" | "advanced" | "plan_only" | "empty_response" | "blocked" | "failed" | "needs_followup" | null;
    runErrorCode?: string | null;
    runError?: string | null;
    resultJson?: Record<string, unknown> | null;
    monitorNextCheckAt?: Date | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const rootIssueId = randomUUID();
    const issueId = randomUUID();
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
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
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
      reason: input.retryReason === "assignment_recovery" ? "issue_assignment_recovery" : "issue_assigned",
      payload: { issueId },
      status: input.runStatus === "cancelled" ? "cancelled" : "failed",
      runId,
      claimedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      error: input.runStatus === "succeeded"
        ? null
        : ("runError" in input ? input.runError : "run failed before issue advanced"),
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.runStatus,
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: input.retryReason === "assignment_recovery"
          ? "issue_assignment_recovery"
          : input.retryReason ?? "issue_assigned",
        ...(input.retryReason ? { retryReason: input.retryReason } : {}),
        ...(input.runSource ? { source: input.runSource } : {}),
      },
      startedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      updatedAt: new Date("2026-03-19T00:05:00.000Z"),
      errorCode: input.runStatus === "succeeded"
        ? null
        : ("runErrorCode" in input ? input.runErrorCode : "process_lost"),
      error: input.runStatus === "succeeded"
        ? null
        : ("runError" in input ? input.runError : "run failed before issue advanced"),
      livenessState: input.livenessState ?? null,
      resultJson: input.resultJson ?? null,
    });

    await db.insert(issues).values([
      ...(input.activePauseHold
        ? [{
          id: rootIssueId,
          companyId,
          title: "Paused recovery root",
          status: "todo",
          priority: "medium",
          responsibleUserId: "responsible-user",
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        }]
        : []),
      {
        id: issueId,
        companyId,
        parentId: input.activePauseHold ? rootIssueId : null,
        title: "Recover stranded assigned work",
        status: input.status,
        priority: "medium",
        assigneeAgentId: input.assignToUser ? null : agentId,
        assigneeUserId: input.assignToUser ? "user-1" : null,
        checkoutRunId: input.status === "in_progress" ? runId : null,
        executionRunId: null,
        monitorNextCheckAt: input.monitorNextCheckAt ?? null,
        responsibleUserId: "responsible-user",
        issueNumber: input.activePauseHold ? 2 : 1,
        identifier: `${issuePrefix}-${input.activePauseHold ? 2 : 1}`,
        startedAt: input.status === "in_progress" ? now : null,
      },
    ]);

    if (input.activePauseHold) {
      await db.insert(issueTreeHolds).values({
        companyId,
        rootIssueId,
        mode: "pause",
        status: "active",
        reason: "pause recovery subtree",
        releasePolicy: { strategy: "manual" },
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId, rootIssueId };
  }

  async function seedInReviewParticipantRunFixture(input?: {
    wakeReason?: string;
    retryReason?: string | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const wakeReason = input?.wakeReason ?? "execution_review_requested";

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
      name: "CodexReviewer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: wakeReason,
      payload: {
        issueId,
        ...(input?.retryReason ? { retryReason: input.retryReason } : {}),
      },
      status: "queued",
      runId,
      requestedAt: now,
      updatedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason,
        ...(input?.retryReason ? { retryReason: input.retryReason } : {}),
      },
      updatedAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review participant stayed pending",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      executionRunId: runId,
      executionAgentNameKey: "codexreviewer",
      executionLockedAt: now,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    return { companyId, agentId, runId, wakeupRequestId, issueId, stageId };
  }

  async function seedAssignedTodoNoRunFixture(input?: {
    agentStatus?: "paused" | "idle" | "running";
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
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
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Assigned todo work that never received a heartbeat",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  async function seedIdleTimerAgentFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
          skipTimerWhenNoActionableWork: true,
        },
      },
      permissions: {},
    });

    return { companyId, agentId };
  }

  async function expectSourceScopedStrandedRecoveryAction(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    runId: string;
    previousStatus: "todo" | "in_progress" | "in_review";
    retryReason?: "assignment_recovery" | "issue_continuation_needed" | "execution_review_participant_recovery" | null;
    cause?: string;
    kind?: string;
    previousOwnerAgentId?: string | null;
    returnOwnerAgentId?: string | null;
  }) {
    const action = await waitForValue(async () =>
      db.select().from(issueRecoveryActions).where(
        and(
          eq(issueRecoveryActions.companyId, input.companyId),
          eq(issueRecoveryActions.sourceIssueId, input.issueId),
        ),
      ).then((rows) => rows[0] ?? null),
    );
    if (!action) throw new Error("Expected source-scoped stranded recovery action to be created");

    expect(action).toMatchObject({
      companyId: input.companyId,
      sourceIssueId: input.issueId,
      recoveryIssueId: null,
      kind: input.kind ?? "stranded_assigned_issue",
      status: "active",
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: input.previousOwnerAgentId ?? input.agentId,
      returnOwnerAgentId: input.returnOwnerAgentId ?? input.agentId,
      cause: input.cause ?? "stranded_assigned_issue",
      attemptCount: 1,
      maxAttempts: null,
    });
    expect(action.evidence).toMatchObject({
      sourceIssueId: input.issueId,
      previousStatus: input.previousStatus,
      latestRunId: input.runId,
      retryReason: input.retryReason ?? null,
      routingPolicy: "board_escalation_no_takeover_v1",
    });
    if (input.cause === "execution_review_participant_recovery") {
      expect(action.nextAction).toContain("failed review participant path");
    } else if (input.cause === "process_lost") {
      expect(action.nextAction).toContain("explicitly retry the original owner");
    } else {
      expect(action.nextAction).toContain(
        input.kind === "missing_disposition" ? "valid issue disposition" : "Board operator",
      );
    }

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, input.companyId),
        eq(issues.originKind, "stranded_issue_recovery"),
        eq(issues.originId, input.issueId),
      ));
    expect(recoveryIssues).toHaveLength(0);

    const recoveryWakeups = await db.select().from(agentWakeupRequests).where(
      sql`${agentWakeupRequests.payload} ->> 'recoveryActionId' = ${action.id}`,
    );
    expect(recoveryWakeups).toHaveLength(0);
    await waitForHeartbeatIdle(db);
    const sourceIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .then((rows) => rows[0] ?? null);
    expect(sourceIssue?.status).toBe("blocked");

    return action;
  }

  async function sourceBlockerIssueIds(companyId: string, sourceIssueId: string) {
    return db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, sourceIssueId),
          eq(issueRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows.map((row) => row.blockerIssueId));
  }

  async function seedQueuedIssueRunFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
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
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      runId,
      requestedAt: now,
      updatedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry transient Codex failure without blocking",
      description: "Verify the successful-run handoff and choose an honest disposition.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: now,
    });

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  async function withTempPaperclipHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hot-restart-"));
    const previousHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = home;
    try {
      return await fn(home);
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      await fs.rm(home, { recursive: true, force: true });
    }
  }

  it.skipIf(process.platform === "win32")("keeps process-group-only hot-restart adoptions out of process_lost reaping", async () => {
    const orphan = await spawnOrphanedProcessGroup();
    cleanupPids.add(orphan.descendantPid);
    expect(isPidAlive(orphan.descendantPid)).toBe(true);
    const { runId } = await seedRunFixture({
      agentStatus: "running",
      processPid: orphan.processPid,
      processGroupId: orphan.processGroupId,
      contextSnapshot: {
        executionEngine: "cli",
        processTopology: "detached",
      },
    });

    await withTempPaperclipHome(async () => {
      const heartbeat = heartbeatService(db);
      await writeHotRestartIntent({
        previousServerPid: process.pid,
        previousServerVersion: "old-version",
        requestedAt: new Date("2026-03-19T00:05:00.000Z"),
      });
      await heartbeat.prepareHotRestartShutdown(
        "SIGTERM",
        new Date("2026-03-19T00:06:00.000Z"),
      );

      const adoption = await heartbeat.reconcileHotRestartAdoption(
        new Date("2026-03-19T00:07:00.000Z"),
      );
      expect(adoption).toMatchObject({
        mode: "reported",
        adoptedRunIds: [runId],
        finalizedWhileDownRunIds: [],
        lostRunIds: [],
        skippedRunIds: [],
      });

      const reap = await heartbeat.reapOrphanedRuns();
      expect(reap).toEqual({ reaped: 0, runIds: [] });
      expect(isPidAlive(orphan.descendantPid)).toBe(true);
      const adopted = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      expect(adopted?.status).toBe("running");
      expect(adopted?.errorCode).not.toBe("process_lost");
      expect(adopted?.resultJson).toMatchObject({
        hotRestart: {
          adopted: true,
          processPid: orphan.processPid,
          processGroupId: orphan.processGroupId,
        },
      });
    });
  });

  // Shutdown-boundary run classification. The 2026-09-22 restart
  // churn recorded runs killed BY the shutdown as `adapter_failed` (×3) and
  // `process_lost` (×2); only the runs the graceful drain reached got
  // `server_shutdown_interrupted`. The gap: the adapter-error close and the
  // startup orphan reap never consulted shutdown state.
  async function seedShutdownBoundaryMarker(home: string, input: {
    signal?: "SIGINT" | "SIGTERM";
    startedAt: Date;
    pid?: number;
  }) {
    await fs.mkdir(path.dirname(resolveServerShutdownBoundaryPath(home)), { recursive: true });
    await fs.writeFile(
      resolveServerShutdownBoundaryPath(home),
      JSON.stringify({
        signal: input.signal ?? "SIGTERM",
        startedAt: input.startedAt.toISOString(),
        pid: input.pid ?? 4242,
      }),
      "utf8",
    );
  }

  async function spawnDeadPid(): Promise<number> {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const pid = child.pid!;
    await waitForPidExit(pid);
    expect(isPidAlive(pid)).toBe(false);
    return pid;
  }

  it("records the shutdown terminal state, not process_lost, when the startup reap replays the 2026-09-22 boundary timeline", async () => {
    await withTempPaperclipHome(async (home) => {
      // Fixture: run 2df60c6f shape — running since 17:18, plugin-worker
      // SIGTERM wave at 17:26:15 kills the server mid-shutdown, systemd
      // restarts immediately, startup reap observes the orphan at 17:26:15.921.
      const deadPid = await spawnDeadPid();
      const { agentId, runId, wakeupRequestId } = await seedRunFixture({
        agentStatus: "running",
        processPid: deadPid,
      });
      await db
        .update(heartbeatRuns)
        .set({ startedAt: new Date("2026-09-22T17:18:02.000Z") })
        .where(eq(heartbeatRuns.id, runId));
      await seedShutdownBoundaryMarker(home, {
        signal: "SIGTERM",
        startedAt: new Date("2026-09-22T17:26:15.000Z"),
      });
      expect(await readLastServerShutdownBoundary(home)).toMatchObject({
        signal: "SIGTERM",
        pid: 4242,
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.reapOrphanedRuns();

      expect(result).toEqual({ reaped: 1, runIds: [runId] });
      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);
      expect(run).toMatchObject({
        status: "interrupted",
        errorCode: "server_shutdown_interrupted",
        signal: "SIGTERM",
      });
      expect(run?.error).toContain("Interrupted by server shutdown (SIGTERM)");

      // Restart recovery is queued, mirroring the graceful-drain semantics.
      const retry = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, runId))
        .then((rows) => rows[0] ?? null);
      expect(retry).toMatchObject({ status: "queued", processLossRetryCount: 1 });

      const wakeup = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null);
      expect(wakeup?.status).toBe("cancelled");

      // Agent status matches today's graceful-drain handling for
      // server_shutdown_interrupted runs exactly (resolveAgentStatusAfterRun
      // has no "interrupted" agent status; the drain parks the agent in
      // error with the shutdown message as the reason).
      const agent = await db
        .select({ status: agents.status, errorReason: agents.errorReason })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      expect(agent?.status).toBe("error");
      expect(agent?.errorReason).toContain("Interrupted by server shutdown (SIGTERM)");

      // The boundary marker is consumed by the reap.
      expect(await readLastServerShutdownBoundary(home)).toBeNull();
    });
  });

  it("still records process_lost when no shutdown boundary exists (negative control)", async () => {
    await withTempPaperclipHome(async () => {
      const deadPid = await spawnDeadPid();
      const { runId } = await seedRunFixture({
        agentStatus: "running",
        processPid: deadPid,
      });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.reapOrphanedRuns();

      expect(result).toEqual({ reaped: 1, runIds: [runId] });
      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);
      expect(run).toMatchObject({ status: "failed", errorCode: "process_lost" });
    });
  });

  it("does not classify a run started after the shutdown boundary as a shutdown kill", async () => {
    await withTempPaperclipHome(async (home) => {
      const deadPid = await spawnDeadPid();
      const { runId } = await seedRunFixture({
        agentStatus: "running",
        processPid: deadPid,
      });
      // Boundary from 30 minutes ago; the orphaned run started after it, so
      // its loss is genuine — exactly the post-restart run that must never be
      // swept into the shutdown class.
      await db
        .update(heartbeatRuns)
        .set({ startedAt: new Date("2026-09-22T17:26:15.001Z") })
        .where(eq(heartbeatRuns.id, runId));
      await seedShutdownBoundaryMarker(home, {
        startedAt: new Date("2026-09-22T17:26:15.000Z"),
      });

      const heartbeat = heartbeatService(db);
      await heartbeat.reapOrphanedRuns();

      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);
      expect(run).toMatchObject({ status: "failed", errorCode: "process_lost" });
      // Stale boundary is still consumed once the reap runs.
      expect(await readLastServerShutdownBoundary(home)).toBeNull();
    });
  });

  it("classifies an adapter SIGTERM-wave failure as shutdown-interrupted when the server is shutting down", async () => {
    await withTempPaperclipHome(async (home) => {
      // The 09-22 adapter_failed shape: the plugin-worker SIGTERM wave kills
      // the adapter stream mid-run; the close path sees exit 143 + an error.
      mockAdapterExecute.mockResolvedValueOnce({
        exitCode: 143,
        signal: "SIGTERM",
        timedOut: false,
        errorMessage: "process terminated by signal SIGTERM",
        provider: "test",
        model: "test-model",
      });
      const { agentId, runId } = await seedQueuedIssueRunFixture();
      const heartbeat = heartbeatService(db);

      // The shutdown signal arrives while the run is live; the adapter stream
      // dies in the SIGTERM wave and the close path must consult the flag.
      // Marking before dispatch keeps the test deterministic.
      markServerShutdownStarted("SIGTERM", new Date("2026-09-22T17:26:15.000Z"));
      await heartbeat.resumeQueuedRuns();
      await waitForRunToSettle(heartbeat, runId);
      await heartbeat.waitForRunExecutionDrain(runId);

      const run = await heartbeat.getRun(runId);
      expect(run).toMatchObject({
        status: "interrupted",
        errorCode: "server_shutdown_interrupted",
        signal: "SIGTERM",
      });
      expect(run?.error).toContain("Interrupted by server shutdown (SIGTERM)");

      const retry = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, runId))
        .then((rows) => rows[0] ?? null);
      // The retry can already be picked up for dispatch by the time this read
      // happens (timing/load dependent — observed as "running" on CI). The
      // invariant under test is that a retry run EXISTS for the interrupted
      // run and is progressing, not parked or failed.
      expect(retry?.retryOfRunId).toBe(runId);
      expect(["queued", "running"]).toContain(retry?.status);

      const agent = await db
        .select({ status: agents.status, errorReason: agents.errorReason })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      // Same agent-status shape as a drain-interrupted run: parked in error
      // with the shutdown message, so operators see why (parity with today's
      // server_shutdown_interrupted handling).
      expect(agent?.status).toBe("error");
      expect(agent?.errorReason).toContain("Interrupted by server shutdown (SIGTERM)");
    });
  });

  it("still records adapter_failed for a real adapter error when no shutdown is in progress (negative control)", async () => {
    await withTempPaperclipHome(async () => {
      mockAdapterExecute.mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "model_error: upstream provider rejected the request",
        provider: "test",
        model: "test-model",
      });
      const { agentId, runId } = await seedQueuedIssueRunFixture();
      const heartbeat = heartbeatService(db);

      await heartbeat.resumeQueuedRuns();
      await waitForRunToSettle(heartbeat, runId);
      await heartbeat.waitForRunExecutionDrain(runId);

      // A genuine mid-run model error must keep the adapter failure class.
      // This assertion goes red if real adapter failures ever collapse into
      // the shutdown class.
      const run = await heartbeat.getRun(runId);
      expect(run).toMatchObject({ status: "failed", errorCode: "adapter_failed" });
      const agent = await db
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      expect(agent?.status).toBe("error");
    });
  });

  it("releases active environment leases when an orphaned run is reaped", async () => {
    const { runId, issueId, companyId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const { leaseId } = await seedEnvironmentLeaseFixture({
      companyId,
      runId,
      issueId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const lease = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0] ?? null);
    expect(lease?.status).toBe("failed");
    expect(lease?.releasedAt).toBeTruthy();
  });

  it.skipIf(process.platform === "win32")("reaps orphaned descendant process groups when the parent pid is already gone", async () => {
    const orphan = await spawnOrphanedProcessGroup();
    cleanupPids.add(orphan.descendantPid);
    expect(isPidAlive(orphan.descendantPid)).toBe(true);

    const { agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: orphan.processPid,
      processGroupId: orphan.processGroupId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    expect(await waitForPidExit(orphan.descendantPid, 2_000)).toBe(true);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.error).toContain("descendant process group");
    expect(failedRun?.resultJson).toMatchObject({
      stopReason: UNMANAGED_BACKGROUND_TASK_STOP_REASON,
      unmanagedBackgroundTask: {
        kind: "orphaned_process_group_cleanup",
        stopped: true,
        stopReason: UNMANAGED_BACKGROUND_TASK_STOP_REASON,
        reason: UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON,
        processPid: orphan.processPid,
        processGroupId: orphan.processGroupId,
      },
    });

    const retryRun = runs.find((row) => row.id !== runId);
    expect(["queued", "running"]).toContain(retryRun?.status);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
  });

});
