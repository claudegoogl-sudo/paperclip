import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
}));

let agentApp: express.Express;

beforeAll(async () => {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const runRows = [
    {
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      contextSnapshot: {},
    },
  ];
  const routeDb = {
    select: vi.fn((selection: Record<string, unknown> = {}) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) =>
            resolve(Object.keys(selection).includes("contextSnapshot") ? runRows : []),
        })),
      })),
    })),
  } as any;
  agentApp = express();
  agentApp.use(express.json());
  agentApp.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  agentApp.use("/api", approvalRoutes(routeDb));
  agentApp.use(errorHandler);
});

function mockCreatedApproval(payload: unknown) {
  mockApprovalService.create.mockResolvedValue({
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    status: "pending",
    payload,
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-09-07T00:00:00.000Z"),
    updatedAt: new Date("2026-09-07T00:00:00.000Z"),
  });
}

describe("approval create rejects contentless payloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("returns 422 for an empty payload and persists nothing", async () => {
    const res = await request(agentApp)
      .post("/api/companies/company-1/approvals")
      .send({ type: "request_board_approval", payload: {} });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("payload must not be empty");
    expect(res.body.code).toBe("approval_payload_empty");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("accepts a payload with at least one key, even when the value is null", async () => {
    mockCreatedApproval({ note: null });

    const res = await request(agentApp)
      .post("/api/companies/company-1/approvals")
      .send({ type: "request_board_approval", payload: { note: null } });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ payload: { note: null } }),
    );
  });

  it("still creates normally titled payloads unchanged", async () => {
    mockCreatedApproval({ title: "Approve hosting spend" });

    const res = await request(agentApp)
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: { title: "Approve hosting spend" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "approval.created" }),
    );
  });

  it("keeps a missing payload a 400 shape-validation error, not the 422 content guard", async () => {
    const res = await request(agentApp)
      .post("/api/companies/company-1/approvals")
      .send({ type: "request_board_approval" });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });
});
