import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BROWSER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const mockService = vi.hoisted(() => ({
  list: vi.fn(),
  viewer: vi.fn(),
}));

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
}));

async function createApp() {
  vi.resetModules();
  const [{ errorHandler }, { browserUseRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/browser-use.js") as Promise<typeof import("../routes/browser-use.js")>,
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
    };
    next();
  });
  app.use("/api", browserUseRoutes(mockDb as any, mockService as any));
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
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

describe("browser use routes issue id validation", () => {
  beforeEach(() => {
    mockService.list.mockReset();
    mockService.viewer.mockReset();
    mockDb.select.mockReset();
    mockDb.select.mockImplementation(() => {
      throw new Error("db.select must not be reached for a malformed issue id");
    });
  });

  it.each([
    ["a non-UUID id", "x"],
    ["a whitespace-padded UUID", encodeURIComponent(` ${ISSUE_ID}`)],
    ["a trailing-whitespace UUID", encodeURIComponent(`${ISSUE_ID} `)],
  ])("returns 404 for %s before querying the database", async (_label, issueId) => {
    const response = await requestApp(await createApp(), (baseUrl) =>
      request(baseUrl).get(`/api/issues/${issueId}/browsers`),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(response.body).toEqual({ error: "Task not found" });
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockService.list).not.toHaveBeenCalled();
  });

  it("returns 404 for a malformed issue id on sub-routes", async () => {
    const response = await requestApp(await createApp(), (baseUrl) =>
      request(baseUrl).get(`/api/issues/x/browsers/${BROWSER_ID}/viewer`),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(response.body).toEqual({ error: "Task not found" });
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockService.viewer).not.toHaveBeenCalled();
  });

  it("still looks up the issue for a valid UUID", async () => {
    const limit = vi.fn().mockResolvedValue([{ companyId: "company-1" }]);
    mockDb.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit }) }),
    }));
    mockService.list.mockResolvedValue([]);

    const response = await requestApp(await createApp(), (baseUrl) =>
      request(baseUrl).get(`/api/issues/${ISSUE_ID}/browsers`),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual([]);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(mockService.list).toHaveBeenCalledWith("company-1", ISSUE_ID, "user-1");
  });
});
