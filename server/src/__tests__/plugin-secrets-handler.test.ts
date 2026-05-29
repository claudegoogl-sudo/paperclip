/**
 * PLA-657 — tests for the company-scoped `secrets.resolve` handler.
 *
 * Covers the SecurityEngineer isolation matrix signed off on PLA-655/PLA-656:
 *  - same-company + bound → resolves
 *  - cross-company (real UUID) → not_found, BYTE-IDENTICAL to a nonexistent UUID
 *  - no / forged runContext → runcontext_invalid
 *  - not-bound (or not in the per-company allow-list) → not_found
 *  - rotation honored (handler never caches the resolved value)
 *  - error messages / payload contain no ref or value (PLA-190/PLA-193, R2)
 *  - rate limiter keyed on (agent) + (agent, company) — never pluginId (R3),
 *    and one company cannot exhaust another company's bucket
 *  - every distinguishable resolver error collapses to one not_found (R1)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

// The default resolver path delegates to secretService; tests inject their own
// resolver, so the real service is never invoked. Mock it to keep the test
// hermetic (no provider registry / DB graph).
vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveSecretValue: vi.fn().mockResolvedValue("unused"),
  }),
}));

const { logActivity } = await import("../services/activity-log.js");
const { createPluginRunContextRegistry } = await import(
  "../services/plugin-run-context-registry.js"
);
const {
  createPluginSecretsHandler,
  SecretsError,
  PLUGIN_SECRET_BINDING_TARGET_TYPE,
} = await import("../services/plugin-secrets-handler.js");

const PLUGIN_DB_ID = "plugin-db-1";
const PLUGIN_KEY = "platform.cad";

// Deterministic UUIDs for the matrix.
const SECRET_A = "11111111-1111-4111-8111-111111111111"; // bound to company A
const SECRET_B = "22222222-2222-4222-8222-222222222222"; // company B's secret
const SECRET_MISSING = "33333333-3333-4333-8333-333333333333"; // nonexistent
const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_X = "agent-x";

interface BuildOpts {
  /** company → set of secretIds bound for that company on this plugin. */
  bindingsByCompany?: Record<string, Set<string>>;
  resolveValue?: (input: { companyId: string; secretId: string; version: number | "latest" }) => string;
  globalRateLimit?: { maxAttempts: number; windowMs: number };
  perCompanyRateLimit?: { maxAttempts: number; windowMs: number };
}

function buildHandler(opts: BuildOpts = {}) {
  const registry = createPluginRunContextRegistry({ ttlMs: 60_000, sweepIntervalMs: 60_000 });
  const bindingsByCompany = opts.bindingsByCompany ?? {
    [COMPANY_A]: new Set([SECRET_A]),
  };
  const resolverFn = vi.fn(async (input: {
    companyId: string;
    secretId: string;
    version: number | "latest";
    pluginDbId: string;
    configPath: string;
  }) => {
    if (opts.resolveValue) return opts.resolveValue(input);
    return `resolved:${input.secretId}`;
  });
  const findBinding = vi.fn(async (input: {
    companyId: string;
    pluginTargetId: string;
    secretId: string;
  }) => {
    const set = bindingsByCompany[input.companyId];
    if (set && set.has(input.secretId)) {
      return { secretId: input.secretId, configPath: "githubPatSecretId", versionSelector: "latest" };
    }
    return null;
  });
  const handler = createPluginSecretsHandler({
    db: {} as never,
    pluginDbId: PLUGIN_DB_ID,
    pluginKey: PLUGIN_KEY,
    runContextRegistry: registry,
    bindings: { findBinding },
    resolver: { resolve: resolverFn },
    globalRateLimit: opts.globalRateLimit,
    perCompanyRateLimit: opts.perCompanyRateLimit,
  });
  return { handler, registry, resolverFn, findBinding };
}

