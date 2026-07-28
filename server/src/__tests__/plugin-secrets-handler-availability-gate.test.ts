/**
 * PLA-1845 — per-tenant plugin-enablement gate on the service/background
 * `secrets.resolve` paths.
 *
 * An operator who disables a plugin for company X expects X's bound secrets to
 * stop resolving for it. The dispatch path could in principle be gated by the
 * host-services wrapper, but the service path cannot: it has no caller-supplied
 * company by construction — the owning company only becomes known inside the
 * handler, after the binding row is read. So the gate is injected into the
 * handler and applied with the authoritative company.
 *
 * This suite verifies:
 *  - service path, plugin disabled for the binding's OWNING company -> opaque
 *    not_found, no `allowed` audit row, and the value is never decrypted.
 *  - service path, plugin enabled -> resolves (guards against over-tightening
 *    the PLA-768 path).
 *  - background path, the same pair, keyed on the TRIGGERING company.
 *  - a host built without the gate fails closed on both paths.
 *  - the denial is not an enablement oracle: disabled and not-bound are
 *    indistinguishable to the worker.
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

const { logActivity } = await import("../services/activity-log.js");
const { createPluginRunContextRegistry } = await import(
  "../services/plugin-run-context-registry.js"
);
const { createPluginSecretsHandler, SecretsError } = await import(
  "../services/plugin-secrets-handler.js"
);
const { clearRunSecretValues, registeredRunCount } = await import(
  "../run-secret-registry.js"
);

const PLUGIN_DB_ID = "plugin-db-messenger";
const PLUGIN_KEY = "platform.messenger";

const SECRET_BOUND = "11111111-1111-4111-8111-111111111111";
const SECRET_UNBOUND = "33333333-3333-4333-8333-333333333333";
const COMPANY_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_RUN_ID = "00000000-0000-4000-8000-0000000000ff";
const BG_RUN_ID = "00000000-0000-4000-8000-0000000000fe";

interface BuildOpts {
  /** Companies the plugin is DISABLED for; the gate throws for these. */
  disabledFor?: string[];
  /** Build the handler with no gate injected at all (legacy host). */
  omitGate?: boolean;
  resolveValue?: string;
}

function buildHandler(opts: BuildOpts = {}) {
  const registry = createPluginRunContextRegistry({
    ttlMs: 60_000,
    sweepIntervalMs: 60_000,
  });
  const disabledFor = new Set(opts.disabledFor ?? []);

  const resolverFn = vi.fn(
    async (input: { companyId: string; secretId: string }) =>
      opts.resolveValue ?? `resolved:${input.companyId}:${input.secretId}`,
  );

  const bindingRow = (companyId: string, secretId: string) => ({
    companyId,
    id: `binding-${companyId}-${secretId}`,
    secretId,
    configPath: "telegramBotTokenSecretId",
    versionSelector: "latest" as const,
    allowedEgress: [],
    egressAllowlistEnforced: false,
  });

  // Company-scoped lookup (background path): only the owner's bound ref hits.
  const findBinding = vi.fn(
    async (input: { companyId: string; secretId: string }) =>
      input.companyId === COMPANY_OWNER && input.secretId === SECRET_BOUND
        ? bindingRow(input.companyId, input.secretId)
        : null,
  );
  // Company-agnostic lookup (service path): derives the owning company.
  const findServiceBinding = vi.fn(async (input: { secretId: string }) =>
    input.secretId === SECRET_BOUND ? bindingRow(COMPANY_OWNER, input.secretId) : null,
  );

  // Mirrors the host's `requirePluginEnabledForCompany`: throws for a company
  // the operator has disabled the plugin for.
  const ensurePluginEnabledForCompany = vi.fn(async (companyId: string) => {
    if (disabledFor.has(companyId)) {
      throw new Error("Plugin is disabled for this company");
    }
  });

  const handler = createPluginSecretsHandler({
    db: {} as never,
    pluginDbId: PLUGIN_DB_ID,
    pluginKey: PLUGIN_KEY,
    runContextRegistry: registry,
    bindings: { findBinding, findServiceBinding },
    resolver: { resolve: resolverFn },
    ...(opts.omitGate ? {} : { ensurePluginEnabledForCompany }),
  });

  return { handler, registry, resolverFn, ensurePluginEnabledForCompany };
}

/** The audit rows the handler wrote, newest last. */
function auditDetails() {
  return (logActivity as ReturnType<typeof vi.fn>).mock.calls.map(
    ([, entry]) => entry.details as Record<string, unknown>,
  );
}

async function expectNotFound(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SecretsError);
  expect((err as InstanceType<typeof SecretsError>).code).toBe("not_found");
  // The message must not name enablement — it is the same opaque string the
  // not-bound case returns.
  expect((err as Error).message).toBe("secret not found");
}

beforeEach(() => {
  vi.clearAllMocks();
  clearRunSecretValues(SERVICE_RUN_ID);
  clearRunSecretValues(BG_RUN_ID);
});

afterEach(() => {
  clearRunSecretValues(SERVICE_RUN_ID);
  clearRunSecretValues(BG_RUN_ID);
});

