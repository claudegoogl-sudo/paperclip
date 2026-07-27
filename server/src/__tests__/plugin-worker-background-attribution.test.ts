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

describe("PLA-1824 — a background call that owns no dispatch must not inherit another tenant's scope", () => {
  // Plugin workers are GLOBAL: one plugin.id is one process shared by every
  // tenant. A loop started in `setup()` (messenger `getUpdates`) services no
  // dispatch, so its worker->host calls carry no `paperclipInvocationId` — the
  // same wire shape as a pre-PLA-657 legacy worker. PLA-719/PLA-761 attribute
  // that shape to the single in-flight dispatch, which for a background caller
  // means reading a tenant's effective config (and the secret-refs it carries)
  // that the background caller has no claim to.

  function buildHarness(echoesInvocationId: boolean) {
    const getForCompany = vi.fn(async (companyId: string) => ({
      tenant: companyId,
      telegramBotTokenSecretId: `secret-ref-of-${companyId}`,
    }));
    const instanceWideGet = vi.fn(async () => ({ tenant: "<instance-wide>" }));

    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: [],
      services: {
        config: { get: instanceWideGet, getForCompany },
      } as unknown as HostServices,
    });

    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: BACKGROUND_CONFIG_POLL_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: handlers,
      ...(echoesInvocationId
        ? { env: { PLUGIN_FIXTURE_ECHOES_INVOCATION_ID: "1" } }
        : {}),
    });

    return { getForCompany, instanceWideGet, handle };
  }

  it("does not resolve a setup()-loop config.get to the unrelated tenant whose dispatch is in flight", async () => {
    const { getForCompany, instanceWideGet, handle } = buildHarness(true);

    try {
      await handle.start();

      // Let the background loop tick with NO dispatch in flight first. This
      // proves the loop is independent of any dispatch: it already exists.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(instanceWideGet.mock.calls.length).toBeGreaterThan(0);
      expect(getForCompany).not.toHaveBeenCalled();

      // Now company-a dispatches an event. The fixture holds it open, so it is
      // the single in-flight invocation while the background loop keeps ticking.
      await handle.call("onEvent", {
        event: {
          companyId: "company-a",
          type: "issue.created",
        },
      } as unknown as HostToWorkerMethods["onEvent"][0]);

      // The background loop owns no dispatch. It must never be handed
      // company-a's effective config.
      expect(getForCompany).not.toHaveBeenCalled();
      // It still gets a working, tenant-free answer — the loop is not broken,
      // it is just no longer pointed at a stranger's tenant.
      expect(instanceWideGet.mock.calls.length).toBeGreaterThan(1);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("still attributes an id-less call to the single in-flight dispatch for a worker that cannot echo the id (PLA-719 preserved)", async () => {
    // The pre-PLA-657 population (platform.cad ≤0.1.7, klipper) never echoes
    // `paperclipInvocationId` even while servicing its own dispatch, so the
    // attribution remains the only way to scope it. Narrowing PLA-1824 must not
    // take that away.
    const { getForCompany, handle } = buildHarness(false);

    try {
      await handle.start();
      await new Promise((resolve) => setTimeout(resolve, 60));

      await handle.call("onEvent", {
        event: { companyId: "company-a", type: "issue.created" },
      } as unknown as HostToWorkerMethods["onEvent"][0]);

      expect(getForCompany).toHaveBeenCalledWith("company-a");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});
