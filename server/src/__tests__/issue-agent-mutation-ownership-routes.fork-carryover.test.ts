import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";

// The merged v2026.824.1 route graph (routes/issues.ts now transitively pulls
// the github merge chain and the full secrets service) costs more than the
// 5s default for the first cold module re-evaluation after this file's
// per-test vi.resetModules(), which timed out the task-bridge deny test at
// createApp even though the guard itself is instant. Assertions are
// unaffected; this only widens the harness budget for this file.
vi.setConfig({ testTimeout: 30_000 });

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const ownerAgentId = "33333333-3333-4333-8333-333333333333";
const peerAgentId = "44444444-4444-4444-8444-444444444444";
const ownerRunId = "55555555-5555-4555-8555-555555555555";
const recoveryActionId = "77777777-7777-4777-8777-777777777777";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  clearOrphanCheckoutLocksIfTerminal: vi.fn(async () => false),
  create: vi.fn(),
  createChild: vi.fn(),
  decomposeAcceptedPlan: vi.fn(),
  getAttachmentById: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  getComment: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  list: vi.fn(),
  listAttachments: vi.fn(),
  listComments: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  remove: vi.fn(),
  removeAttachment: vi.fn(),
  update: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  getInvocationBlock: vi.fn(async () => null),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
}));

const mockDocumentService = vi.hoisted(() => ({
  upsertIssueDocument: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  createForIssue: vi.fn(),
  getById: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
}));

const mockStorageService = vi.hoisted(() => ({
  provider: "local_disk",
  putFile: vi.fn(),
  getObject: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByHistoricalComments: vi.fn(async () => []),
  listForIssue: vi.fn(async () => []),
  create: vi.fn(),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  link: vi.fn(),
  unlink: vi.fn(),
  listApprovalsForIssue: vi.fn(async () => []),
}));
const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  listActiveForIssues: vi.fn(async () => new Map()),
  resolveActiveForIssue: vi.fn(async () => null),
}));
const mockTaskWatchdogService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  revalidateMutationScope: vi.fn(async () => ({
    allowed: true,
    classification: { state: "stopped", stopFingerprint: "task_watchdog_stop:test" },
  })),
  reconcileForIssueAndAncestors: vi.fn(async () => ({
    checked: 0,
    triggered: 0,
    skipped: 0,
    watchdogIssueIds: [],
  })),
  upsertForIssue: vi.fn(),
  disableForIssue: vi.fn(async () => null),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockExternalObjectService = vi.hoisted(() => ({
  getIssueSummaries: vi.fn(async () => new Map()),
  getIssueSummary: vi.fn(async () => ({
    authRequiredCount: 0,
    byLiveness: {},
    byStatusCategory: {},
    highestSeverity: "muted",
    objects: [],
    staleCount: 0,
    total: 0,
    unreachableCount: 0,
  })),
  getProjectSummary: vi.fn(async () => ({
    authRequiredCount: 0,
    byLiveness: {},
    byStatusCategory: {},
    highestSeverity: "muted",
    objects: [],
    staleCount: 0,
    total: 0,
    unreachableCount: 0,
  })),
  listForIssue: vi.fn(async () => []),
  refreshIssueObjects: vi.fn(async () => []),
  syncCommentSafely: vi.fn(async () => undefined),
  syncDocumentSafely: vi.fn(async () => undefined),
  syncIssueSafely: vi.fn(async () => undefined),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockObserveCrossIssueInfluence = vi.hoisted(() => vi.fn(async () => null));

// Hoisted module mocks (not per-test vi.doMock + vi.resetModules): the mock
// registry must be in place before ANY import of the route module, in every
// test. createApp concurrently importActual()s middleware and route modules
// whose graphs share the mocked services, so a load-dependent registry race
// could bind the REAL services module and 500 the request under test
// (master Release runs 35877211616 / 35888840397). A hoisted vi.mock applies
// to every import graph deterministically.
  vi.mock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.mock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.mock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.mock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.mock("../services/documents.js", () => ({
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => mockDocumentService,
  }));

  vi.mock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.mock("../services/work-products.js", () => ({
    workProductService: () => mockWorkProductService,
  }));

  vi.mock("../services/external-objects.js", () => ({
    externalObjectService: () => mockExternalObjectService,
  }));

  vi.mock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.mock("../services/cross-issue-influence-limit.js", () => ({
    observeCrossIssueInfluence: mockObserveCrossIssueInfluence,
    crossIssueInfluenceLimitError: vi.fn(),
    crossIssueInfluenceRunContextError: () => new HttpError(
  403,
  "Agent issue comments and updates require a valid heartbeat run so cross-issue influence can be contained",
  { code: "cross_issue_influence_run_context_required" },
    ),
  }));

  vi.mock("../services/index.js", () => ({
    ISSUE_LIST_DEFAULT_LIMIT: 100,
    ISSUE_LIST_MAX_LIMIT: 500,
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    budgetService: () => mockBudgetService,
    clampIssueListLimit: (value: number) => Math.min(Math.max(value, 1), 500),
    companySkillService: () => ({
  completeTestRunForIssue: vi.fn(async () => null),
    }),
    companyService: () => mockCompanyService,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => mockDocumentService,
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  listCompanyIds: vi.fn(async () => [companyId]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
    issueRecoveryActionService: () => mockIssueRecoveryActionService,
    issueReferenceService: () => ({
  deleteDocumentSource: async () => undefined,
  diffIssueReferenceSummary: () => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  }),
  emptySummary: () => ({ outbound: [], inbound: [] }),
  listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
  syncComment: async () => undefined,
  syncDocument: async () => undefined,
  syncIssue: async () => undefined,
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    taskWatchdogService: () => mockTaskWatchdogService,
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    routineService: () => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => mockWorkProductService,
  }));


function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "in_progress",
    priority: "high",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ownerAgentId,
    assigneeUserId: null,
    createdByUserId: "board-user",
    identifier: "PAP-1649",
    title: "Owned active issue",
    executionPolicy: null,
    executionState: null,
    checkoutRunId: null,
    executionRunId: null,
    hiddenAt: null,
    ...overrides,
  };
}

function makeAgent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    companyId,
    role: "engineer",
    reportsTo: null,
    permissions: { canCreateAgents: false },
    ...overrides,
  };
}

