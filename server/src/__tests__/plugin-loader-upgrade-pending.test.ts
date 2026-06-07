import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companySecretBindings,
  companySecrets,
  createDb,
  pluginConfig,
  pluginState,
  plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  pluginLoader,
  type CapabilityEscalationGateway,
  type CapabilityEscalationRequest,
} from "../services/plugin-loader.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const PLUGIN_KEY = "paperclip.upgrade-pending-test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin upgrade-pending tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * A capability-escalation gateway test double. Records every `file()` call and
 * tracks the pending approval per (pluginId, toVersion) so the loader's
 * idempotency / convergence path (criterion 5) can be exercised without the
 * real company-scoped approvals service.
 */
function createGatewayStub() {
  const filed: CapabilityEscalationRequest[] = [];
  const pendingByKey = new Map<string, string>();
  // The board-approved contract per plugin. In this stub a filed approval is
  // treated as approved, which is what `completeUpgrade` verifies against.
  const approvedByPlugin = new Map<
    string,
    { approvalId: string; toVersion: string; addedCapabilities: string[] }
  >();
  let counter = 0;
  const gateway: CapabilityEscalationGateway = {
    async findPending({ pluginId, toVersion }) {
      return pendingByKey.get(`${pluginId}:${toVersion}`) ?? null;
    },
    async file(input) {
      filed.push(input);
      const approvalId = `approval-${++counter}`;
      pendingByKey.set(`${input.pluginId}:${input.toVersion}`, approvalId);
      approvedByPlugin.set(input.pluginId, {
        approvalId,
        toVersion: input.toVersion,
        addedCapabilities: input.addedCapabilities,
      });
      return approvalId;
    },
    async findApproved({ pluginId }) {
      return approvedByPlugin.get(pluginId) ?? null;
    },
  };
  return { filed, pendingByKey, approvedByPlugin, gateway };
}

function manifest(
  version: string,
  capabilities: PaperclipPluginManifestV1["capabilities"],
): PaperclipPluginManifestV1 {
  return {
    id: PLUGIN_KEY,
    apiVersion: 1,
    version,
    displayName: "Upgrade Pending Test",
    description: "Exercises board-gated capability escalation on upgrade.",
    author: "Paperclip",
    categories: ["automation"],
    capabilities,
    entrypoints: { worker: "./dist/worker.js" },
  };
}

