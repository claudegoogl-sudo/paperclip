/**
 * PLA-702 / PLA-695 Control 2 — egress substitution chokepoint.
 *
 * `plugin-tool-registry.executeTool` is the structural chokepoint where a
 * borrowed handle is swapped back to plaintext for the worker dispatch, while
 * the handle-bearing parameters the caller persists/audits stay untouched.
 *
 * Gating criteria (PLA-701 sign-off):
 *  - a downstream tool whose param carries the handle receives PLAINTEXT at
 *    execution, while the original (persisted) parameters keep the HANDLE (RC4);
 *  - an unknown/foreign handle at egress fails closed — the literal
 *    `vault-handle://` never reaches the worker (RC5).
 *
 * FAILS on pre-fix code (no substitution happens; the worker would receive the
 * literal handle).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const { createPluginToolRegistry } = await import("../services/plugin-tool-registry.js");
const { mintHandle, clearRunHandles } = await import("../handle-vault.js");

const PLUGIN_ID = "platform.deploy";
const PLUGIN_DB_ID = "plugin-db-deploy";
const RUN_ID = "run-egress-1";
const FOREIGN_RUN = "run-egress-2";
const SECRET = "Zx7Qm2Lp9Rt4Wv6Yb1Nc3Df5Gh8Jk0Mn2Pq4Su6Xa";

const manifest = {
  tools: [
    {
      name: "push",
      displayName: "Push",
      description: "Push using a token",
      parametersSchema: { type: "object", properties: { header: { type: "string" } } },
    },
  ],
} as unknown as PaperclipPluginManifestV1;

const runContext = {
  agentId: "agent-x",
  companyId: "co-1",
  runId: RUN_ID,
  projectId: "proj-1",
};

function buildRegistry(received: { params?: unknown }) {
  const workerManager = {
    isRunning: () => true,
    call: async (_dbId: string, _method: string, rpcParams: { parameters: unknown }) => {
      received.params = rpcParams.parameters;
      return { content: "ok" };
    },
  } as unknown as PluginWorkerManager;
  const registry = createPluginToolRegistry(workerManager);
  registry.registerPlugin(PLUGIN_ID, manifest, PLUGIN_DB_ID);
  return registry;
}

beforeEach(() => clearRunHandles(RUN_ID));
afterEach(() => {
  clearRunHandles(RUN_ID);
  clearRunHandles(FOREIGN_RUN);
});

describe("borrowed-handle egress substitution", () => {
  it("RC4 — worker gets plaintext while the caller's params keep the handle", async () => {
    const handle = mintHandle(RUN_ID, SECRET);
    const received: { params?: unknown } = {};
    const registry = buildRegistry(received);

    const callerParams = { header: `Authorization: Bearer ${handle}` };
    await registry.executeTool(`${PLUGIN_ID}:push`, callerParams, runContext as never);

    // Worker (dispatch copy) saw the real secret.
    expect((received.params as { header: string }).header).toBe(
      `Authorization: Bearer ${SECRET}`,
    );
    // Caller's object — the one that gets persisted/audited — kept the handle.
    expect(callerParams.header).toBe(`Authorization: Bearer ${handle}`);
    expect(callerParams.header.includes(SECRET)).toBe(false);
  });

  it("RC5 — a foreign/unknown handle fails closed (never reaches the worker)", async () => {
    // Handle minted under a DIFFERENT run is foreign to this dispatch.
    const foreignHandle = mintHandle(FOREIGN_RUN, SECRET);
    const received: { params?: unknown } = {};
    const registry = buildRegistry(received);

    await expect(
      registry.executeTool(
        `${PLUGIN_ID}:push`,
        { header: `Bearer ${foreignHandle}` },
        runContext as never,
      ),
    ).rejects.toThrow();
    // The worker was never invoked with the literal handle.
    expect(received.params).toBeUndefined();
  });

  it("passes handle-free params straight through", async () => {
    const received: { params?: unknown } = {};
    const registry = buildRegistry(received);
    await registry.executeTool(
      `${PLUGIN_ID}:push`,
      { header: "Authorization: Bearer plain" },
      runContext as never,
    );
    expect((received.params as { header: string }).header).toBe("Authorization: Bearer plain");
  });
});
