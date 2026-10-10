import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";

const execFileAsync = promisify(execFile);
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, pluginConfig, pluginState, plugins } from "@paperclipai/db";
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

const PLUGIN_KEY = "paperclip.upgrade-snapshot-test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin upgrade-snapshot tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Gateway double mirroring the real approvals-backed gateway: a filed approval
 * is treated as board-approved, carrying the digest captured at park so
 * `completeUpgrade` verifies the loaded snapshot against it.
 */
function createGatewayStub() {
  const pendingByKey = new Map<string, string>();
  const approvedByPlugin = new Map<
    string,
    { approvalId: string; toVersion: string; addedCapabilities: string[]; digest: string }
  >();
  let counter = 0;
  const gateway: CapabilityEscalationGateway = {
    async findPending({ pluginId, toVersion }) {
      return pendingByKey.get(`${pluginId}:${toVersion}`) ?? null;
    },
    async file(input: CapabilityEscalationRequest) {
      const approvalId = `approval-${++counter}`;
      pendingByKey.set(`${input.pluginId}:${input.toVersion}`, approvalId);
      approvedByPlugin.set(input.pluginId, {
        approvalId,
        toVersion: input.toVersion,
        addedCapabilities: input.addedCapabilities,
        digest: input.digest,
      });
      return approvalId;
    },
    async findApproved({ pluginId }) {
      return approvedByPlugin.get(pluginId) ?? null;
    },
  };
  return { approvedByPlugin, gateway };
}

function manifest(
  version: string,
  capabilities: PaperclipPluginManifestV1["capabilities"],
): PaperclipPluginManifestV1 {
  return {
    id: PLUGIN_KEY,
    apiVersion: 1,
    version,
    displayName: "Upgrade Snapshot Test",
    description: "Exercises immutable-snapshot loading of parked upgrades.",
    author: "Paperclip",
    categories: ["automation"],
    capabilities,
    entrypoints: { worker: "./dist/worker.js" },
  };
}

const APPROVED_WORKER = "export const approved = true;\n";
const TAMPERED_WORKER = "export const tampered = true;\n";

