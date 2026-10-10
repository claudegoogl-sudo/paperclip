import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  pluginConfig,
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
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const PLUGIN_KEY = "paperclip.install-escalation-test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin install-escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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
    {
      approvalId: string;
      toVersion: string;
      addedCapabilities: string[];
      digest?: string;
      packageName?: string | null;
      packagePath?: string | null;
    }
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
        // Anchor the approved contract to the exact package contents,
        // mirroring what the real approvals-backed gateway persists at park.
        digest: input.digest,
        packageName: input.packageName ?? null,
        packagePath: input.packagePath ?? null,
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


describeEmbeddedPostgres("plugin-loader install/reinstall capability gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let packageRoots: string[] = [];
  let localPluginDir!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-install-escalation-");
    db = createDb(tempDb.connectionString);
    localPluginDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-install-esc-localdir-"));
  }, 20_000);

  afterEach(async () => {
    await db.delete(pluginConfig);
    await db.delete(plugins);
    await db.delete(companies);
    await Promise.all(packageRoots.map((root) => rm(root, { recursive: true, force: true })));
    packageRoots = [];
    await rm(path.join(localPluginDir, ".upgrade-snapshots"), { recursive: true, force: true });
  });

  afterAll(async () => {
    await rm(localPluginDir, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function writePackage(pluginManifest: PaperclipPluginManifestV1): Promise<string> {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-install-esc-pkg-"));
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

  async function seedUninstalled(pluginManifest: PaperclipPluginManifestV1, packagePath: string) {
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
      status: "uninstalled",
      installOrder: 1,
    });
    return pluginId;
  }

  function makeLoader(gateway?: CapabilityEscalationGateway, installCapabilityAllowlist?: string[]) {
    return pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
      escalationGateway: gateway,
      localPluginDir,
      installCapabilityAllowlist,
    } as Parameters<typeof pluginLoader>[1]);
  }

  async function row(pluginId: string) {
    const [r] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
    return r;
  }

  it("reinstall with an added capability parks in upgrade_pending and files the escalation approval", async () => {
    const oldManifest = manifest("0.1.0", ["issues.read"]);
    const pluginId = await seedUninstalled(oldManifest, await writePackage(oldManifest));
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Platform", issuePrefix: "PLA" });
    await db.insert(pluginConfig).values({ pluginId, companyId, configJson: { keep: true } });
    const newPkg = await writePackage(manifest("0.2.0", ["issues.read", "issues.create"]));

    const { filed, gateway } = createGatewayStub();
    const result = (await makeLoader(gateway).installPlugin({ localPath: newPkg })) as any;

    expect(result.installStatus).toBe("upgrade_pending");
    expect(result.approvalId).toBe("approval-1");
    expect(result.capabilities).toEqual(["issues.read", "issues.create"]);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      pluginId,
      fromVersion: "0.1.0",
      toVersion: "0.2.0",
      addedCapabilities: ["issues.create"],
      origin: "install",
    });
    const r = await row(pluginId);
    expect(r?.status).toBe("upgrade_pending");
    // Granted contract untouched until approval completes.
    expect(r?.version).toBe("0.1.0");
    expect(r?.manifestJson.capabilities).toEqual(["issues.read"]);
    const [cfg] = await db.select().from(pluginConfig).where(eq(pluginConfig.pluginId, pluginId));
    expect(cfg?.configJson).toEqual({ keep: true });
  });

  it("reinstall with the same capabilities is unchanged (installed, then ready via lifecycle)", async () => {
    const oldManifest = manifest("0.1.0", ["issues.read"]);
    const pluginId = await seedUninstalled(oldManifest, await writePackage(oldManifest));
    const newPkg = await writePackage(manifest("0.2.0", ["issues.read"]));
    const { filed, gateway } = createGatewayStub();
    const result = (await makeLoader(gateway).installPlugin({ localPath: newPkg })) as any;
    expect(result.installStatus).toBe("installed");
    expect(result.approvalId).toBeNull();
    expect(filed).toHaveLength(0);
    expect((await row(pluginId))?.status).toBe("installed");
  });

  it("reinstall with an added capability and no gateway is refused like /upgrade", async () => {
    const oldManifest = manifest("0.1.0", ["issues.read"]);
    const pluginId = await seedUninstalled(oldManifest, await writePackage(oldManifest));
    const newPkg = await writePackage(manifest("0.2.0", ["issues.read", "issues.create"]));
    await expect(makeLoader().installPlugin({ localPath: newPkg })).rejects.toThrow(
      /introduces new capabilities that require approval: issues\.create/,
    );
    const r = await row(pluginId);
    expect(r?.status).toBe("uninstalled");
    expect(r?.manifestJson.capabilities).toEqual(["issues.read"]);
  });

  it("fresh install with capabilities parks; approve -> ready with exactly the manifest caps", async () => {
    const pkg = await writePackage(manifest("0.1.0", ["issues.read", "issues.create"]));
    const { filed, gateway } = createGatewayStub();
    const loader = makeLoader(gateway);
    const result = (await loader.installPlugin({ localPath: pkg })) as any;
    expect(result.installStatus).toBe("upgrade_pending");
    expect(filed[0]).toMatchObject({
      fromCapabilities: [],
      toCapabilities: ["issues.read", "issues.create"],
      addedCapabilities: ["issues.read", "issues.create"],
      origin: "install",
    });
    const pluginId = filed[0]!.pluginId;
    const parked = await row(pluginId);
    expect(parked?.status).toBe("upgrade_pending");
    expect(parked?.manifestJson.capabilities).toEqual([]);

    const done = await loader.completeUpgrade(pluginId);
    expect(done.status).toBe("ready");
    expect((await row(pluginId))?.manifestJson.capabilities).toEqual(["issues.read", "issues.create"]);
  });

  it("fresh install park, reject -> stays inactive (uninstalled)", async () => {
    const pkg = await writePackage(manifest("0.1.0", ["issues.read"]));
    const { filed, gateway } = createGatewayStub();
    const loader = makeLoader(gateway);
    await loader.installPlugin({ localPath: pkg });
    const pluginId = filed[0]!.pluginId;
    const reverted = await loader.revertPendingUpgrade(pluginId, { origin: "install" } as any);
    expect(reverted.status).toBe("uninstalled");
    expect((await row(pluginId))?.manifestJson.capabilities).toEqual([]);
  });

  it("fresh install without a gateway is unchanged and reports declared capabilities", async () => {
    const pkg = await writePackage(manifest("0.1.0", ["issues.read"]));
    const result = (await makeLoader().installPlugin({ localPath: pkg })) as any;
    expect(result.installStatus).toBe("installed");
    expect(result.capabilities).toEqual(["issues.read"]);
    expect(result.approvalId).toBeNull();
  });

  it("fresh install whose capabilities are all allowlisted is not parked", async () => {
    const pkg = await writePackage(manifest("0.1.0", ["issues.read"]));
    const { filed, gateway } = createGatewayStub();
    const result = (await makeLoader(gateway, ["issues.read"]).installPlugin({ localPath: pkg })) as any;
    expect(result.installStatus).toBe("installed");
    expect(filed).toHaveLength(0);
  });

  it("gateway error at install time fails closed (no row for fresh, reinstall stays uninstalled)", async () => {
    const { gateway } = createGatewayStub();
    gateway.file = async () => {
      throw new Error("approvals down");
    };
    const pkg = await writePackage(manifest("0.1.0", ["issues.read"]));
    await expect(makeLoader(gateway).installPlugin({ localPath: pkg })).rejects.toThrow(/approvals down/);
    expect(await db.select().from(plugins)).toHaveLength(0);

    const oldManifest = manifest("0.1.0", ["issues.read"]);
    const pluginId = await seedUninstalled(oldManifest, await writePackage(oldManifest));
    const newPkg = await writePackage(manifest("0.2.0", ["issues.read", "issues.create"]));
    await expect(makeLoader(gateway).installPlugin({ localPath: newPkg })).rejects.toThrow(/approvals down/);
    expect((await row(pluginId))?.status).toBe("uninstalled");
  });

  it("purge (row deleted) + install is treated as fresh", async () => {
    const oldManifest = manifest("0.1.0", ["issues.read"]);
    const pluginId = await seedUninstalled(oldManifest, await writePackage(oldManifest));
    await db.delete(plugins).where(eq(plugins.id, pluginId));
    const pkg = await writePackage(manifest("0.2.0", ["issues.read"]));
    const { filed, gateway } = createGatewayStub();
    const result = (await makeLoader(gateway).installPlugin({ localPath: pkg })) as any;
    expect(result.installStatus).toBe("upgrade_pending");
    expect(filed[0]).toMatchObject({ fromCapabilities: [], addedCapabilities: ["issues.read"] });
    expect(filed[0]!.pluginId).not.toBe(pluginId);
  });

  it("an exempt (boot bundled) install bypasses the gate", async () => {
    const pkg = await writePackage(manifest("0.1.0", ["issues.read"]));
    const { filed, gateway } = createGatewayStub();
    const result = (await makeLoader(gateway).installPlugin({
      localPath: pkg,
      exemptFromCapabilityGate: true,
    } as any)) as any;
    expect(result.installStatus).toBe("installed");
    expect(filed).toHaveLength(0);
  });
  // --- SE review MF-1: a parked row must not be activated around the gate ---

  it("MF-1(i): enable on a parked fresh install is refused and nothing is activated", async () => {
    const pkg = await writePackage(manifest("0.1.0", ["issues.read", "issues.create"]));
    const { filed, gateway } = createGatewayStub();
    const loader = makeLoader(gateway);
    await loader.installPlugin({ localPath: pkg });
    const pluginId = filed[0]!.pluginId;
    const lifecycle = pluginLifecycleManager(db, loader);
    await expect(lifecycle.enable(pluginId)).rejects.toThrow(/upgrade_pending/);
    const r = await row(pluginId);
    expect(r?.status).toBe("upgrade_pending");
    expect(r?.manifestJson.capabilities).toEqual([]);
  });

  it("MF-1(ii)/SF-1: reinstall park keeps the old source; enable is refused; approve applies the new source; reject keeps the old one", async () => {
    const oldManifest = manifest("0.1.0", ["issues.read"]);
    const oldPkg = await writePackage(oldManifest);
    const pluginId = await seedUninstalled(oldManifest, oldPkg);
    const newPkg = await writePackage(manifest("0.2.0", ["issues.read", "issues.create"]));
    const { filed, gateway } = createGatewayStub();
    const loader = makeLoader(gateway);
    await loader.installPlugin({ localPath: newPkg });
    expect(filed[0]).toMatchObject({ packagePath: newPkg });
    expect((await row(pluginId))?.packagePath).toBe(oldPkg);

    const lifecycle = pluginLifecycleManager(db, loader);
    await expect(lifecycle.enable(pluginId)).rejects.toThrow(/upgrade_pending/);
    expect((await row(pluginId))?.packagePath).toBe(oldPkg);
    expect((await row(pluginId))?.status).toBe("upgrade_pending");

    const done = await loader.completeUpgrade(pluginId);
    expect(done.status).toBe("ready");
    const r = await row(pluginId);
    expect(r?.version).toBe("0.2.0");
    expect(r?.manifestJson.capabilities).toEqual(["issues.read", "issues.create"]);
    expect(r?.packagePath).not.toBe(oldPkg);
  });

  it("SF-1: rejected reinstall stays uninstalled on the previous source", async () => {
    const oldManifest = manifest("0.1.0", ["issues.read"]);
    const oldPkg = await writePackage(oldManifest);
    const pluginId = await seedUninstalled(oldManifest, oldPkg);
    const newPkg = await writePackage(manifest("0.2.0", ["issues.read", "issues.create"]));
    const { gateway } = createGatewayStub();
    const loader = makeLoader(gateway);
    await loader.installPlugin({ localPath: newPkg });
    const reverted = await loader.revertPendingUpgrade(pluginId, { origin: "install" } as any);
    expect(reverted.status).toBe("uninstalled");
    expect((await row(pluginId))?.packagePath).toBe(oldPkg);
    expect((await row(pluginId))?.version).toBe("0.1.0");
  });

  it("MF-1(iii): activation refuses an on-disk manifest that adds a capability; row manifest unchanged", async () => {
    const granted = manifest("0.1.0", ["issues.read"]);
    const pkg = await writePackage(manifest("0.1.0", ["issues.read", "issues.create"]));
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: granted.id,
      packageName: granted.id,
      version: granted.version,
      apiVersion: granted.apiVersion,
      categories: granted.categories,
      manifestJson: granted,
      packagePath: pkg,
      status: "ready",
      installOrder: 1,
    });
    const loader = pluginLoader(
      db,
      { enableLocalFilesystem: false, enableNpmDiscovery: false, localPluginDir } as Parameters<typeof pluginLoader>[1],
      { lifecycleManager: { markError: async () => undefined }, instanceInfo: { hostVersion: "0.0.0" } } as any,
    );
    const result = await loader.loadSingle(pluginId, { markErrorOnFailure: false });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not granted: issues\.create/);
    const r = await row(pluginId);
    expect(r?.manifestJson.capabilities).toEqual(["issues.read"]);
  });
});