function createRunContextDb(
  contextSnapshot: Record<string, unknown> = {},
  runAgentOrRows: string | Record<string, unknown>[] = ownerAgentId,
  runId: string = ownerRunId,
) {
  const runRows = Array.isArray(runAgentOrRows)
    ? runAgentOrRows
    : [{
        id: runId,
        companyId,
        agentId: runAgentOrRows,
        agentCompanyId: companyId,
        contextSnapshot,
      }];
  const firstRun = runRows[0] ?? {};
  const runAgentId = typeof firstRun.agentId === "string" ? firstRun.agentId : ownerAgentId;
  const runAgentCompanyId = typeof firstRun.agentCompanyId === "string" ? firstRun.agentCompanyId : companyId;
  const rowsForSelection = async (selection: Record<string, unknown>) => {
    const keys = Object.keys(selection);
    if (keys.includes("entityId")) return [];
    if (keys.includes("contextSnapshot")) return runRows;
    if (keys.includes("agentCompanyId")) return runRows;
    if (keys.length === 0) {
      const issue = await mockIssueService.getById(issueId);
      return issue ? [issue] : [];
    }
    return [{ id: runAgentId, companyId: runAgentCompanyId, permissions: {}, role: "engineer", reportsTo: null }];
  };
  const buildQuery = (selection: Record<string, unknown>) => {
    const whereResult = {
      orderBy: vi.fn(async () => []),
      limit: vi.fn(() => ({
        then: async (resolve: (limitedRows: unknown[]) => unknown) => resolve(await rowsForSelection(selection)),
      })),
      for: vi.fn(() => ({
        then: async (resolve: (selectedRows: unknown[]) => unknown) => resolve(await rowsForSelection(selection)),
      })),
      then: async (resolve: (selectedRows: unknown[]) => unknown) => resolve(await rowsForSelection(selection)),
    };
    const query = {
      innerJoin: vi.fn(() => query),
      where: vi.fn(() => whereResult),
    };
    return query;
  };
  const dbStub = {
    transaction: async (callback: (tx: typeof dbStub) => Promise<unknown>) => callback(dbStub),
    select: vi.fn((selection: Record<string, unknown> = {}) => ({
      from: vi.fn(() => buildQuery(selection)),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  };
  return dbStub;
}

async function createApp(actor: Record<string, unknown>, db?: unknown) {
  const routeDb = db ?? createRunContextDb(
    {},
    typeof actor.agentId === "string" ? actor.agentId : ownerAgentId,
    typeof actor.runId === "string" ? actor.runId : ownerRunId,
  );
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(routeDb as any, mockStorageService as any));
  app.use(errorHandler);
  return app;
}

function peerActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    agentId: peerAgentId,
    companyId,
    source: "agent_key",
    runId: "66666666-6666-4666-8666-666666666666",
    ...overrides,
  };
}