describeEmbeddedPostgres("plugin-loader upgrade snapshot / immutable load", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let packageRoots: string[] = [];
  let localPluginDir!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-upgrade-snapshot-");
    db = createDb(tempDb.connectionString);
    localPluginDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-snapshot-localdir-"));
  }, 20_000);

  afterEach(async () => {
    await db.delete(pluginState);
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
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-snapshot-pkg-"));
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
    await writeFile(path.join(packageRoot, "dist", "worker.js"), APPROVED_WORKER, "utf8");
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

  function makeLoader(gateway: CapabilityEscalationGateway) {
    return pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
      escalationGateway: gateway,
      localPluginDir,
    });
  }

  const oldManifest = manifest("0.1.0", ["issues.read"]);
  const approvedManifest = manifest("0.2.0", ["issues.read", "issues.create"]);

  it("loads the approved snapshot even when the source dir is swapped after approval (TOCTOU closed)", async () => {
    const oldPkg = await writePackage(oldManifest);
    const approvedPkg = await writePackage(approvedManifest);
    const pluginId = await seedPlugin(oldManifest, oldPkg);

    const { approvedByPlugin, gateway } = createGatewayStub();
    const loader = makeLoader(gateway);

    await loader.upgradePlugin(pluginId, { localPath: approvedPkg });
    const digest = approvedByPlugin.get(pluginId)?.digest;
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Attacker swaps the source dir's executable code AFTER approval but before
    // the worker would load it — the classic verify-then-load race.
    await writeFile(path.join(approvedPkg, "dist", "worker.js"), TAMPERED_WORKER, "utf8");

    const completed = await loader.completeUpgrade(pluginId, { localPath: approvedPkg });
    expect(completed.status).toBe("ready");
    expect(completed.version).toBe("0.2.0");

    // packagePath now points at the immutable snapshot, not the mutable source,
    // and the bytes there are the approved code — the swap never reached load.
    const [row] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
    const snapshotRoot = path.join(localPluginDir, ".upgrade-snapshots", digest!.slice("sha256:".length));
    expect(row?.packagePath).toBe(snapshotRoot);
    const loadedWorker = await readFile(path.join(row!.packagePath!, "dist", "worker.js"), "utf8");
    expect(loadedWorker).toBe(APPROVED_WORKER);
  });

  it("loads the approved snapshot even when the source dir is deleted after approval", async () => {
    const oldPkg = await writePackage(oldManifest);
    const approvedPkg = await writePackage(approvedManifest);
    const pluginId = await seedPlugin(oldManifest, oldPkg);

    const { gateway } = createGatewayStub();
    const loader = makeLoader(gateway);

    await loader.upgradePlugin(pluginId, { localPath: approvedPkg });

    // The source is gone — only the host-controlled snapshot remains.
    await rm(approvedPkg, { recursive: true, force: true });

    const completed = await loader.completeUpgrade(pluginId, { localPath: approvedPkg });
    expect(completed.status).toBe("ready");
    expect(completed.version).toBe("0.2.0");

    const [row] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
    const loadedWorker = await readFile(path.join(row!.packagePath!, "dist", "worker.js"), "utf8");
    expect(loadedWorker).toBe(APPROVED_WORKER);
  });

  it("covers vendored node_modules: a post-approval swap of dependency code never reaches the loaded snapshot", async () => {
    const oldPkg = await writePackage(oldManifest);
    const approvedPkg = await writePackage(approvedManifest);
    // Vendor a dependency inside the package — the common local-path dev case.
    // The content digest deliberately excludes node_modules, so this code is
    // unhashed; the snapshot is what makes it tamper-evident at load time.
    const depFile = path.join(approvedPkg, "node_modules", "dep", "index.js");
    await mkdir(path.dirname(depFile), { recursive: true });
    await writeFile(depFile, "export const dep = 'approved';\n", "utf8");
    const pluginId = await seedPlugin(oldManifest, oldPkg);

    const { gateway } = createGatewayStub();
    const loader = makeLoader(gateway);

    await loader.upgradePlugin(pluginId, { localPath: approvedPkg });

    // Swap the unhashed dependency code in the SOURCE after approval. The digest
    // is unchanged (node_modules excluded), so the version+caps+digest checks
    // still pass — but the snapshot already captured the approved dep bytes.
    await writeFile(depFile, "export const dep = 'tampered';\n", "utf8");

    const completed = await loader.completeUpgrade(pluginId, { localPath: approvedPkg });
    expect(completed.status).toBe("ready");

    const [row] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
    const loadedDep = await readFile(
      path.join(row!.packagePath!, "node_modules", "dep", "index.js"),
      "utf8",
    );
    expect(loadedDep).toBe("export const dep = 'approved';\n");
  });

  it("repoints packagePath to the content-addressed snapshot on completion", async () => {
    const oldPkg = await writePackage(oldManifest);
    const approvedPkg = await writePackage(approvedManifest);
    const pluginId = await seedPlugin(oldManifest, oldPkg);

    const { approvedByPlugin, gateway } = createGatewayStub();
    const loader = makeLoader(gateway);

    await loader.upgradePlugin(pluginId, { localPath: approvedPkg });
    await loader.completeUpgrade(pluginId, { localPath: approvedPkg });

    const digest = approvedByPlugin.get(pluginId)!.digest;
    const expectedRoot = path.join(localPluginDir, ".upgrade-snapshots", digest.slice("sha256:".length));
    const [row] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
    expect(row?.packagePath).toBe(expectedRoot);
    // The snapshot is keyed by the digest hex — content-addressed storage.
    expect(path.basename(row!.packagePath!)).toBe(digest.slice("sha256:".length));
  });

  // -------------------------------------------------------------------------
  // Constrain dereferenced symlinks + bound copy size
  // -------------------------------------------------------------------------

  function snapshotRootFor(digest: string): string {
    return path.join(localPluginDir, ".upgrade-snapshots", digest.slice("sha256:".length));
  }

  it("does NOT copy a symlink whose target escapes the package root (no host-file capture)", async () => {
    // Attacker plants an out-of-tree symlink in the board-approved source dir.
    // The content digest excludes symlinks, so it does not change the digest and
    // would pass the digest re-check; pre-fix `dereference:true` would copy the
    // SECRET's bytes into the worker-readable snapshot.
    const secretDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-snapshot-secret-"));
    const secretFile = path.join(secretDir, "secret.txt");
    const SECRET = "TOP-SECRET-HOST-MATERIAL\n";
    await writeFile(secretFile, SECRET, "utf8");

    try {
      const oldPkg = await writePackage(oldManifest);
      const approvedPkg = await writePackage(approvedManifest);
      await mkdir(path.join(approvedPkg, "vendor"), { recursive: true });
      await symlink(secretFile, path.join(approvedPkg, "vendor", "leak"));
      const pluginId = await seedPlugin(oldManifest, oldPkg);

      const { approvedByPlugin, gateway } = createGatewayStub();
      const loader = makeLoader(gateway);

      await loader.upgradePlugin(pluginId, { localPath: approvedPkg });
      const digest = approvedByPlugin.get(pluginId)!.digest;
      const snapRoot = snapshotRootFor(digest);

      // The leak link was skipped: its destination must not exist in the snapshot
      // and the secret bytes must appear nowhere in the copied tree.
      expect(existsSync(path.join(snapRoot, "vendor", "leak"))).toBe(false);
      const { stdout } = await execFileAsync("grep", [
        "-rl",
        "TOP-SECRET-HOST-MATERIAL",
        snapRoot,
      ]).catch((err: { code?: number; stdout?: string }) =>
        // grep exits 1 with no output when there are no matches — the success case.
        err.code === 1 ? { stdout: "" } : Promise.reject(err),
      );
      expect(stdout.trim()).toBe("");
    } finally {
      await rm(secretDir, { recursive: true, force: true });
    }
  });

  it("refuses (rather than hangs on) a non-regular file in the source tree (DoS angle)", async () => {
    const oldPkg = await writePackage(oldManifest);
    const approvedPkg = await writePackage(approvedManifest);
    // A FIFO would block a naive byte-copy forever; the bounded walk must reject.
    const fifoPath = path.join(approvedPkg, "pipe");
    await execFileAsync("mkfifo", [fifoPath]);
    const pluginId = await seedPlugin(oldManifest, oldPkg);

    const { approvedByPlugin, gateway } = createGatewayStub();
    const loader = makeLoader(gateway);

    await expect(loader.upgradePlugin(pluginId, { localPath: approvedPkg })).rejects.toThrow(
      /non-regular|device|FIFO|socket/i,
    );

    // No partial snapshot is published for the refused copy.
    const digest = approvedByPlugin.get(pluginId)?.digest;
    if (digest) {
      expect(existsSync(snapshotRootFor(digest))).toBe(false);
    }
  });

  it("still materializes a legit in-tree (vendored) symlink — no regression of the A08 fix", async () => {
    const oldPkg = await writePackage(oldManifest);
    const approvedPkg = await writePackage(approvedManifest);
    // pnpm-style: node_modules/dep -> ../.store/dep, all inside the package root.
    const realDep = path.join(approvedPkg, ".store", "dep");
    await mkdir(realDep, { recursive: true });
    await writeFile(path.join(realDep, "index.js"), "export const dep = 'vendored';\n", "utf8");
    await mkdir(path.join(approvedPkg, "node_modules"), { recursive: true });
    await symlink(
      path.join("..", ".store", "dep"),
      path.join(approvedPkg, "node_modules", "dep"),
    );
    const pluginId = await seedPlugin(oldManifest, oldPkg);

    const { approvedByPlugin, gateway } = createGatewayStub();
    const loader = makeLoader(gateway);

    await loader.upgradePlugin(pluginId, { localPath: approvedPkg });
    const digest = approvedByPlugin.get(pluginId)!.digest;
    const snapRoot = snapshotRootFor(digest);

    // The in-tree link is dereferenced into a real file in the snapshot.
    const materialized = await readFile(
      path.join(snapRoot, "node_modules", "dep", "index.js"),
      "utf8",
    );
    expect(materialized).toBe("export const dep = 'vendored';\n");
  });

  it("prunes the superseded snapshot after a second completed upgrade (GC)", async () => {
    const oldPkg = await writePackage(oldManifest);
    const firstPkg = await writePackage(approvedManifest);
    const pluginId = await seedPlugin(oldManifest, oldPkg);

    const { approvedByPlugin, gateway } = createGatewayStub();
    const loader = makeLoader(gateway);

    await loader.upgradePlugin(pluginId, { localPath: firstPkg });
    await loader.completeUpgrade(pluginId, { localPath: firstPkg });
    const firstDigest = approvedByPlugin.get(pluginId)!.digest;
    const firstSnap = snapshotRootFor(firstDigest);
    expect(existsSync(firstSnap)).toBe(true);

    // A second escalating upgrade to a distinct content digest.
    const secondManifest = manifest("0.3.0", ["issues.read", "issues.create", "issues.update"]);
    const secondPkg = await writePackage(secondManifest);
    await writeFile(path.join(secondPkg, "dist", "worker.js"), "export const v3 = true;\n", "utf8");
    await loader.upgradePlugin(pluginId, { localPath: secondPkg });
    await loader.completeUpgrade(pluginId, { localPath: secondPkg });
    const secondDigest = approvedByPlugin.get(pluginId)!.digest;
    const secondSnap = snapshotRootFor(secondDigest);

    // The live packagePath snapshot is kept; the now-unreferenced first is GC'd.
    expect(secondDigest).not.toBe(firstDigest);
    expect(existsSync(secondSnap)).toBe(true);
    expect(existsSync(firstSnap)).toBe(false);
  });
});
