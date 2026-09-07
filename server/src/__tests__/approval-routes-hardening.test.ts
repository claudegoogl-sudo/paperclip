import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-level tests: approval-card creation must be attributed
// to the authenticated actor and capped per agent. Every case drives the real
// router (`approvalRoutes`), so removing the route's enforcement lines turns
// these red.

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

// Controllable fake for the per-agent create limiter + pending-card count.
// `maxPerAgent` and `pendingCount` are set per test; the limiter records a
// hit only when the route calls `record` (i.e. after a successful create).
const rateLimitControl = vi.hoisted(() => {
  const control = {
    maxPerAgent: 10,
    pendingCount: 0,
    inspected: 0,
    recorded: 0,
    countCalls: 0,
    limiter: {
      inspect(_agentId: string) {
        control.inspected += 1;
        const remaining = Math.max(0, control.maxPerAgent - control.recorded);
        return {
          allowed: remaining > 0,
          limit: control.maxPerAgent,
          remaining,
          retryAfterSeconds: remaining > 0 ? 0 : 42,
        };
      },
      record(_agentId: string) {
        control.recorded += 1;
      },
    },
    countPendingApprovalsForAgent: vi.fn(async () => control.pendingCount),
    reset() {
      control.maxPerAgent = 10;
      control.pendingCount = 0;
      control.inspected = 0;
      control.recorded = 0;
      control.countCalls = 0;
      control.countPendingApprovalsForAgent.mockClear();
    },
  };
  return control;
});

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
  vi.doMock("../services/approval-create-rate-limit.js", () => ({
    countPendingApprovalsForAgent: rateLimitControl.countPendingApprovalsForAgent,
    createApprovalCreateRateLimiter: () => rateLimitControl.limiter,
    defaultApprovalCreateRateLimiter: rateLimitControl.limiter,
  }));
}

const AGENT_ID = "a1000000-0000-4000-8000-000000000001";
const OTHER_AGENT_ID = "b2000000-0000-4000-8000-000000000002";

function createRouteDb(contextSnapshot: Record<string, unknown> = {}, runId = "run-1", agentId = AGENT_ID) {
  const runRows = [{
    id: runId,
    companyId: "company-1",
    agentId,
    contextSnapshot,
  }];
  return {
    select: vi.fn((selection: Record<string, unknown> = {}) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => resolve(
            Object.keys(selection).includes("contextSnapshot") ? runRows : [],
          ),
        })),
      })),
    })),
  } as any;
}

async function createApp(actorOverrides: Record<string, unknown> = {}) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb()));
  app.use(errorHandler);
  return app;
}

async function createAgentApp(options: { agentId?: string; runId?: string } = {}) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  const agentId = options.agentId ?? AGENT_ID;
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId,
      companyId: "company-1",
      runId: options.runId ?? "run-1",
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb({}, options.runId ?? "run-1", agentId)));
  app.use(errorHandler);
  return app;
}

function agentPost(app: express.Express, body: Record<string, unknown>) {
  return request(app)
    .post("/api/companies/company-1/approvals")
    .send({ type: "request_board_approval", payload: { title: "Approve hosting spend" }, ...body });
}

describe("approval create attribution", () => {
  beforeEach(() => {
    vi.resetModules();
    registerModuleMocks();
    vi.clearAllMocks();
    rateLimitControl.reset();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockLogActivity.mockResolvedValue(undefined);
    mockApprovalService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "approval-new",
      companyId: "company-1",
      requestedByUserId: null,
      decidedByUserId: null,
      decidedAt: null,
      ...input,
    }));
  });

  it("AC1: rejects an agent attributing the card to another agent with 403 and creates no row", async () => {
    const res = await agentPost(await createAgentApp(), {
      requestedByAgentId: OTHER_AGENT_ID,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("requestedByAgentId");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).not.toHaveBeenCalled();
  });

  it("AC1/AC6: a rejected spoof attempt is observable as an activity-log denial row", async () => {
    const res = await agentPost(await createAgentApp(), {
      requestedByAgentId: OTHER_AGENT_ID,
    });

    expect(res.status).toBe(403);
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "agent",
        actorId: AGENT_ID,
        action: "approval.create_denied",
        entityType: "agent",
        entityId: OTHER_AGENT_ID,
      }),
    );
    const details = mockLogActivity.mock.calls[0][1].details;
    expect(details).toMatchObject({
      outcome: "denied",
      reason: "requestedByAgentId_mismatch",
      claimedRequestedByAgentId: OTHER_AGENT_ID,
    });
  });

  it("AC2: accepts an agent echoing its own id and attributes the card to it", async () => {
    const res = await agentPost(await createAgentApp(), {
      requestedByAgentId: AGENT_ID,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ requestedByAgentId: AGENT_ID, status: "pending" }),
    );
    expect(res.body).toMatchObject({ requestedByAgentId: AGENT_ID, status: "pending" });
  });

  it("AC3: omits-the-field creates stay attributed to the authenticated agent", async () => {
    const res = await agentPost(await createAgentApp(), {});

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ requestedByAgentId: AGENT_ID }),
    );
    expect(res.body).toMatchObject({ requestedByAgentId: AGENT_ID });
  });

  it("AC4: rejects a user/board actor sending requestedByAgentId with 400 and creates no row", async () => {
    const res = await agentPost(await createApp(), {
      requestedByAgentId: OTHER_AGENT_ID,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "approval.create_denied",
        details: expect.objectContaining({
          reason: "requestedByAgentId_not_allowed_for_user_actor",
        }),
      }),
    );
  });

  it("AC4: user actors may still create cards without requestedByAgentId", async () => {
    const res = await agentPost(await createApp(), {});

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ requestedByAgentId: null, requestedByUserId: "user-1" }),
    );
  });
});

