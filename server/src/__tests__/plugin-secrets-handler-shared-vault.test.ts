/**
 * Upstream v2026.722.0 shared-vault coverage for the plugin `secrets.resolve`
 * handler, re-ported onto the fork's run-context contract.
 *
 * These live in their own file because `plugin-secrets-handler.test.ts` mocks
 * `../services/secrets.js` module-wide for its isolation matrix; the tests here
 * deliberately exercise the REAL `secretService` against an embedded PostgreSQL
 * so the binding lookup, provider decryption and `secret_access_events` audit
 * trail are proven end to end.
 *
 * Fork delta vs upstream: the dispatching company is never taken from the
 * worker. It is derived server-side from the run-context registry keyed on
 * `(pluginDbId, runId)` (PLA-655/PLA-657), so every resolve passes a `runId` and
 * a cross-company attempt collapses to the opaque `not_found`.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecrets,
  companySecretVersions,
  createDb,
  heartbeatRuns,
  plugins,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createPluginRunContextRegistry } from "../services/plugin-run-context-registry.js";
import {
  createPluginSecretsHandler,
  extractSecretRefBindingsFromConfig,
} from "../services/plugin-secrets-handler.js";
import { secretService } from "../services/secrets.js";

const pluginId = "11111111-1111-4111-8111-111111111111";
const pluginKey = "paperclip.plugin-secrets-test";
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

  it("normalizes legacy UUID strings at schema-declared secret fields", () => {
    const secretId = "77777777-7777-4777-8777-777777777777";

    // Fork delta: upstream v722 throws here. Shipped manifests declare the
    // field as `type: "string"`, so rejecting the UUID would leave no savable
    // shape at all. Both forms must normalize to the same binding.
    expect(extractSecretRefBindingsFromConfig(
      { token: secretId },
      { type: "object", properties: { token: { format: "secret-ref" } } },
    )).toEqual([
      expect.objectContaining({ secretId, configPath: "token", versionSelector: "latest" }),
    ]);
  });

  it("normalizes the v2026.722.0 object form to the same binding", () => {
    const secretId = "77777777-7777-4777-8777-777777777777";

    expect(extractSecretRefBindingsFromConfig(
      { token: { type: "secret_ref", secretId } },
      { type: "object", properties: { token: { format: "secret-ref" } } },
    )).toEqual([
      expect.objectContaining({ secretId, configPath: "token", versionSelector: "latest" }),
    ]);
  });
});

describe("createPluginSecretsHandler fail-closed guards", () => {
  function buildDbTrap() {
    return {
      select: vi.fn(() => {
        throw new Error("db should not be touched");
      }),
    };
  }

  it("requires a server-validated run context before touching the database", async () => {
    const db = buildDbTrap();
    const handler = createPluginSecretsHandler({
      db: db as never,
      pluginDbId: pluginId,
      pluginKey,
      runContextRegistry: createPluginRunContextRegistry({ ttlMs: 60_000, sweepIntervalMs: 60_000 }),
    });

    // No registered dispatch for this runId: the company can never be derived,
    // so the call fails closed before any binding lookup.
    await expect(
      handler.resolve({ secretRef: { type: "secret_ref", secretId: randomUUID() }, runId: randomUUID() }),
    ).rejects.toThrow(/no active dispatch/i);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("fails closed when the host was built without a run-context registry", async () => {
    const db = buildDbTrap();
    const handler = createPluginSecretsHandler({ db: db as never, pluginDbId: pluginId, pluginKey });

    await expect(
      handler.resolve({ secretRef: { type: "secret_ref", secretId: randomUUID() }, runId: randomUUID() }),
    ).rejects.toThrow(/no active dispatch/i);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("rejects malformed refs before provider resolution", async () => {
    const db = buildDbTrap();
    const handler = createPluginSecretsHandler({
      db: db as never,
      pluginDbId: pluginId,
      pluginKey,
      runContextRegistry: createPluginRunContextRegistry({ ttlMs: 60_000, sweepIntervalMs: 60_000 }),
    });

    await expect(
      handler.resolve({ secretRef: "not-a-uuid", runId: randomUUID() }),
    ).rejects.toThrow(/invalid secret reference/i);
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
    const started = await startEmbeddedPostgresTestDatabase("plugin-secrets-handler-shared-vault");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    // `secretService.resolve` awaits `logActivity`, so the audit row is durable by the
    // time a test returns and must be cleared before the `agents` row it references.
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
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
      pluginKey,
      packageName: "@paperclipai/plugin-secrets-test",
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: pluginKey,
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

  /**
   * Register a dispatch run context the way the host does, backed by a real
   * `heartbeat_runs` row so the value-free audit write satisfies its FK.
   */
  async function seedDispatch(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Secrets Test Agent" });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    const registry = createPluginRunContextRegistry({ ttlMs: 60_000, sweepIntervalMs: 60_000 });
    registry.register(pluginId, {
      agentId,
      companyId,
      runId,
      projectId: null,
      toolName: "secrets.test",
      registeredAt: Date.now(),
    });
    return { registry, runId };
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

    const { registry, runId } = await seedDispatch(companyId);
    const handler = createPluginSecretsHandler({ db, pluginDbId: pluginId, pluginKey, runContextRegistry: registry });
    await expect(
      handler.resolve({
        secretRef: { type: "secret_ref", secretId: secret.id, version: "latest" },
        runId,
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

    // The dispatch belongs to company A, so company B's binding is invisible.
    // The fork collapses this to the opaque `not_found` rather than upstream's
    // "not bound" so a worker cannot use the error as an existence oracle.
    const { registry, runId } = await seedDispatch(companyA);
    const handler = createPluginSecretsHandler({ db, pluginDbId: pluginId, pluginKey, runContextRegistry: registry });
    await expect(
      handler.resolve({
        secretRef: { type: "secret_ref", secretId: foreignSecret.id, version: "latest" },
        runId,
      }),
    ).rejects.toThrow(/secret not found/i);

    const events = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, foreignSecret.id));
    expect(events).toHaveLength(0);
  });
});
