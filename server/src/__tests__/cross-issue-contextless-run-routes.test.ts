import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { CROSS_ISSUE_INFLUENCE_LIMIT } from "../services/cross-issue-influence-limit.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres contextless-run guard route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Route-level proof for the cross-issue influence guard’s contextless-run
 * semantics, against the real routes, real services, and a real database.
 *
 * Timer, manual/on-demand, and retry wakes enrich the run snapshot only when
 * the wake payload carries the issue, so a perfectly valid run row can have no
 * source issue. The guard used to fail every guarded issue write from such
 * runs closed (Copperworks COP-450), even on the agent’s own assigned
 * issues. These tests pin the fix at the HTTP boundary: a contextless run
 * writes under the shared per-run cap, genuine attribution failures still fail
 * closed, and issue-scoped runs keep their source-issue exemption. Because the
 * assertions go through the routes, they fail both if the guard throws again
 * and if a route stops calling the guard (the cap case would silently pass).
 */
describeEmbeddedPostgres("cross-issue influence guard: contextless runs (routes + postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-contextless-guard-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  // An allowed write can wake the assignee, and that wake can land a heartbeat
  // run row just after the response, so teardown is best-effort in foreign-key
  // order. Every assertion below is scoped to its own seeded company instead of
  // relying on an empty database.
  afterEach(async () => {
    const cleanups = [
      () => db.delete(issueThreadInteractions),
      () => db.delete(issueComments),
      () => db.delete(activityLog),
      () => db.delete(agentWakeupRequests),
      () => db.delete(heartbeatRuns),
      () => db.delete(heartbeatRuns),
      () => db.delete(issues),
      () => db.delete(companyMemberships),
      () => db.delete(agents),
      () => db.delete(companies),
    ];
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  });

  afterAll(async () => {
    // End the postgres.js pool before stopping the embedded server (see the
    // interaction-resolution cap suite for the socket-teardown rationale).
    await db.$client.end();
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  function agentActor(companyId: string, agentId: string, runId: string) {
    // Mirrors the actor the real agent-JWT middleware derives for a run-keyed
    // agent request (the Copperworks report’s request shape).
    return { type: "agent", source: "agent_jwt", companyId, agentId, runId };
  }

  let issueSequence = 0;

  // Issue prefixes are globally unique across companies, and best-effort
  // teardown can leave a company row behind when a wake lands just after the
  // deletes, so every company gets a fresh random prefix instead of a fixed
  // per-file one.
  function uniqueIssuePrefix() {
    return `X${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
  }

  async function seedCompanyAndAgent() {
    const prefix = uniqueIssuePrefix();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = `${randomUUID().slice(0, 8)}-operator`;
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${prefix} Coder`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });
    return { companyId, agentId, userId, prefix };
  }

  async function seedIssue(companyId: string, prefix: string, assigneeAgentId: string) {
    const issueId = randomUUID();
    issueSequence += 1;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${prefix}-${issueSequence}`,
      title: `${prefix} issue ${issueSequence}`,
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
    });
    return issueId;
  }

  /** A run whose snapshot has no issueId/taskId: the timer/manual wake shape. */
  async function seedContextlessRun(
    companyId: string,
    agentId: string,
    contextSnapshot: Record<string, unknown> = { wakeSource: "on_demand", wakeTriggerDetail: "manual" },
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      contextSnapshot,
    });
    return runId;
  }

  async function countInfluenceRows(companyId: string, runId: string, action: string) {
    const rows = await db
      .select({ id: activityLog.id, details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.runId, runId),
        eq(activityLog.action, action),
      ));
    return rows;
  }

  it("lets a contextless run comment on an issue it may write (201, not the context 403)", async () => {
    const { companyId, agentId, prefix } = await seedCompanyAndAgent();
    const issueId = await seedIssue(companyId, prefix, agentId);
    const runId = await seedContextlessRun(companyId, agentId);

    const res = await request(app(agentActor(companyId, agentId, runId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Manual wake progress note on the assigned issue." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain("cross_issue_influence_run_context_required");

    const observations = await countInfluenceRows(companyId, runId, "issue.cross_issue_influence_observed");
    expect(observations).toHaveLength(1);
    expect((observations[0].details as Record<string, unknown>).sourceIssueId ?? null).toBeNull();
  }, 30_000);

  it("lets a contextless run PATCH an issue it may write (200, not the context 403)", async () => {
    const { companyId, agentId, prefix } = await seedCompanyAndAgent();
    const issueId = await seedIssue(companyId, prefix, agentId);
    const runId = await seedContextlessRun(companyId, agentId);

    const res = await request(app(agentActor(companyId, agentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Contextless run retitled the assigned issue" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("cross_issue_influence_run_context_required");
    expect(await countInfluenceRows(companyId, runId, "issue.cross_issue_influence_observed")).toHaveLength(1);
  }, 30_000);

  it("lets a contextless run resolve an issue-thread interaction without the context denial", async () => {
    const { companyId, agentId, prefix } = await seedCompanyAndAgent();
    const issueId = await seedIssue(companyId, prefix, agentId);
    const runId = await seedContextlessRun(companyId, agentId);
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone",
      payload: { version: 1, prompt: "Proceed?" } as never,
    }).returning({ id: issueThreadInteractions.id });

    const res = await request(app(agentActor(companyId, agentId, runId)))
      .post(`/api/issues/${issueId}/interactions/${interaction.id}/reject`)
      .send({ reason: "Not now" });

    expect(res.status, JSON.stringify(res.body)).not.toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("cross_issue_influence_run_context_required");
    const [row] = await db
      .select({ status: issueThreadInteractions.status })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interaction.id));
    expect(row?.status).not.toBe("pending");
  }, 30_000);

  it("still fails closed for genuine attribution failures", async () => {
    const { companyId, agentId, prefix } = await seedCompanyAndAgent();
    const issueId = await seedIssue(companyId, prefix, agentId);

    // (a) malformed run id, (b) run row missing, (c) run row owned by another
    // agent, (d) run row that exists only under another company: all four are
    // attribution failures and must keep the shared 403 denial. (c) is the
    // stolen-run shape: the actor names a real run row that belongs to a
    // different agent in the same company.
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "CTX Other",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const foreignCompanyId = randomUUID();
    await db.insert(companies).values({
      id: foreignCompanyId,
      name: "Foreign Company",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    const foreignRunId = await seedContextlessRun(foreignCompanyId, agentId);
    const ownedRunId = await seedContextlessRun(companyId, agentId);

    const cases: Array<[string, Record<string, unknown>]> = [
      ["malformed run id", agentActor(companyId, agentId, "attacker-controlled-run-id")],
      ["missing run row", agentActor(companyId, agentId, randomUUID())],
      ["run row owned by another agent", agentActor(companyId, otherAgentId, ownedRunId)],
      ["run row under another company", agentActor(companyId, agentId, foreignRunId)],
    ];
    for (const [label, actor] of cases) {
      const res = await request(app(actor))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: `Should be rejected: ${label}` });
      expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body.details).toMatchObject({ code: "cross_issue_influence_run_context_required" });
    }

    const comments = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments).toEqual([]);
  }, 30_000);

  it("rejects the 21st contextless-run write with the cap error through the route", async () => {
    const { companyId, agentId, prefix } = await seedCompanyAndAgent();
    const issueId = await seedIssue(companyId, prefix, agentId);
    const runId = await seedContextlessRun(companyId, agentId);
    await db.insert(activityLog).values(Array.from({ length: CROSS_ISSUE_INFLUENCE_LIMIT }, () => ({
      companyId,
      actorType: "agent" as const,
      actorId: agentId,
      agentId,
      runId,
      action: "issue.cross_issue_influence_observed",
      entityType: "issue",
      entityId: issueId,
    })));

    // If a route stopped calling the guard, this write would silently succeed
    // instead of being counted and capped — so this 429 is the central-capture
    // proof that the route graph still enforces the backstop.
    const res = await request(app(agentActor(companyId, agentId, runId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "One write too many for this run." });

    expect(res.status, JSON.stringify(res.body)).toBe(429);
    expect(res.body.details).toMatchObject({
      code: "cross_issue_influence_cap_exceeded",
      cap: CROSS_ISSUE_INFLUENCE_LIMIT,
      count: CROSS_ISSUE_INFLUENCE_LIMIT + 1,
      mode: "enforce",
    });
  }, 30_000);

  it("keeps the source-issue exemption for issue-scoped runs (no regression)", async () => {
    const { companyId, agentId, prefix } = await seedCompanyAndAgent();
    const issueId = await seedIssue(companyId, prefix, agentId);
    const runId = await seedContextlessRun(companyId, agentId, {
      issueId,
      taskId: issueId,
      wakeReason: "issue_assigned",
    });

    const res = await request(app(agentActor(companyId, agentId, runId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Source-issue writes stay exempt from the cap." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await countInfluenceRows(companyId, runId, "issue.cross_issue_influence_observed")).toHaveLength(0);
    expect(await countInfluenceRows(companyId, runId, "issue.cross_issue_influence_cap_rejected")).toHaveLength(0);
  }, 30_000);
});
