import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  activityLog,
  agentApiKeys,
  agentKeyRenewalEvents,
  agents,
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import {
  bindingAutoRenewPolicySchema,
  type BindingAutoRenewPolicy,
} from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { createTaskBridgeKeyClassifier } from "../services/task-bridge-keys.js";
import {
  TASK_BRIDGE_RENEWAL_LEAD_MS,
  runTaskBridgeRenewalSweep,
} from "../services/task-bridge-renewal.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping task_bridge renewal tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Synthetic pinned minimum scope (shape-valid UUIDs; nothing here reaches a
 * real instance — these fixtures are per-test random ids).
 */
function pinnedScope(overrides: Record<string, unknown> = {}) {
  return {
    kind: "task_bridge" as const,
    projectId: randomUUID(),
    parentIssueIds: [randomUUID()],
    allowedAssigneeAgentIds: [randomUUID()],
    ...overrides,
  };
}

function policyFixture(scope: ReturnType<typeof pinnedScope>, enabled = true): BindingAutoRenewPolicy {
  return {
    version: 1,
    enabled,
    scope,
    authorizedByUserId: randomUUID(),
    createdAt: new Date().toISOString(),
  };
}

/** Renewal-lead / clamp constants echoed from the service for readability. */
const ONE_HOUR_MS = 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS;
/** Slack for clamp assertions (mint vs assertion clock drift). */
const CLOCK_SLACK_MS = 5_000;

