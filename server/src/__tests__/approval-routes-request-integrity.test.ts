import express from "express";
import request from "supertest";
import { beforeEach, beforeAll, describe, expect, it, vi } from "vitest";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  withdraw: vi.fn(),
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

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
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

function createRouteDb(contextSnapshot: Record<string, unknown> = {}, runId = "run-1", agentId = "agent-1") {
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

async function createAgentApp(options: { runId?: string; agentId?: string } = {}) {
  return createApp({
    type: "agent",
    agentId: options.agentId ?? "agent-1",
    companyId: "company-1",
    runId: options.runId ?? "run-1",
    source: "api_key",
    isInstanceAdmin: false,
  });
}

function pendingApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    status: "pending",
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    payload: {},
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-09-07T00:00:00Z"),
    updatedAt: new Date("2026-09-07T00:00:00Z"),
    ...overrides,
  };
}

describe("approval creation payload validation", () => {
  // Pay the cold module-graph transform cost once, outside the per-test budget.
  beforeAll(async () => {
    await createApp();
  }, 30_000);

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockImplementation(
      async (_companyId: string, payload: Record<string, unknown>) => payload,
    );
    mockApprovalService.create.mockResolvedValue(pendingApproval());
    mockLogActivity.mockResolvedValue(undefined);
    mockIssueApprovalService.linkManyForApproval.mockResolvedValue(undefined);
  });

  it("rejects an empty request_board_approval payload with 400 and writes no row", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/approvals")
      .send({ type: "request_board_approval", payload: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects a request_board_approval payload with a whitespace-only title", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/approvals")
      .send({ type: "request_board_approval", payload: { title: "   ", summary: "why" } });

    expect(res.status).toBe(400);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("rejects a request_board_approval payload with a missing summary", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/approvals")
      .send({ type: "request_board_approval", payload: { title: "Ask" } });

    expect(res.status).toBe(400);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("rejects a request_board_approval payload with a non-string summary", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/approvals")
      .send({ type: "request_board_approval", payload: { title: "Ask", summary: 42 } });

    expect(res.status).toBe(400);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("accepts a usable request_board_approval payload and trims the fields", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: {
          title: "  Rotate the leaked key  ",
          summary: "The key was published; Step 1 is irreversible.\nPlease approve rotation.",
          risks: ["irreversible"],
        },
      });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
    const created = mockApprovalService.create.mock.calls[0][1];
    expect(created.payload.title).toBe("Rotate the leaked key");
    expect(created.payload.risks).toEqual(["irreversible"]);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "approval.created" }),
    );
  });

  it("does not require new fields for hire_agent approvals", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/approvals")
      .send({ type: "hire_agent", payload: { name: "Scout", role: "scout" } });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
  });

  it("does not require new fields for budget_override_required approvals", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/approvals")
      .send({ type: "budget_override_required", payload: { amountObserved: 5_000_000 } });

    expect(res.status).toBe(201);
  });

  it("does not require new fields for approve_ceo_strategy approvals", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/approvals")
      .send({ type: "approve_ceo_strategy", payload: { strategy: "grow" } });

    expect(res.status).toBe(201);
  });
});

describe("approval withdraw route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("lets the requesting agent withdraw its own pending approval and logs agent + run", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval());
    mockApprovalService.withdraw.mockResolvedValue({
      approval: pendingApproval({ status: "withdrawn" }),
      applied: true,
    });

    const res = await request(await createAgentApp())
      .post("/api/approvals/approval-1/withdraw")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("withdrawn");
    expect(mockApprovalService.withdraw).toHaveBeenCalledWith("approval-1", {
      agentId: "agent-1",
      runId: "run-1",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "approval.withdrawn",
        agentId: "agent-1",
        runId: "run-1",
        entityType: "approval",
        entityId: "approval-1",
      }),
    );
  });

  it("treats a repeated withdraw by the same agent as a converging no-op", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval({ status: "withdrawn" }));
    mockApprovalService.withdraw.mockResolvedValue({
      approval: pendingApproval({ status: "withdrawn" }),
      applied: false,
    });

    const res = await request(await createAgentApp())
      .post("/api/approvals/approval-1/withdraw")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("withdrawn");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("refuses withdrawal by a different agent with 403", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval({ requestedByAgentId: "agent-2" }));

    const res = await request(await createAgentApp({ agentId: "agent-1" }))
      .post("/api/approvals/approval-1/withdraw")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.withdraw).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("refuses withdrawal by a board actor with 403", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval({ requestedByAgentId: "agent-1" }));

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/withdraw")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.withdraw).not.toHaveBeenCalled();
  });

  it("surfaces the service refusal for an already-decided approval as 422", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval({ status: "approved" }));
    mockApprovalService.withdraw.mockRejectedValue(
      Object.assign(new Error("Only pending approvals can be withdrawn"), { status: 422 }),
    );

    const res = await request(await createAgentApp())
      .post("/api/approvals/approval-1/withdraw")
      .send({});

    expect(res.status).toBe(422);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown approval", async () => {
    mockApprovalService.getById.mockResolvedValue(null);

    const res = await request(await createAgentApp())
      .post("/api/approvals/does-not-exist/withdraw")
      .send({});

    expect(res.status).toBe(404);
  });

  it("folds a cross-tenant approval into the same 404 as a missing one", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval({ companyId: "company-2" }));

    const res = await request(await createAgentApp())
      .post("/api/approvals/approval-1/withdraw")
      .send({});

    expect(res.status).toBe(404);
    expect(mockApprovalService.withdraw).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
