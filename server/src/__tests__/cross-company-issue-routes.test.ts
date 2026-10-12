import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { heartbeatRuns as heartbeatRunsTable } from "@paperclipai/db";

// Booting the route graph pulls in nearly every server service module; since the
// v2026.824.1 merge that cold import alone can exceed the 5s default test
// timeout, which killed the first tests in this file (the route module is cached
// after the first import, so later tests never saw the cost).
vi.setConfig({ testTimeout: 30_000 });

const AGENT_RUN_ID = "44444444-4444-4444-8444-444444444444";
const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const PREVIOUS_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const MENTIONED_AGENT_ID = "33333333-3333-4333-8333-333333333333";

const mockIssueService = vi.hoisted(() => ({
  clearOrphanCheckoutLocksIfTerminal: vi.fn(async () => false),
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  listReviewAttention: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: { id: raw },
    })),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({ getIssueDocumentPayload: vi.fn(async () => ({})) }),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({ getDefaultCompanyGoal: vi.fn(async () => null), getById: vi.fn(async () => null) }),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
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
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
}));

const BOARD_ACTOR = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

// Hoisted module mocks, not per-test vi.doMock + vi.resetModules: the mock
// registry must be in place before ANY import of the routes module, in every
// test. createApp concurrently imports middleware and route modules whose
// graphs both contain services/index.js. With doMock-registered mocks that
// first evaluation could race the registry under load and bind the REAL
// services module, rejecting the request under test with a 500 (observed on
// CI in the serialized shard; see PRs #381/#383). A hoisted vi.mock applies
// to every import graph deterministically.
vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: { id: raw },
    })),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({ getIssueDocumentPayload: vi.fn(async () => ({})) }),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({ getDefaultCompanyGoal: vi.fn(async () => null), getById: vi.fn(async () => null) }),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
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
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
}));
// Agent-authored writes resolve source trust by querying the DB, which the
// stubbed `{}` db in this suite cannot serve. Stub it to a no-trust result so
// agent-actor comment POSTs exercise the wake fan-out rather than the db.
vi.mock("../services/source-trust.js", async () => {
  const actual = await vi.importActual<typeof import("../services/source-trust.js")>(
    "../services/source-trust.js",
  );
  return { ...actual, resolveActorSourceTrustForIssue: vi.fn(async () => null) };
});


const CONCIERGE = "b30654b6-2c2f-48b9-b108-1e07e417996d";
const CONTROL = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const state = { grant: true };

function actor(agentId: string) {
  return { type: "agent", agentId, companyId: "home-co", source: "agent_key", runId: AGENT_RUN_ID };
}

async function createApp(a: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = a; next(); });
  const rowsFor = (table: unknown) => {
    const n = (table as Record<symbol, string | undefined> | null | undefined)?.[Symbol.for("drizzle:Name")];
    if (n === "principal_permission_grants") return state.grant ? [{ id: "g1" }] : [];
    if (n === "companies") return [{ status: "active" }];
    if (n === "heartbeat_runs") return [{ id: AGENT_RUN_ID, companyId: "home-co", agentId: a.agentId, responsibleUserId: null, contextSnapshot: { issueId: ISSUE_ID } }];
    if (n !== "instance_settings") return [];
    return [{ id: "instance-settings", defaultEnvironmentId: null, general: {}, experimental: {}, createdAt: new Date(0), updatedAt: new Date(0) }];
  };
  const selectStub = () => {
    let rows: unknown[] = [];
    const t: any = Object.assign(Promise.resolve().then(() => rows), {});
    for (const k of ["where", "for", "limit", "orderBy", "groupBy", "innerJoin", "leftJoin", "offset"]) t[k] = () => t;
    return { from: (table: unknown) => { rows = rowsFor(table); return t; } };
  };
  const insertStub = () => ({ values: async () => [] });
  const txStub = { select: selectStub, insert: insertStub };
  app.use("/api", issueRoutes({
    select: selectStub, insert: insertStub,
    transaction: async (cb: (tx: Record<string, unknown>) => Promise<unknown>) => cb(txStub),
  } as any, {} as any));
  app.use(errorHandler);
  return app;
}

const foreign = () => ({
  id: ISSUE_ID, companyId: "target-co", status: "todo", priority: "medium", projectId: null, goalId: null,
  parentId: null, assigneeAgentId: null, assigneeUserId: null, createdByUserId: "u", identifier: "X-1",
  title: "t", executionPolicy: null, executionState: null, hiddenAt: null,
});

