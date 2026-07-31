import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, plugins } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
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
    `Skipping plugin config agreement-gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
    },
  } as any;
}

const PLUGIN_KEY = "paperclip.test-agreement-gate";

// PLA-1944: instance-config schema declaring a single secret-ref field. Used
// to prove secret-ref paths are excluded from the agreement comparison and
// handled by the separate distinct-value union rule (C2), never by row-count
// (the wrong E1 rule from the superseded PLA-1937 draft).
const MANIFEST_SCHEMA = {
  type: "object",
  properties: {
    apiKeySecretId: { type: "string", format: "secret-ref" },
    defaultBranch: { type: "string" },
  },
};

// PLA-1944 — Option 3 host-minted agreement gate for the no-dispatch
// `config.get` read. Exercises `buildHostServices(...).config.get()` called
// with no `companyId` (server/src/services/plugin-host-services.ts) directly
// against a real, embedded-postgres-backed `plugin_config` table — this is
// the level at which C2 (secret-ref distinct-value union), A1 (structural
// equality), and the loud-failure / redaction contract (C5) actually live.
//
// PLA-1999: this file's call sites originally read
// `services.config.getAgreedOrDeny!()` — a separate method that existed when
// this test was first written. The gate has since been rebuilt
// (`plugin-config-agreement.ts`'s standalone `getAgreedOrDeny`, invoked from
// inside `config.get()` itself when no `companyId` is passed) with an
// equivalent contract but no method of that name on `services.config` — only
// the call sites were updated to match; every assertion below is unchanged.
describeEmbeddedPostgres("plugin config.get agreement gate (PLA-1944)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // Same rationale as the global hookTimeout in vitest.config.ts: under a
  // loaded shard the embedded-postgres cold boot can cross the 20s most
  // suites use. Bumped in isolation here rather than lowering the shared
  // default for every other file.
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-config-agreement-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterEach(async () => {
    await db.delete(plugins);
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

  async function installPlugin() {
    return db
      .insert(plugins)
      .values({
        pluginKey: PLUGIN_KEY,
        packageName: "@paperclipai/test-agreement-gate",
        version: "0.0.0",
        manifestJson: {
          id: PLUGIN_KEY,
          version: "0.0.0",
          displayName: "Agreement gate test plugin",
          apiVersion: 1,
          entrypoints: { worker: "worker.js" },
          instanceConfigSchema: MANIFEST_SCHEMA,
        } as any,
        status: "ready",
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  function buildServices(pluginId: string) {
    return buildHostServices(db, pluginId, PLUGIN_KEY, createEventBusStub(), undefined, {
      manifest: {
        id: PLUGIN_KEY,
        version: "0.0.0",
        displayName: "Agreement gate test plugin",
        apiVersion: 1,
        entrypoints: { worker: "worker.js" },
        instanceConfigSchema: MANIFEST_SCHEMA,
      } as any,
    });
  }

  it("bar#2: agrees when exactly one of 3+ rows carries a non-null secret-ref value — unions it in", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const companyA = await createCompany("AGA");
    const companyB = await createCompany("AGB");
    const companyC = await createCompany("AGC");

    await registry.upsertConfig(plugin.id, companyA.id, {
      configJson: { defaultBranch: "main", apiKeySecretId: null },
    });
    await registry.upsertConfig(plugin.id, companyB.id, {
      configJson: { defaultBranch: "main" }, // apiKeySecretId absent entirely
    });
    const secretId = "11111111-1111-1111-1111-111111111111";
    await registry.upsertConfig(plugin.id, companyC.id, {
      configJson: { defaultBranch: "main", apiKeySecretId: secretId },
    });

    const services = buildServices(plugin.id);
    const result = await services.config.get();
    services.dispose();

    expect(result).toEqual({ defaultBranch: "main", apiKeySecretId: secretId });
    expect(logger.error).not.toHaveBeenCalled();

    const refreshed = await registry.getById(plugin.id);
    expect(refreshed?.lastError).toBeNull();
  });

  it("bar#3 (pre-PLA-1843 shape): all rows share the SAME non-null secret-ref value — agrees and unions it in", async () => {
    // Proves C2 (distinct-value rule) subsumes the old fan-out shape rather
    // than requiring "exactly one row non-null" (the wrong E1 rule).
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const companyA = await createCompany("PRA");
    const companyB = await createCompany("PRB");
    const companyC = await createCompany("PRC");
    const secretId = "22222222-2222-2222-2222-222222222222";

    for (const company of [companyA, companyB, companyC]) {
      await registry.upsertConfig(plugin.id, company.id, {
        configJson: { defaultBranch: "main", apiKeySecretId: secretId },
      });
    }

    const services = buildServices(plugin.id);
    const result = await services.config.get();
    services.dispose();

    expect(result).toEqual({ defaultBranch: "main", apiKeySecretId: secretId });
  });

  it("bar#4: rows diverging on a non-secret key deny loudly, with bounded redaction", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const companyA = await createCompany("DVA");
    const companyB = await createCompany("DVB");
    const companyC = await createCompany("DVC");

    await registry.upsertConfig(plugin.id, companyA.id, {
      configJson: { defaultBranch: "main" },
    });
    await registry.upsertConfig(plugin.id, companyB.id, {
      configJson: { defaultBranch: "main" },
    });
    await registry.upsertConfig(plugin.id, companyC.id, {
      configJson: { defaultBranch: "dev" }, // diverges
    });

    const services = buildServices(plugin.id);
    // PLA-1999: the rebuilt gate (plugin-config-agreement.ts) throws
    // `config.get denied: ... disagree on key(s): ...` rather than this
    // file's original "owning companies disagree" wording — same loud-failure
    // contract (C5), message text only.
    await expect(services.config.get()).rejects.toThrow(
      /disagree on key\(s\)/,
    );
    services.dispose();

    // log.error: pluginId + diverging company ids + disagreeing top-level keys
    // ONLY — never values.
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [logPayload, logMessage] = (logger.error as any).mock.calls[0];
    expect(logPayload.pluginId).toBe(plugin.id);
    expect(new Set(logPayload.companyIds)).toEqual(
      new Set([companyA.id, companyB.id, companyC.id]),
    );
    // PLA-1999: the rebuilt gate's log payload field is `disagreeingKeys`
    // (was `divergingKeys` in this file's original assertion) — same content.
    expect(logPayload.disagreeingKeys).toEqual(["defaultBranch"]);
    expect(JSON.stringify(logPayload)).not.toContain("main");
    expect(JSON.stringify(logPayload)).not.toContain("dev");
    expect(typeof logMessage).toBe("string");
    expect(logMessage).not.toContain("main");
    expect(logMessage).not.toContain("dev");

    // plugins.lastError: bounded message naming the plugin + fact of
    // divergence — NO company ids (C5, resolved, not to be re-opened).
    const refreshed = await registry.getById(plugin.id);
    expect(refreshed?.lastError).toBeTruthy();
    expect(refreshed!.lastError).not.toContain(companyA.id);
    expect(refreshed!.lastError).not.toContain(companyB.id);
    expect(refreshed!.lastError).not.toContain(companyC.id);
    expect(refreshed!.lastError).not.toContain("main");
    expect(refreshed!.lastError).not.toContain("dev");
  });

  it("bar#5: listConfigRows returns every owning row, no truncation", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const ROW_COUNT = 30;
    const companies_ = [];
    for (let i = 0; i < ROW_COUNT; i += 1) {
      const company = await createCompany(`BULK${i}`);
      companies_.push(company);
      await registry.upsertConfig(plugin.id, company.id, {
        configJson: { defaultBranch: "main" },
      });
    }

    const rows = await registry.listConfigRows(plugin.id);
    expect(rows).toHaveLength(ROW_COUNT);
    const seenCompanyIds = new Set(rows.map((r) => r.companyId));
    expect(seenCompanyIds.size).toBe(ROW_COUNT);
    for (const company of companies_) {
      expect(seenCompanyIds.has(company.id)).toBe(true);
    }
  });

  it("lastError clears to null on the next clean resolve after a prior divergence", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const companyA = await createCompany("CLA");
    const companyB = await createCompany("CLB");

    await registry.upsertConfig(plugin.id, companyA.id, {
      configJson: { defaultBranch: "main" },
    });
    await registry.upsertConfig(plugin.id, companyB.id, {
      configJson: { defaultBranch: "dev" },
    });

    const services = buildServices(plugin.id);
    await expect(services.config.get()).rejects.toThrow();
    let refreshed = await registry.getById(plugin.id);
    expect(refreshed?.lastError).toBeTruthy();

    // Fix the divergence, then resolve cleanly.
    await registry.upsertConfig(plugin.id, companyB.id, {
      configJson: { defaultBranch: "main" },
    });
    const result = await services.config.get();
    services.dispose();

    expect(result).toEqual({ defaultBranch: "main" });
    refreshed = await registry.getById(plugin.id);
    expect(refreshed?.lastError).toBeNull();
  });

  // PLA-1963 AC5 — the exact row shape produced by the 0164 migration's
  // pla1843_drop_foreign_secret_refs scrub: the owner row keeps its
  // secret-ref value, every non-owner row has the path deleted entirely
  // (jsonb `#-`, i.e. ABSENT — not null), and every row's non-secret key
  // (defaultBranch here, standing in for topicMap/catchAllIssueMap/
  // companyPolicies) is byte-identical. getAgreedOrDeny must still resolve
  // this shape and union the owner's secret-ref value back in.
  it("PLA-1963 AC5: resolves the post-scrub shape (ref on the owner row, path absent on every other row)", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const owner = await createCompany("SCRO");
    const nonOwners = await Promise.all(
      ["SCR1", "SCR2", "SCR3", "SCR4", "SCR5", "SCR6", "SCR7"].map((prefix) =>
        createCompany(prefix),
      ),
    );
    const secretId = "33333333-3333-3333-3333-333333333333";

    await registry.upsertConfig(plugin.id, owner.id, {
      configJson: { defaultBranch: "main", apiKeySecretId: secretId },
    });
    for (const company of nonOwners) {
      // Path deleted entirely by the scrub, not set to null.
      await registry.upsertConfig(plugin.id, company.id, {
        configJson: { defaultBranch: "main" },
      });
    }

    const services = buildServices(plugin.id);
    const result = await services.config.get();
    services.dispose();

    expect(result).toEqual({ defaultBranch: "main", apiKeySecretId: secretId });
    expect(logger.error).not.toHaveBeenCalled();

    const refreshed = await registry.getById(plugin.id);
    expect(refreshed?.lastError).toBeNull();
  });
});
