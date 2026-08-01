import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  createHostClientHandlers,
  type HostServices,
  type HostToWorkerMethods,
} from "@paperclipai/plugin-sdk";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";
import {
  createPluginRunContextRegistry,
  type PluginRunContextRegistry,
} from "../services/plugin-run-context-registry.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const BACKGROUND_SECRET_POLL_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-background-secret-poll.cjs",
);

const PLUGIN_ID = "test.plugin";

const TEST_MANIFEST: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["secrets.read-ref"],
  entrypoints: { worker: "dist/worker.js" },
};

/**
 * What the server's secrets handler would derive for a given back-filled
 * `runId`. `secrets.resolve` is keyed on `(pluginDbId, runId)` in the
 * run-context registry, so the runId the SDK back-fills IS the tenant binding.
 */
interface ObservedResolve {
  runId: string | undefined;
  /** `params.companyId` — a non-authoritative hint the SDK never injects. */
  paramsCompanyId: string | undefined;
  /** Registry entry kind the runId lands on: service | background | dispatch. */
  registryKind: string | undefined;
  /** Company the server would resolve the secret under. */
  derivedCompanyId: string | undefined;
}

describe("a background secrets.resolve must bind to its own service run-context, not another tenant's in-flight dispatch", () => {
  // Plugin workers are GLOBAL: one plugin.id is one process shared by every
  // tenant. A loop started in `setup()` (messenger `getUpdates`) services no
  // dispatch, so its worker->host calls carry no `paperclipInvocationId` — the
  // same wire shape as a legacy worker.
  //
  // A narrowing fix restricts `singleInFlightScope` to workers that cannot echo an id.
  // The installed base (messenger 0.1.42, platform.cad <=0.1.7) predates the
  // `echoesInvocationId` declaration and bundles its own SDK copy, so it keeps
  // the affordance — and with it this path — until every plugin is rebuilt.
  // These tests therefore run the legacy shape.

  let registries: PluginRunContextRegistry[] = [];

  afterEach(() => {
    for (const registry of registries) registry.dispose();
    registries = [];
  });

  function buildHarness(echoesInvocationId: boolean) {
    const registry = createPluginRunContextRegistry();
    registries.push(registry);

    const observed: ObservedResolve[] = [];
    const resolve = vi.fn(async (params: Record<string, unknown>) => {
      const runId = typeof params.runId === "string" ? params.runId : undefined;
      const entry = runId ? registry.get(PLUGIN_ID, runId) : null;
      observed.push({
        runId,
        paramsCompanyId:
          typeof params.companyId === "string" ? params.companyId : undefined,
        registryKind: entry ? (entry.kind ?? "dispatch") : undefined,
        derivedCompanyId:
          entry && "companyId" in entry ? (entry as { companyId: string }).companyId : undefined,
      });
      return "secret-plaintext";
    });

    const handlers = createHostClientHandlers({
      pluginId: PLUGIN_ID,
      capabilities: ["secrets.read-ref"],
      services: { secrets: { resolve } } as unknown as HostServices,
    });

    // A denied call reaches no service at all, so count denials separately —
    // that doubles as the liveness proof that the background loop is ticking.
    let deniedResolves = 0;
    const rawResolve = handlers["secrets.resolve"];
    handlers["secrets.resolve"] = (async (params: unknown, context: unknown) => {
      try {
        return await (rawResolve as (p: unknown, c: unknown) => Promise<unknown>)(
          params,
          context,
        );
      } catch (err) {
        deniedResolves += 1;
        throw err;
      }
    }) as typeof rawResolve;

    const handle = createPluginWorkerHandle(PLUGIN_ID, {
      entrypointPath: BACKGROUND_SECRET_POLL_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: handlers,
      ...(echoesInvocationId
        ? { env: { PLUGIN_FIXTURE_ECHOES_INVOCATION_ID: "1" } }
        : {}),
    }, { runContextRegistry: registry });

    // The manager registers the handle's service run-context on start
    // (plugin-worker-manager `registerService`); the handle itself does not, so
    // model it here.
    registry.registerService(PLUGIN_ID, handle.serviceRunId);

    return { handle, registry, observed, denials: () => deniedResolves };
  }

  it("never binds a no-dispatch secrets.resolve to the unrelated tenant whose dispatch is in flight", async () => {
    const { handle, observed, denials } = buildHarness(false);

    try {
      await handle.start();

      // Tick with NO dispatch in flight first: this proves the loop exists
      // independently of any dispatch, and pins the correct binding.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(observed.length + denials()).toBeGreaterThan(0);
      const before = observed.length;
      for (const call of observed) {
        expect(call.runId).toBe(handle.serviceRunId);
        expect(call.registryKind).toBe("service");
      }

      // Now company-a dispatches an event. The fixture holds it open, so it is
      // the single in-flight invocation while the background loop keeps
      // ticking. `registerInvocation` mints a company-a background run-context
      // for it and surfaces its runId on `singleInFlightScope`.
      await handle.call("onEvent", {
        event: { companyId: "company-a", type: "issue.created" },
      } as unknown as HostToWorkerMethods["onEvent"][0]);

      // The loop kept ticking underneath the dispatch.
      expect(observed.length + denials()).toBeGreaterThan(before);

      // The security assertion. Pre-fix, `backfillDispatchRunId` prefers
      // `singleInFlightScope.runId` over `serviceScope.runId`, so these calls
      // carry company-a's background runId and the server re-derives company-a
      // — handing a background caller with no claim to that tenant its secret.
      for (const call of observed) {
        expect(call.derivedCompanyId).not.toBe("company-a");
        expect(call.registryKind).not.toBe("background");
        expect(call.runId).toBe(handle.serviceRunId);
      }
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("still binds an id-less call to the single in-flight dispatch for a legacy worker servicing its own dispatch (preserved)", async () => {
    // The discriminator must be "does this call own a dispatch", not "which
    // scope key is present". A legacy worker resolving a secret from
    // inside its own `onEvent` must still reach that dispatch's company —
    // reordering the precedence would break exactly this.
    const registry = createPluginRunContextRegistry();
    registries.push(registry);

    const observed: ObservedResolve[] = [];
    const handlers = createHostClientHandlers({
      pluginId: PLUGIN_ID,
      capabilities: ["secrets.read-ref"],
      services: {
        secrets: {
          resolve: vi.fn(async (params: Record<string, unknown>) => {
            const runId = typeof params.runId === "string" ? params.runId : undefined;
            const entry = runId ? registry.get(PLUGIN_ID, runId) : null;
            observed.push({
              runId,
              paramsCompanyId: undefined,
              registryKind: entry ? (entry.kind ?? "dispatch") : undefined,
              derivedCompanyId:
                entry && "companyId" in entry
                  ? (entry as { companyId: string }).companyId
                  : undefined,
            });
            return "secret-plaintext";
          }),
        },
      } as unknown as HostServices,
    });

    const handle = createPluginWorkerHandle(PLUGIN_ID, {
      entrypointPath: path.join(FIXTURES_DIR, "plugin-worker-dispatch-secret-resolve.cjs"),
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: handlers,
    }, { runContextRegistry: registry });
    registry.registerService(PLUGIN_ID, handle.serviceRunId);

    try {
      await handle.start();
      await handle.call("onEvent", {
        event: { companyId: "company-a", type: "issue.created" },
      } as unknown as HostToWorkerMethods["onEvent"][0]);

      expect(observed.length).toBeGreaterThan(0);
      for (const call of observed) {
        expect(call.derivedCompanyId).toBe("company-a");
        expect(call.registryKind).toBe("background");
      }
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});
