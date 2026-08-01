import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
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
// field. Reused so the write guard and the read gate are proven
// against the exact same non-secret/secret-ref split.
const MANIFEST_SCHEMA = {
  type: "object",
  properties: {
    apiKeySecretId: { type: "string", format: "secret-ref" },
    defaultBranch: { type: "string" },
  },
};

// Two secret-ref fields sharing a top-level parent key (`auth`).
// No shipped first-party manifest declares this shape today, but the
// sibling-orphaning regression test below needs it to exercise the bug.
const NESTED_SIBLING_SCHEMA = {
  type: "object",
  properties: {
    defaultBranch: { type: "string" },
    auth: {
      type: "object",
      properties: {
        tokenSecretId: { type: "string", format: "secret-ref" },
        refreshSecretId: { type: "string", format: "secret-ref" },
      },
    },
  },
};

// Admin config write path guard/fan-out. Exercises
// `writePluginConfigWithAgreement` (server/src/services/plugin-config-write.ts)
// directly against a real, embedded-postgres-backed `plugin_config` table.
// Does not change plugin-config-agreement-gate.test.ts's or getAgreedOrDeny's
// behavior or assertions — this file only adds a *new* combined write+read
// test (AC5/e2e) that calls both modules, reusing that file's harness pattern
// rather than its tests. (Both files' `getAgreedOrDeny` call sites were
// updated to `config.get()` for the rebuilt gate surface — see the
// note atop plugin-config-agreement-gate.test.ts.)
describeEmbeddedPostgres("plugin config write-path agreement guard", () => {
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

  async function installPlugin(schema: Record<string, unknown> = MANIFEST_SCHEMA) {
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
          instanceConfigSchema: schema,
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

  it("AC3: a foreign secret-ref is never written to a company that doesn't own it (fan-out regression guard)", async () => {
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

  it("AC4/AC5 (e2e): after applyToAllCompanies, the no-dispatch read gate resolves cleanly", async () => {
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
    const result = await services.config.get();
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

  // NB: this test passes with or without `exactPathDelete: true` on the
  // `syncSecretRefsForTarget` call in plugin-config-write.ts — it is NOT
  // load-bearing for that flag specifically, and is kept as defense-in-depth
  // at this (route/write-guard) layer rather than removed. The reason: right
  // after `syncSecretRefsForTarget` runs for the target company, this same
  // transaction calls `registry.upsertConfig` for that SAME company, which
  // unconditionally calls `secretService(db).syncPluginSecretBindings(...)` —
  // that call re-derives and re-upserts a binding row for EVERY secret-ref
  // path present in the row's full final `configJson` (including the
  // untouched `auth.refreshSecretId`), healing any wrongly-scoped delete
  // before this test ever reads `company_secret_bindings` back. The
  // `exactPathDelete` regression this test's comment describes IS real for
  // an intermediate DB state, just not observable through this call chain.
  // The genuinely load-bearing regression test for `exactPathDelete` itself
  // lives in secrets-service.test.ts ("exactPathDelete scopes a
  // changed-subset resync..."), which asserts directly on
  // `syncSecretRefsForTarget`'s persisted state with no `upsertConfig` call
  // afterward to heal it.
  it("applyToAllCompanies fan-out does not orphan an unchanged sibling secret-ref binding under the same parent key", async () => {
    const plugin = await installPlugin(NESTED_SIBLING_SCHEMA);
    const registry = pluginRegistryService(db);
    const companyA = await createCompany("SIBA");
    const companyB = await createCompany("SIBB");
    const tokenA = await seedSecret(companyA.id, "token-a");
    const refreshA = await seedSecret(companyA.id, "refresh-a");
    const tokenB = await seedSecret(companyB.id, "token-b");
    const refreshB = await seedSecret(companyB.id, "refresh-b");

    // Seed both rows through the real write path (not a raw upsert) so the
    // initial `auth.tokenSecretId` / `auth.refreshSecretId` bindings actually
    // exist in company_secret_bindings for both companies — each write here
    // sees at most one prior owning row, so the guard never fires.
    await writePluginConfigWithAgreement(db, {
      pluginId: plugin.id,
      companyId: companyA.id,
      configJson: { defaultBranch: "main", auth: { tokenSecretId: tokenA, refreshSecretId: refreshA } },
      schema: NESTED_SIBLING_SCHEMA,
      options: {},
    });
    await writePluginConfigWithAgreement(db, {
      pluginId: plugin.id,
      companyId: companyB.id,
      configJson: { defaultBranch: "main", auth: { tokenSecretId: tokenB, refreshSecretId: refreshB } },
      schema: NESTED_SIBLING_SCHEMA,
      options: {},
    });

    const tokenARotated = await seedSecret(companyA.id, "token-a-rotated");

    // Rotate ONLY auth.tokenSecretId for company A via the fan-out path.
    // auth.refreshSecretId is unchanged in the payload — under the old
    // prefix-scoped delete this would still delete company A's
    // `auth.refreshSecretId` binding row (same top-level `auth` prefix as
    // the changed field) without reinserting it, since only the CHANGED ref
    // subset gets synced in the applyToAllCompanies branch.
    await writePluginConfigWithAgreement(db, {
      pluginId: plugin.id,
      companyId: companyA.id,
      configJson: {
        defaultBranch: "dev",
        auth: { tokenSecretId: tokenARotated, refreshSecretId: refreshA },
      },
      schema: NESTED_SIBLING_SCHEMA,
      options: { applyToAllCompanies: true },
    });

    const bindingRows = await db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyA.id),
          eq(companySecretBindings.targetType, "plugin"),
          eq(companySecretBindings.targetId, plugin.id),
        ),
      );
    const byPath = new Map(bindingRows.map((row) => [row.configPath, row.secretId]));

    expect(byPath.get("auth.tokenSecretId")).toBe(tokenARotated);
    // The regression this test guards: the sibling binding must survive,
    // still pointing at the ORIGINAL (unchanged) secret.
    expect(byPath.get("auth.refreshSecretId")).toBe(refreshA);

    const rowA = await registry.getConfig(plugin.id, companyA.id);
    const rowB = await registry.getConfig(plugin.id, companyB.id);
    expect(rowA?.configJson).toEqual({
      defaultBranch: "dev",
      auth: { tokenSecretId: tokenARotated, refreshSecretId: refreshA },
    });
    // Non-secret change fanned out; B's own distinct secret-ref values
    // (both fields) are completely untouched.
    expect(rowB?.configJson).toEqual({
      defaultBranch: "dev",
      auth: { tokenSecretId: tokenB, refreshSecretId: refreshB },
    });
  });

  it("a concurrent fan-out and a default write on the same plugin never leave a row permanently stuck on an unreconciled value", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const companyA = await createCompany("RACEA");
    const companyB = await createCompany("RACEB");
    const companyC = await createCompany("RACEC");

    // A and B already agree; C starts already diverged on purpose, so the
    // *pre*-fan-out snapshot reads as "rows disagree" (guard inapplicable)
    // while the *post*-fan-out snapshot reads as "rows agree" (guard
    // applicable). That transition is what a stale, unlocked read of
    // company B's concurrent default write could straddle.
    await registry.upsertConfig(plugin.id, companyA.id, { configJson: { defaultBranch: "main" } });
    await registry.upsertConfig(plugin.id, companyB.id, { configJson: { defaultBranch: "main" } });
    await registry.upsertConfig(plugin.id, companyC.id, { configJson: { defaultBranch: "old" } });

    // This test previously raced TX1/TX2 with a bare
    // `Promise.allSettled` and no control over interleaving — real
    // scheduling only produced the straddle window it exists to catch on
    // ~29% of runs (4/14 trials observed with `forUpdate` reverted),
    // because most runs let TX2's read land either cleanly before TX1
    // starts or cleanly after TX1 commits, where both orderings are safe
    // with or without the lock. A test that only sometimes exercises the
    // regression it names is not a regression test.
    //
    // Fixed by injecting a two-step handshake around `listConfigRows` (via
    // the same `pluginRegistryModule` spy pattern used above) that forces
    // TX2's underlying `SELECT` to be *issued* while TX1 is still holding
    // its transaction open, on every run:
    //   1. TX1's `listConfigRows` call (the fan-out's read) resolves, then
    //      blocks on `tx1Ready` before returning — holding TX1's
    //      transaction open (and, with a real `FOR UPDATE`, its row lock)
    //      for as long as we want.
    //   2. Only once TX1 has reached that point do we invoke TX2's write.
    //      TX2's `listConfigRows` call signals `tx2Issued` and THEN calls
    //      through to the real implementation — so the real `SELECT` is
    //      guaranteed to be issued before we release TX1.
    //   3. We await `tx2Issued`, then release `tx1Ready`, letting TX1
    //      finish (commit) while TX2's real query is in flight.
    // With `forUpdate: true` genuinely locking the rows, TX2's `SELECT ...
    // FOR UPDATE` cannot return until TX1's commit releases the lock, so
    // TX2 always reads the post-fan-out ("dev"-agreeing) snapshot. Without
    // the lock, TX2's `SELECT` — already in flight against the
    // pre-commit snapshot — always returns the stale ("main"/"old"
    // disagreeing) rows instead, reproducing the strand deterministically
    // on every run rather than occasionally.
    let listConfigRowsCallCount = 0;
    let tx1ReadyResolve!: () => void;
    let tx2IssuedResolve!: () => void;
    const tx1Ready = new Promise<void>((resolve) => {
      tx1ReadyResolve = resolve;
    });
    const tx2Issued = new Promise<void>((resolve) => {
      tx2IssuedResolve = resolve;
    });
    const realPluginRegistryService = pluginRegistryModule.pluginRegistryService;
    const spy = vi
      .spyOn(pluginRegistryModule, "pluginRegistryService")
      .mockImplementation((txDb) => {
        const real = realPluginRegistryService(txDb);
        return {
          ...real,
          listConfigRows: async (...args: Parameters<typeof real.listConfigRows>) => {
            listConfigRowsCallCount += 1;
            if (listConfigRowsCallCount === 1) {
              const rows = await real.listConfigRows(...args);
              await tx1Ready;
              return rows;
            }
            tx2IssuedResolve();
            return real.listConfigRows(...args);
          },
        };
      });

    try {
      const tx1 = writePluginConfigWithAgreement(db, {
        pluginId: plugin.id,
        companyId: companyA.id,
        configJson: { defaultBranch: "dev" },
        schema: MANIFEST_SCHEMA,
        options: { applyToAllCompanies: true },
      });
      // Don't start TX2 until TX1's read (call #1) has actually happened,
      // so the two `listConfigRows` calls are unambiguously ordered.
      await vi.waitFor(() => expect(listConfigRowsCallCount).toBeGreaterThanOrEqual(1));
      const tx2 = writePluginConfigWithAgreement(db, {
        pluginId: plugin.id,
        companyId: companyB.id,
        configJson: { defaultBranch: "rogue" },
        schema: MANIFEST_SCHEMA,
        options: {},
      });
      await tx2Issued;
      tx1ReadyResolve();
      await Promise.allSettled([tx1, tx2]);
    } finally {
      spy.mockRestore();
    }

    const rowA = await registry.getConfig(plugin.id, companyA.id);
    const rowB = await registry.getConfig(plugin.id, companyB.id);
    const rowC = await registry.getConfig(plugin.id, companyC.id);

    // The regression this guards: B must never be left stranded on "rogue"
    // once A's fan-out has reconciled the group.
    expect(rowB?.configJson).not.toEqual({ defaultBranch: "rogue" });
    expect(rowA?.configJson).toEqual({ defaultBranch: "dev" });
    expect(rowB?.configJson).toEqual({ defaultBranch: "dev" });
    expect(rowC?.configJson).toEqual({ defaultBranch: "dev" });
  });
});
