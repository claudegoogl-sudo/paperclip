import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  createHostClientHandlers,
  type HostServices,
  type HostToWorkerMethods,
} from "@paperclipai/plugin-sdk";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const BACKGROUND_CONFIG_POLL_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-background-config-poll.cjs",
);
const DISPATCH_CONFIG_GET_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-dispatch-config-get.cjs",
);

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

describe("a background call that owns no dispatch must not inherit another tenant's scope", () => {
  // Plugin workers are GLOBAL: one plugin.id is one process shared by every
  // tenant. A loop started in `setup()` (messenger `getUpdates`) services no
  // dispatch, so its worker->host calls carry no `paperclipInvocationId` — the
  // same wire shape as a legacy worker predating invocation-id echoing. The
  // fallback attribution logic attributes that shape to the single in-flight
  // dispatch, which for a background caller means reading a tenant's effective
  // config (and the secret-refs it carries) that the background caller has no
  // claim to.

  function buildHarness(
    echoesInvocationId: boolean,
    entrypointPath: string = BACKGROUND_CONFIG_POLL_WORKER_ENTRYPOINT,
  ) {
    // Upstream handler shape: `config.get` receives `{...params, companyId}`
    // with the host-validated company, or is denied before the service runs.
    const configGet = vi.fn(
      async (params: { companyId?: string }) => ({
        tenant: params.companyId ?? "<no company served>",
      }),
    );

    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: [],
      services: {
        config: { get: configGet },
      } as unknown as HostServices,
    });

    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: handlers,
      ...(echoesInvocationId
        ? { env: { PLUGIN_FIXTURE_ECHOES_INVOCATION_ID: "1" } }
        : {}),
    });

    return { configGet, handle };
  }

  it("never resolves a setup()-loop config.get to the unrelated tenant whose dispatch is in flight — the scope-less read is denied outright", async () => {
    // Upstream semantics restored (decision on the fork-guard review): with no
    // host-issued company context, `config.get` is denied proactively at the
    // SDK layer. A background loop that needs tenant data must target the
    // fork-only service-scope surface (`config.getForServiceScope`), which is
    // provisioned-gated per company. The isolation invariant is unchanged and
    // now holds a fortiori: the loop is not pointed at a stranger's tenant —
    // it is not served AT ALL.
    const { configGet, handle } = buildHarness(true);

    try {
      await handle.start();

      // Let the background loop tick with NO dispatch in flight first. This
      // proves the loop is independent of any dispatch: it already exists.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(configGet).not.toHaveBeenCalled();

      // Now company-a dispatches an event. The fixture holds it open, so it is
      // the single in-flight invocation while the background loop keeps ticking.
      await handle.call("onEvent", {
        event: {
          companyId: "company-a",
          type: "issue.created",
        },
      } as unknown as HostToWorkerMethods["onEvent"][0]);

      // The background loop owns no dispatch. It must never be handed
      // company-a's effective config — the restored guard denies the whole
      // read instead of falling back to an instance-wide payload.
      expect(configGet).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("still attributes an id-less call to the single in-flight dispatch for a worker that cannot echo the id (preserved)", async () => {
    // The legacy population (platform.cad ≤0.1.7, klipper) never echoes
    // `paperclipInvocationId` even while servicing its own dispatch, so the
    // host's single-in-flight attribution (`forkLegacyScopeContext` feeding
    // upstream's `resolveRequiredCompanyId`) remains the only way to scope it.
    //
    // This must use a DISPATCH-ONLY fixture. The background-poll worker would
    // not exercise attribution: its id-less call owns no dispatch and is now
    // denied outright.
    const { configGet, handle } = buildHarness(
      false,
      DISPATCH_CONFIG_GET_WORKER_ENTRYPOINT,
    );

    try {
      await handle.start();

      await handle.call("onEvent", {
        event: { companyId: "company-a", type: "issue.created" },
      } as unknown as HostToWorkerMethods["onEvent"][0]);

      expect(configGet).toHaveBeenCalledWith(
        { companyId: "company-a" },
        expect.anything(),
      );
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});
