import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companySecretBindings, companySecrets, createDb, plugins } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import * as pluginRegistryModule from "../services/plugin-registry.js";
import {
  ConfigAgreementGuardError,
  evaluateConfigWriteAgreementGuard,
  writePluginConfigWithAgreement,
} from "../services/plugin-config-write.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin config write-agreement-guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
    },
  } as any;
}

const PLUGIN_KEY = "paperclip.test-config-write-guard";

// Mirrors the read-gate test's schema shape: one secret-ref field, one plain
// field. Reused so the write guard and the PLA-1944 read gate are proven
// against the exact same non-secret/secret-ref split.
const MANIFEST_SCHEMA = {
  type: "object",
  properties: {
    apiKeySecretId: { type: "string", format: "secret-ref" },
    defaultBranch: { type: "string" },
  },
};

// PLA-1957 — admin config write path guard/fan-out. Exercises
// `writePluginConfigWithAgreement` (server/src/services/plugin-config-write.ts)
// directly against a real, embedded-postgres-backed `plugin_config` table.
// Never modifies plugin-config-agreement-gate.test.ts or getAgreedOrDeny —
// this file only adds a *new* combined write+read test (AC5/e2e) that calls
// both modules, reusing that file's harness pattern rather than its tests.
describeEmbeddedPostgres("plugin config write-path agreement guard (PLA-1957)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-config-write-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companySecretBindings);
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
        packageName: "@paperclipai/test-config-write-guard",
        version: "0.0.0",
        manifestJson: {
          id: PLUGIN_KEY,
          version: "0.0.0",
          displayName: "Config write guard test plugin",
          apiVersion: 1,
          entrypoints: { worker: "worker.js" },
          instanceConfigSchema: MANIFEST_SCHEMA,
        } as any,
        status: "ready",
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  function buildGateServices(pluginId: string) {
    return buildHostServices(db, pluginId, PLUGIN_KEY, createEventBusStub(), undefined, {
      manifest: {
        id: PLUGIN_KEY,
        version: "0.0.0",
        displayName: "Config write guard test plugin",
        apiVersion: 1,
        entrypoints: { worker: "worker.js" },
        instanceConfigSchema: MANIFEST_SCHEMA,
      } as any,
    });
  }

  describe("evaluateConfigWriteAgreementGuard (pure)", () => {
    it("AC2: never fires with a single owning row", () => {
      const result = evaluateConfigWriteAgreementGuard(
        [{ companyId: "a", configJson: { defaultBranch: "main" } }],
        "a",
        { defaultBranch: "dev" },
        new Set(),
      );
      expect(result.wouldBreakAgreement).toBe(false);
    });

    it("AC2: never fires when the owning rows already disagree", () => {
      const result = evaluateConfigWriteAgreementGuard(
        [
          { companyId: "a", configJson: { defaultBranch: "main" } },
          { companyId: "b", configJson: { defaultBranch: "dev" } },
        ],
        "a",
        { defaultBranch: "staging" },
        new Set(),
      );
      expect(result.wouldBreakAgreement).toBe(false);
    });

    it("fires when rows currently agree and the write would diverge", () => {
      const result = evaluateConfigWriteAgreementGuard(
        [
          { companyId: "a", configJson: { defaultBranch: "main" } },
          { companyId: "b", configJson: { defaultBranch: "main" } },
        ],
        "a",
        { defaultBranch: "dev" },
        new Set(),
      );
      expect(result.wouldBreakAgreement).toBe(true);
      expect(result.divergingKeys).toEqual(["defaultBranch"]);
    });

    it("ignores secret-ref paths when deciding agreement", () => {
      const result = evaluateConfigWriteAgreementGuard(
        [
          { companyId: "a", configJson: { defaultBranch: "main", apiKeySecretId: "secret-a" } },
          { companyId: "b", configJson: { defaultBranch: "main", apiKeySecretId: "secret-b" } },
        ],
        "a",
        { defaultBranch: "main", apiKeySecretId: "secret-a-updated" },
        new Set(["apiKeySecretId"]),
      );
      expect(result.wouldBreakAgreement).toBe(false);
    });
  });

  it("AC1: guard denies (409-equivalent) a write that would break a held agreement, and writes nothing", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const companyA = await createCompany("GDA");
    const companyB = await createCompany("GDB");
    const companyC = await createCompany("GDC");

    for (const company of [companyA, companyB, companyC]) {
      await registry.upsertConfig(plugin.id, company.id, {
        configJson: { defaultBranch: "main" },
      });
    }

    await expect(
      writePluginConfigWithAgreement(db, {
        pluginId: plugin.id,
        companyId: companyA.id,
        configJson: { defaultBranch: "dev" },
        schema: MANIFEST_SCHEMA,
        options: {},
      }),
    ).rejects.toBeInstanceOf(ConfigAgreementGuardError);

    const rows = await registry.listConfigRows(plugin.id);
    for (const row of rows) {
      expect(row.configJson).toEqual({ defaultBranch: "main" });
    }
  });

  it("AC2: guard does not fire with only one owning row — the write proceeds", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const companyA = await createCompany("SGA");

    await registry.upsertConfig(plugin.id, companyA.id, {
      configJson: { defaultBranch: "main" },
    });

    const result = await writePluginConfigWithAgreement(db, {
      pluginId: plugin.id,
      companyId: companyA.id,
      configJson: { defaultBranch: "dev" },
      schema: MANIFEST_SCHEMA,
      options: {},
    });

    expect(result.row.configJson).toEqual({ defaultBranch: "dev" });
    expect(result.companiesWritten).toEqual([companyA.id]);
    expect(result.fannedOut).toBe(false);
  });

  it("AC2: guard does not fire when rows already disagree — passes the write straight through", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const companyA = await createCompany("ADA");
    const companyB = await createCompany("ADB");

    await registry.upsertConfig(plugin.id, companyA.id, {
      configJson: { defaultBranch: "main" },
    });
    await registry.upsertConfig(plugin.id, companyB.id, {
      configJson: { defaultBranch: "dev" },
    });

    const result = await writePluginConfigWithAgreement(db, {
      pluginId: plugin.id,
      companyId: companyA.id,
      configJson: { defaultBranch: "staging" },
      schema: MANIFEST_SCHEMA,
      options: {},
    });

    expect(result.row.configJson).toEqual({ defaultBranch: "staging" });
    const rowB = await registry.getConfig(plugin.id, companyB.id);
    expect(rowB?.configJson).toEqual({ defaultBranch: "dev" });
  });

  it("AC3: applyToAllCompanies fans the non-secret change out, preserving each row's DISTINCT secret-ref value", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const companyA = await createCompany("FDA");
    const companyB = await createCompany("FDB");
    const companyC = await createCompany("FDC");
    const secretA = await seedSecret(companyA.id, "key-a");
    const secretB = await seedSecret(companyB.id, "key-b");
    const secretC = await seedSecret(companyC.id, "key-c");

    await registry.upsertConfig(plugin.id, companyA.id, {
      configJson: { defaultBranch: "main", apiKeySecretId: secretA },
    });
    await registry.upsertConfig(plugin.id, companyB.id, {
      configJson: { defaultBranch: "main", apiKeySecretId: secretB },
    });
    await registry.upsertConfig(plugin.id, companyC.id, {
      configJson: { defaultBranch: "main", apiKeySecretId: secretC },
    });

    const result = await writePluginConfigWithAgreement(db, {
      pluginId: plugin.id,
      companyId: companyA.id,
      configJson: { defaultBranch: "dev", apiKeySecretId: secretA },
      schema: MANIFEST_SCHEMA,
      options: { applyToAllCompanies: true },
    });

    expect(result.fannedOut).toBe(true);
    expect(new Set(result.companiesWritten)).toEqual(
      new Set([companyA.id, companyB.id, companyC.id]),
    );

    const rowA = await registry.getConfig(plugin.id, companyA.id);
    const rowB = await registry.getConfig(plugin.id, companyB.id);
    const rowC = await registry.getConfig(plugin.id, companyC.id);
    expect(rowA?.configJson).toEqual({ defaultBranch: "dev", apiKeySecretId: secretA });
    expect(rowB?.configJson).toEqual({ defaultBranch: "dev", apiKeySecretId: secretB });
    expect(rowC?.configJson).toEqual({ defaultBranch: "dev", apiKeySecretId: secretC });
  });

  it("AC3: applyToAllCompanies also works when every row shares the SAME secret-ref value", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const companyA = await createCompany("FSA");
    const companyB = await createCompany("FSB");
    const companyC = await createCompany("FSC");
    const secretId = await seedSecret(companyA.id, "shared-key");

    for (const company of [companyA, companyB, companyC]) {
      await registry.upsertConfig(plugin.id, company.id, {
        configJson: { defaultBranch: "main", apiKeySecretId: secretId },
      });
    }

    await writePluginConfigWithAgreement(db, {
      pluginId: plugin.id,
      companyId: companyB.id,
      configJson: { defaultBranch: "dev", apiKeySecretId: secretId },
      schema: MANIFEST_SCHEMA,
      options: { applyToAllCompanies: true },
    });

    for (const company of [companyA, companyB, companyC]) {
      const row = await registry.getConfig(plugin.id, company.id);
      expect(row?.configJson).toEqual({ defaultBranch: "dev", apiKeySecretId: secretId });
    }
  });

  it("AC3: a foreign secret-ref is never written to a company that doesn't own it (PLA-1843 regression guard)", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const companyA = await createCompany("NFA");
    const companyB = await createCompany("NFB");
    const secretA = await seedSecret(companyA.id, "a-only");
    const secretB = await seedSecret(companyB.id, "b-only");

    await registry.upsertConfig(plugin.id, companyA.id, {
      configJson: { defaultBranch: "main", apiKeySecretId: secretA },
    });
    await registry.upsertConfig(plugin.id, companyB.id, {
      configJson: { defaultBranch: "main", apiKeySecretId: secretB },
    });

    await writePluginConfigWithAgreement(db, {
      pluginId: plugin.id,
      companyId: companyA.id,
      configJson: { defaultBranch: "dev", apiKeySecretId: secretA },
      schema: MANIFEST_SCHEMA,
      options: { applyToAllCompanies: true },
    });

    const rowB = await registry.getConfig(plugin.id, companyB.id);
    // Non-secret change applied, but B's own secret-ref value is untouched —
    // A's secretId must never appear on B's row.
    expect(rowB?.configJson).toEqual({ defaultBranch: "dev", apiKeySecretId: secretB });
  });

  it("AC4/AC5 (e2e): after applyToAllCompanies, the PLA-1944 no-dispatch read gate resolves cleanly", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const companyA = await createCompany("E2EA");
    const companyB = await createCompany("E2EB");
    const companyC = await createCompany("E2EC");

    for (const company of [companyA, companyB, companyC]) {
      await registry.upsertConfig(plugin.id, company.id, {
        configJson: { defaultBranch: "main" },
      });
    }

    // Without fan-out, a lone single-row admin edit would break agreement —
    // prove the guard fires here too, then resolve it via applyToAllCompanies.
    await expect(
      writePluginConfigWithAgreement(db, {
        pluginId: plugin.id,
        companyId: companyA.id,
        configJson: { defaultBranch: "release" },
        schema: MANIFEST_SCHEMA,
        options: {},
      }),
    ).rejects.toBeInstanceOf(ConfigAgreementGuardError);

    await writePluginConfigWithAgreement(db, {
      pluginId: plugin.id,
      companyId: companyA.id,
      configJson: { defaultBranch: "release" },
      schema: MANIFEST_SCHEMA,
      options: { applyToAllCompanies: true },
    });

    const services = buildGateServices(plugin.id);
    const result = await services.config.getAgreedOrDeny!();
    services.dispose();

    expect(result).toEqual({ defaultBranch: "release" });
    expect(logger.error).not.toHaveBeenCalled();
    const refreshed = await registry.getById(plugin.id);
    expect(refreshed?.lastError).toBeNull();
  });

  it("AC6: allowDivergence writes only the target row, bypassing the guard entirely", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const companyA = await createCompany("ALA");
    const companyB = await createCompany("ALB");

    await registry.upsertConfig(plugin.id, companyA.id, {
      configJson: { defaultBranch: "main" },
    });
    await registry.upsertConfig(plugin.id, companyB.id, {
      configJson: { defaultBranch: "main" },
    });

    const result = await writePluginConfigWithAgreement(db, {
      pluginId: plugin.id,
      companyId: companyA.id,
      configJson: { defaultBranch: "dev" },
      schema: MANIFEST_SCHEMA,
      options: { allowDivergence: true },
    });

    expect(result.fannedOut).toBe(false);
    expect(result.companiesWritten).toEqual([companyA.id]);
    const rowA = await registry.getConfig(plugin.id, companyA.id);
    const rowB = await registry.getConfig(plugin.id, companyB.id);
    expect(rowA?.configJson).toEqual({ defaultBranch: "dev" });
    expect(rowB?.configJson).toEqual({ defaultBranch: "main" });
  });

  it("AC7: applyToAllCompanies and allowDivergence together reject with a 400-class error, no write", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const companyA = await createCompany("BADA");

    await registry.upsertConfig(plugin.id, companyA.id, {
      configJson: { defaultBranch: "main" },
    });

    await expect(
      writePluginConfigWithAgreement(db, {
        pluginId: plugin.id,
        companyId: companyA.id,
        configJson: { defaultBranch: "dev" },
        schema: MANIFEST_SCHEMA,
        options: { applyToAllCompanies: true, allowDivergence: true },
      }),
    ).rejects.toMatchObject({ status: 400 });

    const rowA = await registry.getConfig(plugin.id, companyA.id);
    expect(rowA?.configJson).toEqual({ defaultBranch: "main" });
  });

  it("AC8: a forced mid-fan-out failure rolls back the ENTIRE write, including the target row", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const companyA = await createCompany("ATA");
    const companyB = await createCompany("ATB");

    await registry.upsertConfig(plugin.id, companyA.id, {
      configJson: { defaultBranch: "main" },
    });
    await registry.upsertConfig(plugin.id, companyB.id, {
      configJson: { defaultBranch: "main" },
    });

    // Force a real failure partway through the fan-out (after companyA's
    // target-row write has already landed in the transaction, before
    // companyB's fan-out write runs) by making `setConfigJsonForExistingRow`
    // throw on its first call. Proves the whole write — including the
    // target row written earlier in the SAME transaction — rolls back
    // rather than committing partially.
    const realPluginRegistryService = pluginRegistryModule.pluginRegistryService;
    const spy = vi
      .spyOn(pluginRegistryModule, "pluginRegistryService")
      .mockImplementation((txDb) => {
        const real = realPluginRegistryService(txDb);
        return {
          ...real,
          setConfigJsonForExistingRow: async () => {
            throw new Error("forced mid-fan-out failure");
          },
        };
      });

    try {
      await expect(
        writePluginConfigWithAgreement(db, {
          pluginId: plugin.id,
          companyId: companyA.id,
          configJson: { defaultBranch: "dev" },
          schema: MANIFEST_SCHEMA,
          options: { applyToAllCompanies: true },
        }),
      ).rejects.toThrow("forced mid-fan-out failure");
    } finally {
      spy.mockRestore();
    }

    const rowA = await registry.getConfig(plugin.id, companyA.id);
    const rowB = await registry.getConfig(plugin.id, companyB.id);
    expect(rowA?.configJson).toEqual({ defaultBranch: "main" });
    expect(rowB?.configJson).toEqual({ defaultBranch: "main" });
  });

  it("AC9: activity-log fields — fannedOut and companiesWritten name every company actually written", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const companyA = await createCompany("LOGA");
    const companyB = await createCompany("LOGB");
    const companyC = await createCompany("LOGC");

    for (const company of [companyA, companyB, companyC]) {
      await registry.upsertConfig(plugin.id, company.id, {
        configJson: { defaultBranch: "main" },
      });
    }

    const result = await writePluginConfigWithAgreement(db, {
      pluginId: plugin.id,
      companyId: companyB.id,
      configJson: { defaultBranch: "dev" },
      schema: MANIFEST_SCHEMA,
      options: { applyToAllCompanies: true },
    });

    // Target company first (matches WritePluginConfigResult's documented
    // contract), full set otherwise unordered.
    expect(result.companiesWritten[0]).toBe(companyB.id);
    expect(new Set(result.companiesWritten)).toEqual(
      new Set([companyA.id, companyB.id, companyC.id]),
    );
    expect(result.fannedOut).toBe(true);
  });
});