function ownerActor() {
  return {
    type: "agent",
    agentId: ownerAgentId,
    companyId,
    source: "agent_key",
    runId: ownerRunId,
  };
}

function boardActor() {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

describe("agent issue mutation checkout ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed:
        input.action === "tasks:assign" ||
        input.action === "issue:comment" ||
        input.action === "issue:read" ||
        input.action === "issue:mutate" ||
        input.action === "company_scope:read",
      action: input.action,
      reason:
        input.action === "tasks:assign" ||
          input.action === "issue:comment" ||
          input.action === "issue:read" ||
          input.action === "issue:mutate" ||
          input.action === "company_scope:read"
          ? "allow_explicit_grant"
          : "deny_missing_grant",
      explanation:
        input.action === "tasks:assign" ||
          input.action === "issue:comment" ||
          input.action === "issue:read" ||
          input.action === "issue:mutate" ||
          input.action === "company_scope:read"
          ? "Allowed by test default."
          : "Missing permission.",
    }));
    mockAccessService.hasPermission.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockCompanyService.getById.mockReset();
    mockBudgetService.getInvocationBlock.mockReset();
    mockBudgetService.getInvocationBlock.mockResolvedValue(null);
    mockProjectService.getById.mockReset();
    mockProjectService.getById.mockResolvedValue(null);
    mockIssueService.addComment.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.clearOrphanCheckoutLocksIfTerminal.mockReset();
    mockIssueService.clearOrphanCheckoutLocksIfTerminal.mockResolvedValue(false);
    mockIssueService.create.mockReset();
    mockIssueService.createChild.mockReset();
    mockIssueService.decomposeAcceptedPlan.mockReset();
    mockIssueService.getAttachmentById.mockReset();
    mockIssueService.getByIdentifier.mockReset();
    mockIssueService.getById.mockReset();
    mockIssueService.getByIdForUpdate.mockReset();
    mockIssueService.getComment.mockReset();
    mockIssueService.getDependencyReadiness.mockReset();
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      blockerIssueIds: [],
      isDependencyReady: false,
      unresolvedBlockerCount: 0,
    });
    mockIssueService.getRelationSummaries.mockReset();
    mockIssueService.getWakeableParentAfterChildCompletion.mockReset();
    mockIssueService.list.mockReset();
    mockIssueService.listAttachments.mockReset();
    mockIssueService.listComments.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockReset();
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireStaleRequestConfirmationsForIssueDocument.mockReset();
    mockIssueThreadInteractionService.expireStaleRequestConfirmationsForIssueDocument.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByHistoricalComments.mockReset();
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByHistoricalComments.mockResolvedValue([]);
    mockIssueThreadInteractionService.listForIssue.mockReset();
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueRecoveryActionService.getActiveForIssue.mockReset();
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockIssueRecoveryActionService.listActiveForIssues.mockReset();
    mockIssueRecoveryActionService.listActiveForIssues.mockResolvedValue(new Map());
    mockIssueRecoveryActionService.resolveActiveForIssue.mockReset();
    mockIssueRecoveryActionService.resolveActiveForIssue.mockResolvedValue({
      id: recoveryActionId,
      companyId,
      sourceIssueId: issueId,
      recoveryIssueId: null,
      kind: "issue_graph_liveness",
      status: "resolved",
      ownerType: "agent",
      ownerAgentId,
      ownerUserId: null,
      previousOwnerAgentId: null,
      returnOwnerAgentId: null,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:test",
      evidence: {},
      nextAction: "Restore a live execution path.",
      wakePolicy: null,
      monitorPolicy: null,
      attemptCount: 1,
      maxAttempts: null,
      timeoutAt: null,
      lastAttemptAt: new Date("2026-05-13T18:00:00.000Z"),
      outcome: "restored",
      resolutionNote: "Resolved by recovery owner",
      resolvedAt: new Date("2026-05-13T18:05:00.000Z"),
      createdAt: new Date("2026-05-13T17:55:00.000Z"),
      updatedAt: new Date("2026-05-13T18:05:00.000Z"),
    });
    mockTaskWatchdogService.getActiveForIssue.mockReset();
    mockTaskWatchdogService.getActiveForIssue.mockResolvedValue(null);
    mockTaskWatchdogService.revalidateMutationScope.mockReset();
    mockTaskWatchdogService.revalidateMutationScope.mockResolvedValue({
      allowed: true,
      classification: { state: "stopped", stopFingerprint: "task_watchdog_stop:test" },
    });
    mockTaskWatchdogService.reconcileForIssueAndAncestors.mockReset();
    mockTaskWatchdogService.reconcileForIssueAndAncestors.mockResolvedValue({
      checked: 0,
      triggered: 0,
      skipped: 0,
      watchdogIssueIds: [],
    });
    mockTaskWatchdogService.upsertForIssue.mockReset();
    mockTaskWatchdogService.disableForIssue.mockReset();
    mockTaskWatchdogService.disableForIssue.mockResolvedValue(null);
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockReset();
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockReset();
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockIssueApprovalService.link.mockReset();
    mockIssueApprovalService.unlink.mockReset();
    mockIssueApprovalService.listApprovalsForIssue.mockReset();
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.listForIssue.mockReset();
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueService.remove.mockReset();
    mockIssueService.removeAttachment.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockLogActivity.mockClear();
    mockObserveCrossIssueInfluence.mockReset();
    mockObserveCrossIssueInfluence.mockResolvedValue(null);
    mockDocumentService.upsertIssueDocument.mockReset();
    mockWorkProductService.createForIssue.mockReset();
    mockExternalObjectService.getIssueSummaries.mockClear();
    mockExternalObjectService.getIssueSummary.mockClear();
    mockExternalObjectService.getProjectSummary.mockClear();
    mockExternalObjectService.listForIssue.mockClear();
    mockExternalObjectService.refreshIssueObjects.mockClear();
    mockExternalObjectService.syncCommentSafely.mockClear();
    mockExternalObjectService.syncDocumentSafely.mockClear();
    mockExternalObjectService.syncIssueSafely.mockClear();
    mockWorkProductService.getById.mockReset();
    mockWorkProductService.remove.mockReset();
    mockWorkProductService.update.mockReset();
    mockStorageService.putFile.mockReset();
    mockStorageService.getObject.mockReset();
    mockStorageService.headObject.mockReset();
    mockStorageService.deleteObject.mockReset();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === ownerAgentId) return makeAgent(ownerAgentId);
      if (id === peerAgentId) return makeAgent(peerAgentId);
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      makeAgent(ownerAgentId),
      makeAgent(peerAgentId),
    ]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockCompanyService.getById.mockResolvedValue({ id: companyId, issuePrefix: "PAP" });
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.getComment.mockResolvedValue({
      id: "comment-1",
      issueId,
      companyId,
      body: "Mentioned reply context.",
    });
    mockIssueService.list.mockResolvedValue([makeIssue()]);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      ...makeIssue({
        id: "88888888-8888-4888-8888-888888888888",
        status: "todo",
        assigneeAgentId: null,
      }),
      ...input,
      companyId,
    }));
    mockIssueService.createChild.mockImplementation(async (_parentId: string, input: Record<string, unknown>) => ({
      issue: {
        ...makeIssue({
          id: "99999999-9999-4999-8999-999999999999",
          status: "todo",
          parentId: issueId,
          assigneeAgentId: null,
        }),
        ...input,
        companyId,
      },
      parentBlockerAdded: false,
    }));
    mockIssueService.decomposeAcceptedPlan.mockImplementation(async (_sourceIssueId: string, input: Record<string, unknown>) => {
      const children = input.children as Record<string, unknown>[];
      return {
        decomposition: {
          id: "decomposition-1",
          status: "completed",
          childIssueIds: children.map((child) => child.id),
        },
        childIssueIds: children.map((child) => child.id),
        newlyCreatedIssues: children.map((child) => ({
          ...makeIssue({
            id: child.id,
            parentId: issueId,
            status: child.status,
            assigneeAgentId: child.assigneeAgentId ?? null,
          }),
          ...child,
          companyId,
        })),
      };
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.addComment.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      issueId,
      companyId,
      body: "comment",
    });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.listComments.mockResolvedValue([
      {
        id: "comment-1",
        issueId,
        companyId,
        body: "Mentioned reply context.",
      },
    ]);
    mockIssueService.remove.mockResolvedValue(makeIssue({ status: "cancelled" }));
    mockIssueService.getAttachmentById.mockResolvedValue({
      id: "attachment-1",
      issueId,
      companyId,
      objectKey: "issues/attachment-1/report.txt",
      contentType: "text/plain",
      byteSize: 6,
      originalFilename: "report.txt",
    });
    mockIssueService.removeAttachment.mockResolvedValue({
      id: "attachment-1",
      issueId,
      companyId,
      objectKey: "issues/attachment-1/report.txt",
    });
    mockDocumentService.upsertIssueDocument.mockResolvedValue({
      created: false,
      document: {
        id: "document-1",
        key: "plan",
        title: "Plan",
        format: "markdown",
        latestRevisionNumber: 2,
      },
    });
    mockWorkProductService.createForIssue.mockResolvedValue({
      id: "product-2",
      issueId,
      companyId,
      type: "artifact",
      provider: "test",
      title: "Artifact",
    });
    mockWorkProductService.getById.mockResolvedValue({
      id: "product-1",
      issueId,
      companyId,
      type: "artifact",
    });
    mockWorkProductService.update.mockResolvedValue({
      id: "product-1",
      issueId,
      companyId,
      type: "artifact",
      title: "Updated",
    });
    mockWorkProductService.remove.mockResolvedValue({
      id: "product-1",
      issueId,
      companyId,
      type: "artifact",
    });
    mockStorageService.putFile.mockResolvedValue({
      provider: "local_disk",
      objectKey: "issues/upload.txt",
      contentType: "text/plain",
      byteSize: 6,
      sha256: "sha256",
      originalFilename: "upload.txt",
    });
    mockStorageService.getObject.mockResolvedValue({
      stream: Readable.from(Buffer.from("report")),
      contentLength: 6,
    });
    mockStorageService.deleteObject.mockResolvedValue(undefined);
  });

  describe("notify_only agent key on interaction create", () => {
    const keyId = "88888888-8888-4888-8888-888888888888";
    const otherIssueId = "99999999-9999-4999-8999-999999999990";
    const cardBody = {
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Token watch fired. Acknowledge?" },
    };

    function notifyOnlyActor(issueIds: string[]) {
      return {
        type: "agent",
        agentId: peerAgentId,
        companyId,
        source: "agent_key",
        keyId,
        keyScope: { kind: "notify_only", issueIds },
        // intentionally no runId: the pager is not a heartbeat run
      };
    }

    beforeEach(() => {
      mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: ownerAgentId }));
      mockIssueThreadInteractionService.create.mockReset();
      mockIssueThreadInteractionService.create.mockImplementation(async (_issue: unknown, input: Record<string, unknown>) => ({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: input.kind,
        status: "pending",
        sourceRunId: input.sourceRunId ?? null,
        addresseeAgentId: null,
      }));
    });

    it("creates a run-less card on an allow-listed issue with key provenance and no run id", async () => {
      const res = await request(await createApp(notifyOnlyActor([issueId])))
        .post(`/api/issues/${issueId}/interactions`)
        .send(cardBody);

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(mockIssueThreadInteractionService.create).toHaveBeenCalledWith(
        expect.objectContaining({ id: issueId }),
        expect.objectContaining({ sourceRunId: null }),
        expect.objectContaining({ agentId: peerAgentId }),
      );
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.thread_interaction_created",
          actorType: "agent",
          agentId: peerAgentId,
          agentApiKeyId: keyId,
          runId: null,
        }),
      );
    });

    it("returns 403 for an issue that is not on the key allow-list", async () => {
      const res = await request(await createApp(notifyOnlyActor([otherIssueId])))
        .post(`/api/issues/${issueId}/interactions`)
        .send(cardBody);

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.code).toBe("agent_key_scope_violation");
      expect(mockIssueThreadInteractionService.create).not.toHaveBeenCalled();
    });

    it.each(["suggest_tasks", "ask_user_questions"])("returns 403 for a %s card (request_confirmation only)", async (kind) => {
      const res = await request(await createApp(notifyOnlyActor([issueId])))
        .post(`/api/issues/${issueId}/interactions`)
        .send({ kind, payload: {} });

      // Either the kind gate (403) or body validation (400) must refuse; never create.
      expect([400, 403], JSON.stringify(res.body)).toContain(res.status);
      if (res.status === 403) expect(res.body.code).toBe("agent_key_scope_violation");
      expect(mockIssueThreadInteractionService.create).not.toHaveBeenCalled();
    });

    it("rate-limits card creation per key to 10 per hour (429)", async () => {
      const issuesModule = await import("../routes/issues.js");
      issuesModule.resetNotifyOnlyCreateQuotaForTests();
      const app = await createApp(notifyOnlyActor([issueId]));
      for (let i = 0; i < issuesModule.NOTIFY_ONLY_CREATE_LIMIT_PER_HOUR; i += 1) {
        const ok = await request(app).post(`/api/issues/${issueId}/interactions`).send(cardBody);
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      }
      const res = await request(app).post(`/api/issues/${issueId}/interactions`).send(cardBody);
      expect(res.status, JSON.stringify(res.body)).toBe(429);
      expect(res.body.code).toBe("agent_key_rate_limited");
      expect(mockIssueThreadInteractionService.create).toHaveBeenCalledTimes(
        issuesModule.NOTIFY_ONLY_CREATE_LIMIT_PER_HOUR,
      );
    });

    it("keeps the run-id rule for a standard agent key without a run id (401)", async () => {
      mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: peerAgentId, checkoutRunId: null, executionRunId: null }));
      const res = await request(await createApp({
        type: "agent",
        agentId: peerAgentId,
        companyId,
        source: "agent_key",
        keyId,
        keyScope: { kind: "standard" },
      }))
        .post(`/api/issues/${issueId}/interactions`)
        .send(cardBody);

      expect(res.status, JSON.stringify(res.body)).toBe(401);
      expect(res.body.error).toBe("Agent run id required");
      expect(mockIssueThreadInteractionService.create).not.toHaveBeenCalled();
    });

    it("still accepts an agent_jwt with a run id and records that run", async () => {
      mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: peerAgentId, checkoutRunId: null, executionRunId: null }));
      const res = await request(await createApp(peerActor({ source: "agent_jwt" })))
        .post(`/api/issues/${issueId}/interactions`)
        .send(cardBody);

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(mockIssueThreadInteractionService.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sourceRunId: "66666666-6666-4666-8666-666666666666" }),
        expect.anything(),
      );
    });
  });
});
