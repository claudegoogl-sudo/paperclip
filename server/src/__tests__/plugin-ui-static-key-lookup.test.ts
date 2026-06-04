import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// PLA-873: GET /_plugins/:pluginId/ui/* must serve the bundle when :pluginId is
// the plugin *key* (not a UUID). The registry's by-id lookup throws Postgres
// 22P02 (invalid_text_representation) for a non-UUID, drizzle-wrapped so the
// SQLSTATE is on `.cause`. The route must detect that and fall through to the
// by-key lookup instead of surfacing a 500.

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

const makeDrizzleWrapped22P02 = () => {
  const driver = new Error(
    'invalid input syntax for type uuid: "paperclip-messenger"',
  ) as Error & { code: string };
  driver.code = "22P02";
  const wrapped = new Error(
    'Failed query: select "id" from "plugins" where "plugins"."id" = $1\nparams: paperclip-messenger',
  ) as Error & { cause: unknown };
  wrapped.cause = driver;
  return wrapped;
};

let tmpDir: string;

async function createApp() {
  const { pluginUiStaticRoutes } = await import("../routes/plugin-ui-static.js");
  const app = express();
  app.use(pluginUiStaticRoutes({} as never, { localPluginDir: tmpDir }));
  // Minimal error handler so an unhandled throw surfaces as 500 (the bug).
  app.use(
    (
      _err: unknown,
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ error: "Internal server error" });
    },
  );
  return app;
}

describe("plugin-ui-static key lookup (PLA-873)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pla873-ui-"));
    fs.mkdirSync(path.join(tmpDir, "dist", "ui"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "dist", "ui", "index.js"),
      'export const DashboardWidget = () => null;\n',
    );
    mockRegistry.getConfig.mockResolvedValue(null);
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const readyPlugin = () => ({
    id: "11111111-1111-1111-1111-111111111111",
    pluginKey: "paperclip-messenger",
    packageName: "paperclip-messenger",
    packagePath: tmpDir,
    status: "ready",
    manifestJson: { entrypoints: { ui: "./dist/ui" } },
  });

  it("serves the bundle by key when by-id throws a drizzle-wrapped 22P02", async () => {
    mockRegistry.getById.mockRejectedValue(makeDrizzleWrapped22P02());
    mockRegistry.getByKey.mockResolvedValue(readyPlugin());

    const app = await createApp();
    const res = await request(app).get(
      "/_plugins/paperclip-messenger/ui/index.js",
    );

    expect(res.status).toBe(200);
    expect(res.text).toContain("DashboardWidget");
    expect(mockRegistry.getByKey).toHaveBeenCalledWith("paperclip-messenger");
  });

  it("rethrows (500) when by-id fails with a non-22P02 error", async () => {
    const dbDown = new Error("connection refused") as Error & { code: string };
    dbDown.code = "08006";
    mockRegistry.getById.mockRejectedValue(dbDown);

    const app = await createApp();
    const res = await request(app).get(
      "/_plugins/paperclip-messenger/ui/index.js",
    );

    expect(res.status).toBe(500);
    expect(mockRegistry.getByKey).not.toHaveBeenCalled();
  });

  it("serves by UUID id without ever hitting the key fallback", async () => {
    mockRegistry.getById.mockResolvedValue(readyPlugin());

    const app = await createApp();
    const res = await request(app).get(
      "/_plugins/11111111-1111-1111-1111-111111111111/ui/index.js",
    );

    expect(res.status).toBe(200);
    expect(mockRegistry.getByKey).not.toHaveBeenCalled();
  });
});
