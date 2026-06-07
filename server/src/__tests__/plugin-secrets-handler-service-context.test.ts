/**
 * PLA-768 — tests for the worker-lifetime **service** context resolve path.
 *
 * A background plugin dispatch (onEvent/onWebhook/runJob) or a setup()-started
 * loop resolves secrets from its OWN worker-lifetime run-context — there is no
 * dispatching agent or company. This suite verifies:
 *  - service context + bound ref → resolves, with the company DERIVED from the
 *    binding (never asserted by the worker)
 *  - the derived company is the one passed to the resolver (Gate 4 re-check)
 *  - audit attribution: actorType "plugin", agentId null, runId = service runId,
 *    sentinel toolName — NOT a spoofed agent/user run
 *  - value-exact redaction registered under the service runId
 *  - not-bound / ambiguous / missing-lookup all fail closed to opaque not_found
 *  - the per-plugin service rate-limit bucket caps a runaway loop
 *  - borrowed-handle minting is rejected for a service context
 *  - the dispatch path is unaffected (regression)
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
const SECRET_MISSING = "33333333-3333-4333-8333-333333333333";
const COMPANY_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_RUN_ID = "00000000-0000-4000-8000-0000000000ff";

interface BuildOpts {
  /** secretId → owning companyId for findServiceBinding. */
  serviceBindings?: Record<string, string>;
  /** Force findServiceBinding to be absent (legacy injected lookup). */
  omitServiceBinding?: boolean;
  resolveValue?: string;
  globalRateLimit?: { maxAttempts: number; windowMs: number };
}

function buildHandler(opts: BuildOpts = {}) {
  const registry = createPluginRunContextRegistry({
    ttlMs: 60_000,
    sweepIntervalMs: 60_000,
  });
  const serviceBindings = opts.serviceBindings ?? { [SECRET_BOUND]: COMPANY_OWNER };

  const resolverFn = vi.fn(
    async (input: {
      companyId: string;
      secretId: string;
      version: number | "latest";
      pluginDbId: string;
      configPath: string;
    }) => opts.resolveValue ?? `resolved:${input.companyId}:${input.secretId}`,
  );

  const findBinding = vi.fn(async () => null);
  const findServiceBinding = vi.fn(
    async (input: { pluginTargetId: string; secretId: string }) => {
      const companyId = serviceBindings[input.secretId];
      if (!companyId) return null;
      return {
        companyId,
        id: `binding-${input.secretId}`,
        secretId: input.secretId,
        configPath: "telegramBotTokenSecretId",
        versionSelector: "latest" as const,
        allowedEgress: [],
        egressAllowlistEnforced: false,
      };
    },
  );

  const bindings = opts.omitServiceBinding
    ? { findBinding }
    : { findBinding, findServiceBinding };

  const handler = createPluginSecretsHandler({
    db: {} as never,
    pluginDbId: PLUGIN_DB_ID,
    pluginKey: PLUGIN_KEY,
    runContextRegistry: registry,
    bindings,
    resolver: { resolve: resolverFn },
    globalRateLimit: opts.globalRateLimit,
  });
  return { handler, registry, resolverFn, findServiceBinding };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearRunSecretValues(SERVICE_RUN_ID);
});

afterEach(() => {
  clearRunSecretValues(SERVICE_RUN_ID);
});

