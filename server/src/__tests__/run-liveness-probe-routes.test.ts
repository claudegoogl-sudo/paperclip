import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// Reaper-safe run liveness: the liveness probe exposed on the run GET and the
// company live-runs list must reflect the SAME in-memory registry the host-slot accounting
// and the reaper use, so an external actor can distinguish a live (possibly provider-stalled)
// run from an orphaned row before treating a silent log tail as death evidence. The
// b67c6c10 incident reap fired on exactly that misread; these tests pin the API contract.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run-liveness-probe tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("run liveness probe routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-liveness-probe-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    if (liveChild) {
      liveChild.kill("SIGKILL");
      liveChild = null;
    }
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let liveChild: ChildProcess | null = null;

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string) {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: false,
      source: "cloud_tenant",
    };
  }

  async function seedCompany(name: string) {
    return db.insert(companies).values({
      name,
      issuePrefix: `LV${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    }).returning().then((rows) => rows[0]!);
  }

  async function seedAgent(companyId: string, name: string, adapterType: string) {
    return db.insert(agents).values({
      companyId,
      name,
      role: "engineer",
      status: "active" as const,
      adapterType,
      adapterConfig: {},
      runtimeConfig: {},
    }).returning().then((rows) => rows[0]!);
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status?: string;
    processPid?: number | null;
    processGroupId?: number | null;
  }) {
    return db.insert(heartbeatRuns).values({
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status ?? "running",
      startedAt: new Date(),
      processPid: input.processPid ?? null,
      processGroupId: input.processGroupId ?? null,
    }).returning().then((rows) => rows[0]!);
  }

  /** A real detached child so `isProcessAlive`/`isProcessGroupAlive` have a live target. */
  function spawnLiveChild() {
    liveChild = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    return liveChild;
  }

  it("reports a registry-tracked running row as live via GET /heartbeat-runs/:runId", async () => {
    const company = await seedCompany("Liveness Co");
    const agent = await seedAgent(company.id, "Local Agent", "claude_local");
    const run = await seedRun({ companyId: company.id, agentId: agent.id });
    runningProcesses.set(run.id, {
      child: {} as ChildProcess,
      graceSec: 10,
      processGroupId: null,
    });

    const res = await request(createApp(boardActor(company.id)))
      .get(`/api/heartbeat-runs/${run.id}`)
      .expect(200);
    // Symptom test: an in-memory handle must read as LIVE, not silence — the exact
    // misread that let the b67c6c10 reap mark a live stalled run as interrupted.
    expect(res.body.livenessProbe).toMatchObject({
      hasInMemoryHandle: true,
      occupiesHostSlot: true,
    });
  });

  it("reports live pid / process group for a tracked local-child adapter run", async () => {
    const company = await seedCompany("Liveness Co");
    const agent = await seedAgent(company.id, "Local Agent", "claude_local");
    const child = spawnLiveChild();
    const pid = child.pid!;
    const run = await seedRun({
      companyId: company.id,
      agentId: agent.id,
      processPid: pid,
      processGroupId: pid, // detached spawn: the child leads its own process group
    });

    const res = await request(createApp(boardActor(company.id)))
      .get(`/api/heartbeat-runs/${run.id}`)
      .expect(200);
    expect(res.body.livenessProbe).toEqual({
      hasInMemoryHandle: false,
      processPidAlive: true,
      processGroupAlive: true,
      occupiesHostSlot: true,
    });
  });

  it("reports an orphaned running row as not occupying a host slot", async () => {
    const company = await seedCompany("Liveness Co");
    // prime_local is a remote/session adapter: pid fields are not tracked for it, so they
    // read null (not "dead"); with no registry handle the row occupies no slot and the
    // reaper is expected to reap it.
    const agent = await seedAgent(company.id, "Remote Agent", "prime_local");
    const run = await seedRun({ companyId: company.id, agentId: agent.id });

    const res = await request(createApp(boardActor(company.id)))
      .get(`/api/heartbeat-runs/${run.id}`)
      .expect(200);
    expect(res.body.livenessProbe).toEqual({
      hasInMemoryHandle: false,
      processPidAlive: null,
      processGroupAlive: null,
      occupiesHostSlot: false,
    });
  });

  it("omits the probe (null) for non-running rows", async () => {
    const company = await seedCompany("Liveness Co");
    const agent = await seedAgent(company.id, "Local Agent", "claude_local");
    const run = await seedRun({ companyId: company.id, agentId: agent.id, status: "succeeded" });

    const res = await request(createApp(boardActor(company.id)))
      .get(`/api/heartbeat-runs/${run.id}`)
      .expect(200);
    expect(res.body.livenessProbe).toBeNull();
  });

  it("does not widen read access: a cross-company board actor cannot read the run", async () => {
    const companyA = await seedCompany("Company A");
    const companyB = await seedCompany("Company B");
    const agentA = await seedAgent(companyA.id, "A Agent", "claude_local");
    const run = await seedRun({ companyId: companyA.id, agentId: agentA.id });
    runningProcesses.set(run.id, {
      child: {} as ChildProcess,
      graceSec: 10,
      processGroupId: null,
    });

    // Anti-enumeration contract: an out-of-company read is a uniform 404 whose body is
    // only the not-found error — the liveness block (and every other field) stays hidden.
    // The invariant pinned here is that the new fields do NOT widen access.
    const res = await request(createApp(boardActor(companyB.id)))
      .get(`/api/heartbeat-runs/${run.id}`)
      .expect(404);
    expect(res.body).toEqual({ error: "Heartbeat run not found" });
    expect(JSON.stringify(res.body)).not.toContain("livenessProbe");
  });

  it("does not widen read access: a cross-company agent actor cannot read the run", async () => {
    const companyA = await seedCompany("Company A");
    const companyB = await seedCompany("Company B");
    const agentA = await seedAgent(companyA.id, "A Agent", "claude_local");
    const agentB = await seedAgent(companyB.id, "B Agent", "claude_local");
    const run = await seedRun({ companyId: companyA.id, agentId: agentA.id });

    // Same anti-enumeration 404 as the board path: `assertCompanyAccess`'s 403 remains the
    // write-path/other-route behavior, while out-of-company reads on this route are a
    // uniform 404 — unchanged pre-existing semantics that the new fields must preserve.
    const res = await request(createApp({
      type: "agent",
      agentId: agentB.id,
      companyId: companyB.id,
      runId: randomUUID(),
      source: "agent_jwt",
    })).get(`/api/heartbeat-runs/${run.id}`).expect(404);
    expect(res.body).toEqual({ error: "Heartbeat run not found" });
    expect(JSON.stringify(res.body)).not.toContain("livenessProbe");
  });

  it("exposes the probe on the company live-runs list", async () => {
    const company = await seedCompany("Liveness Co");
    const localAgent = await seedAgent(company.id, "Local Agent", "claude_local");
    const remoteAgent = await seedAgent(company.id, "Remote Agent", "prime_local");
    const registryRun = await seedRun({ companyId: company.id, agentId: localAgent.id });
    const orphanRun = await seedRun({ companyId: company.id, agentId: remoteAgent.id });
    runningProcesses.set(registryRun.id, {
      child: {} as ChildProcess,
      graceSec: 10,
      processGroupId: null,
    });

    const res = await request(createApp(boardActor(company.id)))
      .get(`/api/companies/${company.id}/live-runs`)
      .expect(200);
    const byId = new Map<string, any>(res.body.map((run: any) => [run.id, run]));
    expect(byId.get(registryRun.id).livenessProbe).toMatchObject({
      hasInMemoryHandle: true,
      occupiesHostSlot: true,
    });
    expect(byId.get(orphanRun.id).livenessProbe).toEqual({
      hasInMemoryHandle: false,
      processPidAlive: null,
      processGroupAlive: null,
      occupiesHostSlot: false,
    });
  });
});
