/**
 * PLA-697 / PLA-695 Control 1 — host value-exact redaction of vault.read tool
 * results.
 *
 * When the host mediates a `vault.read` secret resolution it obtains plaintext
 * and registers the exact bytes for value-exact redaction (keyed by runId). The
 * shared redaction pipeline then scrubs those bytes from any PERSISTED record
 * (run-log/transcript/event payload) — on BOTH the tool result's `content`
 * (free-form string) and `data.value` (structured field) — while the live value
 * still reaches the agent working context.
 *
 * The probe value is high-entropy with NO secret-ish field name, no dots, and
 * no secret text hint, so it can ONLY be caught by value-exact matching, never
 * by the pattern/heuristic redactor. That is the whole point of Control 1.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveSecretValue: vi.fn().mockResolvedValue("unused"),
  }),
}));

const { createPluginRunContextRegistry } = await import(
  "../services/plugin-run-context-registry.js"
);
const { createPluginSecretsHandler, SecretsError } = await import(
  "../services/plugin-secrets-handler.js"
);
const {
  redactSensitiveText,
  redactEventPayload,
  REDACTED_VAULT_VALUE,
} = await import("../redaction.js");
const { clearRunSecretValues, registeredRunCount } = await import(
  "../run-secret-registry.js"
);

const PLUGIN_DB_ID = "plugin-db-vault";
const PLUGIN_KEY = "platform.vault";
const SECRET_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_ID = "run-vault-1";

// 42 chars, base62, no ".", no secret hint, non-secret-ish — value-exact only.
const VAULT_VALUE = "Zx7Qm2Lp9Rt4Wv6Yb1Nc3Df5Gh8Jk0Mn2Pq4Su6Xa";

function buildHandler(resolveValue: string) {
  const registry = createPluginRunContextRegistry({ ttlMs: 60_000, sweepIntervalMs: 60_000 });
  registry.register(PLUGIN_DB_ID, {
    agentId: "agent-x",
    companyId: COMPANY_ID,
    runId: RUN_ID,
    projectId: "proj-1",
    toolName: "vault.read",
    registeredAt: Date.now(),
  });
  const handler = createPluginSecretsHandler({
    db: {} as never,
    pluginDbId: PLUGIN_DB_ID,
    pluginKey: PLUGIN_KEY,
    runContextRegistry: registry,
    bindings: {
      findBinding: async () => ({ id: "binding-1", secretId: SECRET_ID, configPath: "tokenSecretId", versionSelector: "latest", allowedEgress: [], egressAllowlistEnforced: false }),
    },
    resolver: { resolve: async () => resolveValue },
  });
  return handler;
}

beforeEach(() => {
  clearRunSecretValues(RUN_ID);
});

afterEach(() => {
  clearRunSecretValues(RUN_ID);
  vi.restoreAllMocks();
});

describe("vault.read value-exact redaction (PLA-697)", () => {
  it("returns the live plaintext to the agent AND registers it for persistence redaction", async () => {
    const handler = buildHandler(VAULT_VALUE);

    const value = await handler.resolve({ secretRef: SECRET_ID, runId: RUN_ID });

    // Live in-run consumption is unbroken: the agent receives the real value.
    expect(value).toBe(VAULT_VALUE);
    expect(registeredRunCount()).toBe(1);
  });

  it("redacts the value-exact secret from a persisted tool result `content` string", async () => {
    const handler = buildHandler(VAULT_VALUE);
    await handler.resolve({ secretRef: SECRET_ID, runId: RUN_ID });

    // vault.read returns the secret on `content` as free-form text.
    const content = `the requested credential is ${VAULT_VALUE} — use it`;
    const redacted = redactSensitiveText(content);

    expect(redacted).not.toContain(VAULT_VALUE);
    expect(redacted).toBe(`the requested credential is ${REDACTED_VAULT_VALUE} — use it`);
  });

  it("redacts the value-exact secret from a persisted tool result `data.value` field", async () => {
    const handler = buildHandler(VAULT_VALUE);
    await handler.resolve({ secretRef: SECRET_ID, runId: RUN_ID });

    // vault.read also returns the secret on `data.value`. Field names here are
    // deliberately NON-secret-ish ("value", "blob") to prove value-exact, not
    // pattern, matching. A normal non-secret field must survive untouched.
    const persisted = redactEventPayload({
      value: VAULT_VALUE,
      blob: `embedded ${VAULT_VALUE} inside`,
      note: "nothing sensitive here",
    });

    expect(persisted).toEqual({
      value: REDACTED_VAULT_VALUE,
      blob: `embedded ${REDACTED_VAULT_VALUE} inside`,
      note: "nothing sensitive here",
    });
    expect(JSON.stringify(persisted)).not.toContain(VAULT_VALUE);
  });

  it("stops redacting after the run's values are cleared (rotation / no cross-run leak)", async () => {
    const handler = buildHandler(VAULT_VALUE);
    await handler.resolve({ secretRef: SECRET_ID, runId: RUN_ID });

    clearRunSecretValues(RUN_ID);
    expect(registeredRunCount()).toBe(0);

    // The hint-free value is no longer registered, so the heuristic redactor
    // leaves it untouched — proving redaction was value-exact, not pattern.
    const content = `the requested credential is ${VAULT_VALUE} — use it`;
    expect(redactSensitiveText(content)).toBe(content);
  });

  it("fails closed: an unregisterable (empty) resolution is refused, not handed back", async () => {
    // A degenerate empty resolution cannot be registered for redaction;
    // registration throws and the handler must refuse (opaque not_found) rather
    // than hand back a value it cannot guarantee will be redacted when persisted.
    const handler = buildHandler("");

    const err = await handler.resolve({ secretRef: SECRET_ID, runId: RUN_ID }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SecretsError);
    expect((err as InstanceType<typeof SecretsError>).code).toBe("not_found");
    expect(registeredRunCount()).toBe(0);
  });
});
