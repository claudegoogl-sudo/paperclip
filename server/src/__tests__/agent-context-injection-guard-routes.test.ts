import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(),
  createAgentRegistry: vi.fn(),
  createRuntimeStore: vi.fn(),
  isAcpRuntimeError: vi.fn(() => false),
}));

const mockFindServerAdapter = vi.hoisted(() => vi.fn());
const mockFindActiveServerAdapter = vi.hoisted(() => vi.fn());

vi.mock("../adapters/index.js", () => ({
  detectAdapterModel: vi.fn(),
  findActiveServerAdapter: mockFindActiveServerAdapter,
  findServerAdapter: mockFindServerAdapter,
  listAdapterModels: vi.fn(),
  listAdapterModelProfiles: vi.fn(),
  refreshAdapterModels: vi.fn(),
  requireServerAdapter: vi.fn(),
}));

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: null,
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-03-19T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => config,
  ),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
}));

const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));

  vi.doMock("../services/agent-instructions.js", () => ({
    agentInstructionsService: () => mockAgentInstructionsService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => ({}),
    companySkillService: () => ({}),
    budgetService: () => ({}),
    heartbeatService: () => ({}),
    issueApprovalService: () => ({}),
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => ({}),
    environmentService: () => mockEnvironmentService,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/agents.js") as Promise<typeof import("../routes/agents.js")>,
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

describe("agent adapterConfig context-injection guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation(
      (_agent: unknown, config: Record<string, unknown>) => config,
    );
    mockFindServerAdapter.mockImplementation((type: string) => (type ? { type } : null));
    mockFindActiveServerAdapter.mockImplementation((type: string) => (type ? { type } : null));
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant",
    });
    mockAgentService.getById.mockResolvedValue({ ...baseAgent });
    mockAgentService.update.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => ({
        ...baseAgent,
        adapterConfig: (patch.adapterConfig as Record<string, unknown>) ?? {},
      }),
    );
  });

  it("blocks agent self-updates that set adapterConfig.contextFiles", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterConfig: {
          contextFiles: ["/home/operator/.paperclip/auth.json"],
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("context-injection configuration");
    expect(res.body.error).toContain("adapterConfig.contextFiles");
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("blocks agent self-updates that set adapterConfig.injectClaudeContext", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterConfig: {
          injectClaudeContext: true,
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("context-injection configuration");
    expect(res.body.error).toContain("adapterConfig.injectClaudeContext");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("blocks agent self-updates that set context-injection keys in nested model profiles", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${agentId}`)
      .send({
        runtimeConfig: {
          modelProfiles: {
            cheap: {
              adapterConfig: {
                contextFiles: ["/home/operator/.paperclip/.env"],
              },
            },
          },
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("context-injection configuration");
    expect(res.body.error).toContain(
      "runtimeConfig.modelProfiles.cheap.adapterConfig.contextFiles",
    );
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects instructions-bundle keys with the same error as context-injection keys", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterConfig: {
          instructionsFilePath: "/etc/passwd",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain(
      "instructions path, bundle, or context-injection configuration",
    );
    expect(res.body.error).toContain("adapterConfig.instructionsFilePath");
  });

  it("allows board updates that set context-injection keys", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const adapterConfig = {
      contextFiles: ["/srv/paperclip/context/overview.md"],
      injectClaudeContext: true,
    };

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${agentId}`)
      .send({ adapterConfig }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          contextFiles: adapterConfig.contextFiles,
          injectClaudeContext: true,
        }),
      }),
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent.updated",
    }));
  });

  it("allows agent self-updates that only touch unrelated adapterConfig keys", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterConfig: {
          model: "test-model",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        adapterConfig: expect.objectContaining({ model: "test-model" }),
      }),
      expect.anything(),
    );
  });
});