describe("cross-company issue access over HTTP", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    state.grant = true;
    process.env.PAPERCLIP_CROSS_COMPANY_ISSUE_AGENT_IDS = CONCIERGE;
    const m = await import("../routes/cross-company-issue-access.js");
    m.resetCrossCompanyAllowlistForTests();
    mockIssueService.getById.mockResolvedValue(foreign());
    mockIssueService.getByIdForUpdate.mockImplementation(async () => foreign());
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.listReviewAttention.mockResolvedValue(new Map());
    for (const k of ["getAncestors", "findMentionedProjectIds"]) (mockIssueService as any)[k] = vi.fn(async () => []);
    for (const k of ["listBlockerAttention", "listProductivityReviews"]) (mockIssueService as any)[k] = vi.fn(async () => new Map());
    (mockIssueService as any).getActiveInboxArchiveFields = vi.fn(async () => ({}));
    (mockIssueService as any).listComments = vi.fn(async () => []);
    (mockIssueService as any).getCommentCursor = vi.fn(async () => ({ totalComments: 0, latestCommentId: null }));
    mockIssueService.addComment.mockResolvedValue({ id: "c1", issueId: ISSUE_ID, companyId: "target-co", body: "hi" });
    mockIssueService.update.mockResolvedValue(foreign());
  });

  const missing = async () => {
    mockIssueService.getById.mockResolvedValue(null);
    return (await request(await createApp(actor(CONTROL))).get(`/api/issues/${ISSUE_ID}`)).body;
  };

  it("GET: allowed with both keys, 404 identical to missing otherwise", async () => {
    const gr = await request(await createApp(actor(CONCIERGE))).get(`/api/issues/${ISSUE_ID}`);
    if (gr.status !== 200) console.log("GETBODY", JSON.stringify(gr.body));
    expect(gr.status).toBe(200);
    const miss = await missing();
    mockIssueService.getById.mockResolvedValue(foreign());
    const ctl = await request(await createApp(actor(CONTROL))).get(`/api/issues/${ISSUE_ID}`);
    expect(ctl.status).toBe(404);
    expect(ctl.body).toEqual(miss);
    state.grant = false;
    expect((await request(await createApp(actor(CONCIERGE))).get(`/api/issues/${ISSUE_ID}`)).status).toBe(404);
    state.grant = true;
    process.env.PAPERCLIP_CROSS_COMPANY_ISSUE_AGENT_IDS = "";
    (await import("../routes/cross-company-issue-access.js")).resetCrossCompanyAllowlistForTests();
    expect((await request(await createApp(actor(CONCIERGE))).get(`/api/issues/${ISSUE_ID}`)).status).toBe(404);
  });

  it("GET comments: same matrix", async () => {
    expect((await request(await createApp(actor(CONCIERGE))).get(`/api/issues/${ISSUE_ID}/comments`)).status).toBe(200);
    expect((await request(await createApp(actor(CONTROL))).get(`/api/issues/${ISSUE_ID}/comments`)).status).toBe(404);
    state.grant = false;
    expect((await request(await createApp(actor(CONCIERGE))).get(`/api/issues/${ISSUE_ID}/comments`)).status).toBe(404);
  });

  it("POST comment: 201 attributed to the agent run; denied otherwise; reopen rejected", async () => {
    const ok = await request(await createApp(actor(CONCIERGE))).post(`/api/issues/${ISSUE_ID}/comments`).send({ body: "hi" });
    if (ok.status !== 201) console.log("POSTBODY", JSON.stringify(ok.body));
    expect(ok.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalled();
    expect(JSON.stringify(mockIssueService.addComment.mock.calls[0])).toContain(CONCIERGE);
    expect((await request(await createApp(actor(CONTROL))).post(`/api/issues/${ISSUE_ID}/comments`).send({ body: "hi" })).status).toBe(404);
    state.grant = false;
    expect((await request(await createApp(actor(CONCIERGE))).post(`/api/issues/${ISSUE_ID}/comments`).send({ body: "hi" })).status).toBe(404);
    state.grant = true;
    expect((await request(await createApp(actor(CONCIERGE))).post(`/api/issues/${ISSUE_ID}/comments`).send({ body: "hi", reopen: true })).status).toBe(422);
  });

  it("PATCH: allowed with both keys, denied otherwise", async () => {
    const pr = await request(await createApp(actor(CONCIERGE))).patch(`/api/issues/${ISSUE_ID}`).send({ title: "n" });
    if (pr.status !== 200) console.log("PATCHBODY", JSON.stringify(pr.body));
    expect(pr.status).toBe(200);
    expect((await request(await createApp(actor(CONTROL))).patch(`/api/issues/${ISSUE_ID}`).send({ title: "n" })).status).toBe(404);
    state.grant = false;
    expect((await request(await createApp(actor(CONCIERGE))).patch(`/api/issues/${ISSUE_ID}`).send({ title: "n" })).status).toBe(404);
  });

  it("low-trust-style scoped key and onBehalfOfUser never get the exemption", async () => {
    expect((await request(await createApp({ ...actor(CONCIERGE), keyScope: "notify_only" })).get(`/api/issues/${ISSUE_ID}`)).status).toBe(404);
    expect((await request(await createApp({ ...actor(CONCIERGE), onBehalfOfUserId: "u1" })).get(`/api/issues/${ISSUE_ID}`)).status).toBe(404);
  });

  it("negative control: other issue routes still deny the foreign agent", async () => {
    const a = await createApp(actor(CONCIERGE));
    for (const [m, u] of [["delete", `/api/issues/${ISSUE_ID}`], ["post", `/api/issues/${ISSUE_ID}/checkout`], ["post", `/api/issues/${ISSUE_ID}/release`]] as const) {
      const r = await (request(a) as any)[m](u).send({});
      expect([400, 403, 404]).toContain(r.status);
      expect(r.status).not.toBe(200);
    }
  });
});