describe("approval create per-agent caps", () => {
  beforeEach(() => {
    vi.resetModules();
    registerModuleMocks();
    vi.clearAllMocks();
    rateLimitControl.reset();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockLogActivity.mockResolvedValue(undefined);
    mockApprovalService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "approval-new",
      companyId: "company-1",
      requestedByUserId: null,
      ...input,
    }));
  });

  it("AC7: the (N+1)th create inside the burst window gets 429 with Retry-After and creates no row", async () => {
    rateLimitControl.maxPerAgent = 2;
    const app = await createAgentApp();

    const first = await agentPost(app, {});
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await agentPost(app, {});
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const third = await agentPost(app, {});

    expect(third.status, JSON.stringify(third.body)).toBe(429);
    expect(third.headers["retry-after"]).toBe("42");
    expect(third.body.error).toContain("Too many approval cards");
    // exactly the two successful creates became rows
    expect(mockApprovalService.create).toHaveBeenCalledTimes(2);
    expect(rateLimitControl.recorded).toBe(2);
  });

  it("AC8: an agent at the pending-card cap gets 429 naming the cap and remedy until a card is resolved", async () => {
    rateLimitControl.pendingCount = 5; // = APPROVAL_CREATE_PENDING_CARD_CAP_PER_AGENT
    const app = await createAgentApp();

    const blocked = await agentPost(app, {});
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(429);
    expect(blocked.body.error).toContain("cap 5");
    expect(blocked.body.error).toContain("withdraw or resolve");
    expect(mockApprovalService.create).not.toHaveBeenCalled();

    // a resolve/withdraw frees budget: the pending count drops, create succeeds
    rateLimitControl.pendingCount = 4;
    const allowed = await agentPost(app, {});
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
  });

  it("AC9: board/user actors are exempt from both caps", async () => {
    rateLimitControl.maxPerAgent = 1;
    rateLimitControl.pendingCount = 99;
    const app = await createApp();

    for (let i = 0; i < 3; i += 1) {
      const res = await agentPost(app, {});
      expect(res.status, `create ${i + 1}: ${JSON.stringify(res.body)}`).toBe(201);
    }
    expect(rateLimitControl.inspected).toBe(0);
    expect(rateLimitControl.countPendingApprovalsForAgent).not.toHaveBeenCalled();
  });

  it("AC10: rejected creates never consume burst budget; each successful create consumes exactly one hit", async () => {
    rateLimitControl.maxPerAgent = 1;
    const app = await createAgentApp();

    // spoof attempt: denied, no budget spent
    const spoof = await agentPost(app, { requestedByAgentId: OTHER_AGENT_ID });
    expect(spoof.status).toBe(403);
    expect(rateLimitControl.recorded).toBe(0);

    // pending-cap rejection: still no budget spent
    rateLimitControl.pendingCount = 5;
    const capped = await agentPost(app, {});
    expect(capped.status).toBe(429);
    expect(rateLimitControl.recorded).toBe(0);

    // with the cap freed the legit create still has its full budget
    rateLimitControl.pendingCount = 0;
    const ok = await agentPost(app, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(rateLimitControl.recorded).toBe(1);
    expect(rateLimitControl.inspected).toBe(3);
  });

  it("AC10: this route has no idempotency/dedupe path — two identical creates consume two hits", async () => {
    const app = await createAgentApp();

    const first = await agentPost(app, {});
    const second = await agentPost(app, {});
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledTimes(2);
    expect(rateLimitControl.recorded).toBe(2);
  });

  it("AC7: burst-cap hits are keyed per agent — another agent's budget is untouched", async () => {
    rateLimitControl.maxPerAgent = 1;
    const appA = await createAgentApp();
    const appB = await createAgentApp({ agentId: OTHER_AGENT_ID });

    const a1 = await agentPost(appA, {});
    const a2 = await agentPost(appA, {});
    const b1 = await agentPost(appB, {});
    expect(a1.status).toBe(201);
    expect(a2.status).toBe(429);
    expect(b1.status, JSON.stringify(b1.body)).toBe(201);
  });
});
