import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companySecrets, createDb, plugins } from "@paperclipai/db";
import { pluginRegistryService } from "../services/plugin-registry.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin config scrub round-trip route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const PLUGIN_KEY = "paperclip.test-config-scrub-roundtrip";

// Mirrors the read-gate and write-guard test schemas:
// one secret-ref field, one plain field.
const MANIFEST_SCHEMA = {
  type: "object",
  properties: {
    apiKeySecretId: { type: "string", format: "secret-ref" },
    defaultBranch: { type: "string" },
  },
};

// Proves the 0164 scrub actually fixes the 422 it was built
// for: a GET -> unmodified POST round trip on a non-owning company's config
// used to fail with 422 "Plugin config references a secret outside the
// selected company" (server/src/services/plugin-secrets-handler.ts
// validatePluginSecretRefsForCompany) whenever a foreign owner's secret-ref
// value was still present on the row. After the scrub that value is absent
// from every non-owning row, so extractSecretRefBindingsFromConfig yields no
// refs to validate and the round trip succeeds. Exercises the real HTTP
// routes (server/src/routes/plugins.ts) against a real, embedded-postgres
// -backed plugin_config table — mirroring plugin-install-autobuild.test.ts's
// real-db-real-routes harness rather than the mocked-registry harness in
// plugin-routes-authz.test.ts, since this needs the write path's actual
// secret-ownership validation to run.
describeEmbeddedPostgres("plugin config POST round trip after the 0164 scrub", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-config-scrub-roundtrip-");
    db = createDb(tempDb.connectionString);
  }, 180_000);

  afterEach(async () => {
    await db.delete(plugins);
    await db.delete(companySecrets);
    await db.delete(companies);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix: string) {
    return db
      .insert(companies)
      .values({
        name: `${prefix} ${randomUUID()}`,
        issuePrefix: `${prefix}${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seedSecret(companyId: string, name: string) {
    const secretId = randomUUID();
    await db.insert(companySecrets).values({ id: secretId, companyId, key: name, name });
    return secretId;
  }

  async function installPlugin() {
    return db
      .insert(plugins)
      .values({
        pluginKey: PLUGIN_KEY,
        packageName: "@paperclipai/test-config-scrub-roundtrip",
        version: "0.0.0",
        manifestJson: {
          id: PLUGIN_KEY,
          version: "0.0.0",
          displayName: "Config scrub round-trip test plugin",
          apiVersion: 1,
          entrypoints: { worker: "worker.js" },
          instanceConfigSchema: MANIFEST_SCHEMA,
        } as any,
        status: "ready",
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function createApp() {
    const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/plugins.js"),
      import("../middleware/index.js"),
    ]);

    const loader = { installPlugin: vi.fn() };

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // local_implicit + isInstanceAdmin bypasses per-company membership
      // checks (server/src/routes/authz.ts assertCompanyAccess), matching a
      // system/instance-admin caller managing multi-tenant plugin config.
      req.actor = {
        type: "board",
        userId: "admin-1",
        source: "local_implicit",
        isInstanceAdmin: true,
        companyIds: [],
      } as typeof req.actor;
      next();
    });
    app.use("/api", pluginRoutes(db as never, loader as never, {} as never, undefined, {} as never, undefined));
    app.use(errorHandler);
    return app;
  }

  it("GET a non-owning company's post-scrub config, POST it back unmodified, succeeds (no 422)", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const owner = await createCompany("RTO");
    const nonOwner = await createCompany("RTN");
    const ownerSecretId = await seedSecret(owner.id, "owner-key");

    // Owner keeps the ref; non-owner's row has the path entirely absent —
    // exactly the shape the foreign-secret-ref scrub in
    // packages/db/src/migrations/0164_plugin_config_company_scope.sql produces.
    await registry.upsertConfig(plugin.id, owner.id, {
      configJson: { defaultBranch: "main", apiKeySecretId: ownerSecretId },
    });
    await registry.upsertConfig(plugin.id, nonOwner.id, {
      configJson: { defaultBranch: "main" },
    });

    const app = await createApp();

    const getRes = await request(app)
      .get(`/api/plugins/${plugin.id}/config`)
      .query({ companyId: nonOwner.id });
    expect(getRes.status).toBe(200);
    expect(getRes.body.configJson).toEqual({ defaultBranch: "main" });
    expect(getRes.body.configJson.apiKeySecretId).toBeUndefined();

    const postRes = await request(app)
      .post(`/api/plugins/${plugin.id}/config`)
      .send({ companyId: nonOwner.id, configJson: getRes.body.configJson });

    expect(postRes.status, JSON.stringify(postRes.body)).toBe(200);
    expect(postRes.body.error).toBeUndefined();
    expect(postRes.body.configJson).toEqual({ defaultBranch: "main" });

    // Owner's row (and secret ownership) is untouched by the non-owner's write.
    const ownerRow = await registry.getConfig(plugin.id, owner.id);
    expect(ownerRow?.configJson).toEqual({ defaultBranch: "main", apiKeySecretId: ownerSecretId });
  }, 60_000);
});