function registerCtx(
  registry: ReturnType<typeof createPluginRunContextRegistry>,
  overrides: Partial<{ agentId: string; companyId: string; runId: string; projectId: string; toolName: string }> = {},
) {
  const runId = overrides.runId ?? "run-1";
  registry.register(PLUGIN_DB_ID, {
    agentId: overrides.agentId ?? AGENT_X,
    companyId: overrides.companyId ?? COMPANY_A,
    runId,
    projectId: overrides.projectId ?? "proj-1",
    toolName: overrides.toolName ?? "cad.export",
    registeredAt: Date.now(),
  });
  return runId;
}

/** Resolve and return the thrown error (or throw if it unexpectedly succeeds). */
async function expectThrow(p: Promise<unknown>): Promise<InstanceType<typeof SecretsError>> {
  try {
    await p;
  } catch (err) {
    return err as InstanceType<typeof SecretsError>;
  }
  throw new Error("expected the call to throw");
}

beforeEach(() => {
  (logActivity as unknown as { mockClear: () => void }).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createPluginSecretsHandler — company-scoped resolution", () => {
  it("resolves a same-company, bound secret end-to-end", async () => {
    const { handler, registry, resolverFn } = buildHandler();
    const runId = registerCtx(registry, { companyId: COMPANY_A });

    const value = await handler.resolve({ secretRef: SECRET_A, runId });

    expect(value).toBe(`resolved:${SECRET_A}`);
    // Company scope is the DISPATCHING company from the registry, never a worker value.
    expect(resolverFn).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_A, secretId: SECRET_A, version: "latest" }),
    );
  });

  it("denies cross-company resolution with not_found BYTE-IDENTICAL to a nonexistent ref (no oracle)", async () => {
    const { handler, registry } = buildHandler({
      bindingsByCompany: { [COMPANY_A]: new Set([SECRET_A]) },
    });
    // Company A asks for company B's REAL secret UUID …
    const runId = registerCtx(registry, { companyId: COMPANY_A });
    const crossCompany = await expectThrow(handler.resolve({ secretRef: SECRET_B, runId }));
    // … and for a random nonexistent UUID.
    const runId2 = registerCtx(registry, { companyId: COMPANY_A, runId: "run-2" });
    const nonexistent = await expectThrow(handler.resolve({ secretRef: SECRET_MISSING, runId: runId2 }));

    expect(crossCompany).toBeInstanceOf(SecretsError);
    expect(crossCompany.code).toBe("not_found");
    // Byte-identical code AND message — the only observable difference an
    // attacker could use to enumerate is eliminated.
    expect(crossCompany.code).toBe(nonexistent.code);
    expect(crossCompany.message).toBe(nonexistent.message);
  });

  it("collapses EVERY distinguishable resolver error to one not_found (R1 defence-in-depth)", async () => {
    // A binding exists, but the resolver throws each distinguishable shape the
    // secretService can produce. All must look identical at the worker boundary.
    const errors = [
      Object.assign(new Error("Secret not found"), { status: 404 }),
      Object.assign(new Error("Secret must belong to same company"), { status: 422 }),
      Object.assign(new Error("Secret is not active"), { status: 422, details: { code: "secret_inactive" } }),
      Object.assign(new Error("Secret version not found"), { status: 404, details: { code: "version_missing" } }),
      Object.assign(new Error("provider exploded"), { status: 500 }),
    ];
    for (const thrown of errors) {
      const { handler, registry } = buildHandler({
        bindingsByCompany: { [COMPANY_A]: new Set([SECRET_A]) },
        resolveValue: () => {
          throw thrown;
        },
      });
      const runId = registerCtx(registry, { companyId: COMPANY_A });
      const err = await expectThrow(handler.resolve({ secretRef: SECRET_A, runId }));
      expect(err.code).toBe("not_found");
      expect(err.message).toBe("secret not found");
      // The internal message never reaches the worker.
      expect(err.message).not.toContain(thrown.message);
    }
  });

  it("returns runcontext_invalid when no run-context is registered (forged/expired runId)", async () => {
    const { handler } = buildHandler();
    const err = await expectThrow(handler.resolve({ secretRef: SECRET_A, runId: "forged-run" }));
    expect(err.code).toBe("runcontext_invalid");
  });

  it("returns runcontext_invalid when runId is missing/empty", async () => {
    const { handler, registry } = buildHandler();
    registerCtx(registry, { companyId: COMPANY_A });
    const err = await expectThrow(handler.resolve({ secretRef: SECRET_A, runId: "" }));
    expect(err.code).toBe("runcontext_invalid");
  });

  it("returns not_found for a ref not bound for the dispatching company", async () => {
    const { handler, registry, resolverFn } = buildHandler({
      bindingsByCompany: { [COMPANY_A]: new Set([SECRET_A]) },
    });
    // SECRET_B exists for B but A has no binding for it.
    const runId = registerCtx(registry, { companyId: COMPANY_A });
    const err = await expectThrow(handler.resolve({ secretRef: SECRET_B, runId }));
    expect(err.code).toBe("not_found");
    // The resolver is never reached when the allow-list gate denies.
    expect(resolverFn).not.toHaveBeenCalled();
  });

  it("rejects malformed refs with invalid_ref and never echoes the ref", async () => {
    const { handler, registry } = buildHandler();
    const runId = registerCtx(registry, { companyId: COMPANY_A });
    for (const bad of ["not-a-uuid", "", "   ", "<script>"]) {
      const err = await expectThrow(handler.resolve({ secretRef: bad, runId }));
      expect(err.code).toBe("invalid_ref");
      expect(err.message).toBe("invalid secret reference");
      expect(err.message).not.toContain(bad.trim() || "x");
    }
  });

  it("honours rotation — never caches the resolved value", async () => {
    let n = 0;
    const { handler, registry } = buildHandler({
      bindingsByCompany: { [COMPANY_A]: new Set([SECRET_A]) },
      resolveValue: () => `v${++n}`,
    });
    const runId = registerCtx(registry, { companyId: COMPANY_A });
    const first = await handler.resolve({ secretRef: SECRET_A, runId });
    const runId2 = registerCtx(registry, { companyId: COMPANY_A, runId: "run-2" });
    const second = await handler.resolve({ secretRef: SECRET_A, runId: runId2 });
    expect(first).toBe("v1");
    expect(second).toBe("v2");
  });

  it("never leaks the resolved value into the audit log", async () => {
    const { handler, registry } = buildHandler({
      bindingsByCompany: { [COMPANY_A]: new Set([SECRET_A]) },
      resolveValue: () => "super-secret-value",
    });
    const runId = registerCtx(registry, { companyId: COMPANY_A });
    await handler.resolve({ secretRef: SECRET_A, runId });

    expect(logActivity).toHaveBeenCalled();
    const calls = (logActivity as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain("super-secret-value");
    // The allow audit is value-free, attributes the action, and carries the
    // dispatching company.
    const lastInput = calls[calls.length - 1][1] as {
      action: string;
      actorType: string;
      companyId: string;
      details: Record<string, unknown>;
    };
    expect(lastInput.action).toBe("secret.resolved");
    expect(lastInput.actorType).toBe("plugin");
    expect(lastInput.companyId).toBe(COMPANY_A);
    expect(lastInput.details.outcome).toBe("allowed");
  });
});

