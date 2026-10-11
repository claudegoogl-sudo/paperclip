import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  workspaceOperations,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ACTOR_PROVENANCE_PAYLOAD_KEY,
  getActorProvenance,
  runWithActorProvenance,
} from "../middleware/actor-context.ts";

// F3: a heartbeat run enqueued by a board-key request and dispatched later by a timer drain
// (outside the request AsyncLocalStorage scope) must still write actor_source = 'board_key'.
const holder = vi.hoisted(() => ({ db: null as unknown, seen: [] as unknown[] }));
const mockAdapterExecute = vi.hoisted(() => vi.fn());

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { logActivity } from "../services/activity-log.ts";
import { runningProcesses } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const BOARD = { source: "board_key", keyId: randomUUID() };

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat drains restore enqueue-time actor provenance (F3)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-actor-provenance-");
    db = createDb(tempDb.connectionString);
    holder.db = db;
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    const runIds = (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).map((r) => r.id);
    await Promise.all(runIds.map((id) => heartbeat.waitForRunExecutionDrain(id)));
    await new Promise((r) => setTimeout(r, 150));
    runningProcesses.clear();
    mockAdapterExecute.mockReset();
    holder.seen = [];
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function installExecute() {
    mockAdapterExecute.mockImplementation(async (ctx: { runId: string; agent: { companyId: string; id: string } }) => {
      holder.seen.push(getActorProvenance());
      await logActivity(holder.db as ReturnType<typeof createDb>, {
        companyId: ctx.agent.companyId,
        actorType: "agent",
        actorId: ctx.agent.id,
        action: "test.provenance_probe",
        entityType: "heartbeat_run",
        entityId: ctx.runId,
        runId: ctx.runId,
      });
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "ok", provider: "test", model: "m" };
    });
  }

  async function seedAgent(heartbeatCfg: Record<string, unknown> = { enabled: false, wakeOnDemand: true }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Prov Co",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Prov Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: heartbeatCfg },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function probeRows() {
    await waitFor(async () =>
      (await db.select().from(activityLog).where(eq(activityLog.action, "test.provenance_probe"))).length > 0,
    );
    return db
      .select({ source: activityLog.actorSource, keyId: activityLog.actorKeyId })
      .from(activityLog)
      .where(eq(activityLog.action, "test.provenance_probe"));
  }

  it("persists exactly {source, keyId} in the wakeup payload when enqueued inside a request scope", async () => {
    installExecute();
    const { agentId } = await seedAgent();
    await runWithActorProvenance(BOARD, () =>
      heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "test" }),
    );
    const [req] = await db.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests);
    const stored = (req.payload as Record<string, unknown>)[ACTOR_PROVENANCE_PAYLOAD_KEY] as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["keyId", "source"]);
    expect(stored).toEqual(BOARD);
    // Immediate dispatch in the same scope also writes board_key.
    expect(await probeRows()).toEqual([{ source: "board_key", keyId: BOARD.keyId }]);
  });

  it("resumeQueuedRuns (timer drain, no ALS) restores board_key provenance for a request-originated run", async () => {
    installExecute();
    const { companyId, agentId } = await seedAgent();
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "test",
      payload: { [ACTOR_PROVENANCE_PAYLOAD_KEY]: BOARD },
      status: "queued",
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId: wakeId,
      responsibleUserId: "responsible-user",
      contextSnapshot: {},
    });
    expect(getActorProvenance()).toBeNull();
    await heartbeat.resumeQueuedRuns();
    const rows = await probeRows();
    expect(rows).toEqual([{ source: "board_key", keyId: BOARD.keyId }]);
    expect(holder.seen).toEqual([BOARD]);
  });

  it("a run enqueued with no request context writes actor_source NULL (no placeholder) and no payload key", async () => {
    installExecute();
    const { agentId } = await seedAgent();
    await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "test" });
    const rows = await probeRows();
    expect(rows).toEqual([{ source: null, keyId: null }]);
    const [req] = await db.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests);
    expect((req.payload as Record<string, unknown> | null)?.[ACTOR_PROVENANCE_PAYLOAD_KEY]).toBeUndefined();
  });

  it("tickTimers creates timer-originated wakes with no provenance; their runs write NULL", async () => {
    installExecute();
    const { agentId } = await seedAgent({ enabled: true, intervalSec: 60, wakeOnDemand: true });
    const result = await heartbeat.tickTimers(new Date(Date.now() + 3_600_000));
    expect(result.enqueued).toBeGreaterThanOrEqual(1);
    const rows = await probeRows();
    expect(rows.every((r) => r.source === null && r.keyId === null)).toBe(true);
    const reqs = await db.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    for (const r of reqs) {
      expect((r.payload as Record<string, unknown> | null)?.[ACTOR_PROVENANCE_PAYLOAD_KEY]).toBeUndefined();
    }
  });
});
