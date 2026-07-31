import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, pluginConfig, plugins } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import { ConfigAgreementDeniedError } from "../services/plugin-config-agreement.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

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

    it("Condition 1: a write-side broadcast to company X's non-secret config is visible on company Y's own row, and Y's own secret-ref field is untouched", async () => {
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

      // Simulate the POST /api/plugins/:pluginId/config route: company X
      // writes its own row (mode changes, plus X's own secret-ref), then the
      // route broadcasts the non-secret-ref portion to every sibling row.
      const secretRefPaths = new Set(["githubPatSecretId"]);
      await db
        .update(pluginConfig)
        .set({ configJson: { mode: "staging", githubPatSecretId: "x-secret-v2" } })
        .where(eq(pluginConfig.companyId, companyX.id));
      const touched = await registry.broadcastNonSecretConfig(
        plugin.id,
        companyX.id,
        { mode: "staging", githubPatSecretId: "x-secret-v2" },
        secretRefPaths,
      );
      expect(touched).toEqual([companyY.id]);

      // Company Y's own row now carries X's non-secret write...
      const yRow = await registry.getConfig(plugin.id, companyY.id);
      expect(yRow?.configJson).toMatchObject({ mode: "staging" });
      // ...but Y's own secret-ref field is untouched by X's write.
      expect((yRow?.configJson as Record<string, unknown>)?.githubPatSecretId).toBe(ySecretId);

      // The construction-time agreement gate now sees a genuine secret-ref
      // divergence (X's "x-secret-v2" vs Y's own value) — 2+ distinct values,
      // so that field alone drops per A1, but the broadcast non-secret field
      // ("mode") is what resolves, proving the write-side invariant repair.
      const services = buildHostServices(db, plugin.id, plugin.pluginKey, createEventBusStub());
      const resolved = await services.config.get();
      expect(resolved).toEqual({ mode: "staging" });
      services.dispose();
    });
  },
);
