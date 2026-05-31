import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  pluginCompanySettings,
  plugins,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pluginRegistryService } from "../services/plugin-registry.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin company-config-override tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const MANIFEST_SCHEMA = {
  type: "object",
  properties: {
    githubPatSecretId: { type: "string", format: "secret-ref" },
    label: { type: "string" },
  },
};

describeEmbeddedPostgres("pluginRegistryService.upsertCompanyConfigOverride (PLA-677)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("plugin-company-config-override");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(companySecretBindings);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany(name: string): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  async function seedSecret(companyId: string, name: string): Promise<string> {
    const secretId = randomUUID();
    await db.insert(companySecrets).values({
      id: secretId,
      companyId,
      key: name,
      name,
    });
    return secretId;
  }

  async function seedPlugin(): Promise<string> {
    const pluginId = randomUUID();
    const pluginKey = `test.plugin-${pluginId.slice(0, 8)}`;
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: pluginKey,
      version: "0.0.0",
      manifestJson: {
        id: pluginKey,
        version: "0.0.0",
        displayName: "Test plugin",
        apiVersion: 1,
        entrypoints: { worker: "worker.js" },
        instanceConfigSchema: MANIFEST_SCHEMA,
      },
      status: "ready",
    });
    return pluginId;
  }

  function bindingsFor(pluginId: string) {
    return db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.targetType, "plugin"),
          eq(companySecretBindings.targetId, pluginId),
        ),
      );
  }

  it("creates a per-tenant override and binding without touching other tenants", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const secretA = await seedSecret(companyA, "pat-a");
    const secretB = await seedSecret(companyB, "pat-b");
    const pluginId = await seedPlugin();
    const registry = pluginRegistryService(db);

    await registry.upsertCompanyConfigOverride(pluginId, companyA, {
      githubPatSecretId: secretA,
    });
    await registry.upsertCompanyConfigOverride(pluginId, companyB, {
      githubPatSecretId: secretB,
    });

    const rows = await bindingsFor(pluginId);
    expect(rows).toHaveLength(2);
    const byCompany = new Map(rows.map((r) => [r.companyId, r]));
    expect(byCompany.get(companyA)).toMatchObject({ companyId: companyA, secretId: secretA });
    expect(byCompany.get(companyB)).toMatchObject({ companyId: companyB, secretId: secretB });

    const overrideA = await registry.getCompanyConfigOverride(pluginId, companyA);
    expect(overrideA).toEqual({ githubPatSecretId: secretA });
    const overrideB = await registry.getCompanyConfigOverride(pluginId, companyB);
    expect(overrideB).toEqual({ githubPatSecretId: secretB });
  });

  it("repointing one tenant's override leaves the other tenant's binding intact", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const secretA1 = await seedSecret(companyA, "pat-a-1");
    const secretA2 = await seedSecret(companyA, "pat-a-2");
    const secretB = await seedSecret(companyB, "pat-b");
    const pluginId = await seedPlugin();
    const registry = pluginRegistryService(db);

    await registry.upsertCompanyConfigOverride(pluginId, companyA, { githubPatSecretId: secretA1 });
    await registry.upsertCompanyConfigOverride(pluginId, companyB, { githubPatSecretId: secretB });
    await registry.upsertCompanyConfigOverride(pluginId, companyA, { githubPatSecretId: secretA2 });

    const rows = await bindingsFor(pluginId);
    expect(rows).toHaveLength(2);
    const byCompany = new Map(rows.map((r) => [r.companyId, r]));
    expect(byCompany.get(companyA)).toMatchObject({ companyId: companyA, secretId: secretA2 });
    expect(byCompany.get(companyB)).toMatchObject({ companyId: companyB, secretId: secretB });
  });

  it("skips cross-company refs at the binding sync layer (defence in depth)", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const secretB = await seedSecret(companyB, "other-tenant-secret");
    const pluginId = await seedPlugin();
    const registry = pluginRegistryService(db);

    // Direct write at the registry layer — route layer also validates first,
    // but if it ever doesn't, the binding-sync MUST refuse to bind cross-company.
    await registry.upsertCompanyConfigOverride(pluginId, companyA, {
      githubPatSecretId: secretB,
    });

    const rows = await bindingsFor(pluginId);
    expect(rows).toHaveLength(0);

    // Override row is still stored (config write is best-effort + audited),
    // but no binding row is created.
    const overrideA = await registry.getCompanyConfigOverride(pluginId, companyA);
    expect(overrideA).toEqual({ githubPatSecretId: secretB });
  });

  it("deleting an override revokes only that tenant's bindings", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const secretA = await seedSecret(companyA, "pat-a");
    const secretB = await seedSecret(companyB, "pat-b");
    const pluginId = await seedPlugin();
    const registry = pluginRegistryService(db);

    await registry.upsertCompanyConfigOverride(pluginId, companyA, { githubPatSecretId: secretA });
    await registry.upsertCompanyConfigOverride(pluginId, companyB, { githubPatSecretId: secretB });

    await registry.deleteCompanyConfigOverride(pluginId, companyA);

    const rows = await bindingsFor(pluginId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId: companyB, secretId: secretB });

    const overrideA = await registry.getCompanyConfigOverride(pluginId, companyA);
    expect(overrideA).toBeNull();
  });

  it("preserves localFolders settings on the same row when an override is written", async () => {
    const companyA = await seedCompany("A");
    const secretA = await seedSecret(companyA, "pat-a");
    const pluginId = await seedPlugin();
    const registry = pluginRegistryService(db);

    // Seed a localFolders entry first (mirrors what plugin-local-folders.ts writes).
    await registry.upsertCompanySettings(pluginId, companyA, {
      settingsJson: { localFolders: { source: { path: "/tmp/example" } } },
    });
    await registry.upsertCompanyConfigOverride(pluginId, companyA, {
      githubPatSecretId: secretA,
    });

    const settings = await registry.getCompanySettings(pluginId, companyA);
    expect(settings?.settingsJson).toMatchObject({
      localFolders: { source: { path: "/tmp/example" } },
      configOverrides: { githubPatSecretId: secretA },
    });
  });

  it("effective per-tenant config = global plugin_config merged with override", async () => {
    // The host-services `config.getForCompany` shape (mirrored here at the
    // registry layer): start from `plugin_config.configJson` and shallow-merge
    // the per-tenant `configOverrides` on top.
    const companyA = await seedCompany("A");
    const secretA = await seedSecret(companyA, "pat-a");
    const pluginId = await seedPlugin();
    const registry = pluginRegistryService(db);

    // Seed the instance-wide global config with Platform-shape defaults.
    await registry.upsertConfig(pluginId, {
      configJson: { defaultBranch: "main", githubPatSecretId: "00000000-0000-0000-0000-000000000000" },
    });
    await registry.upsertCompanyConfigOverride(pluginId, companyA, {
      githubPatSecretId: secretA,
    });

    const globalConfig = await registry.getConfig(pluginId);
    const override = await registry.getCompanyConfigOverride(pluginId, companyA);
    const effective = {
      ...((globalConfig?.configJson as Record<string, unknown> | undefined) ?? {}),
      ...(override ?? {}),
    };

    expect(effective).toEqual({
      defaultBranch: "main",
      githubPatSecretId: secretA,
    });
  });
});
