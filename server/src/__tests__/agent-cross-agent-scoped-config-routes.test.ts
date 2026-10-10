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

const agentId = "11111111-1111-4111-8111-111111111111"; // ScanBot (in grant scope)
const conciergeId = "44444444-4444-4444-8444-444444444444";
const ceoId = "55555555-5555-4555-8555-555555555555"; // NOT in grant scope
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

// Hoisted module mocks, not per-test vi.doMock + vi.resetModules: the mock
// registry must be in place before ANY import of the routes module, in every
// test. createApp concurrently imports middleware and route modules whose
// graphs both contain services/index.js. With doMock-registered mocks that
// first evaluation could race the registry under load and bind the REAL
// services module, rejecting the request under test with a 500 (observed on
// CI in the serialized shard; see PRs #381/#383). A hoisted vi.mock applies
// to every import graph deterministically.
vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/agent-instructions.js", () => ({
  agentInstructionsService: () => mockAgentInstructionsService,
  syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/index.js", () => ({
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


const grantScopeTargetIds = [agentId];

function conciergeActor() {
  return { type: "agent", agentId: conciergeId, companyId, source: "agent_key", runId: "run-1" };
}

describe("cross-agent PATCH /agents/:id: scoped agents:configure + model-only allow-list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation(
      (_agent: unknown, config: Record<string, unknown>) => config,
    );
    mockFindServerAdapter.mockImplementation((type: string) => (type ? { type } : null));
    mockFindActiveServerAdapter.mockImplementation((type: string) => (type ? { type } : null));
    // Emulates an agents:configure grant scoped to {targetAgentIds:[ScanBot]}:
    // allowed only when the requested scope names a target in the grant scope.
    mockAccessService.decide.mockImplementation(async (input: any) => {
      const target = input.scope?.targetAgentId;
      if (typeof target === "string" && grantScopeTargetIds.includes(target)) {
        return { allowed: true, reason: "allow_explicit_grant", explanation: "scoped grant" };
      }
      return { allowed: false, reason: "deny_scope", explanation: "Permission agents:configure does not cover the requested scope." };
    });
    mockAgentService.getById.mockImplementation(async (id: string) => ({
      ...baseAgent,
      id,
      name: id === ceoId ? "CEO" : "ScanBot",
      adapterConfig: { model: "old", env: { KEEP: "1" } },
    }));
    mockAgentService.update.mockImplementation(
      async (id: string, patch: Record<string, unknown>) => ({
        ...baseAgent,
        id,
        adapterConfig: (patch.adapterConfig as Record<string, unknown>) ?? {},
      }),
    );
  });

  async function patch(target: string, payload: Record<string, unknown>, actor = conciergeActor()) {
    const app = await createApp(actor);
    return requestApp(app, (baseUrl) => request(baseUrl).patch(`/api/agents/${target}`).send(payload));
  }

  it("AC1: allows model change on an agent inside the grant scope and passes targetAgentId", async () => {
    const res = await patch(agentId, { adapterConfig: { model: "x" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAccessService.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agent_config:update",
        scope: expect.objectContaining({ targetAgentId: agentId }),
      }),
    );
    expect(mockAgentService.update).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({ adapterConfig: expect.objectContaining({ model: "x", env: { KEEP: "1" } }) }),
      expect.anything(),
    );
  });

  it("AC1: allows fallbackModel change on an agent inside the grant scope", async () => {
    const res = await patch(agentId, { adapterConfig: { fallbackModel: "y" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("AC2: denies the same model change on an agent outside the grant scope (deny_scope)", async () => {
    const res = await patch(ceoId, { adapterConfig: { model: "x" } });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain("deny_scope");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it.each([
    ["adapterConfig.env", { adapterConfig: { env: { FOO: "bar" } } }],
    ["adapterConfig.env with model", { adapterConfig: { model: "x", env: {} } }],
    ["adapterConfig.command", { adapterConfig: { command: "/bin/sh" } }],
    ["replaceAdapterConfig", { adapterConfig: { model: "x" }, replaceAdapterConfig: true }],
    ["runtimeConfig", { runtimeConfig: {} }],
    ["name", { name: "pwned" }],
    ["title", { title: "pwned" }],
  ])("AC3-5: rejects %s from an agent caller on another agent", async (_label, payload) => {
    const res = await patch(agentId, payload);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("AC5: self-update by an agent is unchanged (non-model fields allowed)", async () => {
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow_self", explanation: "self" });
    const res = await patch(conciergeId, { title: "New title", adapterConfig: { command: "x" } }, conciergeActor());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("AC6: board callers are not subject to the agent allow-list", async () => {
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow_board", explanation: "board" });
    const res = await patch(
      agentId,
      { adapterConfig: { env: { FOO: "bar" } }, title: "t" },
      { type: "board", userId: "user-1", source: "local_implicit", isInstanceAdmin: true, companyIds: [companyId] } as any,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe("cross-agent non-PATCH agent-config writes are self-only for agent callers (F1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Grant allows everything: the route guard, not the grant, must deny.
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow_explicit_grant", explanation: "grant" });
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentService.getById.mockImplementation(async (id: string) => ({ ...baseAgent, id, adapterConfig: {} }));
  });

  const routes: Array<[string, (r: ReturnType<typeof request>) => any]> = [
    ["PATCH instructions-path", (r) => r.patch(`/api/agents/${agentId}/instructions-path`).send({ path: "AGENTS.md" })],
    ["PATCH instructions-bundle", (r) => r.patch(`/api/agents/${agentId}/instructions-bundle`).send({ mode: "managed" })],
    ["PUT instructions-bundle/file", (r) => r.put(`/api/agents/${agentId}/instructions-bundle/file`).send({ path: "AGENTS.md", content: "x" })],
    ["DELETE instructions-bundle/file", (r) => r.delete(`/api/agents/${agentId}/instructions-bundle/file?path=AGENTS.md`)],
    ["POST skills/sync", (r) => r.post(`/api/agents/${agentId}/skills/sync`).send({ mode: "replace", desiredSkills: [] })],
    ["POST config rollback", (r) => r.post(`/api/agents/${agentId}/config-revisions/rev-1/rollback`).send({})],
  ];

  it.each(routes)("%s on another agent by an agent caller -> 403", async (_label, call) => {
    const app = await createApp(conciergeActor());
    const res = await requestApp(app, (baseUrl) => call(request(baseUrl)));
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    // instructions-path is already board-only upstream of the new guard.
    expect(JSON.stringify(res.body)).toMatch(/on another agent|Only board-authenticated/);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });
});

describe("cross-agent resume stays grant-gated and is bound to the grant's target scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockImplementation(async (input: any) => {
      const target = input.scope?.targetAgentId;
      if (typeof target === "string" && grantScopeTargetIds.includes(target)) {
        return { allowed: true, reason: "allow_explicit_grant", explanation: "scoped grant" };
      }
      return { allowed: false, reason: "deny_scope", explanation: "Permission agents:configure does not cover the requested scope." };
    });
    mockAgentService.getById.mockImplementation(async (id: string) => ({ ...baseAgent, id, status: "paused" }));
  });

  it("denies resume of an agent outside the grant scope (deny_scope)", async () => {
    const app = await createApp(conciergeActor());
    const res = await requestApp(app, (baseUrl) => request(baseUrl).post(`/api/agents/${ceoId}/resume`).send({}));
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(JSON.stringify(res.body)).toContain("deny_scope");
  });
});
