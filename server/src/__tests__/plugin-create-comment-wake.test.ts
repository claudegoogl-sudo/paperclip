import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  plugins,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: async () => {}, subscribe: () => {} };
    },
  } as any;
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin createComment wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin issues.createComment wake + identifier resolution", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-createcomment-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentTaskSessions);
    await db.delete(agentRuntimeState);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(plugins);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(name = "Engineer") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(input: {
    companyId: string;
    identifier: string;
    status?: string;
    assigneeAgentId?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      title: `Issue ${input.identifier}`,
      status: input.status ?? "todo",
      priority: "medium",
      identifier: input.identifier,
      assigneeAgentId: input.assigneeAgentId ?? null,
    });
    return id;
  }

  it("resolves the target issue by identifier when no issueId is supplied", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const identifier = `${issuePrefix(companyId)}-7`;
    const issueId = await seedIssue({ companyId, identifier });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.messenger", createEventBusStub());
    const comment = await services.issues.createComment({
      issueId: "",
      body: "relayed from operator",
      companyId,
      identifier,
    } as any);

    expect(comment.issueId).toBe(issueId);
    const [stored] = await db.select().from(issueComments).where(eq(issueComments.id, comment.id));
    expect(stored?.issueId).toBe(issueId);
    expect(stored?.body).toBe("relayed from operator");
  });

  it("attributes the comment to a board user via authorUserId", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const identifier = `${issuePrefix(companyId)}-8`;
    const issueId = await seedIssue({ companyId, identifier });
    const operatorUserId = randomUUID();

    const services = buildHostServices(db, "plugin-record-id", "paperclip.messenger", createEventBusStub());
    const comment = await services.issues.createComment({
      issueId,
      body: "operator says hi",
      companyId,
      authorUserId: operatorUserId,
    } as any);

    const [stored] = await db.select().from(issueComments).where(eq(issueComments.id, comment.id));
    expect(stored?.authorType).toBe("user");
    expect(stored?.authorUserId).toBe(operatorUserId);
    expect(stored?.authorAgentId).toBeNull();
  });

  it("wakes the assignee on an open issue when wakeAssignee is set", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const identifier = `${issuePrefix(companyId)}-9`;
    const issueId = await seedIssue({ companyId, identifier, status: "in_progress", assigneeAgentId: agentId });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.messenger", createEventBusStub());
    await services.issues.createComment({
      issueId,
      body: "please take a look",
      companyId,
      wakeAssignee: true,
    } as any);

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)));
    expect(wakeups.length).toBeGreaterThan(0);
  });

  it("does not wake anyone when wakeAssignee is omitted", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const identifier = `${issuePrefix(companyId)}-10`;
    const issueId = await seedIssue({ companyId, identifier, status: "in_progress", assigneeAgentId: agentId });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.messenger", createEventBusStub());
    await services.issues.createComment({
      issueId,
      body: "silent note",
      companyId,
    } as any);

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakeups.length).toBe(0);
  });

  it("wakes a mentioned agent in addition to the assignee", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("Assignee");
    const mentionedAgentId = randomUUID();
    await db.insert(agents).values({
      id: mentionedAgentId,
      companyId,
      name: "Reviewer",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: {},
      permissions: {},
    });
    const identifier = `${issuePrefix(companyId)}-11`;
    const issueId = await seedIssue({ companyId, identifier, status: "in_progress", assigneeAgentId: agentId });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.messenger", createEventBusStub());
    await services.issues.createComment({
      issueId,
      body: "ping @Reviewer please review",
      companyId,
      wakeAssignee: true,
    } as any);

    const wokenAgentIds = new Set(
      (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).map(
        (row) => row.agentId,
      ),
    );
    expect(wokenAgentIds.has(agentId)).toBe(true);
    expect(wokenAgentIds.has(mentionedAgentId)).toBe(true);
  });

  it("refuses to land a comment on a closed issue when refuseClosed is set", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const identifier = `${issuePrefix(companyId)}-12`;
    const issueId = await seedIssue({ companyId, identifier, status: "done", assigneeAgentId: agentId });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.messenger", createEventBusStub());
    await expect(
      services.issues.createComment({
        issueId,
        body: "this should bounce",
        companyId,
        refuseClosed: true,
        wakeAssignee: true,
      } as any),
    ).rejects.toThrow(/closed/i);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.length).toBe(0);
    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakeups.length).toBe(0);
  });

  it("does not resolve an identifier belonging to another company", async () => {
    const tenantA = await seedCompanyAndAgent();
    const tenantB = await seedCompanyAndAgent();
    const foreignIdentifier = `${issuePrefix(tenantB.companyId)}-13`;
    await seedIssue({ companyId: tenantB.companyId, identifier: foreignIdentifier });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.messenger", createEventBusStub());
    await expect(
      services.issues.createComment({
        issueId: "",
        body: "cross-tenant attempt",
        companyId: tenantA.companyId,
        identifier: foreignIdentifier,
      } as any),
    ).rejects.toThrow(/not found/i);

    const comments = await db.select().from(issueComments);
    expect(comments.length).toBe(0);
  });
});
