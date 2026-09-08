import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres manager release route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// PLA-6547: an agent holding tasks:manage_active_checkouts for the assignee may
// release an in_progress issue whose checkout is held by a terminal-or-missing
// run, through the normal POST /issues/:id/release route. Route tests drive the
// real handler (boundary ordering included) against a real database; the
// service-level block pins the in-transaction staleness re-check for callers
// that reach svc.release with the stale locks still in place.
describeEmbeddedPostgres("manager release of dead-run checkout locks", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-manager-release-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyAgentsAndRuns() {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const managerAgentId = randomUUID();
    const grantlessAgentId = randomUUID();
    const deadRunId = randomUUID();
    const liveRunId = randomUUID();
    const managerRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: assigneeAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        // Legacy agent-creator authority grants tasks:manage_active_checkouts.
        id: managerAgentId,
        companyId,
        name: "TeamLead",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: { canCreateAgents: true },
      },
      {
        id: grantlessAgentId,
        companyId,
        name: "PeerPeer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: deadRunId,
        companyId,
        agentId: assigneeAgentId,
        status: "failed",
        invocationSource: "manual",
        startedAt: new Date(),
        finishedAt: new Date(),
      },
      {
        id: liveRunId,
        companyId,
        agentId: assigneeAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
      {
        id: managerRunId,
        companyId,
        agentId: managerAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);

    return { companyId, assigneeAgentId, managerAgentId, grantlessAgentId, deadRunId, liveRunId, managerRunId };
  }

  async function seedStuckIssue(input: {
    companyId: string;
    assigneeAgentId: string;
    checkoutRunId: string | null;
    status?: "in_progress" | "todo";
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Stuck checkout lock",
      status: input.status ?? "in_progress",
      priority: "high",
      assigneeAgentId: input.assigneeAgentId,
      checkoutRunId: input.checkoutRunId,
      executionRunId: input.checkoutRunId,
      executionAgentNameKey: input.checkoutRunId ? "codexcoder" : null,
      executionLockedAt: input.checkoutRunId ? new Date() : null,
    });
    return issueId;
  }

  // Simulate a run row that vanished without the schema's ON DELETE SET NULL
  // compensating (dangling checkout_run_id/execution_run_id on the issue).
  // The FKs force the row to exist at seed time, so we delete it with the two
  // referencing FK triggers disabled, then restore them. Test-only: requires
  // the embedded cluster's superuser role.
  async function detachRunRowFromIssues(runId: string) {
    // Internal FK triggers are auto-named (RI_ConstraintTrigger_*), so the
    // constraint names cannot be used here. The ON DELETE SET NULL action fires
    // from the constraint trigger on the referenced table (heartbeat_runs), so
    // both sides must be disabled. TRIGGER ALL is symmetric: the test database
    // is created fresh and enables everything by default.
    await db.execute(sql.raw(`ALTER TABLE issues DISABLE TRIGGER ALL`));
    await db.execute(sql.raw(`ALTER TABLE heartbeat_runs DISABLE TRIGGER ALL`));
    try {
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    } finally {
      await db.execute(sql.raw(`ALTER TABLE heartbeat_runs ENABLE TRIGGER ALL`));
      await db.execute(sql.raw(`ALTER TABLE issues ENABLE TRIGGER ALL`));
    }
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  async function readIssueRow(issueId: string) {
    return db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
  }

  it("lets a checkout-management grant holder release an in_progress issue held by a terminal run", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedStuckIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.deadRunId,
    });

    const res = await request(createApp(agentActor(seed.companyId, seed.managerAgentId, seed.managerRunId)))
      .post(`/api/issues/${issueId}/release`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
    });
    await expect(readIssueRow(issueId)).resolves.toEqual({
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
    });

    // The route's pre-auth orphan-clear guard has already detached the terminal
    // run's locks by the time svc.release runs, so prevCheckoutRunId records the
    // (null) run the release transaction itself cleared. The non-null variant is
    // pinned at the service level below.
    const audit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.released")))
      .then((rows) => rows[0] ?? null);
    expect(audit).not.toBeNull();
    expect(audit!.details).toMatchObject({
      managerOverride: true,
      reason: "stale_checkout_run",
      prevCheckoutRunId: null,
      actorAgentId: seed.managerAgentId,
    });
  });

  it("treats a checkout held by a missing run row as releasable by the grant holder", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const orphanRunId = randomUUID();
    // The checkout FK forces the run row to exist at seed time; detachRunRow
    // then deletes it out from under the issue to reach the predicate's
    // missing-run branch.
    await db.insert(heartbeatRuns).values({
      id: orphanRunId,
      companyId: seed.companyId,
      agentId: seed.assigneeAgentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    const issueId = await seedStuckIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: orphanRunId,
    });
    await detachRunRowFromIssues(orphanRunId);

    const res = await request(createApp(agentActor(seed.companyId, seed.managerAgentId, seed.managerRunId)))
      .post(`/api/issues/${issueId}/release`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expect(readIssueRow(issueId)).resolves.toEqual({
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
    });
  });

  it("still returns 409 when the grant holder targets a checkout held by a live run", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedStuckIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.liveRunId,
    });

    const res = await request(createApp(agentActor(seed.companyId, seed.managerAgentId, seed.managerRunId)))
      .post(`/api/issues/${issueId}/release`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toContain("live run");
    await expect(readIssueRow(issueId)).resolves.toEqual({
      status: "in_progress",
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.liveRunId,
      executionRunId: seed.liveRunId,
    });

    const audit = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.released")))
      .then((rows) => rows);
    expect(audit).toEqual([]);
  });

  it("keeps default-deny for an agent without the checkout-management grant (dead holding run)", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedStuckIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.deadRunId,
    });

    const res = await request(createApp(agentActor(seed.companyId, seed.grantlessAgentId, seed.managerRunId)))
      .post(`/api/issues/${issueId}/release`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details?.code).toBe("issue_write_assignee_run_lock");
    // The pre-auth orphan-clear guard detached the terminal run's locks before
    // the boundary denied; the assignee lock and status remain untouched.
    await expect(readIssueRow(issueId)).resolves.toEqual({
      status: "in_progress",
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: null,
      executionRunId: null,
    });
  });

  it("keeps default-deny for an agent without the checkout-management grant (live holding run)", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedStuckIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.liveRunId,
    });

    const res = await request(createApp(agentActor(seed.companyId, seed.grantlessAgentId, seed.managerRunId)))
      .post(`/api/issues/${issueId}/release`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details?.code).toBe("issue_write_assignee_run_lock");
    await expect(readIssueRow(issueId)).resolves.toEqual({
      status: "in_progress",
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.liveRunId,
      executionRunId: seed.liveRunId,
    });
  });

  it("confines the override to in_progress issues", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedStuckIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: null,
      status: "todo",
    });

    const res = await request(createApp(agentActor(seed.companyId, seed.managerAgentId, seed.managerRunId)))
      .post(`/api/issues/${issueId}/release`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toContain("Only assignee can release issue");
    await expect(readIssueRow(issueId)).resolves.toEqual({
      status: "todo",
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: null,
      executionRunId: null,
    });
  });

  describe("issueService.release managerOverride option", () => {
    it("releases and reports the stale run when the locks are still in place", async () => {
      const seed = await seedCompanyAgentsAndRuns();
      const issueId = await seedStuckIssue({
        companyId: seed.companyId,
        assigneeAgentId: seed.assigneeAgentId,
        checkoutRunId: seed.deadRunId,
      });

      const svc = issueService(db);
      const released = await svc.release(issueId, seed.managerAgentId, null, { managerOverride: true });

      expect(released).not.toBeNull();
      expect(released!.managerOverride).toBe(true);
      expect(released!.previous).toEqual({
        assigneeAgentId: seed.assigneeAgentId,
        checkoutRunId: seed.deadRunId,
        executionRunId: seed.deadRunId,
      });
      expect(released!.issue).toMatchObject({
        status: "todo",
        assigneeAgentId: null,
        checkoutRunId: null,
        executionRunId: null,
      });
    });

    it("releases and reports the missing run when the locks are still in place", async () => {
      const seed = await seedCompanyAgentsAndRuns();
      const orphanRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: orphanRunId,
        companyId: seed.companyId,
        agentId: seed.assigneeAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      });
      const issueId = await seedStuckIssue({
        companyId: seed.companyId,
        assigneeAgentId: seed.assigneeAgentId,
        checkoutRunId: orphanRunId,
      });
      await detachRunRowFromIssues(orphanRunId);

      const svc = issueService(db);
      const released = await svc.release(issueId, seed.managerAgentId, null, { managerOverride: true });

      expect(released).not.toBeNull();
      expect(released!.managerOverride).toBe(true);
      expect(released!.previous).toEqual({
        assigneeAgentId: seed.assigneeAgentId,
        checkoutRunId: orphanRunId,
        executionRunId: orphanRunId,
      });
      expect(released!.issue).toMatchObject({
        status: "todo",
        assigneeAgentId: null,
        checkoutRunId: null,
        executionRunId: null,
      });
    });

    it("rejects with 409 when the holding run is still live", async () => {
      const seed = await seedCompanyAgentsAndRuns();
      const issueId = await seedStuckIssue({
        companyId: seed.companyId,
        assigneeAgentId: seed.assigneeAgentId,
        checkoutRunId: seed.liveRunId,
      });

      const svc = issueService(db);
      await expect(
        svc.release(issueId, seed.managerAgentId, null, { managerOverride: true }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(readIssueRow(issueId)).resolves.toEqual({
        status: "in_progress",
        assigneeAgentId: seed.assigneeAgentId,
        checkoutRunId: seed.liveRunId,
        executionRunId: seed.liveRunId,
      });
    });

    it("ignores the option for the assignee themself", async () => {
      const seed = await seedCompanyAgentsAndRuns();
      const issueId = await seedStuckIssue({
        companyId: seed.companyId,
        assigneeAgentId: seed.assigneeAgentId,
        checkoutRunId: null,
      });

      const svc = issueService(db);
      const released = await svc.release(issueId, seed.assigneeAgentId, null, { managerOverride: true });

      expect(released).not.toBeNull();
      expect(released!.managerOverride).toBe(false);
      await expect(readIssueRow(issueId)).resolves.toEqual({
        status: "todo",
        assigneeAgentId: null,
        checkoutRunId: null,
        executionRunId: null,
      });
    });
  });
});
