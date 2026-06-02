/**
 * PLA-773 — tests for the per-dispatch **background** context resolve path.
 *
 * A background dispatch (`onEvent`) carries a known TRIGGERING company. Unlike
 * the company-less PLA-768 service path (which derives the owning company from
 * the binding), a background context resolves **scoped to the triggering
 * company** via the company-scoped `findBinding`. This suite verifies:
 *  - GATING (item 1): company A's onEvent resolves company A's bound ref, but
 *    CANNOT resolve a ref company B bound — it collapses to opaque not_found.
 *  - the lookup is the company-scoped `findBinding`, never the company-agnostic
 *    `findServiceBinding`.
 *  - audit attribution: actorType "plugin", agentId null, the TRIGGERING
 *    company, the host-minted background runId, sentinel toolName.
 *  - value-exact redaction registered under the background runId.
 *  - GATING (item 3): company A exhausting its per-(plugin, company) bucket does
 *    NOT throttle company B's background resolves.
 *  - borrowed-handle minting is rejected for a background context.
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
const { createPluginSecretsHandler } = await import(
  "../services/plugin-secrets-handler.js"
);
const { clearRunSecretValues, registeredRunCount } = await import(
  "../run-secret-registry.js"
);

const PLUGIN_DB_ID = "plugin-db-messenger";
const PLUGIN_KEY = "platform.messenger";

const SECRET_A = "11111111-1111-4111-8111-111111111111"; // bound by company A
const SECRET_B = "22222222-2222-4222-8222-222222222222"; // bound by company B
const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BG_RUN_A = "00000000-0000-4000-8000-00000000000a";
const BG_RUN_B = "00000000-0000-4000-8000-00000000000b";

interface BuildOpts {
  resolveValue?: string;
  globalRateLimit?: { maxAttempts: number; windowMs: number };
}

function buildHandler(opts: BuildOpts = {}) {
  const registry = createPluginRunContextRegistry({
    ttlMs: 60_000,
    sweepIntervalMs: 60_000,
  });

  // Operator-created per-company bindings: only (owner company, ref) resolves.
  const operatorBindings: Record<string, string> = {
    [`${COMPANY_A}:${SECRET_A}`]: "configA",
    [`${COMPANY_B}:${SECRET_B}`]: "configB",
  };

  const resolverFn = vi.fn(
    async (input: { companyId: string; secretId: string }) =>
      opts.resolveValue ?? `resolved:${input.companyId}:${input.secretId}`,
  );

  // Company-scoped lookup: a ref resolves ONLY for the company that bound it.
  const findBinding = vi.fn(
    async (input: { companyId: string; pluginTargetId: string; secretId: string }) => {
      const configPath = operatorBindings[`${input.companyId}:${input.secretId}`];
      if (!configPath) return null;
      return {
        id: `binding-${input.companyId}-${input.secretId}`,
        secretId: input.secretId,
        configPath,
        versionSelector: "latest" as const,
        allowedEgress: [],
        egressAllowlistEnforced: false,
      };
    },
  );
  // The company-agnostic service lookup MUST NOT be consulted on the background
  // path. If it is, this spy proves the regression.
  const findServiceBinding = vi.fn(async () => null);

  const handler = createPluginSecretsHandler({
    db: {} as never,
    pluginDbId: PLUGIN_DB_ID,
    pluginKey: PLUGIN_KEY,
    runContextRegistry: registry,
    bindings: { findBinding, findServiceBinding },
    resolver: { resolve: resolverFn },
    globalRateLimit: opts.globalRateLimit,
  });
  return { handler, registry, resolverFn, findBinding, findServiceBinding };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearRunSecretValues(BG_RUN_A);
  clearRunSecretValues(BG_RUN_B);
});

afterEach(() => {
  clearRunSecretValues(BG_RUN_A);
  clearRunSecretValues(BG_RUN_B);
});

describe("background-context secrets.resolve (PLA-773 item 1)", () => {
  it("resolves company A's bound ref scoped to the triggering company", async () => {
    const { handler, registry, resolverFn, findBinding, findServiceBinding } =
      buildHandler({ resolveValue: "bot-token-A" });
    registry.registerBackground(PLUGIN_DB_ID, BG_RUN_A, COMPANY_A);

    const value = await handler.resolve({ secretRef: SECRET_A, runId: BG_RUN_A });

    expect(value).toBe("bot-token-A");
    // Company-scoped lookup with the TRIGGERING company — never the agnostic one.
    expect(findBinding).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      pluginTargetId: PLUGIN_DB_ID,
      secretId: SECRET_A,
    });
    expect(findServiceBinding).not.toHaveBeenCalled();
    expect(resolverFn).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_A, secretId: SECRET_A }),
    );
  });

  it("GATING: company A's onEvent CANNOT resolve company B's bound secret", async () => {
    const { handler, registry, resolverFn, findServiceBinding } = buildHandler();
    registry.registerBackground(PLUGIN_DB_ID, BG_RUN_A, COMPANY_A);

    // SECRET_B is a real, resolvable ref — but it is bound by company B, not the
    // triggering company A. The company-scoped lookup finds nothing for A.
    await expect(
      handler.resolve({ secretRef: SECRET_B, runId: BG_RUN_A }),
    ).rejects.toMatchObject({ code: "not_found" });

    // It must never have reached the resolver, and never have consulted the
    // company-agnostic service lookup (which WOULD have derived company B).
    expect(resolverFn).not.toHaveBeenCalled();
    expect(findServiceBinding).not.toHaveBeenCalled();
  });

  it("audits as a plugin system actor scoped to the triggering company, with a durable null run_id (PLA-806)", async () => {
    const { handler, registry } = buildHandler();
    registry.registerBackground(PLUGIN_DB_ID, BG_RUN_A, COMPANY_A);

    await handler.resolve({ secretRef: SECRET_A, runId: BG_RUN_A });

    expect(logActivity).toHaveBeenCalledTimes(1);
    const [, entry] = (logActivity as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(entry).toMatchObject({
      actorType: "plugin",
      actorId: PLUGIN_DB_ID,
      action: "secret.resolved",
      companyId: COMPANY_A,
      agentId: null,
      // PLA-806: the background runId is host-minted/synthetic — NOT a
      // heartbeat_runs row. Writing it into run_id would 23503 and drop the
      // audit row, so it goes to run_id=NULL with the synthetic id in details.
      runId: null,
    });
    expect(entry.details).toMatchObject({
      outcome: "allowed",
      dispatchingAgentId: null,
      dispatchingCompanyId: COMPANY_A,
      toolName: "background:dispatch",
      backgroundRunId: BG_RUN_A,
      runContextKind: "background",
    });
  });

  it("registers the plaintext for value-exact redaction under the background runId", async () => {
    const { handler, registry } = buildHandler({ resolveValue: "Zx7Qm2Lp9Rt4Wv6Yb1Nc" });
    registry.registerBackground(PLUGIN_DB_ID, BG_RUN_A, COMPANY_A);

    expect(registeredRunCount()).toBe(0);
    await handler.resolve({ secretRef: SECRET_A, runId: BG_RUN_A });
    expect(registeredRunCount()).toBeGreaterThan(0);
  });

  it("rejects borrowed-handle minting for a background context", async () => {
    const { handler, registry } = buildHandler();
    registry.registerBackground(PLUGIN_DB_ID, BG_RUN_A, COMPANY_A);

    await expect(
      handler.mintHandle({ value: "secret-value-xyz", runId: BG_RUN_A }),
    ).rejects.toMatchObject({ code: "runcontext_invalid" });
  });
});

describe("per-tenant background rate bucket (PLA-773 item 3)", () => {
  it("GATING: company A exhausting its bucket does not throttle company B", async () => {
    const { handler, registry } = buildHandler({
      globalRateLimit: { maxAttempts: 2, windowMs: 60_000 },
    });
    registry.registerBackground(PLUGIN_DB_ID, BG_RUN_A, COMPANY_A);
    registry.registerBackground(PLUGIN_DB_ID, BG_RUN_B, COMPANY_B);

    // Company A exhausts its per-(plugin, company) bucket (2 allowed, 3rd denied).
    await handler.resolve({ secretRef: SECRET_A, runId: BG_RUN_A });
    await handler.resolve({ secretRef: SECRET_A, runId: BG_RUN_A });
    await expect(
      handler.resolve({ secretRef: SECRET_A, runId: BG_RUN_A }),
    ).rejects.toMatchObject({ code: "rate_limited" });

    // Company B is unaffected — its own bucket is untouched.
    await expect(
      handler.resolve({ secretRef: SECRET_B, runId: BG_RUN_B }),
    ).resolves.toBe(`resolved:${COMPANY_B}:${SECRET_B}`);
  });
});
