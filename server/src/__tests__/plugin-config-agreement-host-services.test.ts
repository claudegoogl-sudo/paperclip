import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, pluginConfig, plugins } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import { ConfigAgreementDeniedError } from "../services/plugin-config-agreement.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { writePluginConfigWithAgreement } from "../services/plugin-config-write.js";
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

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: vi.fn(),
        subscribe: vi.fn(),
        clear: vi.fn(),
      };
    },
  } as any;
}

async function getPlugin(db: ReturnType<typeof createDb>, id: string) {
  return db
    .select()
    .from(plugins)
    .where(eq(plugins.id, id))
    .then((rows) => rows[0] ?? null);
}

async function createCompany(db: ReturnType<typeof createDb>, prefix: string) {
  return db
    .insert(companies)
    .values({
      name: `${prefix} ${randomUUID()}`,
      issuePrefix: `${prefix}${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function installPlugin(db: ReturnType<typeof createDb>, pluginKey: string) {
  return db
    .insert(plugins)
    .values({
      pluginKey,
      packageName: pluginKey,
      version: "0.1.0",
      manifestJson: {
        id: pluginKey,
        version: "0.1.0",
        instanceConfigSchema: {
          type: "object",
          properties: {
            mode: { type: "string" },
            githubPatSecretId: { type: "string", format: "secret-ref" },
          },
        },
      } as any,
    })
    .returning()
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres(
  "config.get host-minted agreement gate (PLA-1887/1929/1937/1942)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-config-agreement-");
      db = createDb(tempDb.connectionString);
    }, 20_000);

    afterEach(async () => {
      await db.delete(pluginConfig);
      await db.delete(plugins);
      await db.delete(companies);
      vi.clearAllMocks();
    });

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    it("A3.2: listConfigsForPlugin returns every owning row — no truncation across a large row set", async () => {
      const plugin = await installPlugin(db, "paperclip.config-agreement-test-a");
      const companyRows = await Promise.all(
        Array.from({ length: 12 }, (_, index) => createCompany(db, `AG${index}`)),
      );
      await db.insert(pluginConfig).values(
        companyRows.map((company) => ({
          pluginId: plugin.id,
          companyId: company.id,
          configJson: { mode: "prod" },
        })),
      );

      const services = buildHostServices(db, plugin.id, plugin.pluginKey, createEventBusStub());
      const result = await services.config.get();
      expect(result).toEqual({ mode: "prod" });
      services.dispose();
    });

    it("A3.3: agreeing owning rows resolve a construction-time config.get with no dispatch scope", async () => {
      const plugin = await installPlugin(db, "paperclip.config-agreement-test-b");
      const secretRefId = "22222222-2222-4222-8222-222222222222";
      const companyA = await createCompany(db, "AGA");
      const companyB = await createCompany(db, "AGB");
      await db.insert(pluginConfig).values([
        {
          pluginId: plugin.id,
          companyId: companyA.id,
          configJson: { mode: "prod", githubPatSecretId: secretRefId },
        },
        {
          pluginId: plugin.id,
          companyId: companyB.id,
          configJson: { mode: "prod", githubPatSecretId: secretRefId },
        },
      ]);

      const services = buildHostServices(db, plugin.id, plugin.pluginKey, createEventBusStub());
      const result = await services.config.get();
      // A1: identical secret-ref value across every owning row is one
      // distinct value — union it in, don't drop it.
      expect(result).toEqual({ mode: "prod", githubPatSecretId: secretRefId });

      const current = await getPlugin(db, plugin.id);
      expect(current?.lastError ?? null).toBeNull();
      services.dispose();
    });

    it("A3.3b: agrees when exactly one of 3+ rows carries a non-null secret-ref value — unions it in", async () => {
      const plugin = await installPlugin(db, "paperclip.config-agreement-test-b2");
      const companyA = await createCompany(db, "AGE");
      const companyB = await createCompany(db, "AGF");
      const companyC = await createCompany(db, "AGG");
      const secretRefId = "11111111-1111-4111-8111-111111111111";

      await db.insert(pluginConfig).values([
        { pluginId: plugin.id, companyId: companyA.id, configJson: { mode: "prod", githubPatSecretId: null } },
        // githubPatSecretId absent entirely on B — same "no value" outcome as A's explicit null.
        { pluginId: plugin.id, companyId: companyB.id, configJson: { mode: "prod" } },
        { pluginId: plugin.id, companyId: companyC.id, configJson: { mode: "prod", githubPatSecretId: secretRefId } },
      ]);

      const services = buildHostServices(db, plugin.id, plugin.pluginKey, createEventBusStub());
      const result = await services.config.get();
      services.dispose();

      // A1: "at most one DISTINCT non-null value" unions it in even though
      // only one of three rows actually carries it — a row-count check (the
      // superseded rule) would misread this as a 1-of-3 conflict and drop it.
      expect(result).toEqual({ mode: "prod", githubPatSecretId: secretRefId });
      expect(logger.error).not.toHaveBeenCalled();
      const current = await getPlugin(db, plugin.id);
      expect(current?.lastError ?? null).toBeNull();
    });

    it("A3.3/A3.4b: diverging owning rows deny config.get and surface a tenant-neutral message on plugins.lastError", async () => {
      const plugin = await installPlugin(db, "paperclip.config-agreement-test-c");
      const companyA = await createCompany(db, "AGC");
      const companyB = await createCompany(db, "AGD");
      await db.insert(pluginConfig).values([
        { pluginId: plugin.id, companyId: companyA.id, configJson: { mode: "prod" } },
        { pluginId: plugin.id, companyId: companyB.id, configJson: { mode: "staging" } },
      ]);

      const services = buildHostServices(db, plugin.id, plugin.pluginKey, createEventBusStub());
      await expect(services.config.get()).rejects.toBeInstanceOf(ConfigAgreementDeniedError);

      const denied = await getPlugin(db, plugin.id);
      expect(denied?.lastError).toBe(
        "config-agreement: unscoped config.get denied; owning config rows disagree on key(s): mode. See host log for company detail.",
      );
      // A2: the persisted, board-readable message must never contain a
      // company id — only the host-side `log.error` (not this table) gets
      // full detail.
      expect(denied?.lastError).not.toContain(companyA.id);
      expect(denied?.lastError).not.toContain(companyB.id);
      // The plugin's lifecycle status must pass through unchanged — a denied
      // config read is a health signal, not a lifecycle transition.
      expect(denied?.status).toBe("installed");

      // Fixing the divergence and reading again must clear lastError back to
      // healthy, or a resolved divergence leaves a permanent false-positive.
      await db
        .update(pluginConfig)
        .set({ configJson: { mode: "prod" } })
        .where(eq(pluginConfig.companyId, companyB.id));
      const resolved = await services.config.get();
      expect(resolved).toEqual({ mode: "prod" });
      const healed = await getPlugin(db, plugin.id);
      expect(healed?.lastError ?? null).toBeNull();

      services.dispose();
    });

    it("bar#4: rows diverging on a non-secret key deny loudly, with bounded redaction on the host log only", async () => {
      const plugin = await installPlugin(db, "paperclip.config-agreement-test-bar4");
      const companyA = await createCompany(db, "AGH");
      const companyB = await createCompany(db, "AGI");
      const companyC = await createCompany(db, "AGJ");

      await db.insert(pluginConfig).values([
        { pluginId: plugin.id, companyId: companyA.id, configJson: { mode: "prod" } },
        { pluginId: plugin.id, companyId: companyB.id, configJson: { mode: "prod" } },
        { pluginId: plugin.id, companyId: companyC.id, configJson: { mode: "canary" } },
      ]);

      const services = buildHostServices(db, plugin.id, plugin.pluginKey, createEventBusStub());
      await expect(services.config.get()).rejects.toBeInstanceOf(ConfigAgreementDeniedError);
      services.dispose();

      // bar#4: the host log carries full detail (pluginId/pluginKey/company
      // ids/which keys disagree)...
      expect(logger.error).toHaveBeenCalledTimes(1);
      const [logPayload, logMessage] = (logger.error as any).mock.calls[0];
      expect(logPayload.pluginId).toBe(plugin.id);
      expect(logPayload.pluginKey).toBe(plugin.pluginKey);
      expect(new Set(logPayload.companyIds)).toEqual(new Set([companyA.id, companyB.id, companyC.id]));
      expect(logPayload.disagreeingKeys).toEqual(["mode"]);
      // ...but the diverging VALUES themselves never leak into the log
      // payload or message — only key names and ids are safe to record.
      expect(JSON.stringify(logPayload)).not.toContain("prod");
      expect(JSON.stringify(logPayload)).not.toContain("canary");
      expect(typeof logMessage).toBe("string");
      expect(logMessage).not.toContain("prod");
      expect(logMessage).not.toContain("canary");
    });

    it("PLA-1963 AC5: resolves the post-scrub shape — ref present on the owner row, path absent (not null) on every other row", async () => {
      const plugin = await installPlugin(db, "paperclip.config-agreement-test-scrub");
      const owner = await createCompany(db, "AGK");
      const nonOwners = await Promise.all(
        Array.from({ length: 7 }, (_, index) => createCompany(db, `AGL${index}`)),
      );
      const secretRefId = "44444444-4444-4444-8444-444444444444";

      await db.insert(pluginConfig).values([
        { pluginId: plugin.id, companyId: owner.id, configJson: { mode: "prod", githubPatSecretId: secretRefId } },
        ...nonOwners.map((company) => ({
          pluginId: plugin.id,
          companyId: company.id,
          // 0164 scrub shape: the secret-ref path is entirely ABSENT here,
          // not present-with-null — the union rule must treat both the same.
          configJson: { mode: "prod" },
        })),
      ]);

      const services = buildHostServices(db, plugin.id, plugin.pluginKey, createEventBusStub());
      const result = await services.config.get();
      services.dispose();

      expect(result).toEqual({ mode: "prod", githubPatSecretId: secretRefId });
      expect(logger.error).not.toHaveBeenCalled();
      const current = await getPlugin(db, plugin.id);
      expect(current?.lastError ?? null).toBeNull();
    });

    it("Condition 1 (PLA-1957 applyToAllCompanies): an explicit-consent fan-out write from company X is visible on company Y's own row, and Y's own secret-ref field is untouched", async () => {
      const registry = pluginRegistryService(db);
      const plugin = await installPlugin(db, "paperclip.config-agreement-test-broadcast");
      const companyX = await createCompany(db, "AGX");
      const companyY = await createCompany(db, "AGY");
      const ySecretId = "33333333-3333-4333-8333-333333333333";

      await db.insert(pluginConfig).values([
        {
          pluginId: plugin.id,
          companyId: companyX.id,
          configJson: { mode: "prod", githubPatSecretId: "x-secret" },
        },
        {
          pluginId: plugin.id,
          companyId: companyY.id,
          configJson: { mode: "prod", githubPatSecretId: ySecretId },
        },
      ]);

      // Simulate the POST /api/plugins/:pluginId/config route with explicit
      // applyToAllCompanies consent: company X writes its own row (mode
      // changes, plus X's own secret-ref), and the PLA-1957 fan-out applies
      // the non-secret-ref portion to every sibling row atomically.
      const schema = plugin.manifestJson?.instanceConfigSchema as Record<string, unknown>;
      const result = await writePluginConfigWithAgreement(db, {
        pluginId: plugin.id,
        companyId: companyX.id,
        configJson: { mode: "staging", githubPatSecretId: "x-secret-v2" },
        schema,
        options: { applyToAllCompanies: true },
      });
      expect(result.fannedOut).toBe(true);
      expect(result.companiesWritten).toEqual([companyX.id, companyY.id]);

      // Company Y's own row now carries X's non-secret write...
      const yRow = await registry.getConfig(plugin.id, companyY.id);
      expect(yRow?.configJson).toMatchObject({ mode: "staging" });
      // ...but Y's own secret-ref field is untouched by X's write.
      expect((yRow?.configJson as Record<string, unknown>)?.githubPatSecretId).toBe(ySecretId);

      // The construction-time agreement gate now sees a genuine secret-ref
      // divergence (X's "x-secret-v2" vs Y's own value) — 2+ distinct values,
      // so that field alone drops per A1, but the fanned-out non-secret field
      // ("mode") is what resolves, proving the write-side invariant repair.
      const services = buildHostServices(db, plugin.id, plugin.pluginKey, createEventBusStub());
      const resolved = await services.config.get();
      expect(resolved).toEqual({ mode: "staging" });
      services.dispose();
    });
  },
);
