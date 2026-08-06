/**
 * PLA-790 — composition-level regression guard for the PLA-781 registry-wiring
 * fix, driven through the REAL `createApp` instead of hand-wiring the
 * manager↔handler over a shared registry.
 *
 * The PLA-781 defect lived in the `index.ts`/`app.ts` composition, NOT in the
 * worker-manager or secrets-handler APIs (which were unchanged): the host built
 * the worker manager with one run-context registry while `createApp` always
 * minted its OWN, disjoint registry for the secrets host-handler. A worker's
 * host-minted service run-context was therefore registered into a registry the
 * handler never read, so setup()-loop / background `secrets.resolve` failed
 * Gate 1 with `runcontext_invalid`. The sibling
 * `plugin-secrets-service-context-wiring.test.ts` cases share one registry by
 * construction, so they pass on the PRE-fix tree and cannot guard this defect.
 *
 * These two cases pin the actual fix surface — `createApp`'s
 * `opts.pluginRunContextRegistry ?? createPluginRunContextRegistry()` selection:
 *  1. manager built on registry A injected, `createApp` called WITHOUT
 *     `pluginRunContextRegistry` → app threads a DISJOINT registry to the
 *     secrets path → a manager-minted service runId fails `runcontext_invalid`
 *     (reproduces the pre-fix bug).
 *  2. same manager, `pluginRunContextRegistry: A` threaded → app uses A for the
 *     secrets path → the same service runId resolves. This assertion FAILS on
 *     the pre-fix `app.ts` (which ignored the option and always built its own
 *     registry) and passes only after the fix.
 *
 * The registry `createApp` wires into the secrets/tool path is observed via the
 * `createPluginToolDispatcher` seam — it receives the same `pluginRunContextRegistry`
 * instance that `buildHostServices` (and thus the secrets handler) is built with.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Captures the run-context registry instance `createApp` threads into the
// secrets/tool host path. Reset per test.
const dispatcherCapture = vi.hoisted(() => ({ registry: null as unknown }));

vi.mock("../services/plugin-tool-dispatcher.js", () => ({
  createPluginToolDispatcher: (opts: { runContextRegistry?: unknown }) => {
    dispatcherCapture.registry = opts.runContextRegistry ?? null;
    return {
      initialize: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    };
  },
}));

// Keep boot quiet/deterministic: no real activity-log writes and no background
// `loader.loadAll()` query racing embedded-pg teardown.
vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  setPluginEventBus: vi.fn(),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveSecretValue: vi.fn().mockResolvedValue("unused"),
  }),
}));

vi.mock("../services/plugin-loader.js", () => ({
  DEFAULT_LOCAL_PLUGIN_DIR: "plugins",
  pluginLoader: () => ({ loadAll: vi.fn().mockResolvedValue(null) }),
}));

const { createApp } = await import("../app.js");
const { createPluginWorkerManager } = await import(
  "../services/plugin-worker-manager.js"
);
const { createPluginRunContextRegistry } = await import(
  "../services/plugin-run-context-registry.js"
);
const { createPluginSecretsHandler } = await import(
  "../services/plugin-secrets-handler.js"
);
const { clearRunSecretValues } = await import("../run-secret-registry.js");

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);
const WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-onevent.cjs");

const PLUGIN_ID = "test.plugin";
const PLUGIN_KEY = "platform.test";
const SECRET_BOUND = "11111111-1111-4111-8111-111111111111";
const COMPANY_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const TEST_MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

type Registry = ReturnType<typeof createPluginRunContextRegistry>;
type Manager = ReturnType<typeof createPluginWorkerManager>;

// Mirrors the production secrets-handler construction in `buildHostServices`,
// over whichever registry `createApp` selected.
function buildSecretsHandler(registry: Registry) {
  const resolverFn = vi.fn(
    async (input: { companyId: string; secretId: string }) =>
      `resolved:${input.companyId}:${input.secretId}`,
  );
  const findServiceBinding = vi.fn(
    async (input: { pluginTargetId: string; secretId: string }) => {
      if (input.secretId !== SECRET_BOUND) return null;
      return {
        companyId: COMPANY_OWNER,
        id: `binding-${input.secretId}`,
        secretId: input.secretId,
        configPath: "tokenSecretId",
        versionSelector: "latest" as const,
        allowedEgress: [],
        egressAllowlistEnforced: false,
      };
    },
  );
  const handler = createPluginSecretsHandler({
    db: {} as never,
    pluginDbId: PLUGIN_ID,
    pluginKey: PLUGIN_KEY,
    runContextRegistry: registry,
    bindings: { findBinding: vi.fn(async () => null), findServiceBinding },
    resolver: { resolve: resolverFn },
  });
  return { handler, resolverFn, findServiceBinding };
}

async function startWorker(manager: Manager) {
  const handle = await manager.startWorker(PLUGIN_ID, {
    entrypointPath: WORKER_ENTRYPOINT,
    manifest: TEST_MANIFEST,
    config: {},
    instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
    apiVersion: 1,
    hostHandlers: {},
  });
  return handle.serviceRunId;
}

async function bootApp(
  db: ReturnType<typeof createDb>,
  manager: Manager,
  registry: Registry | undefined,
) {
  const app = await createApp(db as never, {
    uiMode: "static",
    serverPort: 3100,
    storageService: {} as never,
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    allowedHostnames: [],
    bindHost: "127.0.0.1",
    authReady: true,
    companyDeletionEnabled: false,
    pluginWorkerManager: manager,
    ...(registry ? { pluginRunContextRegistry: registry } : {}),
  } as never);
  return app as { locals?: { paperclipShutdown?: () => void } };
}

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres(
  "PLA-790 — createApp composition threads the manager's registry to the secrets path",
  () => {
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
    let db!: ReturnType<typeof createDb>;
    let activeRunIds: string[] = [];

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-createapp-wiring-");
      db = createDb(tempDb.connectionString);
    }, 30_000);

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    beforeEach(() => {
      vi.clearAllMocks();
      dispatcherCapture.registry = null;
      activeRunIds = [];
    });

    afterEach(() => {
      for (const runId of activeRunIds) clearRunSecretValues(runId);
    });

    it("WITHOUT pluginRunContextRegistry: app builds a disjoint registry, so a manager-minted service runId fails closed (runcontext_invalid)", async () => {
      const registryA = createPluginRunContextRegistry({ sweepIntervalMs: 60_000 });
      const manager = createPluginWorkerManager({ runContextRegistry: registryA });
      const app = await bootApp(db, manager, undefined);

      try {
        const appRegistry = dispatcherCapture.registry as Registry;
        // Pre-fix bug surface: the app's secrets-path registry is NOT the one
        // the injected manager registers worker run-contexts into.
        expect(appRegistry).not.toBe(registryA);

        const serviceRunId = await startWorker(manager);
        activeRunIds.push(serviceRunId);
        // The manager registered the service run-context into A, but the
        // secrets handler reads the app's disjoint registry → Gate 1 fails.
        expect(registryA.get(PLUGIN_ID, serviceRunId)).not.toBeNull();
        expect(appRegistry.get(PLUGIN_ID, serviceRunId)).toBeNull();

        const { handler, findServiceBinding } = buildSecretsHandler(appRegistry);
        await expect(
          handler.resolve({ secretRef: SECRET_BOUND, runId: serviceRunId }),
        ).rejects.toMatchObject({ code: "runcontext_invalid" });
        // An unregistered runId must never reach the binding lookup.
        expect(findServiceBinding).not.toHaveBeenCalled();
      } finally {
        await manager.stopAll().catch(() => undefined);
        app.locals?.paperclipShutdown?.();
        registryA.dispose();
      }
    }, 30_000);

    it("WITH pluginRunContextRegistry: A threaded: app uses A for the secrets path, so the manager-minted service runId resolves (regresses on pre-fix app.ts)", async () => {
      const registryA = createPluginRunContextRegistry({ sweepIntervalMs: 60_000 });
      const manager = createPluginWorkerManager({ runContextRegistry: registryA });
      const app = await bootApp(db, manager, registryA);

      try {
        const appRegistry = dispatcherCapture.registry as Registry;
        // The fix: createApp honors the injected registry instead of minting
        // its own. Pre-fix app.ts ignored this option → appRegistry !== A and
        // the resolve below would fail, so this case guards the regression.
        expect(appRegistry).toBe(registryA);

        const serviceRunId = await startWorker(manager);
        activeRunIds.push(serviceRunId);

        const { handler, findServiceBinding, resolverFn } =
          buildSecretsHandler(appRegistry);
        const value = await handler.resolve({
          secretRef: SECRET_BOUND,
          runId: serviceRunId,
        });

        expect(value).toBe(`resolved:${COMPANY_OWNER}:${SECRET_BOUND}`);
        // Company derived from the operator binding, never asserted by the worker.
        expect(findServiceBinding).toHaveBeenCalledWith({
          pluginTargetId: PLUGIN_ID,
          secretId: SECRET_BOUND,
        });
        expect(resolverFn).toHaveBeenCalledWith(
          expect.objectContaining({ companyId: COMPANY_OWNER, secretId: SECRET_BOUND }),
        );
      } finally {
        await manager.stopAll().catch(() => undefined);
        app.locals?.paperclipShutdown?.();
        registryA.dispose();
      }
    }, 30_000);
  },
);
