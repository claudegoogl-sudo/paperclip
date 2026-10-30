import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectToolContext = vi.hoisted(() => vi.fn());
const mockProjectToolDefinitions = vi.hoisted(() => vi.fn());
const mockCallProjectTool = vi.hoisted(() => vi.fn());

vi.mock("../services/project-tool-context.js", () => ({
  projectToolContext: mockProjectToolContext,
}));

vi.mock("../services/project-tools.js", () => ({
  projectToolDefinitions: mockProjectToolDefinitions,
  callProjectTool: mockCallProjectTool,
}));

vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: vi.fn(),
}));

async function createApp() {
  const [{ projectToolRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/project-tools.js")>("../routes/project-tools.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "agent", source: "agent_key", agentId: "agent-1", companyId: "company-1", runId: "run-1" };
    next();
  });
  app.use("/api", projectToolRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("project tool routes", () => {
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    app = await createApp();
  }, 120_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectToolContext.mockResolvedValue({
      run: { companyId: "company-1", agentId: "agent-1" },
      issue: { id: "issue-1", workMode: "standard", conversationAgentId: null },
    });
    mockProjectToolDefinitions.mockReturnValue([{ name: "demo_tool" }]);
  });

  it("answers a JSON-RPC invalid request when the POST has no JSON body", async () => {
    const res = await request(app).post("/api/mcp/project-tools");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });
  });

  it("rejects a JSON array body instead of destructuring it", async () => {
    const res = await request(app).post("/api/mcp/project-tools").send([{ method: "tools/list" }]);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32600);
  });

  it("still serves tools/list for a valid JSON-RPC body", async () => {
    const res = await request(app)
      .post("/api/mcp/project-tools")
      .send({ jsonrpc: "2.0", id: 7, method: "tools/list" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jsonrpc: "2.0", id: 7, result: { tools: [{ name: "demo_tool" }] } });
  });
});