describeEmbeddedPostgres("plugin-loader upgrade_pending (PLA-908)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let packageRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-upgrade-pending-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companySecretBindings);
    await db.delete(companySecrets);
    await db.delete(pluginState);
    await db.delete(pluginConfig);
    await db.delete(plugins);
    await db.delete(companies);
    await Promise.all(packageRoots.map((root) => rm(root, { recursive: true, force: true })));
    packageRoots = [];
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function writePackage(pluginManifest: PaperclipPluginManifestV1): Promise<string> {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-upgrade-pkg-"));
    packageRoots.push(packageRoot);
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: pluginManifest.id,
        version: pluginManifest.version,
        type: "module",
        paperclipPlugin: { manifest: "./manifest.js" },
      }),
      "utf8",
    );
    await writeFile(
      path.join(packageRoot, "manifest.js"),
      `export default ${JSON.stringify(pluginManifest, null, 2)};\n`,
      "utf8",
    );
    await mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await writeFile(path.join(packageRoot, "dist", "worker.js"), "export {};\n", "utf8");
    return packageRoot;
  }

  async function seedPlugin(
    pluginManifest: PaperclipPluginManifestV1,
    packagePath: string,
  ): Promise<string> {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: pluginManifest.id,
      packageName: pluginManifest.id,
      version: pluginManifest.version,
      apiVersion: pluginManifest.apiVersion,
      categories: pluginManifest.categories,
      manifestJson: pluginManifest,
      packagePath,
      status: "ready",
      installOrder: 1,
    });
    return pluginId;
  }

  function makeLoader(gateway?: CapabilityEscalationGateway) {
    return pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
      escalationGateway: gateway,
    });
  }

  it("parks the plugin and files an approval instead of throwing on cap escalation (criteria 1, 3, 6)", async () => {
    const oldManifest = manifest("0.1.0", ["issues.read"]);
    const oldPkg = await writePackage(oldManifest);
    const newManifest = manifest("0.2.0", ["issues.read", "issues.create"]);
    const newPkg = await writePackage(newManifest);
    const pluginId = await seedPlugin(oldManifest, oldPkg);

    const { filed, gateway } = createGatewayStub();
    const loader = makeLoader(gateway);

    const result = await loader.upgradePlugin(pluginId, { localPath: newPkg });

    expect(result.status).toBe("upgrade_pending");
    expect(result.addedCapabilities).toEqual(["issues.create"]);
    expect(result.approvalId).toBe("approval-1");

    // Exactly one approval filed, naming the plugin + version delta + added caps.
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      pluginId,
      pluginKey: PLUGIN_KEY,
      fromVersion: "0.1.0",
      toVersion: "0.2.0",
      addedCapabilities: ["issues.create"],
    });

    // No silent escalation: the row is parked but version/caps/manifest are
    // untouched until the upgrade is completed (criteria 3 & 6).
    const [row] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
    expect(row?.status).toBe("upgrade_pending");
    expect(row?.version).toBe("0.1.0");
    expect(row?.manifestJson.capabilities).toEqual(["issues.read"]);
  });

  it("fails closed when no escalation gateway is configured", async () => {
    const oldManifest = manifest("0.1.0", ["issues.read"]);
    const oldPkg = await writePackage(oldManifest);
    const newManifest = manifest("0.2.0", ["issues.read", "issues.create"]);
    const newPkg = await writePackage(newManifest);
    const pluginId = await seedPlugin(oldManifest, oldPkg);

    const loader = makeLoader(); // no gateway

    await expect(loader.upgradePlugin(pluginId, { localPath: newPkg })).rejects.toThrow(
      /require approval|capabilit/i,
    );

    const [row] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
    expect(row?.status).toBe("ready");
    expect(row?.version).toBe("0.1.0");
  });

  it("completes a parked upgrade after approval, preserving config/state/secret-ref bindings (criterion 2)", async () => {
    const oldManifest = manifest("0.1.0", ["issues.read"]);
    const oldPkg = await writePackage(oldManifest);
    const newManifest = manifest("0.2.0", ["issues.read", "issues.create"]);
    const newPkg = await writePackage(newManifest);
    const pluginId = await seedPlugin(oldManifest, oldPkg);

    // Seed plugin-scoped data that must survive the upgrade untouched.
    const [config] = await db
      .insert(pluginConfig)
      .values({ pluginId, configJson: { apiBase: "https://example.test", retries: 3 } })
      .returning();
    const [state] = await db
      .insert(pluginState)
      .values({
        pluginId,
        scopeKind: "instance",
        scopeId: null,
        stateKey: "cursor",
        valueJson: { offset: 42 },
      })
      .returning();

    // Secret-ref binding lives in a separate table with no FK to plugins.
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Platform", issuePrefix: "PLA" });
    const [secret] = await db
      .insert(companySecrets)
      .values({ companyId, key: "upgrade_test_secret", name: "Upgrade Test Secret" })
      .returning();
    const [binding] = await db
      .insert(companySecretBindings)
      .values({
        companyId,
        secretId: secret.id,
        targetType: "plugin",
        targetId: PLUGIN_KEY,
        configPath: "apiKey",
      })
      .returning();

    const { gateway } = createGatewayStub();
    const loader = makeLoader(gateway);

    await loader.upgradePlugin(pluginId, { localPath: newPkg });
    const completed = await loader.completeUpgrade(pluginId, { localPath: newPkg });

    // Version + capabilities now reflect the approved upgrade.
    expect(completed.status).toBe("ready");
    expect(completed.version).toBe("0.2.0");
    const [row] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
    expect(row?.version).toBe("0.2.0");
    expect(row?.manifestJson.capabilities).toEqual(["issues.read", "issues.create"]);

    // Config, state, and the secret-ref binding survive byte-for-byte.
    const [configAfter] = await db.select().from(pluginConfig).where(eq(pluginConfig.id, config.id));
    expect(configAfter).toEqual(config);
    const [stateAfter] = await db.select().from(pluginState).where(eq(pluginState.id, state.id));
    expect(stateAfter).toEqual(state);
    const [bindingAfter] = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.id, binding.id));
    expect(bindingAfter).toEqual(binding);
  });

  it("reverts a rejected upgrade to the prior version/caps/ready with no partial mutation (criterion 3)", async () => {
    const oldManifest = manifest("0.1.0", ["issues.read"]);
    const oldPkg = await writePackage(oldManifest);
    const newManifest = manifest("0.2.0", ["issues.read", "issues.create"]);
    const newPkg = await writePackage(newManifest);
    const pluginId = await seedPlugin(oldManifest, oldPkg);

    const { gateway } = createGatewayStub();
    const loader = makeLoader(gateway);

    await loader.upgradePlugin(pluginId, { localPath: newPkg });
    const reverted = await loader.revertPendingUpgrade(pluginId);

    expect(reverted.status).toBe("ready");
    expect(reverted.version).toBe("0.1.0");
    const [row] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
    expect(row?.status).toBe("ready");
    expect(row?.version).toBe("0.1.0");
    expect(row?.manifestJson.capabilities).toEqual(["issues.read"]);
  });

  it("applies a non-escalating upgrade in place without filing an approval (criterion 4)", async () => {
    const oldManifest = manifest("0.1.0", ["issues.read"]);
    const oldPkg = await writePackage(oldManifest);
    const newManifest = manifest("0.2.0", ["issues.read"]); // same caps
    const newPkg = await writePackage(newManifest);
    const pluginId = await seedPlugin(oldManifest, oldPkg);

    const { filed, gateway } = createGatewayStub();
    const loader = makeLoader(gateway);

    const result = await loader.upgradePlugin(pluginId, { localPath: newPkg });

    expect(result.status).toBe("ready");
    expect(result.approvalId).toBeNull();
    expect(result.addedCapabilities).toEqual([]);
    expect(filed).toHaveLength(0);

    const [row] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
    expect(row?.status).toBe("ready");
    expect(row?.version).toBe("0.2.0");
    expect(row?.manifestJson.capabilities).toEqual(["issues.read"]);
  });

  it("converges on a repeated escalating upgrade without double-filing (criterion 5)", async () => {
    const oldManifest = manifest("0.1.0", ["issues.read"]);
    const oldPkg = await writePackage(oldManifest);
    const newManifest = manifest("0.2.0", ["issues.read", "issues.create"]);
    const newPkg = await writePackage(newManifest);
    const pluginId = await seedPlugin(oldManifest, oldPkg);

    const { filed, gateway } = createGatewayStub();
    const loader = makeLoader(gateway);

    const first = await loader.upgradePlugin(pluginId, { localPath: newPkg });
    const second = await loader.upgradePlugin(pluginId, { localPath: newPkg });

    expect(first.approvalId).toBe("approval-1");
    expect(second.status).toBe("upgrade_pending");
    expect(second.approvalId).toBe("approval-1");
    expect(filed).toHaveLength(1);

    const [row] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
    expect(row?.status).toBe("upgrade_pending");
    expect(row?.version).toBe("0.1.0");
  });

  it("refuses to complete an upgrade whose fetched manifest exceeds the approved capabilities (PLA-911 Finding 1)", async () => {
    const oldManifest = manifest("0.1.0", ["issues.read"]);
    const oldPkg = await writePackage(oldManifest);
    // The package the board reviewed: adds only issues.create.
    const approvedManifest = manifest("0.2.0", ["issues.read", "issues.create"]);
    const approvedPkg = await writePackage(approvedManifest);
    const pluginId = await seedPlugin(oldManifest, oldPkg);

    const { gateway } = createGatewayStub();
    const loader = makeLoader(gateway);

    // Park + file the approval naming addedCapabilities = ["issues.create"].
    await loader.upgradePlugin(pluginId, { localPath: approvedPkg });

    // A swapped package at the SAME approved version but declaring an extra,
    // valid-but-unapproved capability (issues.update). completeUpgrade must
    // reject it (issues.update is a real capability, so this exercises the
    // approval-binding check rather than manifest schema validation).
    const tamperedManifest = manifest("0.2.0", ["issues.read", "issues.create", "issues.update"]);
    const tamperedPkg = await writePackage(tamperedManifest);

    await expect(loader.completeUpgrade(pluginId, { localPath: tamperedPkg })).rejects.toThrow(
      /not approved|issues\.update/i,
    );

    // Fail closed: no mutation, row stays parked at the old version/caps.
    const [row] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
    expect(row?.status).toBe("upgrade_pending");
    expect(row?.version).toBe("0.1.0");
    expect(row?.manifestJson.capabilities).toEqual(["issues.read"]);
  });

  it("refuses to complete an upgrade whose fetched version differs from the approved target (PLA-911 Finding 1)", async () => {
    const oldManifest = manifest("0.1.0", ["issues.read"]);
    const oldPkg = await writePackage(oldManifest);
    const approvedManifest = manifest("0.2.0", ["issues.read", "issues.create"]);
    const approvedPkg = await writePackage(approvedManifest);
    const pluginId = await seedPlugin(oldManifest, oldPkg);

    const { gateway } = createGatewayStub();
    const loader = makeLoader(gateway);

    await loader.upgradePlugin(pluginId, { localPath: approvedPkg });

    // A package whose caps stay within the approved set but at a different,
    // un-approved version (0.3.0). completeUpgrade must reject it.
    const wrongVersionManifest = manifest("0.3.0", ["issues.read", "issues.create"]);
    const wrongVersionPkg = await writePackage(wrongVersionManifest);

    await expect(loader.completeUpgrade(pluginId, { localPath: wrongVersionPkg })).rejects.toThrow(
      /version/i,
    );

    const [row] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
    expect(row?.status).toBe("upgrade_pending");
    expect(row?.version).toBe("0.1.0");
    expect(row?.manifestJson.capabilities).toEqual(["issues.read"]);
  });

  it("refuses to park a disabled plugin for a cap-escalating upgrade (PLA-911 Finding 2)", async () => {
    const oldManifest = manifest("0.1.0", ["issues.read"]);
    const oldPkg = await writePackage(oldManifest);
    const newManifest = manifest("0.2.0", ["issues.read", "issues.create"]);
    const newPkg = await writePackage(newManifest);
    const pluginId = await seedPlugin(oldManifest, oldPkg);

    // Operator deliberately disabled the plugin (a kill switch).
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, pluginId));

    const { filed, gateway } = createGatewayStub();
    const loader = makeLoader(gateway);

    await expect(loader.upgradePlugin(pluginId, { localPath: newPkg })).rejects.toThrow(
      /only a "ready" plugin|disabled/i,
    );

    // No approval filed, and the operator-disabled state is untouched — a later
    // revert cannot silently re-enable it because it was never parked.
    expect(filed).toHaveLength(0);
    const [row] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
    expect(row?.status).toBe("disabled");
    expect(row?.version).toBe("0.1.0");
    expect(row?.manifestJson.capabilities).toEqual(["issues.read"]);
  });
});
