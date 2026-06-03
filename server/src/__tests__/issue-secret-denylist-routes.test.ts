import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PLA-842 AC §2 / §4: the write-block denylist is verified through the REAL
 * Express route handlers and the REAL structured 422 response — the secret
 * matcher is not mocked. We drive a synthetic secret fixture through each
 * guarded surface (POST create description, PATCH description/comment/title,
 * POST comment body) and assert the API returns 422 naming the matched class,
 * the persistence service is never called (body not stored), and a clean body
 * still passes through to the service. Fixtures are synthetic, shape-valid,
 * non-live values (PLA-177 / PLA-319: zero live secret bytes).
 */

const GITHUB_PAT = `github_pat_${"A".repeat(82)}`;

function b64url(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function makeJwt(claims: Record<string, unknown>): string {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  return `${header}.${b64url(claims)}.c2lnbmF0dXJl`;
}

const THIRD_PARTY_JWT = makeJwt({ iss: "https://login.auth0.example/", sub: "u1" });
const PAPERCLIP_JWT = makeJwt({ iss: "paperclip", sub: "run-1" });

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";

const mockIssueService = vi.hoisted(() => ({
  clearOrphanCheckoutLocksIfTerminal: vi.fn(async () => false),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockDb = vi.hoisted(() => ({
  select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ orderBy: vi.fn(async () => []) })) })) })),
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));
const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
}));
const mockIssueTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
}));
const mockIssueReferenceService = vi.hoisted(() => ({
  deleteDocumentSource: vi.fn(async () => undefined),
  diffIssueReferenceSummary: vi.fn(() => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  })),
  emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  syncComment: vi.fn(async () => undefined),
  syncDocument: vi.fn(async () => undefined),
  syncIssue: vi.fn(async () => undefined),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/access.js", () => ({ accessService: () => mockAccessService }));
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));
vi.mock("../services/agents.js", () => ({ agentService: () => mockAgentService }));
vi.mock("../services/feedback.js", () => ({ feedbackService: () => mockFeedbackService }));
vi.mock("../services/heartbeat.js", () => ({ heartbeatService: () => mockHeartbeatService }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => mockInstanceSettingsService }));
vi.mock("../services/issues.js", () => ({ issueService: () => mockIssueService }));
vi.mock("../services/routines.js", () => ({ routineService: () => mockRoutineService }));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => mockFeedbackService,
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => mockIssueRecoveryActionService,
  issueReferenceService: () => mockIssueReferenceService,
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  issueTreeControlService: () => mockIssueTreeControlService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => ({}),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

async function installActor(app: express.Express, actor?: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  app.use((req, _res, next) => {
    (req as express.Request & { actor: unknown }).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as never, {} as never));
  app.use(errorHandler);
  return app;
}

function makeIssue() {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "todo" as const,
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-842",
    title: "Secret denylist target",
  };
}

describe.sequential("issue write-block secret denylist routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.clearOrphanCheckoutLocksIfTerminal.mockResolvedValue(false);
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.create.mockResolvedValue({ ...makeIssue(), title: "ok" });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: ISSUE_ID,
      companyId: "company-1",
      body: "clean",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: ISSUE_ID,
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow", explanation: "ok" });
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockIssueTreeControlService.getActivePauseHoldGate.mockResolvedValue(null);
  });

  it("blocks a github_pat in a new issue description with a structured 422 and never persists", async () => {
    const res = await request(await installActor(createApp()))
      .post("/api/companies/company-1/issues")
      .send({ title: "leak attempt", description: `please use ${GITHUB_PAT} to deploy` });

    expect(res.status).toBe(422);
    expect(res.body.blockedPattern).toBe("github_pat");
    expect(res.body.surface).toBe("description");
    // The matched value is never echoed back to the client.
    expect(JSON.stringify(res.body)).not.toContain(GITHUB_PAT);
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  // PLA-842 Finding 3 regression: create-issue `title` is a stored, rendered
  // free-text field and must be guarded symmetrically with PATCH `title`. Fails
  // on pre-fix code, where the create guard only covered `description`.
  it("blocks a github_pat in a new issue title and never persists", async () => {
    const res = await request(await installActor(createApp()))
      .post("/api/companies/company-1/issues")
      .send({ title: `deploy with ${GITHUB_PAT}`, description: "clean" });

    expect(res.status).toBe(422);
    expect(res.body.blockedPattern).toBe("github_pat");
    expect(res.body.surface).toBe("title");
    expect(JSON.stringify(res.body)).not.toContain(GITHUB_PAT);
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("blocks a github_pat in a PATCH description", async () => {
    const res = await request(await installActor(createApp()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ description: `rotated to ${GITHUB_PAT}` });

    expect(res.status).toBe(422);
    expect(res.body.blockedPattern).toBe("github_pat");
    expect(res.body.surface).toBe("description");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("blocks a github_pat in a PATCH comment", async () => {
    const res = await request(await installActor(createApp()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ comment: `here it is ${GITHUB_PAT}` });

    expect(res.status).toBe(422);
    expect(res.body.blockedPattern).toBe("github_pat");
    expect(res.body.surface).toBe("comment");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("blocks a github_pat in a POST comment body and never stores it", async () => {
    const res = await request(await installActor(createApp()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: `token ${GITHUB_PAT}` });

    expect(res.status).toBe(422);
    expect(res.body.blockedPattern).toBe("github_pat");
    expect(res.body.surface).toBe("body");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("blocks a third-party JWT in a comment body (Option A)", async () => {
    const res = await request(await installActor(createApp()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: `Authorization: Bearer ${THIRD_PARTY_JWT}` });

    expect(res.status).toBe(422);
    expect(res.body.blockedPattern).toBe("jwt");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("allows a Paperclip run JWT in a comment body (Option A)", async () => {
    const res = await request(await installActor(createApp()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: `debug output: ${PAPERCLIP_JWT}` });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalled();
  });

  it("passes a clean comment body through to the service", async () => {
    const res = await request(await installActor(createApp()))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "a perfectly ordinary follow-up note" });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalled();
  });
});
