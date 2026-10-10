/**
 * Regression: activation-time manifest refresh must not apply
 * privilege-escalating on-disk manifests outside the /upgrade approval gate.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  listConfigs: vi.fn(),
  update: vi.fn(),
  updateStatus: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

import { diffPrivilegeEscalations, pluginLoader } from "../services/plugin-loader.js";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { isPluginDevWatchEnabled } from "../services/plugin-dev-watcher.js";

const PLUGIN_ID = "plugin-capgate";
const PLUGIN_KEY = "example.capgate";

function manifestWith(capabilities: string[], extra: Partial<PaperclipPluginManifestV1> = {}): PaperclipPluginManifestV1 {
  return {
    id: PLUGIN_KEY,
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Cap gate",
    description: "fixture",
    author: "test",
    categories: ["automation"],
    capabilities,
    entrypoints: { worker: "dist/worker.js" },
    ...extra,
  } as PaperclipPluginManifestV1;
}

let fixtureDir: string;

function writeOnDisk(manifest: PaperclipPluginManifestV1) {
  fs.writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({ name: "@example/capgate", version: manifest.version, paperclipPlugin: { manifest: "manifest.mjs" } }),
  );
  fs.writeFileSync(path.join(fixtureDir, "manifest.mjs"), `export default ${JSON.stringify(manifest)};`);
}

function makeLoader() {
  const lifecycleManager = { markError: vi.fn().mockResolvedValue(undefined) };
  const workerManager = {
    startWorker: vi.fn().mockResolvedValue(undefined),
    isRunning: vi.fn(() => false),
    stopWorker: vi.fn().mockResolvedValue(undefined),
    getWorker: vi.fn(() => undefined),
  };
  const loader = pluginLoader(
    {} as never,
    { enableLocalFilesystem: false, enableNpmDiscovery: false, localPluginDir: "__missing_plugin_dir__" },
    {
      lifecycleManager,
      workerManager,
      eventBus: { forPlugin: vi.fn(() => ({ subscribe: vi.fn() })), clearPlugin: vi.fn(), subscriptionCount: vi.fn(() => 0) },
      jobScheduler: { unregisterPlugin: vi.fn().mockResolvedValue(undefined), registerPlugin: vi.fn() },
      jobStore: {},
      toolDispatcher: { unregisterPluginTools: vi.fn(), registerPluginTools: vi.fn() },
      buildHostHandlers: vi.fn(() => ({})),
      instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
    } as never,
  );
  return { loader, workerManager, lifecycleManager };
}

function registryPlugin(caps: string[]) {
  return {
    id: PLUGIN_ID,
    pluginKey: PLUGIN_KEY,
    status: "ready",
    packageName: "@example/capgate",
    packagePath: fixtureDir,
    version: "1.0.0",
    manifestJson: manifestWith(caps),
  };
}

describe("activation-time manifest refresh capability gate", () => {
  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-capgate-"));
    fs.mkdirSync(path.join(fixtureDir, "dist"));
    fs.writeFileSync(path.join(fixtureDir, "dist", "worker.js"), "");
    for (const fn of Object.values(mockRegistry)) fn.mockReset();
    mockRegistry.listConfigs.mockResolvedValue([]);
    mockRegistry.update.mockResolvedValue(undefined);
    mockRegistry.updateStatus.mockResolvedValue(undefined);
  });
  afterEach(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

  it("loadSingle refuses an on-disk manifest that adds a capability", async () => {
    mockRegistry.getById.mockResolvedValue(registryPlugin(["events.subscribe"]));
    writeOnDisk(manifestWith(["events.subscribe", "secrets.read-ref"], { version: "1.0.1" }));
    const { loader, workerManager } = makeLoader();

    const result = await loader.loadSingle(PLUGIN_ID, { markErrorOnFailure: false });

    expect(result.success).toBe(false);
    expect(result.error).toContain("adds capabilities that were not granted: secrets.read-ref");
    expect(result.error).toContain("/upgrade");
    expect(mockRegistry.update).not.toHaveBeenCalled();
    expect(workerManager.startWorker).not.toHaveBeenCalled();
  });

  it("loadSingle refuses a secret-ref field added inside a oneOf branch", async () => {
    mockRegistry.getById.mockResolvedValue(registryPlugin(["events.subscribe"]));
    writeOnDisk(
      manifestWith(["events.subscribe"], {
        version: "1.0.1",
        instanceConfigSchema: {
          type: "object",
          properties: {
            cred: { oneOf: [{ type: "object", properties: { token: { type: "string", format: "secret-ref" } } }] },
          },
        },
      }),
    );
    const { loader } = makeLoader();

    const result = await loader.loadSingle(PLUGIN_ID, { markErrorOnFailure: false });

    expect(result.success).toBe(false);
    expect(result.error).toContain("adds secret-ref config fields");
    expect(mockRegistry.update).not.toHaveBeenCalled();
  });

  it("restartWorker (dev-watcher reload path) refuses the same escalation", async () => {
    mockRegistry.getById.mockResolvedValue(registryPlugin(["events.subscribe"]));
    writeOnDisk(manifestWith(["events.subscribe", "secrets.read-ref"], { version: "1.0.1" }));
    const { loader, workerManager } = makeLoader();
    // A running worker exists, so restartWorker takes the full reload path.
    workerManager.getWorker.mockReturnValue({ restart: vi.fn(), stop: vi.fn() } as never);
    const loadSpy = vi.spyOn(loader, "loadSingle");
    const lifecycle = pluginLifecycleManager({} as never, { loader, workerManager: workerManager as never });

    await lifecycle.restartWorker(PLUGIN_ID).catch(() => undefined);

    expect(loadSpy).toHaveBeenCalled();
    await expect(loadSpy.mock.results[0]!.value).resolves.toMatchObject({ success: false });

    expect(mockRegistry.update).not.toHaveBeenCalled();
    expect(workerManager.startWorker).not.toHaveBeenCalled();
  });

  it("still auto-refreshes an on-disk manifest that only removes a capability", async () => {
    mockRegistry.getById.mockResolvedValue(registryPlugin(["events.subscribe", "secrets.read-ref"]));
    const reduced = manifestWith(["events.subscribe"], { version: "1.0.1" });
    writeOnDisk(reduced);
    const { loader } = makeLoader();

    await loader.loadSingle(PLUGIN_ID, { markErrorOnFailure: false });

    expect(mockRegistry.update).toHaveBeenCalledWith(
      PLUGIN_ID,
      expect.objectContaining({ version: "1.0.1", manifest: expect.objectContaining({ capabilities: ["events.subscribe"] }) }),
    );
  });

  it("diffPrivilegeEscalations flags tools/webhooks/database/secret-ref additions", () => {
    const base = manifestWith(["a"]);
    expect(diffPrivilegeEscalations(base, manifestWith([]))).toEqual([]);
    const esc = diffPrivilegeEscalations(
      base,
      manifestWith(["a"], {
        tools: [{ name: "t1", displayName: "t", description: "d", parametersSchema: {} }],
        webhooks: [{ endpointKey: "w1", displayName: "w" }],
        database: { namespaceSlug: "x", migrationsDir: "m" },
        instanceConfigSchema: { type: "object", properties: { k: { type: "string", format: "secret-ref" } } },
      } as never),
    );
    expect(esc).toEqual([
      "adds tools t1",
      "adds webhooks w1",
      "changes database declaration",
      "adds secret-ref config fields k",
    ]);
  });

  it("treats a jsonb-reordered database declaration as unchanged (activation proceeds)", async () => {
    // jsonb key order: by length, then bytes -> migrationsDir before namespaceSlug.
    const registryDb = { coreReadTables: ["issues"], migrationsDir: "migrations", namespaceSlug: "capgate" };
    const authoredDb = { namespaceSlug: "capgate", migrationsDir: "migrations", coreReadTables: ["issues"] };
    const caps = ["database.namespace.migrate", "database.namespace.read"];
    const reg = manifestWith(caps, { database: registryDb } as never);
    const disk = manifestWith(caps, { database: authoredDb } as never);
    expect(JSON.stringify(reg.database)).not.toBe(JSON.stringify(disk.database));
    expect(diffPrivilegeEscalations(reg, disk)).toEqual([]);
    mockRegistry.getById.mockResolvedValue({ ...registryPlugin(caps), manifestJson: reg });
    writeOnDisk(disk);
    const { loader } = makeLoader();
    const result = await loader.loadSingle(PLUGIN_ID, { markErrorOnFailure: false });
    expect(result.error ?? "").not.toMatch(/escalates privilege/);
    // Canonical short-circuit: identical content -> no refresh write, no refusal.
    expect(mockRegistry.update).not.toHaveBeenCalled();
  });

  it("still refuses a real database declaration change", () => {
    const base = manifestWith([], { database: { namespaceSlug: "x", migrationsDir: "m", coreReadTables: ["issues"] } } as never);
    for (const db of [
      { migrationsDir: "m2", namespaceSlug: "x", coreReadTables: ["issues"] },
      { coreReadTables: ["issues", "agents"], migrationsDir: "m", namespaceSlug: "x" },
    ]) {
      expect(diffPrivilegeEscalations(base, manifestWith([], { database: db } as never))).toEqual([
        "changes database declaration",
      ]);
    }
  });
});

describe("isPluginDevWatchEnabled", () => {
  it("is off unless PAPERCLIP_PLUGIN_DEV_WATCH opts in", () => {
    expect(isPluginDevWatchEnabled({})).toBe(false);
    expect(isPluginDevWatchEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(isPluginDevWatchEnabled({ PAPERCLIP_PLUGIN_DEV_WATCH: "0" })).toBe(false);
    expect(isPluginDevWatchEnabled({ PAPERCLIP_PLUGIN_DEV_WATCH: "1" })).toBe(true);
    expect(isPluginDevWatchEnabled({ PAPERCLIP_PLUGIN_DEV_WATCH: "true" })).toBe(true);
  });
});
