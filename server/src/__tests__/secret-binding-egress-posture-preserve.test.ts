import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  companySecretBindings,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping secret-binding egress-posture preserve tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const PLUGIN_SCHEMA = {
  type: "object",
  properties: {
    githubPatSecretId: { type: "string", format: "secret-ref" },
  },
};

/**
 * A binding's egress posture (`allowedEgress`, `egressAllowlistEnforced`)
 * is operator state keyed by `(companyId, targetType, targetId, configPath)` — not
 * by the row id. Delete+reinsert syncs re-create rows with fresh ids, so every one
 * of them must carry the old row's posture via the shared preserve helper
 * (`preservedEgressPosture`). A config re-save must not silently change posture in
 * either direction; new bindings are born enforcing.
 *
 * The replace-path tests fail on a checkout without the fix
 * (replaceSecretRefsForInstanceTarget wiped posture); the rest are the regression
 * guards that make "delete the helper call from any one call site" turn red.
 */
describeEmbeddedPostgres("secret binding egress posture is preserved across delete+reinsert syncs", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("secret-binding-egress-posture-preserve");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(companySecretBindings);
    await db.delete(companySecrets);
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

  async function seedBinding(input: {
    companyId: string;
    secretId: string;
    targetType: "environment" | "agent" | "plugin";
    targetId: string;
    configPath: string;
    allowedEgress: string[];
    enforced: boolean;
  }) {
    await db.insert(companySecretBindings).values({
      companyId: input.companyId,
      secretId: input.secretId,
      targetType: input.targetType,
      targetId: input.targetId,
      configPath: input.configPath,
      versionSelector: "latest",
      required: true,
      allowedEgress: input.allowedEgress,
      egressAllowlistEnforced: input.enforced,
    });
  }

  function bindingsFor(targetId: string) {
    return db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, targetId));
  }

  it("(AC-a) replaceSecretRefsForInstanceTarget preserves an operator-set allowedEgress across a re-save", async () => {
    const companyId = await seedCompany("Acme");
    const secretId = await seedSecret(companyId, "provider-key");
    const environmentId = randomUUID();
    await seedBinding({
      companyId,
      secretId,
      targetType: "environment",
      targetId: environmentId,
      configPath: "apiKey",
      allowedEgress: ["https://example.com"],
      enforced: true,
    });

    await secretService(db).replaceSecretRefsForInstanceTarget(
      { targetType: "environment", targetId: environmentId },
      [{ secretId, configPath: "apiKey" }],
    );

    const rows = await bindingsFor(environmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.configPath).toBe("apiKey");
    expect(rows[0]?.secretId).toBe(secretId);
    expect(rows[0]?.allowedEgress).toEqual(["https://example.com"]);
  });

  it("(AC-b) replaceSecretRefsForInstanceTarget preserves egressAllowlistEnforced=false across a re-save", async () => {
    const companyId = await seedCompany("Acme");
    const secretId = await seedSecret(companyId, "provider-key");
    const environmentId = randomUUID();
    await seedBinding({
      companyId,
      secretId,
      targetType: "environment",
      targetId: environmentId,
      configPath: "apiKey",
      allowedEgress: ["https://example.com"],
      enforced: false,
    });

    await secretService(db).replaceSecretRefsForInstanceTarget(
      { targetType: "environment", targetId: environmentId },
      [{ secretId, configPath: "apiKey" }],
    );

    const rows = await bindingsFor(environmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.egressAllowlistEnforced).toBe(false);
    expect(rows[0]?.allowedEgress).toEqual(["https://example.com"]);
  });

  it("replaceSecretRefsForInstanceTarget preserves posture per company on a shared instance target", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const secretA = await seedSecret(companyA, "key-a");
    const secretB = await seedSecret(companyB, "key-b");
    const environmentId = randomUUID();
    await seedBinding({
      companyId: companyA,
      secretId: secretA,
      targetType: "environment",
      targetId: environmentId,
      configPath: "apiKey",
      allowedEgress: ["https://a.example"],
      enforced: false,
    });
    await seedBinding({
      companyId: companyB,
      secretId: secretB,
      targetType: "environment",
      targetId: environmentId,
      configPath: "apiKey",
      allowedEgress: ["https://b.example"],
      enforced: true,
    });

    await secretService(db).replaceSecretRefsForInstanceTarget(
      { targetType: "environment", targetId: environmentId },
      [
        { secretId: secretA, configPath: "apiKey" },
        { secretId: secretB, configPath: "apiKey" },
      ],
    );

    const rows = await bindingsFor(environmentId);
    expect(rows).toHaveLength(2);
    const rowA = rows.find((row) => row.companyId === companyA);
    const rowB = rows.find((row) => row.companyId === companyB);
    expect(rowA?.allowedEgress).toEqual(["https://a.example"]);
    expect(rowA?.egressAllowlistEnforced).toBe(false);
    expect(rowB?.allowedEgress).toEqual(["https://b.example"]);
    expect(rowB?.egressAllowlistEnforced).toBe(true);
  });

  it("(AC-c) syncSecretRefsForTarget keeps preserving operator posture on re-sync", async () => {
    const companyId = await seedCompany("Acme");
    const secretId = await seedSecret(companyId, "agent-key");
    const target = { targetType: "environment" as const, targetId: "tgt-sync-1" };
    await seedBinding({
      companyId,
      secretId,
      targetType: "environment",
      targetId: target.targetId,
      configPath: "env.API_KEY",
      allowedEgress: ["https://example.com"],
      enforced: false,
    });

    await secretService(db).syncSecretRefsForTarget(companyId, target, [
      { secretId, configPath: "env.API_KEY" },
    ]);

    const rows = await bindingsFor(target.targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.allowedEgress).toEqual(["https://example.com"]);
    expect(rows[0]?.egressAllowlistEnforced).toBe(false);
  });

  it("(AC-c) syncEnvBindingsForTarget keeps preserving operator posture on re-sync", async () => {
    const companyId = await seedCompany("Acme");
    const secretId = await seedSecret(companyId, "agent-env-key");
    const target = { targetType: "agent" as const, targetId: "agent-sync-1" };
    await seedBinding({
      companyId,
      secretId,
      targetType: "agent",
      targetId: target.targetId,
      configPath: "env.API_KEY",
      allowedEgress: ["https://example.com"],
      enforced: false,
    });

    await secretService(db).syncEnvBindingsForTarget(companyId, target, {
      API_KEY: { type: "secret_ref", secretId, version: "latest" },
    });

    const rows = await bindingsFor(target.targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.configPath).toBe("env.API_KEY");
    expect(rows[0]?.allowedEgress).toEqual(["https://example.com"]);
    expect(rows[0]?.egressAllowlistEnforced).toBe(false);
  });

  it("(AC-d) syncPluginSecretBindings carries operator posture across a repoint (delete+reinsert of the same path)", async () => {
    const companyId = await seedCompany("Acme");
    const secretA = await seedSecret(companyId, "old-pat");
    const secretB = await seedSecret(companyId, "new-pat");
    const pluginId = randomUUID();
    await seedBinding({
      companyId,
      secretId: secretA,
      targetType: "plugin",
      targetId: pluginId,
      configPath: "githubPatSecretId",
      allowedEgress: ["https://example.com"],
      enforced: false,
    });

    const res = await secretService(db).syncPluginSecretBindings({
      pluginId,
      instanceConfigSchema: PLUGIN_SCHEMA,
      previousConfig: { githubPatSecretId: secretA },
      nextConfig: { githubPatSecretId: secretB },
    });

    expect(res).toEqual({ bound: 1, revoked: 1 });
    const rows = await bindingsFor(pluginId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.secretId).toBe(secretB);
    expect(rows[0]?.configPath).toBe("githubPatSecretId");
    expect(rows[0]?.allowedEgress).toEqual(["https://example.com"]);
    expect(rows[0]?.egressAllowlistEnforced).toBe(false);
  });

  it("(AC-e) a binding born at a config path with no prior row is enforcing with an empty allowlist", async () => {
    const companyId = await seedCompany("Acme");
    const secretId = await seedSecret(companyId, "fresh-key");
    const environmentId = randomUUID();

    await secretService(db).replaceSecretRefsForInstanceTarget(
      { targetType: "environment", targetId: environmentId },
      [{ secretId, configPath: "freshPath" }],
    );
    const rows = await bindingsFor(environmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.allowedEgress).toEqual([]);
    expect(rows[0]?.egressAllowlistEnforced).toBe(true);

    const pluginId = randomUUID();
    await secretService(db).syncPluginSecretBindings({
      pluginId,
      instanceConfigSchema: PLUGIN_SCHEMA,
      previousConfig: null,
      nextConfig: { githubPatSecretId: secretId },
    });
    const pluginRows = await bindingsFor(pluginId);
    expect(pluginRows).toHaveLength(1);
    expect(pluginRows[0]?.allowedEgress).toEqual([]);
    expect(pluginRows[0]?.egressAllowlistEnforced).toBe(true);
  });
});
