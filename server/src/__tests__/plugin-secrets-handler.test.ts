import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecrets,
  companySecretVersions,
  createDb,
  plugins,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  createPluginSecretsHandler,
  extractSecretRefBindingsFromConfig,
} from "../services/plugin-secrets-handler.js";
import { secretService } from "../services/secrets.js";

const pluginId = "11111111-1111-4111-8111-111111111111";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin secret handler integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("extractSecretRefBindingsFromConfig", () => {
  it("ignores UUID strings outside schema-declared secret fields", () => {
    const externalProjectId = "77777777-7777-4777-8777-777777777777";

    expect(extractSecretRefBindingsFromConfig(
      { externalProjectId },
      { type: "object", properties: { externalProjectId: { type: "string" } } },
    )).toEqual([]);
  });

  it("rejects legacy UUID strings at schema-declared secret fields", () => {
    const secretId = "77777777-7777-4777-8777-777777777777";

    expect(() => extractSecretRefBindingsFromConfig(
      { token: secretId },
      { type: "object", properties: { token: { format: "secret-ref" } } },
    )).toThrow(/must use.*secret_ref/i);
  });
});

describe("createPluginSecretsHandler fail-closed guards", () => {
  it("requires company context before touching the database", async () => {
    const db = { select: vi.fn(() => { throw new Error("db should not be touched"); }) };
    const handler = createPluginSecretsHandler({ db: db as never, pluginId });

    await expect(
      handler.resolve({ secretRef: { type: "secret_ref", secretId: randomUUID() } }),
    ).rejects.toThrow(/companyId is required/i);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("rejects legacy string refs before provider resolution", async () => {
    const db = { select: vi.fn(() => { throw new Error("db should not be touched"); }) };
    const handler = createPluginSecretsHandler({ db: db as never, pluginId });

    await expect(
      handler.resolve({ companyId: randomUUID(), secretRef: randomUUID() }),
    ).rejects.toThrow(/use \{ type: "secret_ref"/i);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describeEmbeddedPostgres("createPluginSecretsHandler shared vault integration", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-plugin-secrets-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("plugin-secrets-handler");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `P${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  async function seedPlugin() {
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.plugin-secrets-test",
      packageName: "@paperclipai/plugin-secrets-test",
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.plugin-secrets-test",
        apiVersion: 1,
        version: "0.0.1",
        displayName: "Plugin Secrets Test",
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
  }

  it("resolves bound plugin refs through secretService and emits plugin_worker access events", async () => {
    await seedPlugin();
    const companyId = await seedCompany("Plugin Co");
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `plugin-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "resolved-plugin-secret",
    });
    await svc.syncSecretRefsForTarget(companyId, { targetType: "plugin", targetId: pluginId }, [
      { secretId: secret.id, configPath: "apiKey" },
    ], { replaceAll: true });

    const handler = createPluginSecretsHandler({ db, pluginId });
    await expect(
      handler.resolve({
        companyId,
        secretRef: { type: "secret_ref", secretId: secret.id, version: "latest" },
      }),
    ).resolves.toBe("resolved-plugin-secret");

    const events = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, secret.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      companyId,
      secretId: secret.id,
      consumerType: "plugin_worker",
      consumerId: pluginId,
      configPath: "apiKey",
      pluginId,
      outcome: "success",
      errorCode: null,
    });
  });

  it("fails closed for cross-company resolve before secret provider access", async () => {
    await seedPlugin();
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = secretService(db);
    const foreignSecret = await svc.create(companyB, {
      name: `foreign-plugin-secret-${randomUUID()}`,
      provider: "local_encrypted",
      value: "foreign-value",
    });
    await svc.syncSecretRefsForTarget(companyB, { targetType: "plugin", targetId: pluginId }, [
      { secretId: foreignSecret.id, configPath: "apiKey" },
    ], { replaceAll: true });

    const handler = createPluginSecretsHandler({ db, pluginId });
    await expect(
      handler.resolve({
        companyId: companyA,
        secretRef: { type: "secret_ref", secretId: foreignSecret.id, version: "latest" },
      }),
    ).rejects.toThrow(/not bound/i);

    const events = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, foreignSecret.id));
    expect(events).toHaveLength(0);
  });
});
/**
 * Tests for the company-scoped `secrets.resolve` handler.
 *
 * Covers the SecurityEngineer isolation matrix:
 *  - same-company + bound → resolves
 *  - cross-company (real UUID) → not_found, BYTE-IDENTICAL to a nonexistent UUID
 *  - no / forged runContext → runcontext_invalid
 *  - not-bound (or not in the per-company allow-list) → not_found
 *  - rotation honored (handler never caches the resolved value)
 *  - error messages / payload contain no ref or value (R2)
 *  - rate limiter keyed on (agent) + (agent, company) — never pluginId (R3),
 *    and one company cannot exhaust another company's bucket
 *  - every distinguishable resolver error collapses to one not_found (R1)
 */


vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

// Merge note (sync re-land): the fork originally mocked "../services/secrets.js"
// wholesale to keep these unit tests hermetic. Upstream v2026.824.1 adds a
// real-DB integration suite for the same handler below, which requires the real
// secretService (and the handler's default resolver path calls
// resolveSecretValue). The mock is therefore omitted in the merged file: these
// tests inject their own `resolver` and never invoke secretService, so every
// assertion below is unchanged.

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
      return {
        id: `binding-${input.secretId}`,
        secretId: input.secretId,
        configPath: "githubPatSecretId",
        versionSelector: "latest",
        allowedEgress: [],
        egressAllowlistEnforced: false,
      };
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
      runId: string | null;
      details: Record<string, unknown>;
    };
    expect(lastInput.action).toBe("secret.resolved");
    expect(lastInput.actorType).toBe("plugin");
    expect(lastInput.companyId).toBe(COMPANY_A);
    expect(lastInput.details.outcome).toBe("allowed");
    // AC3: a foreground agent dispatch carries a REAL heartbeat run,
    // so run_id is populated with the dispatch runId — never nulled — and the
    // synthetic-run markers used by the background/service paths are absent.
    expect(lastInput.runId).toBe(runId);
    expect(lastInput.details.backgroundRunId).toBeUndefined();
    expect(lastInput.details.runContextKind).toBeUndefined();
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
