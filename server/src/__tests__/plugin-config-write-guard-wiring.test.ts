import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static + behavioral guard against silently dropping the plugin-config
 * write-path agreement guard (PLA-1957 "Option 3" invariant) or its wiring
 * into `POST /api/plugins/:pluginId/config`.
 *
 * This is not hypothetical: catch-up merge `a144d3c0b` reverted the guard
 * once. CI stayed green because the revert was internally consistent — no
 * dangling imports, no type errors — and the only existing coverage
 * (`plugin-config-write-agreement-guard.test.ts`) calls
 * `writePluginConfigWithAgreement` directly, so it keeps passing even if the
 * route stops calling it and writes config through `upsertConfig` instead.
 * That gap is what this file closes: AC1 catches a dropped export, AC2
 * catches the call site moving out of the handler (or into a comment), AC3
 * proves the wired guard actually changes route behaviour.
 *
 * Pattern follows authz-existence-oracle-guard.test.ts (static source scan)
 * for AC1/AC2, and plugin-routes-authz.test.ts's mock harness for AC3.
 */

const ROUTES_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "routes",
  "plugins.ts",
);
const GUARD_MODULE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "services",
  "plugin-config-write.ts",
);

describe("plugin config write-path agreement guard: presence", () => {
  it("exports evaluateConfigWriteAgreementGuard and writePluginConfigWithAgreement (AC1)", async () => {
    const guardModule = await import("../services/plugin-config-write.js");
    expect(
      typeof guardModule.evaluateConfigWriteAgreementGuard,
      `evaluateConfigWriteAgreementGuard is not exported from ${GUARD_MODULE_PATH}. ` +
        "This function enforces the PLA-1957 Option 3 config-write agreement invariant. " +
        "A dropped export silently disables the guard's own unit coverage while leaving " +
        "the route compiling — see the a144d3c0b catch-up-merge revert incident.",
    ).toBe("function");
    expect(
      typeof guardModule.writePluginConfigWithAgreement,
      `writePluginConfigWithAgreement is not exported from ${GUARD_MODULE_PATH}. ` +
        "This is the entry point POST /api/plugins/:pluginId/config must call to preserve " +
        "the PLA-1957 Option 3 agreement invariant. A dropped export means the route can no " +
        "longer import it at all — see the a144d3c0b catch-up-merge revert incident.",
    ).toBe("function");
  });
});

