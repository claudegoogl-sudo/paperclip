import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  approvals,
  companies,
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
import { pluginLoader } from "../services/plugin-loader.js";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { approvalService } from "../services/approvals.js";
import {
  CAPABILITY_ESCALATION_APPROVAL_TYPE,
  CAPABILITY_ESCALATION_PAYLOAD_KIND,
  type CapabilityEscalationPayload,
  createApprovalsCapabilityEscalationGateway,
  isCapabilityEscalationPayload,
  registerCapabilityEscalationResolver,
  __resetCapabilityEscalationResolverForTests,
} from "../services/plugin-capability-escalation.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const PLUGIN_KEY = "paperclip.capability-escalation-test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres capability-escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function manifest(
  version: string,
  capabilities: PaperclipPluginManifestV1["capabilities"],
): PaperclipPluginManifestV1 {
  return {
    id: PLUGIN_KEY,
    apiVersion: 1,
    version,
    displayName: "Capability Escalation Test",
    description: "Exercises the board-gated capability-escalation wiring.",
    author: "Paperclip",
    categories: ["automation"],
    capabilities,
    entrypoints: { worker: "./dist/worker.js" },
  };
}

describeEmbeddedPostgres("plugin capability-escalation wiring (PLA-910)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let packageRoots: string[] = [];
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cap-escalation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    companyId = await seedCompany();
  });

  afterEach(async () => {
    __resetCapabilityEscalationResolverForTests();
    await db.delete(approvals);
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

  async function seedCompany(): Promise<string> {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Platform",
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function writePackage(pluginManifest: PaperclipPluginManifestV1): Promise<string> {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-cap-pkg-"));
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

  function makeLoaderWithGateway(cid: string) {
    const gateway = createApprovalsCapabilityEscalationGateway({
      approvals: approvalService(db),
      companyId: cid,
    });
    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
      escalationGateway: gateway,
    });
    return { gateway, loader };
  }

  it("gateway.file() creates a pending board approval carrying the escalation payload", async () => {
    const { gateway } = makeLoaderWithGateway(companyId);

    const approvalId = await gateway.file({
      pluginId: "plugin-1",
      pluginKey: PLUGIN_KEY,
      fromVersion: "0.1.0",
      toVersion: "0.2.0",
      fromCapabilities: ["issues.read"],
      toCapabilities: ["issues.read", "issues.create"],
      addedCapabilities: ["issues.create"],
    });

    const approvals = await approvalService(db).list(companyId, "pending");
    expect(approvals).toHaveLength(1);
    const approval = approvals[0]!;
    expect(approval.id).toBe(approvalId);
    expect(approval.type).toBe(CAPABILITY_ESCALATION_APPROVAL_TYPE);
    expect(isCapabilityEscalationPayload(approval.payload)).toBe(true);
    expect(approval.payload).toMatchObject({
      kind: CAPABILITY_ESCALATION_PAYLOAD_KIND,
      pluginId: "plugin-1",
      toVersion: "0.2.0",
      addedCapabilities: ["issues.create"],
    });
  });

  it("gateway.findPending() dedups on the (pluginId, toVersion) tuple", async () => {
    const { gateway } = makeLoaderWithGateway(companyId);
    const id = await gateway.file({
      pluginId: "plugin-2",
      pluginKey: PLUGIN_KEY,
      fromVersion: "0.1.0",
      toVersion: "0.2.0",
      fromCapabilities: [],
      toCapabilities: ["issues.create"],
      addedCapabilities: ["issues.create"],
    });

    expect(await gateway.findPending({ pluginId: "plugin-2", toVersion: "0.2.0" })).toBe(id);
    // Different target version → no match.
    expect(await gateway.findPending({ pluginId: "plugin-2", toVersion: "0.3.0" })).toBeNull();
    // Different plugin → no match.
    expect(await gateway.findPending({ pluginId: "plugin-x", toVersion: "0.2.0" })).toBeNull();
  });

  it("upgrade through the loader files exactly one approval, even when called twice (idempotent)", async () => {
    const oldManifest = manifest("0.1.0", ["issues.read"]);
    const oldPkg = await writePackage(oldManifest);
    const newManifest = manifest("0.2.0", ["issues.read", "issues.create"]);
    const newPkg = await writePackage(newManifest);
    const pluginId = await seedPlugin(oldManifest, oldPkg);

    const { loader } = makeLoaderWithGateway(companyId);

    const first = await loader.upgradePlugin(pluginId, { localPath: newPkg });
    expect(first.status).toBe("upgrade_pending");

    // Repeat call while parked must converge on the same approval (no double-file).
    const second = await loader.upgradePlugin(pluginId, { localPath: newPkg });
    expect(second.status).toBe("upgrade_pending");
    expect(second.approvalId).toBe(first.approvalId);

    const approvals = await approvalService(db).list(companyId, "pending");
    expect(approvals).toHaveLength(1);
  });

  it("approving the board approval completes the parked upgrade (version + caps applied, ready)", async () => {
    const oldManifest = manifest("0.1.0", ["issues.read"]);
    const oldPkg = await writePackage(oldManifest);
    const newManifest = manifest("0.2.0", ["issues.read", "issues.create"]);
    const newPkg = await writePackage(newManifest);
    const pluginId = await seedPlugin(oldManifest, oldPkg);

    // Plugin-scoped data that must survive the upgrade untouched.
    await db.insert(pluginConfig).values({
      pluginId,
      configJson: { apiBase: "https://example.test" },
    });

    const { gateway, loader } = makeLoaderWithGateway(companyId);
    const lifecycle = pluginLifecycleManager(db, { loader });
    registerCapabilityEscalationResolver(async ({ payload, outcome }) => {
      if (outcome === "approved") await lifecycle.completeUpgradeApproved(payload.pluginId);
      else await lifecycle.revertUpgradeRejected(payload.pluginId);
    });

    // Park the upgrade. completeUpgrade re-reads from packagePath, so point the
    // stored packagePath at the new package the upgrade targets.
    const parked = await loader.upgradePlugin(pluginId, { localPath: newPkg });
    expect(parked.status).toBe("upgrade_pending");
    await db.update(plugins).set({ packagePath: newPkg }).where(eq(plugins.id, pluginId));

    const [approval] = await approvalService(db).list(companyId, "pending");
    expect(approval).toBeTruthy();

    // The production gateway must persist the park-time content digest (PLA-912):
    // without it completeUpgrade can never pin the applied bytes to what the board
    // approved and silently falls back to version+caps only.
    expect(isCapabilityEscalationPayload(approval!.payload)).toBe(true);
    const parkDigest = (approval!.payload as CapabilityEscalationPayload).digest;
    expect(parkDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const { applied } = await approvalService(db).approve(approval!.id, "board-user");
    expect(applied).toBe(true);

    const [row] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
    expect(row?.status).toBe("ready");
    expect(row?.version).toBe("0.2.0");
    expect(row?.manifestJson.capabilities).toEqual(["issues.read", "issues.create"]);

    // The digest round-trips back out of the gateway as the board-approved
    // contract, so completeUpgrade pins against it (the anchor is live through
    // production wiring, not just the loader interface).
    const approvedContract = await gateway.findApproved({ pluginId });
    expect(approvedContract?.digest).toBe(parkDigest);

    // Completion applies the immutable park-time snapshot (PLA-913), so the row's
    // packagePath is repointed at the content-addressed snapshot — proving the
    // approved bytes were applied, not whatever the mutable source held at approve
    // time. A swap of newPkg after approval can no longer reach the loader.
    const parkHex = parkDigest!.slice("sha256:".length);
    expect(row?.packagePath).toContain(parkHex);
    expect(row?.packagePath).not.toBe(newPkg);

    // Config bindings untouched.
    const [cfg] = await db.select().from(pluginConfig).where(eq(pluginConfig.pluginId, pluginId));
    expect(cfg?.configJson).toMatchObject({ apiBase: "https://example.test" });
  });

  it("rejecting the board approval reverts the parked upgrade (full restore, unchanged version)", async () => {
    const oldManifest = manifest("0.1.0", ["issues.read"]);
    const oldPkg = await writePackage(oldManifest);
    const newManifest = manifest("0.2.0", ["issues.read", "issues.create"]);
    const newPkg = await writePackage(newManifest);
    const pluginId = await seedPlugin(oldManifest, oldPkg);

    const { loader } = makeLoaderWithGateway(companyId);
    const lifecycle = pluginLifecycleManager(db, { loader });
    registerCapabilityEscalationResolver(async ({ payload, outcome }) => {
      if (outcome === "approved") await lifecycle.completeUpgradeApproved(payload.pluginId);
      else await lifecycle.revertUpgradeRejected(payload.pluginId);
    });

    const parked = await loader.upgradePlugin(pluginId, { localPath: newPkg });
    expect(parked.status).toBe("upgrade_pending");

    const [approval] = await approvalService(db).list(companyId, "pending");
    const { applied } = await approvalService(db).reject(approval!.id, "board-user", "not now");
    expect(applied).toBe(true);

    const [row] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
    expect(row?.status).toBe("ready");
    // Parking never mutated version/caps; reject is a pure status restore.
    expect(row?.version).toBe("0.1.0");
    expect(row?.manifestJson.capabilities).toEqual(["issues.read"]);
  });
});