describe("service-context secrets.resolve (PLA-768)", () => {
  it("resolves a bound ref, deriving the company from the binding", async () => {
    const { handler, registry, resolverFn, findServiceBinding } = buildHandler({
      resolveValue: "bot-token-xyz",
    });
    registry.registerService(PLUGIN_DB_ID, SERVICE_RUN_ID);

    const value = await handler.resolve({
      secretRef: SECRET_BOUND,
      runId: SERVICE_RUN_ID,
    });

    expect(value).toBe("bot-token-xyz");
    // Company derived from the binding, never asserted by the worker.
    expect(findServiceBinding).toHaveBeenCalledWith({
      pluginTargetId: PLUGIN_DB_ID,
      secretId: SECRET_BOUND,
    });
    // Gate 4: the derived company is the one handed to the resolver.
    expect(resolverFn).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_OWNER, secretId: SECRET_BOUND }),
    );
  });

  it("audits as a plugin system actor with a null run_id and the synthetic runId preserved in details (PLA-806)", async () => {
    const { handler, registry } = buildHandler();
    registry.registerService(PLUGIN_DB_ID, SERVICE_RUN_ID);

    await handler.resolve({ secretRef: SECRET_BOUND, runId: SERVICE_RUN_ID });

    expect(logActivity).toHaveBeenCalledTimes(1);
    const [, entry] = (logActivity as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(entry).toMatchObject({
      actorType: "plugin",
      actorId: PLUGIN_DB_ID,
      action: "secret.resolved",
      companyId: COMPANY_OWNER,
      agentId: null,
      // PLA-806: the service runId is host-minted/synthetic — NOT a heartbeat_runs
      // row. It must be written as run_id=NULL so the FK does not silently drop
      // the row; the synthetic id is preserved in details instead.
      runId: null,
    });
    expect(entry.details).toMatchObject({
      outcome: "allowed",
      dispatchingAgentId: null,
      dispatchingCompanyId: COMPANY_OWNER,
      toolName: "service:background",
      backgroundRunId: SERVICE_RUN_ID,
      runContextKind: "service",
    });
  });

  it("registers the plaintext for value-exact redaction under the service runId", async () => {
    const { handler, registry } = buildHandler({ resolveValue: "Zx7Qm2Lp9Rt4Wv6Yb1Nc" });
    registry.registerService(PLUGIN_DB_ID, SERVICE_RUN_ID);

    expect(registeredRunCount(SERVICE_RUN_ID)).toBe(0);
    await handler.resolve({ secretRef: SECRET_BOUND, runId: SERVICE_RUN_ID });
    expect(registeredRunCount(SERVICE_RUN_ID)).toBeGreaterThan(0);
  });

  it("fails closed to not_found when the ref is not bound", async () => {
    const { handler, registry } = buildHandler();
    registry.registerService(PLUGIN_DB_ID, SERVICE_RUN_ID);

    await expect(
      handler.resolve({ secretRef: SECRET_MISSING, runId: SERVICE_RUN_ID }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("fails closed when the binding derivation is ambiguous (no row returned)", async () => {
    // serviceBindings without the ref simulates the ambiguity null the default
    // lookup returns when >1 company bound the ref.
    const { handler, registry } = buildHandler({ serviceBindings: {} });
    registry.registerService(PLUGIN_DB_ID, SERVICE_RUN_ID);

    await expect(
      handler.resolve({ secretRef: SECRET_BOUND, runId: SERVICE_RUN_ID }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("fails closed when the injected lookup has no service support", async () => {
    const { handler, registry } = buildHandler({ omitServiceBinding: true });
    registry.registerService(PLUGIN_DB_ID, SERVICE_RUN_ID);

    await expect(
      handler.resolve({ secretRef: SECRET_BOUND, runId: SERVICE_RUN_ID }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("caps a runaway loop via the per-plugin service rate bucket", async () => {
    const { handler, registry } = buildHandler({
      globalRateLimit: { maxAttempts: 2, windowMs: 60_000 },
    });
    registry.registerService(PLUGIN_DB_ID, SERVICE_RUN_ID);

    await handler.resolve({ secretRef: SECRET_BOUND, runId: SERVICE_RUN_ID });
    await handler.resolve({ secretRef: SECRET_BOUND, runId: SERVICE_RUN_ID });
    await expect(
      handler.resolve({ secretRef: SECRET_BOUND, runId: SERVICE_RUN_ID }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("rejects borrowed-handle minting for a service context", async () => {
    const { handler, registry } = buildHandler();
    registry.registerService(PLUGIN_DB_ID, SERVICE_RUN_ID);

    await expect(
      handler.mintHandle({ value: "secret", runId: SERVICE_RUN_ID }),
    ).rejects.toMatchObject({ code: "runcontext_invalid" });
  });

  it("leaves the agent-dispatch resolve path unaffected (regression)", async () => {
    const { handler, registry, resolverFn } = buildHandler();
    // A normal dispatch entry still resolves via the company it asserts, NOT the
    // service derivation path.
    const DISPATCH_RUN = "dispatch-run-1";
    registry.register(PLUGIN_DB_ID, {
      agentId: "agent-x",
      companyId: COMPANY_OWNER,
      runId: DISPATCH_RUN,
      projectId: "proj-1",
      toolName: "messenger.send",
      registeredAt: Date.now(),
    });
    // For the dispatch path, the default per-company findBinding must match;
    // inject a binding for this company via the dispatch lookup.
    const value = await handler.resolve({ secretRef: SECRET_BOUND, runId: DISPATCH_RUN }).catch(
      (e: unknown) => (e instanceof SecretsError ? e.code : "threw"),
    );
    // findBinding (dispatch) returns null in this harness, so the dispatch path
    // collapses to not_found — proving it did NOT fall through to the service
    // derivation (which WOULD have resolved). resolverFn must not have run.
    expect(value).toBe("not_found");
    expect(resolverFn).not.toHaveBeenCalled();
  });
});
