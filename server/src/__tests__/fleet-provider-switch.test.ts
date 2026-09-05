import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService, mergeAdapterConfigPatch } from "../services/agents.ts";
import {
  handleFleetSwitchProvider,
  resolveDispatchingAgentId,
  isExcludedTarget,
  FleetSwitchProviderDeniedError,
  type FleetAgentRow,
} from "../services/fleet-provider-switch.ts";

describe("mergeAdapterConfigPatch (D4 unit)", () => {
  it("preserves env and secret_ref bindings that the patch does not mention", () => {
    const existing = {
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      env: { MY_SECRET: "secret_ref:abc123" },
      secretRefBindings: [{ key: "MY_SECRET", secretId: "sec-1" }],
    };
    const merged = mergeAdapterConfigPatch(existing, { provider: "zai", model: "glm-4.6" });
    expect(merged.env).toEqual(existing.env);
    expect(merged.secretRefBindings).toEqual(existing.secretRefBindings);
    expect(merged.provider).toBe("zai");
    expect(merged.model).toBe("glm-4.6");
  });
});

describe("resolveDispatchingAgentId (D1 unit)", () => {
  it("fails closed when invocationScope is absent", () => {
    expect(resolveDispatchingAgentId({})).toBeNull();
  });

  it("fails closed when invalidInvocationScope is set even if singleInFlightScope carries an id", () => {
    expect(
      resolveDispatchingAgentId({
        invalidInvocationScope: true,
        singleInFlightScope: { agentId: "attacker-controlled" },
      } as any),
    ).toBeNull();
  });

  it("ignores serviceScope entirely", () => {
    expect(
      resolveDispatchingAgentId({ serviceScope: { agentId: "service-scope-agent" } } as any),
    ).toBeNull();
  });

  it("resolves only from a concrete invocationScope.agentId", () => {
    expect(resolveDispatchingAgentId({ invocationScope: { agentId: "antbot-1" } })).toBe("antbot-1");
  });
});

