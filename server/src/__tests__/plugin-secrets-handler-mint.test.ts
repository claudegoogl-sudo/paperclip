/**
 * PLA-702 / PLA-695 Control 2 — `secrets.mintHandle` host handler.
 *
 * Asserts the SecurityEngineer PLA-701 gating criteria that live in the mint
 * handler:
 *  - RC2: minting registers the plaintext with the Control-1 value-exact
 *    redactor (so the consuming tool's own output is scrubbed), and a
 *    registration throw FAILS the mint (no handle for an unregisterable value).
 *  - RC3: the borrowed value is keyed by the server-validated runContext.runId;
 *    a handle minted in run A does not resolve under run B.
 *  - value-free discipline: the plaintext is never written to the audit log.
 *  - fail-closed: no active runContext → runcontext_invalid (never a handle).
 *
 * Each FAILS on pre-fix code (no `mintHandle` method exists).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logActivityMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/activity-log.js", () => ({
  logActivity: (...args: unknown[]) => logActivityMock(...args),
}));
vi.mock("../services/secrets.js", () => ({
  secretService: () => ({ resolveSecretValue: vi.fn().mockResolvedValue("unused") }),
}));

const { createPluginRunContextRegistry } = await import(
  "../services/plugin-run-context-registry.js"
);
const { createPluginSecretsHandler, SecretsError } = await import(
  "../services/plugin-secrets-handler.js"
);
const {
  clearRunSecretValues,
  redactRegisteredSecretValues,
} = await import("../run-secret-registry.js");
const { resolveHandle, clearRunHandles, isHandleShaped } = await import(
  "../handle-vault.js"
);

const PLUGIN_DB_ID = "plugin-db-vault";
const PLUGIN_KEY = "platform.vault";
const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_ID = "run-mint-1";
const OTHER_RUN = "run-mint-2";
// High-entropy, no secret-ish hint — only value-exact matching can scrub it.
const VALUE = "Zx7Qm2Lp9Rt4Wv6Yb1Nc3Df5Gh8Jk0Mn2Pq4Su6Xa";

function buildHandler(runIds: string[] = [RUN_ID]) {
  const registry = createPluginRunContextRegistry({ ttlMs: 60_000, sweepIntervalMs: 60_000 });
  for (const runId of runIds) {
    registry.register(PLUGIN_DB_ID, {
      agentId: "agent-x",
      companyId: COMPANY_ID,
      runId,
      projectId: "proj-1",
      toolName: "vault.read",
      registeredAt: Date.now(),
    });
  }
  return createPluginSecretsHandler({
    db: {} as never,
    pluginDbId: PLUGIN_DB_ID,
    pluginKey: PLUGIN_KEY,
    runContextRegistry: registry,
  });
}

beforeEach(() => {
  logActivityMock.mockClear();
  clearRunSecretValues(RUN_ID);
  clearRunSecretValues(OTHER_RUN);
  clearRunHandles(RUN_ID);
  clearRunHandles(OTHER_RUN);
});

afterEach(() => {
  clearRunSecretValues(RUN_ID);
  clearRunSecretValues(OTHER_RUN);
  clearRunHandles(RUN_ID);
  clearRunHandles(OTHER_RUN);
});

describe("secrets.mintHandle", () => {
  it("mints a handle that resolves to the value under the same run", async () => {
    const handler = buildHandler();
    const { handle } = await handler.mintHandle({ value: VALUE, runId: RUN_ID });
    expect(isHandleShaped(handle)).toBe(true);
    expect(handle.includes(VALUE)).toBe(false);
    expect(resolveHandle(RUN_ID, handle)).toBe(VALUE);
  });

  it("RC2 — registers the value with the Control-1 value-exact redactor", async () => {
    const handler = buildHandler();
    // Pre-mint: the registry does not know the value, so it is not scrubbed.
    expect(redactRegisteredSecretValues(`leak ${VALUE} here`, "X")).toContain(VALUE);
    await handler.mintHandle({ value: VALUE, runId: RUN_ID });
    // Post-mint: the consuming tool's output carrying the value is scrubbed.
    expect(redactRegisteredSecretValues(`leak ${VALUE} here`, "X")).not.toContain(VALUE);
  });

  it("RC3 — a handle minted in run A does not resolve under run B", async () => {
    const handler = buildHandler([RUN_ID, OTHER_RUN]);
    const { handle } = await handler.mintHandle({ value: VALUE, runId: RUN_ID });
    expect(resolveHandle(OTHER_RUN, handle)).toBeUndefined();
  });

  it("is value-free: the plaintext never appears in the audit log", async () => {
    const handler = buildHandler();
    await handler.mintHandle({ value: VALUE, runId: RUN_ID });
    expect(logActivityMock).toHaveBeenCalled();
    const serialized = JSON.stringify(logActivityMock.mock.calls);
    expect(serialized).not.toContain(VALUE);
  });

  it("fail-closed: no active runContext → runcontext_invalid (no handle)", async () => {
    const handler = buildHandler();
    await expect(
      handler.mintHandle({ value: VALUE, runId: "run-not-registered" }),
    ).rejects.toBeInstanceOf(SecretsError);
  });

  it("rejects an empty value", async () => {
    const handler = buildHandler();
    await expect(handler.mintHandle({ value: "", runId: RUN_ID })).rejects.toBeInstanceOf(
      SecretsError,
    );
  });
});
