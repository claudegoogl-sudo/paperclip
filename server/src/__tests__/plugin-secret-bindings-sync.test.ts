import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin secret-binding sync tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A manifest schema with a top-level (flat) secret-ref field — the exact shape
// the env-binding `syncSecretRefsForTarget` prefix-delete cannot handle — plus a
// nested secret-ref and a non-secret field that must never be bound.
const SCHEMA = {
  type: "object",
  properties: {
    githubPatSecretId: { type: "string", format: "secret-ref" },
    label: { type: "string" },
    nested: {
      type: "object",
      properties: {
        token: { type: "string", format: "secret-ref" },
      },
    },
  },
};

describeEmbeddedPostgres("secretService.syncPluginSecretBindings", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("plugin-secret-bindings-sync");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
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

  it("creates an instance-wide binding owned by the secret's company", async () => {
    const companyId = await seedCompany("Acme");
    const secretId = await seedSecret(companyId, "cad-artifacts-github-pat");
    const pluginId = randomUUID();

    const res = await secretService(db).syncPluginSecretBindings({
      pluginId,
      instanceConfigSchema: SCHEMA,
      previousConfig: null,
      nextConfig: { githubPatSecretId: secretId, label: "ignore-me" },
    });

    expect(res).toEqual({ bound: 1, revoked: 0 });
    const rows = await bindingsFor(pluginId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      secretId,
      targetId: pluginId,
      configPath: "githubPatSecretId",
      versionSelector: "latest",
      required: true,
    });
  });

  it("is idempotent — re-saving identical config keeps exactly one row", async () => {
    const companyId = await seedCompany("Acme");
    const secretId = await seedSecret(companyId, "pat");
    const pluginId = randomUUID();
    const svc = secretService(db);
    const config = { githubPatSecretId: secretId };

    await svc.syncPluginSecretBindings({ pluginId, instanceConfigSchema: SCHEMA, previousConfig: null, nextConfig: config });
    const second = await svc.syncPluginSecretBindings({
      pluginId,
      instanceConfigSchema: SCHEMA,
      previousConfig: config,
      nextConfig: config,
    });

    expect(second).toEqual({ bound: 1, revoked: 0 });
    const rows = await bindingsFor(pluginId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.secretId).toBe(secretId);
  });

  it("removes the binding when the secret-ref field is cleared", async () => {
    const companyId = await seedCompany("Acme");
    const secretId = await seedSecret(companyId, "pat");
    const pluginId = randomUUID();
    const svc = secretService(db);

    await svc.syncPluginSecretBindings({
      pluginId,
      instanceConfigSchema: SCHEMA,
      previousConfig: null,
      nextConfig: { githubPatSecretId: secretId },
    });
    const cleared = await svc.syncPluginSecretBindings({
      pluginId,
      instanceConfigSchema: SCHEMA,
      previousConfig: { githubPatSecretId: secretId },
      nextConfig: {},
    });

    expect(cleared).toEqual({ bound: 0, revoked: 1 });
    expect(await bindingsFor(pluginId)).toHaveLength(0);
  });

  it("repoints to a new owner: revokes the old company row, binds the new", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const secretA = await seedSecret(companyA, "pat-a");
    const secretB = await seedSecret(companyB, "pat-b");
    const pluginId = randomUUID();
    const svc = secretService(db);

    await svc.syncPluginSecretBindings({
      pluginId,
      instanceConfigSchema: SCHEMA,
      previousConfig: null,
      nextConfig: { githubPatSecretId: secretA },
    });
    const repointed = await svc.syncPluginSecretBindings({
      pluginId,
      instanceConfigSchema: SCHEMA,
      previousConfig: { githubPatSecretId: secretA },
      nextConfig: { githubPatSecretId: secretB },
    });

    expect(repointed).toEqual({ bound: 1, revoked: 1 });
    const rows = await bindingsFor(pluginId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId: companyB, secretId: secretB });
  });

  it("binds nested secret-ref paths with the manifest dot-path", async () => {
    const companyId = await seedCompany("Acme");
    const secretId = await seedSecret(companyId, "nested-token");
    const pluginId = randomUUID();

    await secretService(db).syncPluginSecretBindings({
      pluginId,
      instanceConfigSchema: SCHEMA,
      previousConfig: null,
      nextConfig: { nested: { token: secretId } },
    });

    const rows = await bindingsFor(pluginId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.configPath).toBe("nested.token");
  });

  it("skips orphan refs (no matching secret) without throwing", async () => {
    const pluginId = randomUUID();
    const res = await secretService(db).syncPluginSecretBindings({
      pluginId,
      instanceConfigSchema: SCHEMA,
      previousConfig: null,
      nextConfig: { githubPatSecretId: randomUUID() },
    });
    expect(res).toEqual({ bound: 0, revoked: 0 });
    expect(await bindingsFor(pluginId)).toHaveLength(0);
  });

  it("no-ops when the manifest declares no secret-ref fields", async () => {
    const companyId = await seedCompany("Acme");
    const secretId = await seedSecret(companyId, "pat");
    const pluginId = randomUUID();

    const res = await secretService(db).syncPluginSecretBindings({
      pluginId,
      instanceConfigSchema: { type: "object", properties: { label: { type: "string" } } },
      previousConfig: null,
      // Even a UUID-shaped value at a non-secret-ref field must not bind.
      nextConfig: { label: secretId },
    });
    expect(res).toEqual({ bound: 0, revoked: 0 });
    expect(await bindingsFor(pluginId)).toHaveLength(0);
  });

  describe("per-company scope (plugin_company_settings)", () => {
    it("binds only secrets owned by the saving company; skips cross-company refs", async () => {
      const companyC = await seedCompany("C");
      const companyD = await seedCompany("D");
      const secretC = await seedSecret(companyC, "own");
      const secretD = await seedSecret(companyD, "other");
      const pluginId = randomUUID();
      const svc = secretService(db);

      // Cross-company ref → skipped.
      const cross = await svc.syncPluginSecretBindings({
        pluginId,
        instanceConfigSchema: SCHEMA,
        previousConfig: null,
        nextConfig: { githubPatSecretId: secretD },
        companyId: companyC,
      });
      expect(cross).toEqual({ bound: 0, revoked: 0 });
      expect(await bindingsFor(pluginId)).toHaveLength(0);

      // Own ref → bound to the saving company.
      const own = await svc.syncPluginSecretBindings({
        pluginId,
        instanceConfigSchema: SCHEMA,
        previousConfig: null,
        nextConfig: { githubPatSecretId: secretC },
        companyId: companyC,
      });
      expect(own).toEqual({ bound: 1, revoked: 0 });
      const rows = await bindingsFor(pluginId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ companyId: companyC, secretId: secretC });
    });
  });
});