describe("isExcludedTarget (D3 unit)", () => {
  const triggerIds = new Set(["antbot-1", "zbot-1"]);
  it("excludes the triggering agent and its peer trigger by id/name", () => {
    expect(isExcludedTarget({ id: "antbot-1", name: "antbot", companyId: "c1", adapterConfig: {} }, triggerIds)).toBe(true);
    expect(isExcludedTarget({ id: "zbot-1", name: "zbot", companyId: "c1", adapterConfig: {} }, triggerIds)).toBe(true);
  });
  it("excludes claude_local skip-list agents by name+company", () => {
    expect(
      isExcludedTarget(
        { id: "x", name: "CADWorker", companyId: "c2", companyUrlKey: "3d-models", adapterType: "claude_local", adapterConfig: {} },
        triggerIds,
      ),
    ).toBe(true);
    expect(
      isExcludedTarget(
        { id: "y", name: "CEO", companyId: "c3", companyUrlKey: "paperclipai", adapterType: "claude_local", adapterConfig: {} },
        triggerIds,
      ),
    ).toBe(true);
  });
  it("does not exclude an ordinary agent", () => {
    expect(isExcludedTarget({ id: "z", name: "SomeWorker", companyId: "c1", adapterConfig: {} }, triggerIds)).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres fleet-provider-switch tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("handleFleetSwitchProvider (D1/D4 integration)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-fleet-switch-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("fleet-provider-switch");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Fleet Co", urlKey: "fleet-co" } as any);
    const svc = agentService(db);
    const antbot = await svc.create(companyId, {
      name: "antbot",
      role: "general",
      status: "active",
      adapterType: "process",
      adapterConfig: { provider: "openai", model: "gpt-4o" },
    } as any);
    const worker = await svc.create(companyId, {
      name: "OrdinaryWorker",
      role: "general",
      status: "active",
      adapterType: "process",
      adapterConfig: {
        provider: "openai",
        model: "gpt-4o",
        env: { MY_KEY: "secret_ref:zzz" },
        secretRefBindings: [{ key: "MY_KEY", secretId: "sec-9" }],
      },
    } as any);
    return { companyId, antbot, worker };
  }

  function targetsFrom(rows: { id: string; name: string; companyId: string; adapterType: string; adapterConfig: unknown }[]): FleetAgentRow[] {
    return rows.map((r) => ({ id: r.id, name: r.name, companyId: r.companyId, adapterType: r.adapterType, adapterConfig: r.adapterConfig }));
  }

  async function freshTargets(rows: { id: string }[]): Promise<FleetAgentRow[]> {
    const svc = agentService(db);
    const refreshed = await Promise.all(rows.map((r) => svc.getById(r.id)));
    return targetsFrom(refreshed.filter((r): r is NonNullable<typeof r> => r !== null) as any);
  }

  it("D1: rejects when no invocationScope.agentId is bound, even with a plausible payload", async () => {
    const { antbot, worker } = await seed();
    const deps = {
      db,
      listFleetTargets: async () => targetsFrom([antbot!, worker!]),
      auditPoster: { postAudit: async () => {} },
      featureFlag: { isEnabled: () => true },
      firstInvocationGuard: { consumeIsFirstInvocation: async () => false },
    };
    await expect(
      handleFleetSwitchProvider({} as any, { dryRun: false } as any, deps),
    ).rejects.toBeInstanceOf(FleetSwitchProviderDeniedError);

    const reread = await agentService(db).getById(worker!.id);
    expect(reread!.adapterConfig).toEqual(worker!.adapterConfig);
  });

  it("D4: a live switch preserves env/secret_ref bindings byte-for-byte (fails on naive full-replace)", async () => {
    const { antbot, worker } = await seed();
    const audits: any[] = [];
    const deps = {
      db,
      listFleetTargets: async () => freshTargets([antbot!, worker!]),
      auditPoster: { postAudit: async (records: any) => { audits.push(records); } },
      featureFlag: { isEnabled: () => true },
      firstInvocationGuard: { consumeIsFirstInvocation: async () => false },
    };
    const result = await handleFleetSwitchProvider({ invocationScope: { agentId: antbot!.id } } as any, { dryRun: false }, deps);
    expect(result.dryRun).toBe(false);
    const workerRecord = result.results.find((r) => r.agentId === worker!.id);
    expect(workerRecord?.outcome).toBe("CHANGED");

    const reread = await agentService(db).getById(worker!.id);
    const cfg = reread!.adapterConfig as any;
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-opus-4-6");
    // The regression this proves: a naive `{ provider, model }` full-replace
    // write would drop these two keys entirely.
    expect(cfg.env).toEqual({ MY_KEY: { type: "plain", value: "secret_ref:zzz" } });
    expect(cfg.secretRefBindings).toEqual([{ key: "MY_KEY", secretId: "sec-9" }]);
    expect(audits.length).toBe(1);

    // Second invocation is a full no-op (D6.3 idempotency).
    const second = await handleFleetSwitchProvider({ invocationScope: { agentId: antbot!.id } } as any, { dryRun: false }, deps);
    for (const r of second.results) {
      if (r.agentId === worker!.id) expect(r.outcome).toBe("NO_OP");
    }
  });

  it("D3: never switches the trigger agent itself or its peer trigger", async () => {
    const { companyId, antbot, worker } = await seed();
    const svc = agentService(db);
    const zbot = await svc.create(companyId, {
      name: "zbot",
      role: "general",
      status: "active",
      adapterType: "process",
      adapterConfig: { provider: "openai", model: "gpt-4o" },
    } as any);
    const deps = {
      db,
      listFleetTargets: async () => targetsFrom([antbot!, zbot!, worker!]),
      auditPoster: { postAudit: async () => {} },
      featureFlag: { isEnabled: () => true },
      firstInvocationGuard: { consumeIsFirstInvocation: async () => false },
    };
    const result = await handleFleetSwitchProvider({ invocationScope: { agentId: antbot!.id } } as any, { dryRun: false }, deps);
    const selfRecord = result.results.find((r) => r.agentId === antbot!.id);
    const peerRecord = result.results.find((r) => r.agentId === zbot!.id);
    expect(selfRecord?.outcome).toBe("SKIPPED");
    expect(peerRecord?.outcome).toBe("SKIPPED");
  });

  it("D6.2: kill switch denies the call before touching any agent", async () => {
    const { antbot, worker } = await seed();
    const deps = {
      db,
      listFleetTargets: async () => targetsFrom([antbot!, worker!]),
      auditPoster: { postAudit: async () => {} },
      featureFlag: { isEnabled: () => false },
      firstInvocationGuard: { consumeIsFirstInvocation: async () => false },
    };
    await expect(
      handleFleetSwitchProvider({ invocationScope: { agentId: antbot!.id } } as any, { dryRun: false }, deps),
    ).rejects.toBeInstanceOf(FleetSwitchProviderDeniedError);
  });

  it("D6.5: forces dry-run on the first post-deploy invocation regardless of the dryRun flag", async () => {
    const { antbot, worker } = await seed();
    const deps = {
      db,
      listFleetTargets: async () => targetsFrom([antbot!, worker!]),
      auditPoster: { postAudit: async () => {} },
      featureFlag: { isEnabled: () => true },
      firstInvocationGuard: { consumeIsFirstInvocation: async () => true },
    };
    const result = await handleFleetSwitchProvider({ invocationScope: { agentId: antbot!.id } } as any, { dryRun: false }, deps);
    expect(result.dryRun).toBe(true);
    const reread = await agentService(db).getById(worker!.id);
    expect((reread!.adapterConfig as any).provider).toBe("openai");
  });
});
