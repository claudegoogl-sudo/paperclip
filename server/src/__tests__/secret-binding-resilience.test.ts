import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";
import { agentService } from "../services/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping secret binding resilience tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Regression coverage for the 2026-08-07 outage class: a user agent-PATCH
 * carrying `adapterConfig.env: {}` produced zero secret refs and the
 * delete-and-reinsert binding reconcile wiped every company_secret_bindings
 * row for the agent, bricking all of its spawns (binding_missing) until
 * bindings were manually restored.
 */
describeEmbeddedPostgres("secret binding resilience", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-secrets-resilience-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("secrets-binding-resilience");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(secretAccessEvents);
    await db.delete(activityLog);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agents);
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

  async function seedCompany(name = "Acme") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  async function seedSecret(companyId: string, value = "super-secret-value") {
    const svc = secretService(db);
    return svc.create(companyId, {
      name: `zai-${randomUUID()}`,
      provider: "local_encrypted",
      value,
    });
  }

  async function seedAgent(companyId: string, adapterConfig: Record<string, unknown>) {
    const created = await agentService(db).create(companyId, {
      name: `agent-${randomUUID().slice(0, 8)}`,
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig,
      status: "idle",
    } as Parameters<ReturnType<typeof agentService>["create"]>[1]);
    return created;
  }

  function bindingsFor(agentId: string) {
    return db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, agentId));
  }

  it("(b) syncSecretRefsForTarget with zero refs (non-replaceAll) is a no-op, not a delete-all", async () => {
    const companyId = await seedCompany();
    const secret = await seedSecret(companyId);
    const svc = secretService(db);
    const target = { targetType: "environment" as const, targetId: "env-1" };

    await svc.syncSecretRefsForTarget(companyId, target, [
      { secretId: secret.id, configPath: "env.API_KEY" },
    ]);
    await expect(bindingsFor(target.targetId)).resolves.toHaveLength(1);

    // The historical footgun: an empty ref list used to delete every binding
    // for the target in the non-replaceAll branch.
    await svc.syncSecretRefsForTarget(companyId, target, []);

    const after = await bindingsFor(target.targetId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ configPath: "env.API_KEY", secretId: secret.id });
  });

  it("(a) agent PATCH carrying env:{} preserves bindings and logs secret.binding_wipe_refused", async () => {
    const companyId = await seedCompany();
    const secret = await seedSecret(companyId);
    // The exact incident shape: env with one secret_ref plus one plain value.
    const agent = await seedAgent(companyId, {
      env: {
        AUTH_TOKEN: { type: "secret_ref", secretId: secret.id, version: "latest" },
        BASE_URL: "https://example.internal",
      },
    });
    await expect(bindingsFor(agent.id)).resolves.toHaveLength(1);

    // The offending PATCH from the incident: the form dropped env entirely.
    await agentService(db).update(agent.id, { adapterConfig: { env: {} } });

    const bindings = await bindingsFor(agent.id);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ configPath: "env.AUTH_TOKEN", secretId: secret.id });

    const events = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "secret.binding_wipe_refused"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      companyId,
      agentId: agent.id,
      entityType: "agent",
      entityId: agent.id,
    });
    expect(events[0].details).toMatchObject({ refusedConfigPaths: ["env.AUTH_TOKEN"] });
  });

  it("(a') agent PATCH with env key absent entirely (no env object) also preserves bindings", async () => {
    const companyId = await seedCompany();
    const secret = await seedSecret(companyId);
    const agent = await seedAgent(companyId, {
      env: { AUTH_TOKEN: { type: "secret_ref", secretId: secret.id, version: "latest" } },
    });
    await expect(bindingsFor(agent.id)).resolves.toHaveLength(1);

    await agentService(db).update(agent.id, { adapterConfig: { model: "gpt-4o" } });

    await expect(bindingsFor(agent.id)).resolves.toHaveLength(1);
    const events = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "secret.binding_wipe_refused"));
    expect(events).toHaveLength(1);
    expect(events[0].details).toMatchObject({ refusedConfigPaths: ["env.AUTH_TOKEN"] });
  });

  it("(e) rewriting a secret_ref to a plain value on the same env key still removes the binding", async () => {
    const companyId = await seedCompany();
    const secret = await seedSecret(companyId);
    const agent = await seedAgent(companyId, {
      env: { AUTH_TOKEN: { type: "secret_ref", secretId: secret.id, version: "latest" } },
    });
    await expect(bindingsFor(agent.id)).resolves.toHaveLength(1);

    // Explicit decommission of the key: same key, plain value. This is the
    // documented escape hatch and must keep working.
    await agentService(db).update(agent.id, {
      adapterConfig: { env: { AUTH_TOKEN: "plain-inline-token" } },
    });

    await expect(bindingsFor(agent.id)).resolves.toHaveLength(0);
    const events = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "secret.binding_wipe_refused"));
    expect(events).toHaveLength(0);
  });

  it("(c) resolving an agent config whose binding row was wiped auto-heals the row and succeeds", async () => {
    const companyId = await seedCompany();
    const secret = await seedSecret(companyId, "healed-secret-value");
    const agent = await seedAgent(companyId, {
      env: { AUTH_TOKEN: { type: "secret_ref", secretId: secret.id, version: "latest" } },
    });
    await expect(bindingsFor(agent.id)).resolves.toHaveLength(1);

    // Simulate the historical wipe: the binding row vanishes while the
    // persisted config still references the secret.
    await db.delete(companySecretBindings).where(eq(companySecretBindings.targetId, agent.id));
    await expect(bindingsFor(agent.id)).resolves.toHaveLength(0);

    const svc = secretService(db);
    const { config } = await svc.resolveAdapterConfigForRuntime(
      companyId,
      agent.adapterConfig as Record<string, unknown>,
      { consumerType: "agent", consumerId: agent.id, actorType: "agent", actorId: agent.id },
    );

    expect((config.env as Record<string, string>).AUTH_TOKEN).toBe("healed-secret-value");
    const healed = await bindingsFor(agent.id);
    expect(healed).toHaveLength(1);
    expect(healed[0]).toMatchObject({
      configPath: "env.AUTH_TOKEN",
      secretId: secret.id,
      targetType: "agent",
      targetId: agent.id,
    });
    const events = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "secret.binding_auto_healed"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ companyId, agentId: agent.id });
    // NB: activity details are sanitized — secret ids are redacted by design,
    // so assert the path (not the id) and that no secret value leaked.
    expect(events[0].details).toMatchObject({ configPath: "env.AUTH_TOKEN" });
    expect(JSON.stringify(events[0].details)).not.toContain("healed-secret-value");
  });

  it("(c') auto-heal never mints a binding the persisted config does not reference", async () => {
    const companyId = await seedCompany();
    const secret = await seedSecret(companyId);
    const agent = await seedAgent(companyId, {
      env: { AUTH_TOKEN: { type: "secret_ref", secretId: secret.id, version: "latest" } },
    });
    await db.delete(companySecretBindings).where(eq(companySecretBindings.targetId, agent.id));

    // A resolution for a path the agent's persisted config does not carry.
    const svc = secretService(db);
    await expect(
      svc.resolveAdapterConfigForRuntime(
        companyId,
        { env: { OTHER_TOKEN: { type: "secret_ref", secretId: secret.id, version: "latest" } } },
        { consumerType: "agent", consumerId: agent.id, actorType: "agent", actorId: agent.id },
      ),
    ).rejects.toThrow(/not bound/i);

    await expect(bindingsFor(agent.id)).resolves.toHaveLength(0);
    const healed = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "secret.binding_auto_healed"));
    expect(healed).toHaveLength(0);
  });

  it("(d) a failed resolution records an outcome=failure secret_access_events row", async () => {
    const companyId = await seedCompany();
    const secret = await seedSecret(companyId);
    // Agent B never referenced the secret in persisted config: no heal is
    // possible and the resolution must fail AND leave an audit row.
    const agentB = await seedAgent(companyId, { env: {} });

    const svc = secretService(db);
    await expect(
      svc.resolveAdapterConfigForRuntime(
        companyId,
        { env: { AUTH_TOKEN: { type: "secret_ref", secretId: secret.id, version: "latest" } } },
        { consumerType: "agent", consumerId: agentB.id, actorType: "agent", actorId: agentB.id },
      ),
    ).rejects.toThrow(/not bound/i);

    const failures = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.consumerId, agentB.id));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      outcome: "failure",
      errorCode: "binding_missing",
      companyId,
      secretId: secret.id,
      configPath: "env.AUTH_TOKEN",
    });
  });
});
