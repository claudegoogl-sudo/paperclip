import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, activityLog, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("QA PLA-12493 handoff hold repro", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("pla12493-");
    db = createDb(tempDb.connectionString);
  }, 30_000);
  afterEach(async () => {
    await db.execute(sql`drop trigger if exists qa_fail_handoff on issues`);
    await db.delete(issueRecoveryActions); await db.delete(activityLog); await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns); await db.delete(issues); await db.delete(agents); await db.delete(companies);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), reviewerId = randomUUID(), coderId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const prefix = `QA${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "QA Co", issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    const mk = (id: string, name: string, role: string) => ({ id, companyId, name, role, status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(agents).values([mk(reviewerId, "Reviewer", "cto"), mk(coderId, "Coder", "engineer")]);
    await db.insert(issues).values({ id: issueId, companyId, title: "handoff", status: "in_progress", priority: "medium", assigneeAgentId: coderId, issueNumber: 1, identifier: `${prefix}-1` });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: coderId, invocationSource: "assignment", status: "running", runtimeMode: "legacy",
      startedAt: new Date(), contextSnapshot: { issueId } } as never);
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId, executionLockedAt: new Date() }).where(eq(issues.id, issueId));
    return { companyId, reviewerId, coderId, issueId, runId };
  }
  const app = () => { const a = express(); a.use(express.json()); a.use((req, _r, n) => { (req as any).actor = { type: "board", source: "local_implicit" }; n(); }); a.use("/api", issueRoutes(db, {} as any, {})); a.use(errorHandler); return a; };
  const holds = (issueId: string) => db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, issueId), eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"), sql`${issueRecoveryActions.status} in ('active','escalated')`));

  it("A: successful review handoff leaves no hold, reviewer wake delivered", async () => {
    const s = await seed();
    const res = await request(app()).patch(`/api/issues/${s.issueId}`).send({ status: "in_review", assigneeAgentId: s.reviewerId });
    console.log("QA-A status", res.status, JSON.stringify(res.body).slice(0, 300));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.runId));
    console.log("QA-A run", run!.status, run!.errorCode, JSON.stringify(Object.keys((run!.resultJson ?? {}) as object)));
    const h = await holds(s.issueId);
    let wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.reviewerId));
    for (let i = 0; i < 40 && wakes.length === 0; i++) { await new Promise((r) => setTimeout(r, 250)); wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.reviewerId)); }
    const rr = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, s.reviewerId));
    console.log("QA-A reviewer runs", rr.map((x) => x.status), "wake reasons", wakes.map((w) => [w.reason, w.status]));
    const allw = await db.select().from(agentWakeupRequests);
    const acts = await db.select().from(activityLog);
    console.log("QA-A ALL wakes", JSON.stringify(allw.map((w) => [w.agentId === s.reviewerId ? "reviewer" : "coder", w.reason, w.status])), "activity", JSON.stringify(acts.map((a) => a.action)));
    console.log("QA-A holds", h.length, "reviewer wakes", wakes.map((w) => w.status));
    expect(res.status).toBe(200);
    expect(h.length).toBe(0);
  });

  it("A2: reviewer wake delivered (harness may not write wake rows)", async () => {
    const s = await seed();
    await request(app()).patch(`/api/issues/${s.issueId}`).send({ status: "in_review", assigneeAgentId: s.reviewerId });
    await new Promise((r) => setTimeout(r, 3000));
    const wakes = await db.select().from(agentWakeupRequests);
    expect(wakes.length, "wake rows in harness").toBeGreaterThan(0);
  });

  it("B: failed handoff transaction keeps the hold", async () => {
    const s = await seed();
    await db.execute(sql`create or replace function qa_fail() returns trigger as $$ begin if new.assignee_agent_id = '${sql.raw(s.reviewerId)}' then raise exception 'qa forced failure'; end if; return new; end $$ language plpgsql`);
    await db.execute(sql`create trigger qa_fail_handoff before update on issues for each row execute function qa_fail()`);
    const res = await request(app()).patch(`/api/issues/${s.issueId}`).send({ status: "in_review", assigneeAgentId: s.reviewerId });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.runId));
    const [iss] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    const h = await holds(s.issueId);
    console.log("QA-B status", res.status, "run", run!.status, "assignee-unchanged", iss!.assigneeAgentId === s.coderId, "holds", h.length, "marker", JSON.stringify(Object.keys((run!.resultJson ?? {}) as object)));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(iss!.assigneeAgentId).toBe(s.coderId);
    expect(h.length).toBe(1);
  });
});
