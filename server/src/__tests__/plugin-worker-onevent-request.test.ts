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

// `onEvent` is dispatched as a JSON-RPC request so the event's invocation is
// cleared when the handler settles, not 15 min after send. These tests cover
// the scope lifetime and the single-in-flight attribution rules for events.

const ENTRYPOINT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "plugin-worker-onevent-request.cjs",
);

const MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["companies.read"],
  entrypoints: { worker: "dist/worker.js" },
} as unknown as PaperclipPluginManifestV1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness(opts: { echoes: boolean; rpcTimeoutMs?: number }) {
  const companiesList = vi.fn(async () => [{ id: "company-a" }]);
  const configGet = vi.fn(async (params: { companyId?: string }) => ({
    tenant: params.companyId ?? "<none>",
  }));
  const handlers = createHostClientHandlers({
    pluginId: "test.plugin",
    capabilities: ["companies.read"],
    services: {
      companies: { list: companiesList, get: vi.fn() },
      config: { get: configGet },
    } as unknown as HostServices,
  });
  const handle = createPluginWorkerHandle("test.plugin", {
    entrypointPath: ENTRYPOINT,
    manifest: MANIFEST,
    config: {},
    instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
    apiVersion: 1,
    hostHandlers: handlers,
    ...(opts.rpcTimeoutMs ? { rpcTimeoutMs: opts.rpcTimeoutMs } : {}),
    ...(opts.echoes ? { env: { PLUGIN_FIXTURE_ECHOES_INVOCATION_ID: "1" } } : {}),
  });
  return { handle, companiesList, configGet };
}

const event = (type: string, companyId = "company-a") =>
  ({ event: { companyId, type } }) as unknown as HostToWorkerMethods["onEvent"][0];

async function withHandle<T>(h: ReturnType<typeof harness>, fn: () => Promise<T>) {
  try {
    await h.handle.start();
    return await fn();
  } finally {
    await h.handle.stop().catch(() => undefined);
  }
}

describe("onEvent dispatched as a request: scope lifetime = handler runtime", () => {
  it("(1) after the event handler finishes, an id-less companies.list is NOT refused", async () => {
    const h = harness({ echoes: true });
    await withHandle(h, async () => {
      h.handle.notify("onEvent", event("probe-after"));
      await sleep(250);
      expect(h.companiesList).toHaveBeenCalledTimes(1);
    });
  });

  it("(2) inside a live event dispatch, an id-less cross-company read is still refused", async () => {
    const h = harness({ echoes: true });
    await withHandle(h, async () => {
      h.handle.notify("onEvent", event("probe-inside"));
      await sleep(300);
      expect(h.companiesList).not.toHaveBeenCalled();
    });
  });

  it("(3) a worker that never replies: the invocation is cleared at the bounded timeout", async () => {
    const h = harness({ echoes: true, rpcTimeoutMs: 150 });
    await withHandle(h, async () => {
      h.handle.notify("onEvent", event("hang"));
      await sleep(300); // past the 150ms timeout
      h.handle.notify("onEvent", event("probe-after"));
      await sleep(250);
      expect(h.companiesList).toHaveBeenCalledTimes(1);
    });
  });

  it("(5) legacy no-echo worker: a method already seen with no dispatch gets NO single-in-flight scope during an event", async () => {
    const h = harness({ echoes: false });
    await withHandle(h, async () => {
      h.handle.notify("onEvent", event("config-after", "company-x"));
      await sleep(250); // config.get issued id-less with nothing in flight
      h.handle.notify("onEvent", event("config-inside", "company-a"));
      await sleep(300);
      expect(h.configGet).not.toHaveBeenCalledWith({ companyId: "company-a" }, expect.anything());
    });
  });

  it("(5b) legacy no-echo worker, first id-less config.get inside its single event: attributed (same as runJob)", async () => {
    const h = harness({ echoes: false });
    await withHandle(h, async () => {
      h.handle.notify("onEvent", event("config-inside", "company-a"));
      await sleep(300);
      expect(h.configGet).toHaveBeenCalledWith({ companyId: "company-a" }, expect.anything());
    });
  });

  it("(6) echoesInvocationId worker, event in flight: an id-less call gets NO single-in-flight scope", async () => {
    const h = harness({ echoes: true });
    await withHandle(h, async () => {
      h.handle.notify("onEvent", event("config-inside", "company-a"));
      await sleep(300);
      expect(h.configGet).not.toHaveBeenCalled();
    });
  });

  it("(7) event + runJob both in flight: no attribution (fail-closed)", async () => {
    const h = harness({ echoes: false });
    await withHandle(h, async () => {
      const job = h.handle
        .call("runJob", { job: { jobKey: "j", runId: "r", trigger: "schedule", scheduledAt: "" }, companyId: "company-b" } as never)
        .catch(() => undefined);
      await sleep(30);
      h.handle.notify("onEvent", event("config-inside", "company-a"));
      await sleep(300);
      await job;
      expect(h.configGet).not.toHaveBeenCalledWith({ companyId: "company-a" }, expect.anything());
    });
  });

  it("(9) echo-trusted worker: an onEvent handler longer than the untrusted cap keeps its scope", async () => {
    const h = harness({ echoes: true, rpcTimeoutMs: 150 }); // untrusted cap = 150ms
    await withHandle(h, async () => {
      h.handle.notify("onEvent", event("long-echo", "company-a"));
      await sleep(700);
      // Both echoed calls resolve to company-a, including the one at ~400ms.
      expect(h.configGet).toHaveBeenCalledTimes(2);
      expect(h.configGet).toHaveBeenLastCalledWith({ companyId: "company-a" }, expect.anything());
    });
  });

  it("(10) declared-but-never-echoed worker: scope is cleared at the untrusted cap", async () => {
    const h = harness({ echoes: true, rpcTimeoutMs: 150 });
    await withHandle(h, async () => {
      h.handle.notify("onEvent", event("late-echo", "company-a"));
      await sleep(700);
      // The first echo arrives at ~400ms, after the 150ms cap: refused.
      expect(h.configGet).not.toHaveBeenCalled();
    });
  });

  it("(8) handler throws: error reply clears the invocation", async () => {
    const h = harness({ echoes: true });
    await withHandle(h, async () => {
      h.handle.notify("onEvent", event("throw"));
      await sleep(250);
      expect(h.companiesList).toHaveBeenCalledTimes(1);
    });
  });
});