describe("service-context resolve honours per-tenant plugin enablement (PLA-1845)", () => {
  it("denies with not_found when the plugin is disabled for the binding's owning company", async () => {
    const { handler, registry, resolverFn, ensurePluginEnabledForCompany } = buildHandler({
      disabledFor: [COMPANY_OWNER],
    });
    registry.registerService(PLUGIN_DB_ID, SERVICE_RUN_ID);

    await expectNotFound(
      handler.resolve({ secretRef: SECRET_BOUND, runId: SERVICE_RUN_ID }),
    );

    // The gate ran with the BINDING-DERIVED company — the only company the
    // service path ever learns.
    expect(ensurePluginEnabledForCompany).toHaveBeenCalledWith(COMPANY_OWNER);
    // Denied before decryption: the secret value was never fetched...
    expect(resolverFn).not.toHaveBeenCalled();
    // ...and never registered for redaction (nothing to redact).
    expect(registeredRunCount(SERVICE_RUN_ID)).toBe(0);
  });

  it("writes a denied audit row and never one claiming allowed", async () => {
    const { handler, registry } = buildHandler({ disabledFor: [COMPANY_OWNER] });
    registry.registerService(PLUGIN_DB_ID, SERVICE_RUN_ID);

    await expectNotFound(
      handler.resolve({ secretRef: SECRET_BOUND, runId: SERVICE_RUN_ID }),
    );

    const details = auditDetails();
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      outcome: "denied",
      deniedReason: "not_found",
      dispatchingCompanyId: COMPANY_OWNER,
      runContextKind: "service",
      toolName: "service:background",
    });
    expect(details.some((d) => d.outcome === "allowed")).toBe(false);
    // Owning company is not attributed on a deny.
    expect(details[0].secretCompanyId ?? null).toBeNull();
  });

  it("still resolves when the plugin is enabled (no over-tightening of PLA-768)", async () => {
    const { handler, registry, ensurePluginEnabledForCompany } = buildHandler({
      resolveValue: "bot-token-xyz",
    });
    registry.registerService(PLUGIN_DB_ID, SERVICE_RUN_ID);

    const value = await handler.resolve({
      secretRef: SECRET_BOUND,
      runId: SERVICE_RUN_ID,
    });

    expect(value).toBe("bot-token-xyz");
    expect(ensurePluginEnabledForCompany).toHaveBeenCalledWith(COMPANY_OWNER);
    expect(auditDetails()[0]).toMatchObject({ outcome: "allowed" });
  });

  it("is not an enablement oracle: disabled and not-bound are indistinguishable", async () => {
    const disabled = buildHandler({ disabledFor: [COMPANY_OWNER] });
    disabled.registry.registerService(PLUGIN_DB_ID, SERVICE_RUN_ID);
    const disabledErr = await disabled.handler
      .resolve({ secretRef: SECRET_BOUND, runId: SERVICE_RUN_ID })
      .catch((e: Error) => e);

    vi.clearAllMocks();

    const unbound = buildHandler();
    unbound.registry.registerService(PLUGIN_DB_ID, SERVICE_RUN_ID);
    const unboundErr = await unbound.handler
      .resolve({ secretRef: SECRET_UNBOUND, runId: SERVICE_RUN_ID })
      .catch((e: Error) => e);

    expect((disabledErr as InstanceType<typeof SecretsError>).code).toBe(
      (unboundErr as InstanceType<typeof SecretsError>).code,
    );
    expect(disabledErr.message).toBe(unboundErr.message);
  });

  it("fails closed when the host was built without the enablement gate", async () => {
    const { handler, registry, resolverFn } = buildHandler({ omitGate: true });
    registry.registerService(PLUGIN_DB_ID, SERVICE_RUN_ID);

    await expectNotFound(
      handler.resolve({ secretRef: SECRET_BOUND, runId: SERVICE_RUN_ID }),
    );
    expect(resolverFn).not.toHaveBeenCalled();
  });
});

describe("background-context resolve honours per-tenant plugin enablement (PLA-1845)", () => {
  it("denies with not_found when the plugin is disabled for the triggering company", async () => {
    const { handler, registry, resolverFn, ensurePluginEnabledForCompany } = buildHandler({
      disabledFor: [COMPANY_OWNER],
    });
    registry.registerBackground(PLUGIN_DB_ID, BG_RUN_ID, COMPANY_OWNER);

    await expectNotFound(handler.resolve({ secretRef: SECRET_BOUND, runId: BG_RUN_ID }));

    // The gate ran with the HOST-VALIDATED triggering company.
    expect(ensurePluginEnabledForCompany).toHaveBeenCalledWith(COMPANY_OWNER);
    expect(resolverFn).not.toHaveBeenCalled();
    expect(registeredRunCount(BG_RUN_ID)).toBe(0);

    const details = auditDetails();
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      outcome: "denied",
      deniedReason: "not_found",
      dispatchingCompanyId: COMPANY_OWNER,
      runContextKind: "background",
      toolName: "background:dispatch",
    });
    expect(details.some((d) => d.outcome === "allowed")).toBe(false);
  });

  it("still resolves when the plugin is enabled (no over-tightening of PLA-773)", async () => {
    const { handler, registry, ensurePluginEnabledForCompany } = buildHandler({
      resolveValue: "bg-token-abc",
    });
    registry.registerBackground(PLUGIN_DB_ID, BG_RUN_ID, COMPANY_OWNER);

    const value = await handler.resolve({ secretRef: SECRET_BOUND, runId: BG_RUN_ID });

    expect(value).toBe("bg-token-abc");
    expect(ensurePluginEnabledForCompany).toHaveBeenCalledWith(COMPANY_OWNER);
    expect(auditDetails()[0]).toMatchObject({ outcome: "allowed" });
  });

  it("fails closed when the host was built without the enablement gate", async () => {
    const { handler, registry, resolverFn } = buildHandler({ omitGate: true });
    registry.registerBackground(PLUGIN_DB_ID, BG_RUN_ID, COMPANY_OWNER);

    await expectNotFound(handler.resolve({ secretRef: SECRET_BOUND, runId: BG_RUN_ID }));
    expect(resolverFn).not.toHaveBeenCalled();
  });
});