describe("createPluginSecretsHandler — rate limiting (R3)", () => {
  it("keys the per-company bucket on (agent, company) — one company cannot exhaust another's", async () => {
    const { handler, registry } = buildHandler({
      bindingsByCompany: {
        [COMPANY_A]: new Set([SECRET_A]),
        [COMPANY_B]: new Set([SECRET_B]),
      },
      globalRateLimit: { maxAttempts: 100, windowMs: 60_000 },
      perCompanyRateLimit: { maxAttempts: 2, windowMs: 60_000 },
    });
    // Same agent X, company A: 2 ok, 3rd rate_limited.
    const a1 = registerCtx(registry, { agentId: AGENT_X, companyId: COMPANY_A, runId: "a1" });
    const a2 = registerCtx(registry, { agentId: AGENT_X, companyId: COMPANY_A, runId: "a2" });
    const a3 = registerCtx(registry, { agentId: AGENT_X, companyId: COMPANY_A, runId: "a3" });
    await handler.resolve({ secretRef: SECRET_A, runId: a1 });
    await handler.resolve({ secretRef: SECRET_A, runId: a2 });
    const denied = await expectThrow(handler.resolve({ secretRef: SECRET_A, runId: a3 }));
    expect(denied.code).toBe("rate_limited");

    // Same agent X, company B is a SEPARATE bucket — still resolves.
    const b1 = registerCtx(registry, { agentId: AGENT_X, companyId: COMPANY_B, runId: "b1" });
    const ok = await handler.resolve({ secretRef: SECRET_B, runId: b1 });
    expect(ok).toBe(`resolved:${SECRET_B}`);
  });

  it("keys the global bucket per dispatching agent (not pluginId)", async () => {
    const { handler, registry } = buildHandler({
      bindingsByCompany: {
        [COMPANY_A]: new Set([SECRET_A]),
        [COMPANY_B]: new Set([SECRET_B]),
      },
      globalRateLimit: { maxAttempts: 2, windowMs: 60_000 },
      perCompanyRateLimit: { maxAttempts: 100, windowMs: 60_000 },
    });
    const a1 = registerCtx(registry, { agentId: AGENT_X, companyId: COMPANY_A, runId: "a1" });
    const a2 = registerCtx(registry, { agentId: AGENT_X, companyId: COMPANY_A, runId: "a2" });
    const b1 = registerCtx(registry, { agentId: AGENT_X, companyId: COMPANY_B, runId: "b1" });
    await handler.resolve({ secretRef: SECRET_A, runId: a1 });
    await handler.resolve({ secretRef: SECRET_A, runId: a2 });
    // Third call from the SAME agent — even for a different company — hits the
    // global per-agent ceiling.
    const denied = await expectThrow(handler.resolve({ secretRef: SECRET_B, runId: b1 }));
    expect(denied.code).toBe("rate_limited");
  });

  it("isolates the global bucket BETWEEN agents (proves it is not keyed on pluginId)", async () => {
    const { handler, registry } = buildHandler({
      bindingsByCompany: { [COMPANY_A]: new Set([SECRET_A]) },
      globalRateLimit: { maxAttempts: 1, windowMs: 60_000 },
      perCompanyRateLimit: { maxAttempts: 100, windowMs: 60_000 },
    });
    const a1 = registerCtx(registry, { agentId: "agent-1", companyId: COMPANY_A, runId: "a1" });
    await handler.resolve({ secretRef: SECRET_A, runId: a1 });
    // A DIFFERENT agent on the SAME plugin still resolves — if the limiter were
    // keyed on pluginId, this would be denied.
    const a2 = registerCtx(registry, { agentId: "agent-2", companyId: COMPANY_A, runId: "a2" });
    const ok = await handler.resolve({ secretRef: SECRET_A, runId: a2 });
    expect(ok).toBe(`resolved:${SECRET_A}`);
  });
});

describe("createPluginSecretsHandler — binding target convention", () => {
  it("looks up bindings under targetType 'plugin' keyed by the plugin install id", async () => {
    const { handler, registry, findBinding } = buildHandler();
    const runId = registerCtx(registry, { companyId: COMPANY_A });
    await handler.resolve({ secretRef: SECRET_A, runId });
    expect(PLUGIN_SECRET_BINDING_TARGET_TYPE).toBe("plugin");
    expect(findBinding).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      pluginTargetId: PLUGIN_DB_ID,
      secretId: SECRET_A,
    });
  });
});
