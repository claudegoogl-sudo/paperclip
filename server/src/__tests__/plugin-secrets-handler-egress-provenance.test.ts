/**
 * PLA-723 EG1-provenance — the egress allowlist captured onto a borrowed handle
 * is OPERATOR-only. It is always derived host-side from the secret's
 * `company_secret_bindings` row keyed by (dispatching company, plugin,
 * secretRef). No worker/agent-passable field on the mintHandle params can set
 * or extend it; the worker can only NAME which secret it borrowed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/secrets.js", () => ({
  secretService: () => ({ resolveSecretValue: vi.fn().mockResolvedValue("unused") }),
}));

const { createPluginRunContextRegistry } = await import(
  "../services/plugin-run-context-registry.js"
);
const { createPluginSecretsHandler } = await import("../services/plugin-secrets-handler.js");
const { getHandleRecord, clearRunHandles } = await import("../handle-vault.js");

const PLUGIN_DB_ID = "plugin-db-prov";
const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET_BOUND = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "run-prov-1";
const VALUE = "Zx7Qm2Lp9Rt4Wv6Yb1Nc3Df5Gh8Jk0Mn2Pq4Su6Xa";

// The operator-set posture the binding row carries. Nothing the worker sends
// may override these values.
const OPERATOR_ALLOWLIST = ["https://api.github.com"];

function build() {
  const registry = createPluginRunContextRegistry({ ttlMs: 60_000, sweepIntervalMs: 60_000 });
  const findBinding = vi.fn(async (input: { secretId: string }) => {
    if (input.secretId !== SECRET_BOUND) return null;
    return {
      id: "binding-operator-1",
      secretId: SECRET_BOUND,
      configPath: "tokenSecretId",
      versionSelector: "latest",
      allowedEgress: OPERATOR_ALLOWLIST,
      egressAllowlistEnforced: true,
    };
  });
  const handler = createPluginSecretsHandler({
    db: {} as never,
    pluginDbId: PLUGIN_DB_ID,
    pluginKey: "platform.http",
    runContextRegistry: registry,
    bindings: { findBinding },
    resolver: { resolve: async () => VALUE },
  });
  registry.register(PLUGIN_DB_ID, {
    agentId: "agent-x",
    companyId: COMPANY_A,
    runId: RUN_ID,
    projectId: "proj-1",
    toolName: "http.fetch",
    registeredAt: Date.now(),
  });
  return { handler, findBinding };
}

afterEach(() => clearRunHandles(RUN_ID));

describe("EG1-provenance — allowlist is operator-derived, not worker-passable", () => {
  it("captures the binding's allowlist + enforced + bindingId onto the handle", async () => {
    const { handler } = build();
    const { handle } = await handler.mintHandle({ value: VALUE, runId: RUN_ID, secretRef: SECRET_BOUND });
    const rec = getHandleRecord(RUN_ID, handle);
    expect(rec).toMatchObject({
      value: VALUE,
      allowedEgress: OPERATOR_ALLOWLIST,
      enforced: true,
      bindingId: "binding-operator-1",
    });
  });

  it("ignores a worker-supplied allowedEgress / enforced / bindingId on the params", async () => {
    const { handler } = build();
    // A malicious worker stuffs extra fields into the JSON-RPC params trying to
    // widen its own egress. The host reads ONLY value/runId/secretRef.
    const rogue = {
      value: VALUE,
      runId: RUN_ID,
      secretRef: SECRET_BOUND,
      allowedEgress: ["https://attacker.com"],
      enforced: false,
      bindingId: "attacker-binding",
      unmediatedOptInTools: ["platform.http:selfsend"],
    } as never;
    const { handle } = await handler.mintHandle(rogue);
    const rec = getHandleRecord(RUN_ID, handle);
    // The captured posture is exactly the binding's — none of the rogue fields leak.
    expect(rec?.allowedEgress).toEqual(OPERATOR_ALLOWLIST);
    expect(rec?.enforced).toBe(true);
    expect(rec?.bindingId).toBe("binding-operator-1");
    expect(rec?.unmediatedOptInTools).toBeUndefined();
  });

  it("falls back to the log-only migration posture when no secretRef is given", async () => {
    const { handler, findBinding } = build();
    const { handle } = await handler.mintHandle({ value: VALUE, runId: RUN_ID });
    const rec = getHandleRecord(RUN_ID, handle);
    expect(findBinding).not.toHaveBeenCalled();
    expect(rec).toMatchObject({ allowedEgress: [], enforced: false, bindingId: null });
  });

  it("falls back to log-only when the ref resolves to no binding (no fabricated allowlist)", async () => {
    const { handler } = build();
    const UNBOUND = "99999999-9999-4999-8999-999999999999";
    const { handle } = await handler.mintHandle({ value: VALUE, runId: RUN_ID, secretRef: UNBOUND });
    const rec = getHandleRecord(RUN_ID, handle);
    expect(rec).toMatchObject({ allowedEgress: [], enforced: false, bindingId: null });
  });
});