describe("plugin config write-path agreement guard: route wiring (AC2)", () => {
  function extractConfigHandlerBody(): string {
    const source = readFileSync(ROUTES_FILE, "utf8");
    const lines = source.split("\n");
    // Anchored on the literal quoted route path (with the closing quote
    // immediately after "config") so this does not also match the sibling
    // POST /plugins/:pluginId/config/test handler.
    const startIndex = lines.findIndex((line) =>
      /router\.post\(\s*["']\/plugins\/:pluginId\/config["']/.test(line),
    );
    expect(
      startIndex,
      `Could not find the POST /plugins/:pluginId/config route registration in ${ROUTES_FILE}. ` +
        "Either the route was renamed/removed, or its registration no longer matches the " +
        "expected router.post(\"/plugins/:pluginId/config\", ...) shape this guard scans for.",
    ).toBeGreaterThanOrEqual(0);

    const indent = lines[startIndex]!.match(/^\s*/)![0];
    // The handler's own closing `});` sits at the same indentation as the
    // `router.post(` call that opened it. Every other `});` inside the
    // handler body (nested try/catch, RPC calls, etc.) is indented deeper,
    // so this is an unambiguous scope boundary.
    const endOffset = lines
      .slice(startIndex + 1)
      .findIndex((line) => line === `${indent}});`);
    expect(
      endOffset,
      `Could not find the closing "${indent}});" for the POST /plugins/:pluginId/config handler ` +
        `starting at ${ROUTES_FILE}:${startIndex + 1}. The handler body scope this guard relies on ` +
        "may have been reshaped.",
    ).toBeGreaterThanOrEqual(0);

    return lines.slice(startIndex, startIndex + 1 + endOffset + 1).join("\n");
  }

  it("calls writePluginConfigWithAgreement from inside the handler body, not just a comment", () => {
    const body = extractConfigHandlerBody();

    // A bare file-wide substring/grep check would false-pass here: this
    // very handler carries a JSDoc line mentioning
    // `writePluginConfigWithAgreement()` in prose, and a naive .includes()
    // on the whole file also picks up the import statement. Require an
    // actual call expression on a non-comment line within the handler body.
    const callSites = body
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .filter((line) => /\bwritePluginConfigWithAgreement\s*\(/.test(line));

    expect(
      callSites,
      "The POST /plugins/:pluginId/config handler in " +
        `${ROUTES_FILE} no longer calls writePluginConfigWithAgreement() from a live (non-comment) ` +
        "code path. This route is the only place that persists admin plugin-config writes, and it " +
        "MUST route through writePluginConfigWithAgreement() to preserve the PLA-1957 Option 3 " +
        "agreement invariant — writing through registry.upsertConfig()/setConfigJsonForExistingRow() " +
        "directly silently reintroduces the a144d3c0b catch-up-merge revert bug: an ordinary " +
        "single-company config edit breaks agreement for every other owning company with no error, " +
        "and the no-dispatch config.get() read gate (plugin-host-services.ts getAgreedOrDeny) starts " +
        "denying reads it used to resolve.",
    ).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC3 — behavioral proof through the route. Reuses the mock-registry/
// mock-secret-service harness from plugin-routes-authz.test.ts. Only
// plugin-registry.js and secrets.js are mocked — plugin-config-write.ts
// (the guard module under test) runs for real, so a 409 here can only come
// from the real evaluateConfigWriteAgreementGuard actually firing on the
// real route path.
// ---------------------------------------------------------------------------

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  upsertConfig: vi.fn(),
  listConfigRows: vi.fn(),
  setConfigJsonForExistingRow: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  getById: vi.fn(),
  syncSecretRefsForTarget: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({
    load: vi.fn(),
    upgrade: vi.fn(),
    unload: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
  }),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

async function createApp(actor: Record<string, unknown>) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use(
    "/api",
    pluginRoutes(
      { transaction: (cb: (tx: unknown) => unknown) => cb({}) } as never,
      { installPlugin: vi.fn() } as never,
      undefined,
      undefined,
      undefined,
      undefined,
    ),
  );
  app.use(errorHandler);
  return app;
}

const companyA = "22222222-2222-4222-8222-222222222222";
const companyB = "33333333-3333-4333-8333-333333333333";
const pluginId = "11111111-1111-4111-8111-111111111111";

function instanceAdminActor() {
  return {
    type: "board",
    userId: "admin-1",
    source: "session",
    isInstanceAdmin: true,
    companyIds: [companyA, companyB],
  };
}

describe("plugin config write-path agreement guard: behavioral proof through the route (AC3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey: "paperclip.example",
      version: "1.0.0",
      status: "ready",
    });
  });

  it("rejects a single-company write that would break an agreement two owning companies currently hold", async () => {
    // Both owning rows agree today on defaultBranch — the exact
    // precondition evaluateConfigWriteAgreementGuard requires before it can
    // fire (rows.length > 1 and they currently agree).
    mockRegistry.listConfigRows.mockResolvedValue([
      { companyId: companyA, configJson: { defaultBranch: "main" } },
      { companyId: companyB, configJson: { defaultBranch: "main" } },
    ]);

    const app = await createApp(instanceAdminActor());

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/config`)
      .send({ companyId: companyA, configJson: { defaultBranch: "develop" } });

    // Only writePluginConfigWithAgreement -> evaluateConfigWriteAgreementGuard
    // produces this 409/divergingKeys shape. If the route wiring were
    // dropped in favour of a direct registry.upsertConfig() write, this
    // would be a 200 instead.
    expect(res.status).toBe(409);
    expect(res.body.divergingKeys).toEqual(["defaultBranch"]);
    expect(mockRegistry.upsertConfig).not.toHaveBeenCalled();
  }, 20_000);

  it("accepts the same write with allowDivergence: true (guard's own explicit bypass)", async () => {
    mockRegistry.listConfigRows.mockResolvedValue([
      { companyId: companyA, configJson: { defaultBranch: "main" } },
      { companyId: companyB, configJson: { defaultBranch: "main" } },
    ]);
    mockRegistry.upsertConfig.mockResolvedValue({
      id: "config-1",
      pluginId,
      companyId: companyA,
      configJson: { defaultBranch: "develop" },
    });

    const app = await createApp(instanceAdminActor());

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/config`)
      .send({
        companyId: companyA,
        configJson: { defaultBranch: "develop" },
        allowDivergence: true,
      });

    expect(res.status).toBe(200);
    expect(mockRegistry.upsertConfig).toHaveBeenCalledWith(pluginId, companyA, {
      companyId: companyA,
      configJson: { defaultBranch: "develop" },
    });
  }, 20_000);
});
