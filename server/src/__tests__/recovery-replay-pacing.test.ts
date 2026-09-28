import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres recovery replay pacing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("staggered boot recovery replay", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-replay-pacing-");
    db = createDb(tempDb.connectionString);
  }, 45_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE companies CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  async function seedAssignedTodoIssue(companyId: string, agentId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Boot-time replay fixture",
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
    });
    return issueId;
  }

  it("AC3/AC5: the boot recovery sweep dispatches stranded assignments staggered, not back-to-back", async () => {
    const companyId = await seedCompany();
    const agentCount = 5;
    const agentIds: string[] = [];
    for (let i = 0; i < agentCount; i += 1) {
      const agentId = await seedAgent(companyId, `Replay${i}`);
      agentIds.push(agentId);
      // Each todo issue with an active assignee and no run yet is dispatched by
      // reconcileStrandedAssignedIssues — the boot/recovery drain surface.
      await seedAssignedTodoIssue(companyId, agentId);
    }

    // Real recovery service wiring: the sweep runs against the DB and drives the
    // enqueueWakeup we hand it, paced by the pacer the service installs at
    // construction. Timing is shrunk (60ms floor, deterministic jitter) so the
    // test stays fast; production uses the >= 2s defaults.
    const starts: Array<{ agentId: string; atMs: number }> = [];
    let active = 0;
    let maxActive = 0;
    const recovery = recoveryService(db, {
      // Returns a truthy run row so the sweep accounts the wake as dispatched.
      enqueueWakeup: async (agentId) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        starts.push({ agentId, atMs: Date.now() });
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return { id: randomUUID() } as unknown as typeof heartbeatRuns.$inferSelect;
      },
      hostCeilingValue: 4, // cap must resolve to ceil(4 / 2) = 2
      replayPacing: {
        minDelayMs: 60,
        jitterSpanMs: 10,
        random: () => 0.5, // deterministic jitter: 60 + floor(0.5 * 11) = 65ms
      },
    });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.assignmentDispatched).toBe(agentCount);
    expect(starts).toHaveLength(agentCount);
    // Each stranded issue woke its own assignee, exactly once.
    expect(new Set(starts.map((start) => start.agentId))).toEqual(new Set(agentIds));

    // Central capture: this assertion fails if the pacer wrap is deleted from
    // recoveryService — an unpaced sweep dispatches back-to-back with only DB
    // query latency (single-digit ms here) between starts.
    const deltas: number[] = [];
    for (let i = 1; i < starts.length; i += 1) {
      deltas.push(starts[i].atMs - starts[i - 1].atMs);
    }
    expect(deltas).toHaveLength(agentCount - 1);
    for (const delta of deltas) {
      expect(delta).toBeGreaterThanOrEqual(55); // 60ms floor minus timer slop
      expect(delta).toBeLessThanOrEqual(1000); // sanity: pacing must not stall
    }
    // At most ceil(hostCeiling / 2) replay dispatches in flight at once.
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("AC3: the replay cap derives from the host ceiling when no env override is set", async () => {
    const companyId = await seedCompany();
    const agentIds = [await seedAgent(companyId, "Solo")];
    await seedAssignedTodoIssue(companyId, agentIds[0]);

    const starts: number[] = [];
    const recovery = recoveryService(db, {
      enqueueWakeup: async () => {
        starts.push(Date.now());
        return { id: randomUUID() } as unknown as typeof heartbeatRuns.$inferSelect;
      },
      hostCeilingValue: 3, // default cap ceil(3 / 2) = 2
      replayPacing: { minDelayMs: 20, jitterSpanMs: 0, random: () => 0 },
    });
    const result = await recovery.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(1);
    // An isolated wake starts immediately: the pacer never delays a lone dispatch.
    expect(starts).toHaveLength(1);
    expect(Date.now() - starts[0]).toBeLessThan(5000);
  });
});