describeEmbeddedPostgres("task_bridge auto-renewer sweep", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-task-bridge-renewal-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("task-bridge-renewal");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    // FK-safe order: audit rows reference agents/companies/secrets, so they
    // go first; agents before companies.
    await db.delete(activityLog);
    await db.delete(agentKeyRenewalEvents);
    await db.delete(agentApiKeys);
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

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Renewal Co ${companyId.slice(0, 6)}`,
      issuePrefix: `R${companyId.slice(0, 6)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Bridge agent ${agentId.slice(0, 6)}`,
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  /**
   * The standard fixture: company + agent + a real task_bridge agent key
   * (minted through the real service so keyHash/expiry behave exactly like
   * production) + a local_encrypted secret whose value is that key's
   * plaintext + an agent binding at env.PAPERCLIP_BRIDGE_API_KEY with an
   * auto-renew policy.
   */
  async function seedPolicyBinding(options: {
    ttlSeconds?: number | null;
    keyScope?: Record<string, unknown>;
    policyScope?: Record<string, unknown>;
    policy?: BindingAutoRenewPolicy | null;
    revoked?: boolean;
    valueOverride?: string;
  } = {}) {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const policyScope = options.policyScope ?? pinnedScope();

    let plaintext: string;
    let keyId: string | null = null;
    let keyExpiresAt: Date | null = null;
    if (options.valueOverride !== undefined) {
      plaintext = options.valueOverride;
    } else {
      const created = await agentService(db).createApiKey(
        agentId,
        "bridge fixture",
        (options.keyScope ?? policyScope) as never,
        { ttlSeconds: options.ttlSeconds === undefined ? 2 * ONE_HOUR_MS / 1000 : options.ttlSeconds },
      );
      plaintext = created.token;
      keyId = created.id;
      keyExpiresAt = created.expiresAt;
      if (options.revoked) {
        await agentService(db).revokeKey(agentId, created.id);
      }
    }

    const secret = await secretService(db).create(companyId, {
      name: `bridge-${randomUUID()}`,
      provider: "local_encrypted",
      value: plaintext,
    });
    const [binding] = await db
      .insert(companySecretBindings)
      .values({
        companyId,
        secretId: secret.id,
        targetType: "agent",
        targetId: agentId,
        configPath: "env.PAPERCLIP_BRIDGE_API_KEY",
        versionSelector: "latest",
      })
      .returning();
    const policy = "policy" in options ? options.policy : policyFixture(policyScope as never);
    if (policy !== null) {
      await db
        .update(companySecretBindings)
        .set({ autoRenewPolicy: policy })
        .where(eq(companySecretBindings.id, binding.id));
    }

    return { companyId, agentId, bindingId: binding.id, secretId: secret.id, keyId, plaintext, keyExpiresAt, policy };
  }

  async function liveKeyRows(agentId: string) {
    return db
      .select({ id: agentApiKeys.id, expiresAt: agentApiKeys.expiresAt, scopeConfig: agentApiKeys.scopeConfig })
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.agentId, agentId), isNull(agentApiKeys.revokedAt)));
  }

  /** Resolve the binding's `latest` exactly the way the consumer does. */
  async function resolveLatest(companyId: string, agentId: string, secretId: string) {
    const resolution = await secretService(db).resolveEnvBindings(
      companyId,
      { PAPERCLIP_BRIDGE_API_KEY: { type: "secret_ref", secretId, version: "latest" } },
      { consumerType: "agent", consumerId: agentId },
    );
    return resolution.env.PAPERCLIP_BRIDGE_API_KEY ?? null;
  }

  async function renewalEvents(bindingId: string) {
    return db
      .select()
      .from(agentKeyRenewalEvents)
      .where(eq(agentKeyRenewalEvents.bindingId, bindingId));
  }

  async function renewalActivityRows(companyId: string) {
    return db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityType, "agent")));
  }

  function sweep(now: Date, deps?: Parameters<typeof runTaskBridgeRenewalSweep>[1]) {
    return runTaskBridgeRenewalSweep(db, { now, ...(deps ?? {}) });
  }

  it("renews a healthy key inside the lead window: clamp preserved, old key revoked, binding resolves to the new key, audit rows written", async () => {
    const fixture = await seedPolicyBinding({ ttlSeconds: 2 * ONE_HOUR_MS / 1000 }); // expires t0+2h
    const now = new Date(Date.now() + 1 * ONE_HOUR_MS); // 1h remaining <= 8h lead

    const result = await sweep(now);

    expect(result).toMatchObject({ policies: 1, renewed: 1, suspended: 0, failed: 0 });

    // Exactly one live key afterwards: the new one.
    const live = await liveKeyRows(fixture.agentId);
    expect(live).toHaveLength(1);
    expect(live[0].id).not.toBe(fixture.keyId);

    // AC-5 clamp: renewed expiry <= now + 24h (+ clock slack), and in the future.
    expect(live[0].expiresAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(live[0].expiresAt!.getTime()).toBeLessThanOrEqual(now.getTime() + TWENTY_FOUR_HOURS_MS + CLOCK_SLACK_MS);

    // THE INVARIANT: binding `latest` resolves to a live key's plaintext.
    const latest = await resolveLatest(fixture.companyId, fixture.agentId, fixture.secretId);
    expect(latest).not.toBeNull();
    expect(latest).not.toBe(fixture.plaintext);

    // The old key is revoked.
    const [oldKey] = await db
      .select({ revokedAt: agentApiKeys.revokedAt })
      .from(agentApiKeys)
      .where(eq(agentApiKeys.id, fixture.keyId!));
    expect(oldKey.revokedAt).not.toBeNull();

    // AC-8 audit completeness: events row + system activity row.
    const events = await renewalEvents(fixture.bindingId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ trigger: "scheduled", outcome: "success", newKeyId: live[0].id, oldKeyId: fixture.keyId });
    expect(events[0].newExpiresAt).toEqual(live[0].expiresAt);
    const activity = await renewalActivityRows(fixture.companyId);
    expect(activity.some((row) => row.action === "agent.key_auto_renewed")).toBe(true);
  });

  it("leaves a healthy key outside the lead window alone (no mint, no events)", async () => {
    const fixture = await seedPolicyBinding({ ttlSeconds: 20 * ONE_HOUR_MS / 1000 }); // 20h remaining
    const result = await sweep(new Date());

    expect(result).toMatchObject({ policies: 1, renewed: 0, recovered: 0, suspended: 0, failed: 0 });
    const live = await liveKeyRows(fixture.agentId);
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(fixture.keyId);
    expect(await renewalEvents(fixture.bindingId)).toHaveLength(0);
  });

  it("AC-3 default-deny: a NULL policy binding never mints, including past expiry", async () => {
    const fixture = await seedPolicyBinding({
      ttlSeconds: 30_000, // expires ~30s after mint
      policy: null, // column stays NULL — the default-deny default
    });
    const now = new Date(Date.now() + ONE_HOUR_MS); // key long expired by sweep time

    const result = await sweep(now);

    expect(result).toMatchObject({ policies: 0, renewed: 0, recovered: 0, suspended: 0, failed: 0 });
    // Nothing minted, nothing revoked, nothing audited for this binding.
    const live = await liveKeyRows(fixture.agentId);
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(fixture.keyId);
    expect(await renewalEvents(fixture.bindingId)).toHaveLength(0);
    expect(await renewalActivityRows(fixture.companyId)).toHaveLength(0);
  });

  it("an opted-out (enabled:false) policy never mints", async () => {
    const fixture = await seedPolicyBinding({
      ttlSeconds: 2 * ONE_HOUR_MS / 1000,
      policy: policyFixture(pinnedScope(), false),
    });
    const result = await sweep(new Date(Date.now() + ONE_HOUR_MS));
    expect(result).toMatchObject({ policies: 1, renewed: 0, suspended: 0, failed: 0 });
    expect(await renewalEvents(fixture.bindingId)).toHaveLength(0);
  });

  it("AC-4 scope pinning: live-key scope drift suspends, never mints, and audits", async () => {
    // Policy pins scope A; the live key was minted with scope B (different project).
    const fixture = await seedPolicyBinding({
      ttlSeconds: 2 * ONE_HOUR_MS / 1000,
      keyScope: pinnedScope(), // B
      policyScope: pinnedScope(), // A (fresh random -> differs from B)
    });

    const result = await sweep(new Date(Date.now() + ONE_HOUR_MS));

    expect(result).toMatchObject({ policies: 1, suspended: 1, renewed: 0, failed: 0 });
    const live = await liveKeyRows(fixture.agentId);
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(fixture.keyId); // untouched
    const events = await renewalEvents(fixture.bindingId);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("suspended:scope_drift");
    const activity = await renewalActivityRows(fixture.companyId);
    expect(activity.some((row) => row.action === "agent.key_auto_renew_suspended")).toBe(true);
  });

  describe("AC-4 canonical scope comparison: effective set, not raw shape", () => {
    // Shared fixture builder: one effective scope expressed in two shapes.
    // Enforcement (scopeAllows) unions singular+plural boundary fields, so the
    // renewer must treat these as identical — a byte comparison suspends on
    // shape variation that changes nothing about what the key can do.
    function equivalentScopePair() {
      const projectId = randomUUID();
      const parentIssueIds = [randomUUID(), randomUUID()];
      const allowedAssigneeAgentIds = [randomUUID()];
      return {
        projectId,
        parentIssueIds,
        allowedAssigneeAgentIds,
        singular: {
          kind: "task_bridge" as const,
          projectId,
          parentIssueIds,
          allowedAssigneeAgentIds,
        },
        plural: {
          kind: "task_bridge" as const,
          projectIds: [projectId],
          parentIssueIds,
          allowedAssigneeAgentIds,
        },
      };
    }

    it("renews a plural projectIds live key against a singular pinned policy (same effective set)", async () => {
      const pair = equivalentScopePair();
      const fixture = await seedPolicyBinding({
        ttlSeconds: 2 * ONE_HOUR_MS / 1000,
        keyScope: pair.plural,
        policyScope: pair.singular,
      });

      const result = await sweep(new Date(Date.now() + ONE_HOUR_MS));

      expect(result).toMatchObject({ policies: 1, renewed: 1, suspended: 0, failed: 0 });
      const live = await liveKeyRows(fixture.agentId);
      expect(live).toHaveLength(1);
      expect(live[0].id).not.toBe(fixture.keyId);
      expect((await renewalEvents(fixture.bindingId))[0]).toMatchObject({ outcome: "success" });
    });

    it("renews a singular live key against a plural projectIds policy (same effective set)", async () => {
      const pair = equivalentScopePair();
      const fixture = await seedPolicyBinding({
        ttlSeconds: 2 * ONE_HOUR_MS / 1000,
        keyScope: pair.singular,
        policyScope: pair.plural,
      });

      const result = await sweep(new Date(Date.now() + ONE_HOUR_MS));

      expect(result).toMatchObject({ policies: 1, renewed: 1, suspended: 0, failed: 0 });
      expect((await liveKeyRows(fixture.agentId))).toHaveLength(1);
    });

    it("array order, duplicate entries, and mixed singular+plural unions carry no boundary", async () => {
      const projectIds = [randomUUID(), randomUUID()];
      const parentIssueIds = [randomUUID(), randomUUID()];
      const allowedAssigneeAgentIds = [randomUUID(), randomUUID()];
      const fixture = await seedPolicyBinding({
        ttlSeconds: 2 * ONE_HOUR_MS / 1000,
        // Live key: plural, shuffled order, duplicated project + assignee.
        keyScope: {
          kind: "task_bridge",
          projectIds: [projectIds[1], projectIds[0], projectIds[1]],
          parentIssueIds: [parentIssueIds[1], parentIssueIds[0]],
          allowedAssigneeAgentIds: [allowedAssigneeAgentIds[0], allowedAssigneeAgentIds[1], allowedAssigneeAgentIds[0]],
        },
        // Policy: the same effective sets, expressed as a singular+plural
        // union in yet another order.
        policyScope: {
          kind: "task_bridge",
          projectId: projectIds[0],
          projectIds: [projectIds[1], projectIds[0]],
          parentIssueIds: [parentIssueIds[0], parentIssueIds[1]],
          allowedAssigneeAgentIds: [allowedAssigneeAgentIds[1], allowedAssigneeAgentIds[0]],
        },
      });

      const result = await sweep(new Date(Date.now() + ONE_HOUR_MS));

      expect(result).toMatchObject({ policies: 1, renewed: 1, suspended: 0, failed: 0 });
    });

    it("a genuinely different effective set still suspends with scope_drift (guards the canonicalization)", async () => {
      // Same shape (both plural), different project — plain drift.
      const parentIssueIds = [randomUUID()];
      const allowedAssigneeAgentIds = [randomUUID()];
      const pluralA = {
        kind: "task_bridge" as const,
        projectIds: [randomUUID()],
        parentIssueIds,
        allowedAssigneeAgentIds,
      };
      const pluralB = {
        kind: "task_bridge" as const,
        projectIds: [randomUUID()],
        parentIssueIds,
        allowedAssigneeAgentIds,
      };
      const fixture = await seedPolicyBinding({
        ttlSeconds: 2 * ONE_HOUR_MS / 1000,
        keyScope: pluralA,
        policyScope: pluralB,
      });

      const result = await sweep(new Date(Date.now() + ONE_HOUR_MS));

      expect(result).toMatchObject({ policies: 1, suspended: 1, renewed: 0, failed: 0 });
      expect((await renewalEvents(fixture.bindingId))[0].outcome).toBe("suspended:scope_drift");
      expect((await liveKeyRows(fixture.agentId))[0].id).toBe(fixture.keyId); // untouched
    });

    it("a BROADER live key (superset of the pinned projects) suspends — the pinned snapshot is exact, not minimum-only", async () => {
      const pair = equivalentScopePair();
      const fixture = await seedPolicyBinding({
        ttlSeconds: 2 * ONE_HOUR_MS / 1000,
        keyScope: { ...pair.plural, projectIds: [...pair.plural.projectIds, randomUUID()] },
        policyScope: pair.singular,
      });

      const result = await sweep(new Date(Date.now() + ONE_HOUR_MS));

      expect(result).toMatchObject({ policies: 1, suspended: 1, renewed: 0, failed: 0 });
      expect((await renewalEvents(fixture.bindingId))[0].outcome).toBe("suspended:scope_drift");
    });

    it("an unknown extra scope field on the live key still suspends (fail-closed against unexplained structure)", async () => {
      const pair = equivalentScopePair();
      const fixture = await seedPolicyBinding({
        ttlSeconds: 2 * ONE_HOUR_MS / 1000,
        // Same effective boundaries, but carrying a field outside the
        // task_bridge vocabulary. The strict-scope classifier refuses it
        // BEFORE the drift check is reached (scope_mismatch); the
        // canonicalizer additionally preserves unknown fields, so the drift
        // path itself stays fail-closed even if classification ever loosens.
        keyScope: { ...pair.plural, "project:sneaky": ["true"] },
        policyScope: pair.singular,
      });

      const result = await sweep(new Date(Date.now() + ONE_HOUR_MS));

      expect(result).toMatchObject({ policies: 1, suspended: 1, renewed: 0, failed: 0 });
      expect((await renewalEvents(fixture.bindingId))[0].outcome).toBe("suspended:scope_mismatch");
    });

    it("reconciliation recognizes a stray minted in the plural-equivalent shape of the pinned singular scope", async () => {
      const pair = equivalentScopePair();
      const fixture = await seedPolicyBinding({
        ttlSeconds: 20 * ONE_HOUR_MS / 1000, // healthy, outside the lead window
        policyScope: pair.singular,
      });
      // A crashed rotation's stray, minted plural — same effective scope.
      const stray = await agentService(db).createApiKey(
        fixture.agentId,
        "stray plural-shaped",
        pair.plural as never,
        { ttlSeconds: 2 * ONE_HOUR_MS / 1000 },
      );

      const result = await sweep(new Date());

      expect(result).toMatchObject({ policies: 1, renewed: 0, reconciled: 1, failed: 0 });
      const live = await liveKeyRows(fixture.agentId);
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(fixture.keyId); // the bound key survived
      expect((await renewalEvents(fixture.bindingId)).some((e) => e.trigger === "reconcile" && e.oldKeyId === stray.id)).toBe(true);
    });
  });

  it("AC-6 operator revocation wins: a revoked bound key suspends the policy instead of re-minting", async () => {
    const fixture = await seedPolicyBinding({ ttlSeconds: 2 * ONE_HOUR_MS / 1000, revoked: true });

    const result = await sweep(new Date(Date.now() + ONE_HOUR_MS));

    expect(result).toMatchObject({ policies: 1, suspended: 1, renewed: 0, recovered: 0, failed: 0 });
    const live = await liveKeyRows(fixture.agentId);
    expect(live).toHaveLength(0); // nothing re-minted; the operator's revocation stands
    const events = await renewalEvents(fixture.bindingId);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("suspended:key_revoked_by_operator");
  });

  it("recovery: a naturally expired key is re-minted from the pinned snapshot", async () => {
    const fixture = await seedPolicyBinding({ ttlSeconds: 30 }); // expires 30s after mint
    const now = new Date(Date.now() + ONE_HOUR_MS); // long expired by sweep time

    const result = await sweep(now);

    expect(result).toMatchObject({ policies: 1, recovered: 1, renewed: 0, suspended: 0, failed: 0 });
    const latest = await resolveLatest(fixture.companyId, fixture.agentId, fixture.secretId);
    expect(latest).not.toBe(fixture.plaintext);
    const events = await renewalEvents(fixture.bindingId);
    expect(events[0]).toMatchObject({ trigger: "recovery", outcome: "success" });

    // The expired old key is inert (auth-time expiry backstop) but still
    // unrevoked; the invariant is satisfied by the NEW bound key. The next
    // sweep's janitor revokes the lingering expired key — convergence to
    // exactly one live key.
    let live = await liveKeyRows(fixture.agentId);
    expect(live).toHaveLength(2);
    const newKey = live.find((row) => row.id !== fixture.keyId)!;
    // Clamp holds on the recovery path too.
    expect(newKey.expiresAt!.getTime()).toBeLessThanOrEqual(now.getTime() + TWENTY_FOUR_HOURS_MS + CLOCK_SLACK_MS);

    const second = await sweep(now);
    expect(second.reconciled).toBeGreaterThanOrEqual(1);
    live = await liveKeyRows(fixture.agentId);
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(newKey.id);
  });

  it("recovery: a bound value with no key row (missing) re-mints", async () => {
    const fixture = await seedPolicyBinding({ valueOverride: "pat-synthetic-value-without-any-key-row" });
    const result = await sweep(new Date(Date.now() + ONE_HOUR_MS));
    expect(result).toMatchObject({ policies: 1, recovered: 1, suspended: 0, failed: 0 });
    expect(await liveKeyRows(fixture.agentId)).toHaveLength(1);
  });

  describe("AC-2 ordering/invariant: fault injection at each rotation stage", () => {
    it("fail at mint: nothing changes, old key stays live and bound, failed:mint audited", async () => {
      const fixture = await seedPolicyBinding({ ttlSeconds: 2 * ONE_HOUR_MS / 1000 });
      const now = new Date(Date.now() + ONE_HOUR_MS);

      const result = await sweep(now, {
        deps: {
          createKey: async () => {
            throw new Error("injected mint failure");
          },
        },
      });

      expect(result).toMatchObject({ policies: 1, failed: 1, renewed: 0 });
      // Old key still the only live key, still what `latest` resolves to.
      const live = await liveKeyRows(fixture.agentId);
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(fixture.keyId);
      expect(await resolveLatest(fixture.companyId, fixture.agentId, fixture.secretId)).toBe(fixture.plaintext);
      const events = await renewalEvents(fixture.bindingId);
      expect(events).toHaveLength(1);
      expect(events[0].outcome).toBe("failed:mint");
      const activity = await renewalActivityRows(fixture.companyId);
      expect(activity.some((row) => row.action === "agent.key_auto_renewal_failed")).toBe(true);
    });

    it("fail at append: the stray minted key is revoked, the old key stays live and bound; the next sweep converges", async () => {
      const fixture = await seedPolicyBinding({ ttlSeconds: 2 * ONE_HOUR_MS / 1000 });
      const now = new Date(Date.now() + ONE_HOUR_MS);

      const failed = await sweep(now, {
        deps: {
          rotateSecret: async () => {
            throw new Error("injected append failure");
          },
        },
      });
      expect(failed).toMatchObject({ policies: 1, failed: 1 });

      // The just-minted stray was revoked by the handler; exactly one live key (the old one) remains bound.
      expect(await liveKeyRows(fixture.agentId)).toHaveLength(1);
      expect(await resolveLatest(fixture.companyId, fixture.agentId, fixture.secretId)).toBe(fixture.plaintext);
      const events1 = await renewalEvents(fixture.bindingId);
      expect(events1.some((e) => e.outcome === "failed:append_version")).toBe(true);

      // Next sweep, no injection: converges to a successful renewal.
      const converged = await sweep(now);
      expect(converged).toMatchObject({ policies: 1, renewed: 1, failed: 0 });
      const live = await liveKeyRows(fixture.agentId);
      expect(live).toHaveLength(1);
      expect(live[0].id).not.toBe(fixture.keyId);
      expect(await resolveLatest(fixture.companyId, fixture.agentId, fixture.secretId)).not.toBe(fixture.plaintext);
    });

    it("fail at verify: the new version rolls back, latest resolves to the OLD key again, old key stays live", async () => {
      const fixture = await seedPolicyBinding({ ttlSeconds: 2 * ONE_HOUR_MS / 1000 });
      const now = new Date(Date.now() + ONE_HOUR_MS);

      // Call 1 = the sweep's classification of the current value (must pass);
      // call 2 = step-3 verification of the rotated value (injected to fail).
      let classifyCalls = 0;
      const result = await sweep(now, {
        deps: {
          classify: async (companyId: string, resolvedKey: string) => {
            classifyCalls += 1;
            if (classifyCalls >= 2) {
              return { ok: false, code: "key_expired" as const };
            }
            return createTaskBridgeKeyClassifier(db, companyId)(resolvedKey);
          },
        },
      });

      expect(result).toMatchObject({ policies: 1, failed: 1, renewed: 0 });
      // Rollback restored `latest` to the previous version -> OLD plaintext.
      expect(await resolveLatest(fixture.companyId, fixture.agentId, fixture.secretId)).toBe(fixture.plaintext);
      // Old key still live; the rolled-back new key was revoked.
      const live = await liveKeyRows(fixture.agentId);
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(fixture.keyId);
      const events = await renewalEvents(fixture.bindingId);
      expect(events.some((e) => e.outcome === "failed:verify" && e.trigger === "rollback")).toBe(true);
    });

    it("fail at revoke-old: binding is already healthy on the new key; the next sweep reconciles the lingering old key", async () => {
      const fixture = await seedPolicyBinding({ ttlSeconds: 2 * ONE_HOUR_MS / 1000 });
      const now = new Date(Date.now() + ONE_HOUR_MS);
      const agents = agentService(db);

      const result = await sweep(now, {
        deps: {
          revokeKey: async (agentId: string, keyId: string) => {
            if (keyId === fixture.keyId) throw new Error("injected revoke failure");
            return agents.revokeKey(agentId, keyId);
          },
        },
      });
      expect(result).toMatchObject({ policies: 1, failed: 1 });

      // The invariant held anyway: latest resolves to the NEW live key.
      const latest = await resolveLatest(fixture.companyId, fixture.agentId, fixture.secretId);
      expect(latest).not.toBe(fixture.plaintext);
      let live = await liveKeyRows(fixture.agentId);
      expect(live).toHaveLength(2); // new (bound) + old (lingering, unreferenced)
      expect(eventsWith(await renewalEvents(fixture.bindingId), "failed:revoke_old")).toHaveLength(1);

      // Next sweep: the new key is healthy and outside the lead window ->
      // reconciliation revokes the lingering old key. Exactly one live key.
      const converged = await sweep(now);
      expect(converged.reconciled).toBeGreaterThanOrEqual(1);
      live = await liveKeyRows(fixture.agentId);
      expect(live).toHaveLength(1);
      const events = await renewalEvents(fixture.bindingId);
      expect(events.some((e) => e.trigger === "reconcile" && e.oldKeyId === fixture.keyId)).toBe(true);

      function eventsWith(rows: { outcome: string }[], outcome: string) {
        return rows.filter((row) => row.outcome === outcome);
      }
    });

    it("crash between mint and append (stray live key): the next sweep reconciles it without touching the bound key", async () => {
      const fixture = await seedPolicyBinding({ ttlSeconds: 20 * ONE_HOUR_MS / 1000 }); // healthy, outside lead
      // Simulate a process crash right after minting: a live key with the
      // pinned scope that no secret version references.
      const stray = await agentService(db).createApiKey(
        fixture.agentId,
        "stray from crashed rotation",
        fixture.policy.scope as never,
        { ttlSeconds: 2 * ONE_HOUR_MS / 1000 },
      );

      const result = await sweep(new Date());

      expect(result).toMatchObject({ policies: 1, renewed: 0, reconciled: 1, failed: 0 });
      const live = await liveKeyRows(fixture.agentId);
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(fixture.keyId); // the bound key survived
      expect(await resolveLatest(fixture.companyId, fixture.agentId, fixture.secretId)).toBe(fixture.plaintext);
      const events = await renewalEvents(fixture.bindingId);
      expect(events.some((e) => e.trigger === "reconcile" && e.oldKeyId === stray.id)).toBe(true);
    });
  });

  it("a corrupt/drifted policy row suspends as policy_invalid (fail-closed) instead of being trusted", async () => {
    const fixture = await seedPolicyBinding({ ttlSeconds: 2 * ONE_HOUR_MS / 1000 });
    // Drift the stored policy into an invalid shape (hostile fat TTL field).
    await db
      .update(companySecretBindings)
      .set({
        autoRenewPolicy: {
          ...fixture.policy,
          scope: { ...fixture.policy.scope, ttlSeconds: 999_999_999 },
        } as never,
      })
      .where(eq(companySecretBindings.id, fixture.bindingId));

    const result = await sweep(new Date(Date.now() + ONE_HOUR_MS));

    expect(result).toMatchObject({ policies: 1, suspended: 1, renewed: 0, failed: 0 });
    expect(await liveKeyRows(fixture.agentId)).toHaveLength(1);
    const events = await renewalEvents(fixture.bindingId);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("suspended:policy_invalid");
  });

  it("secretService.setBindingAutoRenewPolicy: stores, clears, and refuses non-bridge binding shapes", async () => {
    const fixture = await seedPolicyBinding({ policy: null });
    const svc = secretService(db);
    const policy = policyFixture(pinnedScope());

    await svc.setBindingAutoRenewPolicy({ companyId: fixture.companyId, bindingId: fixture.bindingId, policy });
    let [row] = await db.select().from(companySecretBindings).where(eq(companySecretBindings.id, fixture.bindingId));
    expect(row.autoRenewPolicy).toEqual(policy);

    // Clearing returns to default-deny.
    await svc.setBindingAutoRenewPolicy({ companyId: fixture.companyId, bindingId: fixture.bindingId, policy: null });
    [row] = await db.select().from(companySecretBindings).where(eq(companySecretBindings.id, fixture.bindingId));
    expect(row.autoRenewPolicy).toBeNull();

    // A binding at any other config path is refused.
    const [other] = await db
      .insert(companySecretBindings)
      .values({
        companyId: fixture.companyId,
        secretId: fixture.secretId,
        targetType: "agent",
        targetId: fixture.agentId,
        configPath: "env.SOME_OTHER_KEY",
        versionSelector: "latest",
      })
      .returning();
    await expect(
      svc.setBindingAutoRenewPolicy({ companyId: fixture.companyId, bindingId: other.id, policy }),
    ).rejects.toThrow(/env\.PAPERCLIP_BRIDGE_API_KEY/i);
  });

  it("secretService.listRenewalEvents: returns the per-secret audit trail, newest first, without key material", async () => {
    const fixture = await seedPolicyBinding({ ttlSeconds: 30 }); // expired by sweep time -> recovery
    await sweep(new Date(Date.now() + ONE_HOUR_MS));

    const events = await secretService(db).listRenewalEvents(fixture.companyId, fixture.secretId);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toMatchObject({ bindingId: fixture.bindingId, agentId: fixture.agentId });
    // No plaintext or key hashes anywhere in the serialized audit trail.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(fixture.plaintext);
  });
});

describe("bindingAutoRenewPolicySchema (pinning gate)", () => {
  const validScope = pinnedScope();

  it("accepts a fully pinned task_bridge snapshot", () => {
    expect(bindingAutoRenewPolicySchema.safeParse(policyFixture(validScope)).success).toBe(true);
  });

  it("refuses an unpinned snapshot (no parentIssueIds / allowedAssigneeAgentIds)", () => {
    const unpinned = { ...validScope, parentIssueIds: undefined, allowedAssigneeAgentIds: undefined };
    const result = bindingAutoRenewPolicySchema.safeParse(policyFixture(unpinned));
    expect(result.success).toBe(false);
  });

  it("refuses a non-task_bridge scope", () => {
    const result = bindingAutoRenewPolicySchema.safeParse(
      policyFixture({ ...validScope, kind: "standard" } as never),
    );
    expect(result.success).toBe(false);
  });

  it("refuses a hostile fat-TTL field injected into the snapshot (strict schema)", () => {
    const result = bindingAutoRenewPolicySchema.safeParse(
      policyFixture({ ...validScope, ttlSeconds: 999_999_999 } as never),
    );
    expect(result.success).toBe(false);
  });

  it("accepts a plural projectIds boundary with no singular projectId (effective-set pinning)", () => {
    const plural = {
      ...validScope,
      projectId: undefined,
      projectIds: [validScope.projectId as string],
    };
    expect(bindingAutoRenewPolicySchema.safeParse(policyFixture(plural)).success).toBe(true);
  });

  it("refuses a snapshot with neither a singular nor a plural project boundary", () => {
    const noProject = { ...validScope, projectId: undefined };
    expect(bindingAutoRenewPolicySchema.safeParse(policyFixture(noProject)).success).toBe(false);
  });

  it("refuses an empty projectIds array as the only project boundary", () => {
    const empty = { ...validScope, projectId: undefined, projectIds: [] };
    expect(bindingAutoRenewPolicySchema.safeParse(policyFixture(empty)).success).toBe(false);
  });
});

describe("AC-7 module boundary: the renewer registers no route and is imported only by the scheduler entry point", () => {
  function listSourceFiles(dir: string): string[] {
    const entries = readdirSync(dir);
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        files.push(...listSourceFiles(full));
      } else if (entry.endsWith(".ts")) {
        files.push(full);
      }
    }
    return files;
  }

  it("no route file imports the renewal module, and server/src/index.ts is its only importer", () => {
    const serverSrc = fileURLToPath(new URL("../", import.meta.url));
    const importers: string[] = [];
    for (const file of listSourceFiles(serverSrc)) {
      const normalized = file.split(path.sep).join("/");
      if (normalized.includes("/__tests__/")) continue;
      const source = readFileSync(file, "utf8");
      // Match actual import specifiers (`.../task-bridge-renewal.js`), not
      // prose mentions of the module name in comments.
      if (/task-bridge-renewal\.js/.test(source) && !normalized.endsWith("/services/task-bridge-renewal.ts")) {
        importers.push(normalized);
      }
    }
    expect(importers).toEqual([expect.stringMatching(/\/src\/index\.ts$/)]);
  });
});
