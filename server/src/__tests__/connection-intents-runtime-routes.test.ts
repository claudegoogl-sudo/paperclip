import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const claims = vi.hoisted(() => ({
  sub: "agent-1",
  company_id: "company-1",
  run_id: "run-1",
  responsible_user_id: "user-1",
  scope: "connection_intents" as const,
  iat: 0,
  exp: 9_999_999_999,
  instance_id: "instance-1",
}));

const mockService = vi.hoisted(() => ({
  validate: vi.fn(),
  search: vi.fn(),
  request: vi.fn(),
}));

const mockVerifyToken = vi.hoisted(() => vi.fn());

vi.mock("../runtime-tools-token.js", () => ({
  verifyRuntimeToolsToken: mockVerifyToken,
}));
vi.mock("../services/connection-intents.js", () => ({
  connectionIntentService: () => mockService,
}));
vi.mock("../services/connection-intent-delivery.js", () => ({
  connectionIntentDeliveryService: () => ({}),
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/access.js", () => ({ accessService: () => ({}) }));
vi.mock("../services/github-operation-credentials.js", () => ({
  resolveGitHubOperationCredentials: vi.fn(),
}));

let runtimeConnectionIntentRoutes: typeof import("../routes/connection-intents.js").runtimeConnectionIntentRoutes;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(runtimeConnectionIntentRoutes({} as never));
  return app;
}

describe("POST /mcp/runtime-tools body handling", () => {
  beforeAll(async () => {
    ({ runtimeConnectionIntentRoutes } = await import("../routes/connection-intents.js"));
  }, 90_000);

  beforeEach(() => {
    mockVerifyToken.mockReset();
    mockVerifyToken.mockReturnValue(claims);
    mockService.validate.mockReset();
    mockService.validate.mockResolvedValue(undefined);
  });

  it("returns a JSON-RPC invalid request error when no body is sent", async () => {
    const res = await request(createApp())
      .post("/mcp/runtime-tools")
      .set("Authorization", "Bearer token");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
  });

  it("returns a JSON-RPC invalid request error for an array body", async () => {
    const res = await request(createApp())
      .post("/mcp/runtime-tools")
      .set("Authorization", "Bearer token")
      .send([{ method: "initialize" }]);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
  });

  it("still validates the token before looking at the body", async () => {
    mockVerifyToken.mockReturnValue(null);

    const res = await request(createApp()).post("/mcp/runtime-tools");

    expect(res.status).not.toBe(400);
    expect(mockService.validate).not.toHaveBeenCalled();
  });

  it("still answers a valid initialize request", async () => {
    const res = await request(createApp())
      .post("/mcp/runtime-tools")
      .set("Authorization", "Bearer token")
      .send({ jsonrpc: "2.0", id: 7, method: "initialize" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      result: { serverInfo: { name: "paperclip-runtime-tools" } },
    });
    expect(mockService.validate).toHaveBeenCalledWith(claims);
  });
});
