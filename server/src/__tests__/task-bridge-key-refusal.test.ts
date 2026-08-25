import { describe, expect, it, vi } from "vitest";
import {
  SANCTIONED_BRIDGE_ENV_KEY,
  resolveExecutionRunAdapterConfig,
  resolveSanctionedBridgeEnvBinding,
} from "../services/heartbeat.ts";
import {
  classifyAgentApiKeyRow,
} from "../services/task-bridge-keys.ts";

const BRIDGE_SECRET_REF = {
  type: "secret_ref",
  secretId: "0000b41d-9e00-4000-8000-000000000001",
  version: "latest" as const,
};

function mockSecretsSvc(resolvedValue?: string | Error) {
  const resolveEnvBindings = resolvedValue instanceof Error
    ? vi.fn().mockRejectedValue(resolvedValue)
    : vi.fn().mockResolvedValue({
        env: resolvedValue === undefined ? {} : { [SANCTIONED_BRIDGE_ENV_KEY]: resolvedValue },
        secretKeys: resolvedValue === undefined ? new Set<string>() : new Set([SANCTIONED_BRIDGE_ENV_KEY]),
        manifest: [],
      });
  return {
    resolveEnvBindings,
    svc: { resolveEnvBindings } as any,
  };
}

describe("classifyAgentApiKeyRow (pure bridge-key classifier)", () => {
  const NOW = new Date("2026-08-25T12:00:00.000Z");

  it("classifies a live, unexpired task_bridge key as ok", () => {
    expect(classifyAgentApiKeyRow({
      liveRow: {
        id: "key-1",
        scopeConfig: { kind: "task_bridge", projectId: "909f45e3-0000-4000-8000-000000000001" },
        expiresAt: new Date("2026-08-26T08:09:00.000Z"),
      },
      anyRow: null,
      now: NOW,
    })).toEqual({ ok: true });
  });

  it("classifies an expired key as key_expired and attaches keyId + expiresAt", () => {
    expect(classifyAgentApiKeyRow({
      liveRow: {
        id: "key-expired",
        scopeConfig: { kind: "task_bridge", projectId: "909f45e3-0000-4000-8000-000000000001" },
        expiresAt: new Date("2026-08-25T08:09:00.000Z"),
      },
      anyRow: null,
      now: NOW,
    })).toEqual({
      ok: false,
      code: "key_expired",
      keyId: "key-expired",
      expiresAt: "2026-08-25T08:09:00.000Z",
    });
  });

  it("classifies a live key of the wrong scope kind as key_scope_mismatch", () => {
    expect(classifyAgentApiKeyRow({
      liveRow: { id: "key-standard", scopeConfig: { kind: "standard" }, expiresAt: null },
      anyRow: null,
      now: NOW,
    })).toEqual({
      ok: false,
      code: "key_scope_mismatch",
      keyId: "key-standard",
      actualScopeKind: "standard",
    });
  });

  it("classifies no-live-row + row-with-revokedAt as key_revoked", () => {
    expect(classifyAgentApiKeyRow({
      liveRow: null,
      anyRow: { id: "key-revoked" },
      now: NOW,
    })).toEqual({ ok: false, code: "key_revoked", keyId: "key-revoked" });
  });

  it("classifies no row at all as key_missing", () => {
    expect(classifyAgentApiKeyRow({ liveRow: null, anyRow: null, now: NOW }))
      .toEqual({ ok: false, code: "key_missing" });
  });

  it("treats a corrupt expiresAt as expired (fail-closed) without throwing", () => {
    expect(classifyAgentApiKeyRow({
      liveRow: { id: "key-corrupt", scopeConfig: { kind: "task_bridge" }, expiresAt: "not-a-date" },
      anyRow: null,
      now: NOW,
    })).toEqual({ ok: false, code: "key_expired", keyId: "key-corrupt" });
  });
});

describe("resolveSanctionedBridgeEnvBinding refusal taxonomy", () => {
  // AC: expired vs revoked vs missing vs scope-mismatch must produce four
  // DISTINCT refusal codes — the historical boolean verifier collapsed them
  // all into one generic refusal.
  it.each([
    ["key_expired", { ok: false as const, code: "key_expired" as const, keyId: "k1", expiresAt: "2026-08-25T08:09:00.000Z" }],
    ["key_revoked", { ok: false as const, code: "key_revoked" as const, keyId: "k2" }],
    ["key_missing", { ok: false as const, code: "key_missing" as const }],
    ["key_scope_mismatch", { ok: false as const, code: "key_scope_mismatch" as const, keyId: "k3", actualScopeKind: "standard" }],
  ])("surfaces a typed %s refusal and delivers nothing", async (code, verification) => {
    const { svc } = mockSecretsSvc("pat-synthetic-bridge-key");
    const verifyTaskBridgeKey = vi.fn(async () => verification);

    const result = await resolveSanctionedBridgeEnvBinding({
      companyId: "company-1",
      rawAgentEnv: { [SANCTIONED_BRIDGE_ENV_KEY]: BRIDGE_SECRET_REF },
      secretsSvc: svc,
      verifyTaskBridgeKey,
    });

    const { ok: _ok, ...refusal } = verification;
    expect(result).toEqual({ status: "refused", refusal });
    expect(verifyTaskBridgeKey).toHaveBeenCalledWith("pat-synthetic-bridge-key");
  });

  it("delivers on the ok classification", async () => {
    const { svc } = mockSecretsSvc("pat-synthetic-bridge-key");
    const result = await resolveSanctionedBridgeEnvBinding({
      companyId: "company-1",
      rawAgentEnv: { [SANCTIONED_BRIDGE_ENV_KEY]: BRIDGE_SECRET_REF },
      secretsSvc: svc,
      verifyTaskBridgeKey: async () => ({ ok: true }),
    });
    expect(result).toEqual({
      status: "delivered",
      value: "pat-synthetic-bridge-key",
      secretKeys: new Set([SANCTIONED_BRIDGE_ENV_KEY]),
    });
  });

  it.each([
    ["binding_absent", { OTHER_KEY: "not-a-bridge-binding" }],
    ["binding_malformed", { [SANCTIONED_BRIDGE_ENV_KEY]: { type: "secret_ref", secretId: "not-a-uuid" } }],
    ["binding_not_secret_ref", { [SANCTIONED_BRIDGE_ENV_KEY]: "pat-agent-self-granted" }],
  ])("refuses with %s before any resolution", async (code, rawAgentEnv) => {
    const { svc, resolveEnvBindings } = mockSecretsSvc("pat-synthetic-bridge-key");
    const result = await resolveSanctionedBridgeEnvBinding({
      companyId: "company-1",
      rawAgentEnv,
      secretsSvc: svc,
      verifyTaskBridgeKey: async () => ({ ok: true }),
    });
    expect(result).toEqual({ status: "refused", refusal: { code } });
    expect(resolveEnvBindings).not.toHaveBeenCalled();
  });

  it("refuses with secret_unresolved when the backing secret throws", async () => {
    const { svc } = mockSecretsSvc(new Error("provider unavailable"));
    const result = await resolveSanctionedBridgeEnvBinding({
      companyId: "company-1",
      rawAgentEnv: { [SANCTIONED_BRIDGE_ENV_KEY]: BRIDGE_SECRET_REF },
      secretsSvc: svc,
      verifyTaskBridgeKey: async () => ({ ok: true }),
    });
    expect(result).toEqual({ status: "refused", refusal: { code: "secret_unresolved" } });
  });

  it("refuses with verifier_unavailable when no classifier is wired (fail-closed default)", async () => {
    const { svc } = mockSecretsSvc("pat-synthetic-bridge-key");
    const result = await resolveSanctionedBridgeEnvBinding({
      companyId: "company-1",
      rawAgentEnv: { [SANCTIONED_BRIDGE_ENV_KEY]: BRIDGE_SECRET_REF },
      secretsSvc: svc,
    });
    expect(result).toEqual({ status: "refused", refusal: { code: "verifier_unavailable" } });
  });
});

describe("resolveExecutionRunAdapterConfig bridge-key outcome", () => {
  function baseOverrides() {
    const resolveAdapterConfigForRuntime = vi.fn(async (_c: string, config: Record<string, unknown>) => ({
      config,
      secretKeys: new Set<string>(),
      manifest: [],
    }));
    return { resolveAdapterConfigForRuntime };
  }

  it("reports bridgeKey refused with the typed code when the classifier refuses", async () => {
    const { resolveAdapterConfigForRuntime } = baseOverrides();
    const { svc } = mockSecretsSvc("pat-synthetic-bridge-key");
    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      executionRunConfig: { env: {} },
      boardGatedAgentEnv: { [SANCTIONED_BRIDGE_ENV_KEY]: BRIDGE_SECRET_REF },
      projectEnv: null,
      secretsSvc: { ...svc, resolveAdapterConfigForRuntime } as any,
      verifyTaskBridgeKey: async () => ({
        ok: false,
        code: "key_expired",
        keyId: "k1",
        expiresAt: "2026-08-25T08:09:00.000Z",
      }),
    });
    expect(result.bridgeKey).toEqual({
      status: "refused",
      refusal: { code: "key_expired", keyId: "k1", expiresAt: "2026-08-25T08:09:00.000Z" },
    });
    expect((result.resolvedConfig.env as Record<string, unknown>)[SANCTIONED_BRIDGE_ENV_KEY])
      .toBeUndefined();
  });

  it("reports bridgeKey delivered on a passing classification", async () => {
    const { resolveAdapterConfigForRuntime } = baseOverrides();
    const { svc } = mockSecretsSvc("pat-synthetic-bridge-key");
    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      executionRunConfig: { env: {} },
      boardGatedAgentEnv: { [SANCTIONED_BRIDGE_ENV_KEY]: BRIDGE_SECRET_REF },
      projectEnv: null,
      secretsSvc: { ...svc, resolveAdapterConfigForRuntime } as any,
      verifyTaskBridgeKey: async () => ({ ok: true }),
    });
    expect(result.bridgeKey).toEqual({ status: "delivered" });
    expect((result.resolvedConfig.env as Record<string, unknown>)[SANCTIONED_BRIDGE_ENV_KEY])
      .toBe("pat-synthetic-bridge-key");
  });

  it("reports bridgeKey null when there is no agent consumer", async () => {
    const { resolveAdapterConfigForRuntime } = baseOverrides();
    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: { env: {} },
      projectEnv: null,
      secretsSvc: { resolveAdapterConfigForRuntime } as any,
    });
    expect(result.bridgeKey).toBeNull();
  });
});
