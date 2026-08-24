import { createHmac, randomUUID } from "node:crypto";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  createDb,
  documentRevisions,
  documents,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issues,
  projectWorkspaces,
  projects,
  routineDocuments,
  routineRuns,
  routines,
  routineTriggers,
  secretAccessEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import * as providerRegistry from "../secrets/provider-registry.ts";
import { routineService } from "../services/routines.ts";
import { secretService } from "../services/secrets.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const originalSecretsProviderEnv = process.env.PAPERCLIP_SECRETS_PROVIDER;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routines service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine service live-execution coalescing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routines-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    if (originalSecretsProviderEnv === undefined) {
      delete process.env.PAPERCLIP_SECRETS_PROVIDER;
    } else {
      process.env.PAPERCLIP_SECRETS_PROVIDER = originalSecretsProviderEnv;
    }
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueInboxArchives);
    await db.delete(issueReadStates);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(routineDocuments);
    await db.delete(documents);
    await db.delete(documentRevisions);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(opts?: {
    wakeup?: (
      agentId: string,
      wakeupOpts: {
        source?: string;
        triggerDetail?: string;
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
      },
    ) => Promise<unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const defaultResponsibleUserId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const wakeups: Array<{
      agentId: string;
      opts: {
        source?: string;
        triggerDetail?: string;
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
      };
    }> = [];

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Routines",
      status: "in_progress",
    });

    const svc = routineService(db, {
      heartbeat: {
        wakeup: async (wakeupAgentId, wakeupOpts) => {
          wakeups.push({ agentId: wakeupAgentId, opts: wakeupOpts });
          if (opts?.wakeup) return opts.wakeup(wakeupAgentId, wakeupOpts);
          const issueId =
            (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
            (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
            null;
          if (!issueId) return null;
          const issue = await db
            .select({ responsibleUserId: issues.responsibleUserId })
            .from(issues)
            .where(eq(issues.id, issueId))
            .then((rows) => rows[0] ?? null);
          const queuedRunId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: queuedRunId,
            companyId,
            agentId: wakeupAgentId,
            invocationSource: wakeupOpts.source ?? "assignment",
            triggerDetail: wakeupOpts.triggerDetail ?? null,
            status: "queued",
            responsibleUserId: issue?.responsibleUserId ?? defaultResponsibleUserId,
            contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
          });
          await db
            .update(issues)
            .set({
              executionRunId: queuedRunId,
              executionLockedAt: new Date(),
            })
            .where(eq(issues.id, issueId));
          return { id: queuedRunId };
        },
      },
    });
    const issueSvc = issueService(db);
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "ascii frog",
        description: "Run the frog routine",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    return { companyId, agentId, issueSvc, projectId, routine, svc, wakeups };
  }

  it("filters listed routines by project", async () => {
    const { companyId, agentId, projectId, routine, svc } = await seedFixture();
    const otherProjectId = randomUUID();
    await db.insert(projects).values({
      id: otherProjectId,
      companyId,
      name: "Other routines",
      status: "in_progress",
    });
    const otherRoutine = await svc.create(
      companyId,
      {
        projectId: otherProjectId,
        goalId: null,
        parentIssueId: null,
        title: "other project routine",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const projectRoutines = await svc.list(companyId, { projectId });
    const allRoutines = await svc.list(companyId);

    expect(projectRoutines.map((entry) => entry.id)).toEqual([routine.id]);
    expect(allRoutines.map((entry) => entry.id)).toEqual(expect.arrayContaining([routine.id, otherRoutine.id]));
  });

  it("creates a fresh execution issue when the previous routine issue is open but idle", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    const previousRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "todo",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
      completedAt: new Date("2026-03-20T12:00:00.000Z"),
    });

    const detailBefore = await svc.getDetail(routine.id);
    expect(detailBefore?.activeIssue).toBeNull();

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).not.toBe(previousIssue.id);

    const routineIssues = await db
      .select({
        id: issues.id,
        originRunId: issues.originRunId,
      })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(2);
    expect(routineIssues.map((issue) => issue.id)).toContain(previousIssue.id);
    expect(routineIssues.map((issue) => issue.id)).toContain(run.linkedIssueId);
  });

  it("creates draft routines without a project or default assignee", async () => {
    const { companyId, svc } = await seedFixture();

    const routine = await svc.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "draft routine",
        description: "No defaults yet",
        assigneeAgentId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    expect(routine.projectId).toBeNull();
    expect(routine.assigneeAgentId).toBeNull();
    expect(routine.status).toBe("paused");
  });

  it("creates revision 1 on routine create and appends revisions for real updates only", async () => {
    const { routine, svc } = await seedFixture();

    const initialRevisions = await svc.listRevisions(routine.id);
    expect(initialRevisions).toHaveLength(1);
    expect(initialRevisions[0]).toMatchObject({
      id: routine.latestRevisionId,
      revisionNumber: 1,
      title: "ascii frog",
      changeSummary: "Created routine",
    });
    expect(initialRevisions[0]?.snapshot.routine.description).toBe("Run the frog routine");

    const updated = await svc.update(
      routine.id,
      {
        description: "Run the frog routine with logs",
        baseRevisionId: routine.latestRevisionId,
      },
      {},
    );
    expect(updated?.latestRevisionNumber).toBe(2);
    expect(updated?.latestRevisionId).not.toBe(routine.latestRevisionId);

    const noOp = await svc.update(
      routine.id,
      {
        description: "Run the frog routine with logs",
        baseRevisionId: updated?.latestRevisionId,
      },
      {},
    );
    expect(noOp?.latestRevisionId).toBe(updated?.latestRevisionId);
    expect(noOp?.latestRevisionNumber).toBe(2);

    const revisions = await svc.listRevisions(routine.id);
    expect(revisions.map((revision) => revision.revisionNumber)).toEqual([2, 1]);
    expect(revisions[0]?.snapshot.routine.description).toBe("Run the frog routine with logs");
    expect(revisions[1]?.snapshot.routine.description).toBe("Run the frog routine");
  });

  it("stores routine env in revisions, syncs routine secret bindings, and stamps runs with the dispatch revision", async () => {
    const { agentId, companyId, projectId, svc } = await seedFixture();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `routine-api-${randomUUID()}`,
      provider: "local_encrypted",
      value: "secret-value",
    });

    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "secret routine",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "always_enqueue",
        catchUpPolicy: "skip_missed",
        env: {
          ROUTINE_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
          ROUTINE_PLAIN: { type: "plain", value: "plain-value" },
        },
      },
      {},
    );

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, routine.id));
    expect(bindings).toMatchObject([
      {
        companyId,
        secretId: secret.id,
        targetType: "routine",
        configPath: "env.ROUTINE_API_KEY",
      },
    ]);

    const [initialRevision] = await svc.listRevisions(routine.id);
    expect(initialRevision?.snapshot.routine.env).toEqual(routine.env);

    await db.delete(companySecretBindings).where(eq(companySecretBindings.targetId, routine.id));
    const repaired = await svc.update(routine.id, { env: routine.env }, {});
    expect(repaired).not.toBeNull();
    const repairedBindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, routine.id));
    expect(repairedBindings).toMatchObject([
      {
        companyId,
        secretId: secret.id,
        targetType: "routine",
        configPath: "env.ROUTINE_API_KEY",
      },
    ]);

    const currentRoutine = repaired ?? routine;
    const runBefore = await svc.runRoutine(routine.id, { source: "manual" });
    expect(runBefore.routineRevisionId).toBe(currentRoutine.latestRevisionId);

    const updated = await svc.update(
      routine.id,
      {
        env: {
          ROUTINE_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
          ROUTINE_PLAIN: { type: "plain", value: "changed" },
        },
      },
      {},
    );
    expect(updated?.latestRevisionNumber).toBe(currentRoutine.latestRevisionNumber + 1);

    const runAfter = await svc.runRoutine(routine.id, { source: "manual" });
    expect(runAfter.routineRevisionId).toBe(updated?.latestRevisionId);
    expect(runAfter.dispatchFingerprint).not.toBe(runBefore.dispatchFingerprint);
  });

  it("rejects stale routine baseRevisionId updates", async () => {
    const { routine, svc } = await seedFixture();
    const updated = await svc.update(routine.id, { description: "new description" }, {});
    await expect(
      svc.update(routine.id, {
        title: "stale update",
        baseRevisionId: routine.latestRevisionId,
      }, {}),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        currentRevisionId: updated?.latestRevisionId,
      },
    });
  });

  it("restores an older routine revision append-only and preserves run history", async () => {
    const { routine, svc } = await seedFixture();
    const revision1Id = routine.latestRevisionId!;
    const run = await svc.runRoutine(routine.id, { source: "manual" });
    const revision2Routine = await svc.update(routine.id, { description: "revision 2" }, {});

    const restored = await svc.restoreRevision(routine.id, revision1Id, {});

    expect(restored.restoredFromRevisionId).toBe(revision1Id);
    expect(restored.restoredFromRevisionNumber).toBe(1);
    expect(restored.routine.latestRevisionNumber).toBe(3);
    expect(restored.routine.latestRevisionId).not.toBe(revision2Routine?.latestRevisionId);
    expect(restored.routine.description).toBe("Run the frog routine");
    expect(restored.revision.restoredFromRevisionId).toBe(revision1Id);
    expect(restored.revision.snapshot.routine.description).toBe("Run the frog routine");

    const revisions = await svc.listRevisions(routine.id);
    expect(revisions.map((revision) => revision.revisionNumber)).toEqual([3, 2, 1]);
    await expect(db.select().from(routineRuns).where(eq(routineRuns.id, run.id))).resolves.toHaveLength(1);
  });

  it("rejects restoring the current latest routine revision", async () => {
    const { routine, svc } = await seedFixture();

    await expect(
      svc.restoreRevision(routine.id, routine.latestRevisionId!, {}),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        currentRevisionId: routine.latestRevisionId,
      },
    });
  });

  it("recreates deleted webhook trigger secrets when restoring a historical revision", async () => {
    const { routine, svc } = await seedFixture();
    const created = await svc.createTrigger(routine.id, {
      kind: "webhook",
      signingMode: "bearer",
      replayWindowSec: 300,
    }, {});
    await svc.deleteTrigger(created.trigger.id, {});
    await expect(db.select().from(companySecrets).where(eq(companySecrets.id, created.trigger.secretId!))).resolves.toHaveLength(0);
    await expect(db.select().from(companySecretBindings).where(eq(companySecretBindings.secretId, created.trigger.secretId!))).resolves.toHaveLength(0);

    const restored = await svc.restoreRevision(routine.id, created.revision.id, {});

    expect(restored.secretMaterials).toHaveLength(1);
    expect(restored.secretMaterials[0]).toMatchObject({
      triggerId: created.trigger.id,
    });
    expect(restored.secretMaterials[0]?.webhookSecret).toBeTruthy();
    expect(restored.secretMaterials[0]?.webhookUrl).toContain("/api/routine-triggers/public/");

    const restoredTrigger = await svc.getTrigger(created.trigger.id);
    expect(restoredTrigger?.secretId).toBeTruthy();
    expect(restoredTrigger?.publicId).toBeTruthy();
    expect(restoredTrigger?.publicId).not.toBe(created.trigger.publicId);
  });

  it("persists custom schedule cron expressions exactly", async () => {
    const { companyId, routine, svc } = await seedFixture();
    const cronExpression = "0 8-18/2 * * 1-5";

    const created = await svc.createTrigger(routine.id, {
      kind: "schedule",
      label: "Business hours",
      cronExpression,
      timezone: "UTC",
    }, {});

    expect(created.trigger.cronExpression).toBe(cronExpression);

    const storedTrigger = await svc.getTrigger(created.trigger.id);
    expect(storedTrigger?.cronExpression).toBe(cronExpression);

    const [listed] = await svc.list(companyId);
    expect(listed?.triggers[0]?.cronExpression).toBe(cronExpression);
  });

  it("blocks agents from restoring routine revisions assigned to another agent", async () => {
    const { companyId, routine, svc } = await seedFixture();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const revision1Id = routine.latestRevisionId!;

    await svc.update(routine.id, { assigneeAgentId: otherAgentId }, {});

    await expect(
      svc.restoreRevision(routine.id, revision1Id, { agentId: otherAgentId }),
    ).rejects.toMatchObject({
      status: 403,
      message: "Agents can only restore routine revisions assigned to themselves",
    });
    await expect(svc.get(routine.id)).resolves.toMatchObject({
      assigneeAgentId: otherAgentId,
      latestRevisionNumber: 2,
    });
  });

  it("blocks restoring routine revisions assigned to agents that are no longer assignable", async () => {
    const { agentId, routine, svc } = await seedFixture();
    const revision1Id = routine.latestRevisionId!;
    await svc.update(routine.id, { description: "revision 2" }, {});
    await db
      .update(agents)
      .set({ status: "terminated" })
      .where(eq(agents.id, agentId));

    await expect(
      svc.restoreRevision(routine.id, revision1Id, { userId: "board-user" }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Cannot assign routines to terminated agents",
      details: {
        code: "agent_not_assignable",
        reason: "assignee_terminated",
        assigneeAgentId: agentId,
      },
    });
    await expect(svc.get(routine.id)).resolves.toMatchObject({
      description: "revision 2",
      latestRevisionNumber: 2,
    });
  });

  it("blocks routine reassignment to agents under terminated managers", async () => {
    const { agentId, companyId, routine, svc } = await seedFixture();
    const terminatedManagerId = randomUUID();
    const blockedAgentId = randomUUID();
    await db.insert(agents).values([
      {
        id: terminatedManagerId,
        companyId,
        name: "TerminatedManager",
        role: "manager",
        status: "terminated",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: blockedAgentId,
        companyId,
        name: "BlockedRoutineCoder",
        role: "engineer",
        status: "active",
        reportsTo: terminatedManagerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await expect(svc.update(routine.id, {
      assigneeAgentId: blockedAgentId,
    }, { userId: "board-user" })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "agent_not_assignable",
        reason: "ancestor_terminated",
        assigneeAgentId: blockedAgentId,
        invalidAncestorAgentId: terminatedManagerId,
      },
    });

    await expect(svc.get(routine.id)).resolves.toMatchObject({
      assigneeAgentId: agentId,
    });
  });

  it("blocks manual routine runs when the persisted assignee is no longer assignable", async () => {
    const { agentId, routine, svc } = await seedFixture();
    await db
      .update(agents)
      .set({ status: "terminated" })
      .where(eq(agents.id, agentId));

    await expect(svc.runRoutine(routine.id, {
      source: "manual",
      payload: null,
      variables: null,
    }, { userId: "board-user" })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "agent_not_assignable",
        reason: "assignee_terminated",
        assigneeAgentId: agentId,
      },
    });
  });

  it("appends safe trigger metadata revisions without leaking webhook secrets", async () => {
    const { routine, svc } = await seedFixture();
    const created = await svc.createTrigger(routine.id, {
      kind: "webhook",
      signingMode: "bearer",
      replayWindowSec: 300,
    }, {});
    expect(created.revision.revisionNumber).toBe(2);
    expect(created.secretMaterial?.webhookSecret).toBeTruthy();

    const updated = await svc.updateTrigger(created.trigger.id, { label: "deploy hook" }, {});
    expect(updated?.revision.revisionNumber).toBe(3);

    const rotated = await svc.rotateTriggerSecret(created.trigger.id, {});
    expect(rotated.revision.revisionNumber).toBe(4);
    expect(rotated.secretMaterial.webhookSecret).toBeTruthy();

    const deleted = await svc.deleteTrigger(created.trigger.id, {});
    expect(deleted.revision?.revisionNumber).toBe(5);
    await expect(db.select().from(companySecrets).where(eq(companySecrets.id, created.trigger.secretId!))).resolves.toHaveLength(0);
    await expect(db.select().from(companySecretBindings).where(eq(companySecretBindings.secretId, created.trigger.secretId!))).resolves.toHaveLength(0);

    const revisions = await svc.listRevisions(routine.id);
    const serialized = JSON.stringify(revisions.map((revision) => revision.snapshot));
    expect(serialized).toContain(created.trigger.publicId!);
    expect(serialized).not.toContain(created.secretMaterial!.webhookSecret);
    expect(serialized).not.toContain(rotated.secretMaterial.webhookSecret);
    expect(serialized).not.toContain(created.trigger.secretId!);
    expect(revisions[0]?.snapshot.triggers).toHaveLength(0);
  });

  it("wakes the assignee when a routine creates a fresh execution issue", async () => {
    const { agentId, routine, svc, wakeups } = await seedFixture();

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
    expect(wakeups).toEqual([
      {
        agentId,
        opts: {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: run.linkedIssueId, mutation: "create" },
          requestedByActorType: undefined,
          requestedByActorId: null,
          contextSnapshot: { issueId: run.linkedIssueId, source: "routine.dispatch" },
        },
      },
    ]);
  });

  it("records the manual board runner on fresh routine issues so they appear in that user's inbox", async () => {
    const { companyId, agentId, issueSvc, routine, svc } = await seedFixture();
    const userId = randomUUID();

    const run = await svc.runRoutine(routine.id, { source: "manual" }, { userId });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
    const [createdIssue] = await db
      .select({
        id: issues.id,
        assigneeAgentId: issues.assigneeAgentId,
        createdByUserId: issues.createdByUserId,
        responsibleUserId: issues.responsibleUserId,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!));
    expect(createdIssue).toMatchObject({
      id: run.linkedIssueId,
      assigneeAgentId: agentId,
      createdByUserId: userId,
      responsibleUserId: userId,
    });

    const inboxIssues = await issueSvc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
      includeRoutineExecutions: true,
    });
    expect(inboxIssues.map((issue) => issue.id)).toContain(run.linkedIssueId);
  });

  it("uses the routine revision responsible-user snapshot for automatic runs", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const responsibleUserId = randomUUID();
    const driftUserId = randomUUID();
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "snapshotted owner routine",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      { userId: responsibleUserId },
    );

    await db
      .update(routines)
      .set({ responsibleUserId: driftUserId, updatedAt: new Date() })
      .where(eq(routines.id, routine.id));

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("issue_created");
    expect(run.responsibleUserId).toBe(responsibleUserId);
    const [createdIssue] = await db
      .select({
        responsibleUserId: issues.responsibleUserId,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!));
    expect(createdIssue?.responsibleUserId).toBe(responsibleUserId);
  });

  it("waits for the assignee wakeup to be queued before returning the routine run", async () => {
    let wakeupResolved = false;
    const { routine, svc } = await seedFixture({
      wakeup: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        wakeupResolved = true;
        return null;
      },
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(wakeupResolved).toBe(true);
  });

  it("coalesces only when the existing routine issue has a live execution run", async () => {
    const { agentId, companyId, issueSvc, routine, svc } = await seedFixture();
    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "in_progress",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });

    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });

    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));

    const detailBefore = await svc.getDetail(routine.id);
    expect(detailBefore?.activeIssue?.id).toBe(previousIssue.id);

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    expect(run.coalescedIntoRunId).toBe(previousRunId);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(1);
    expect(routineIssues[0]?.id).toBe(previousIssue.id);
  });

  it("touches a coalesced routine issue for the manual runner's inbox", async () => {
    const { agentId, companyId, issueSvc, routine, svc } = await seedFixture();
    const userId = randomUUID();
    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "in_progress",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });
    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });
    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));
    await db.insert(issueInboxArchives).values({
      companyId,
      issueId: previousIssue.id,
      userId,
      archivedAt: new Date("2026-03-20T12:02:00.000Z"),
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" }, { userId });

    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    await expect(
      db.select().from(issueInboxArchives).where(eq(issueInboxArchives.issueId, previousIssue.id)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(issueReadStates).where(eq(issueReadStates.issueId, previousIssue.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        companyId,
        issueId: previousIssue.id,
        userId,
      }),
    ]);

    const inboxIssues = await issueSvc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
      includeRoutineExecutions: true,
    });
    expect(inboxIssues.map((issue) => issue.id)).toContain(previousIssue.id);
  });

  it("touches a skipped active routine issue for the manual runner's inbox", async () => {
    const { agentId, companyId, issueSvc, routine, svc } = await seedFixture();
    const userId = randomUUID();
    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();

    await db
      .update(routines)
      .set({ concurrencyPolicy: "skip_if_active" })
      .where(eq(routines.id, routine.id));

    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "in_progress",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });
    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });
    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));
    await db.insert(issueInboxArchives).values({
      companyId,
      issueId: previousIssue.id,
      userId,
      archivedAt: new Date("2026-03-20T12:02:00.000Z"),
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" }, { userId });

    expect(run.status).toBe("skipped");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    await expect(
      db.select().from(issueInboxArchives).where(eq(issueInboxArchives.issueId, previousIssue.id)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(issueReadStates).where(eq(issueReadStates.issueId, previousIssue.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        companyId,
        issueId: previousIssue.id,
        userId,
      }),
    ]);

    const inboxIssues = await issueSvc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
      includeRoutineExecutions: true,
    });
    expect(inboxIssues.map((issue) => issue.id)).toContain(previousIssue.id);
  });

  // Polls until some backend is parked on a row lock, so the concurrency test synchronises on the
  // real block instead of a sleep.
  async function waitForBlockedBackend(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const blocked = await db.execute(
        drizzleSql`select count(*)::int as blocked from pg_stat_activity
                   where wait_event_type = 'Lock' and state = 'active'`,
      );
      if (Number((blocked as unknown as Array<{ blocked: number }>)[0]?.blocked ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("timed out waiting for a backend to block on a row lock");
  }

  // A `scheduled_retry` heartbeat run counts as live, so a retry that is never
  // promoted pins the execution issue and `skip_if_active` skips every subsequent tick forever.
  async function seedStaleExecutionPin(input: {
    heartbeatRunStatus: "scheduled_retry" | "queued" | "running" | "failed";
    startedAt?: Date | null;
    lastOutputAt?: Date | null;
    scheduledRetryAt?: Date | null;
  }) {
    const fixture = await seedFixture();
    const { agentId, companyId, issueSvc, routine } = fixture;
    const previousRunId = randomUUID();
    const pinningRunId = randomUUID();

    await db
      .update(routines)
      .set({ concurrencyPolicy: "skip_if_active" })
      .where(eq(routines.id, routine.id));

    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "in_progress",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "schedule",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });

    await db.insert(heartbeatRuns).values({
      id: pinningRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: input.heartbeatRunStatus,
      contextSnapshot: { issueId: previousIssue.id, wakeReason: "transient_failure_retry" },
      startedAt: input.startedAt ?? null,
      lastOutputAt: input.lastOutputAt ?? null,
      scheduledRetryAt: input.scheduledRetryAt ?? null,
      scheduledRetryAttempt: input.heartbeatRunStatus === "scheduled_retry" ? 4 : 0,
      scheduledRetryReason: input.heartbeatRunStatus === "scheduled_retry" ? "transient_failure" : null,
    });

    await db
      .update(issues)
      .set({ executionRunId: pinningRunId, executionLockedAt: new Date("2026-03-20T12:01:00.000Z") })
      .where(eq(issues.id, previousIssue.id));

    return { ...fixture, pinningRunId, previousIssue };
  }

  it("releases a dead scheduled-retry pin so skip_if_active cannot skip forever", async () => {
    const { companyId, pinningRunId, previousIssue, routine, svc } = await seedStaleExecutionPin({
      heartbeatRunStatus: "scheduled_retry",
      startedAt: null,
      lastOutputAt: null,
      // Due well over the staleness grace period ago and never promoted.
      scheduledRetryAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
    });

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).not.toBe(previousIssue.id);

    const stalePin = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, pinningRunId))
      .then((rows) => rows[0] ?? null);
    expect(stalePin).toEqual({ status: "cancelled", errorCode: "stale_execution_pin" });

    const staleIssue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, previousIssue.id))
      .then((rows) => rows[0] ?? null);
    expect(staleIssue?.status).toBe("cancelled");

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, previousIssue.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("pinned by a scheduled retry that never started");

    // Exactly one live execution issue for this routine afterwards.
    const openIssues = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(eq(issues.originId, routine.id));
    expect(openIssues.filter((issue) => !["done", "cancelled"].includes(issue.status))).toEqual([
      expect.objectContaining({ id: run.linkedIssueId }),
    ]);

    const detail = await svc.getDetail(routine.id);
    expect(detail?.activeIssue?.id).toBe(run.linkedIssueId);

    const audit = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    expect(audit.map((entry) => entry.action)).toContain("routine.stale_execution_pin_released");
    expect(
      audit.find((entry) => entry.action === "routine.stale_execution_pin_released")?.entityId,
    ).toBe(previousIssue.id);
  });

  it("keeps skipping while a scheduled retry is still within its grace period", async () => {
    const { pinningRunId, previousIssue, routine, svc } = await seedStaleExecutionPin({
      heartbeatRunStatus: "scheduled_retry",
      startedAt: null,
      lastOutputAt: null,
      // Due in the future — a legitimately pending retry.
      scheduledRetryAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("skipped");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    await expect(
      db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, pinningRunId)),
    ).resolves.toEqual([{ status: "scheduled_retry" }]);
  });

  // Promotion sets `status = 'queued'` and leaves scheduledRetryAt/startedAt alone, so a
  // run that has just been promoted looks byte-for-byte like a dead one on every field except
  // status. Reaping it cancels work that is about to start.
  it("never reaps a pin that has already been promoted to queued", async () => {
    const { pinningRunId, previousIssue, routine, svc } = await seedStaleExecutionPin({
      heartbeatRunStatus: "queued",
      startedAt: null,
      lastOutputAt: null,
      scheduledRetryAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
    });

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("skipped");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    await expect(
      db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, pinningRunId)),
    ).resolves.toEqual([{ status: "queued" }]);
    await expect(
      db.select({ status: issues.status }).from(issues).where(eq(issues.id, previousIssue.id)),
    ).resolves.toEqual([{ status: "in_progress" }]);
  });

  // The promoter runs outside the dispatch transaction. Under READ COMMITTED the reap
  // could decide "dead" on a pre-promotion snapshot and then cancel the promoted run anyway.
  it("abandons the reap when the pin is promoted concurrently with dispatch", async () => {
    const { pinningRunId, previousIssue, routine, svc } = await seedStaleExecutionPin({
      heartbeatRunStatus: "scheduled_retry",
      startedAt: null,
      lastOutputAt: null,
      scheduledRetryAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
    });

    let releasePromoter!: () => void;
    const promoterHeld = new Promise<void>((resolve) => {
      releasePromoter = resolve;
    });
    const promoterTx = db.transaction(async (tx) => {
      await tx
        .update(heartbeatRuns)
        .set({ status: "queued", updatedAt: new Date() })
        .where(eq(heartbeatRuns.id, pinningRunId));
      await promoterHeld;
    });

    const dispatch = svc.runRoutine(routine.id, { source: "schedule" });
    // Let dispatch reach the pinning row and block on the promoter's uncommitted row lock; without
    // that lock it would read the stale snapshot and the assertions below would be vacuous.
    await waitForBlockedBackend();
    releasePromoter();
    await promoterTx;
    const run = await dispatch;

    expect(run.status).toBe("skipped");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    await expect(
      db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, pinningRunId)),
    ).resolves.toEqual([{ status: "queued" }]);
    await expect(
      db.select({ status: issues.status }).from(issues).where(eq(issues.id, previousIssue.id)),
    ).resolves.toEqual([{ status: "in_progress" }]);
    await expect(
      db.select().from(issueComments).where(eq(issueComments.issueId, previousIssue.id)),
    ).resolves.toHaveLength(0);
  });

  // The "demonstrably redundant" arm only has a meaning relative to a schedule, so these fire the
  // routine through tickScheduledTriggers rather than runRoutine — runRoutine without a trigger
  // has no nextRunAt and leaves the arm inert by construction.
  // `retryOffsetMs` is measured from the trigger's own next cron tick rather than from wall clock,
  // so "retry lands before/after the next tick" holds no matter what time of day CI runs at.
  async function fireDueScheduleTrigger(input: {
    svc: ReturnType<typeof routineService>;
    routineId: string;
    pinningRunId: string;
    retryOffsetMs: number;
  }) {
    const { trigger } = await input.svc.createTrigger(
      input.routineId,
      { kind: "schedule", label: "pin-test", cronExpression: "0 * * * *", timezone: "UTC" },
      {},
    );
    await db
      .update(heartbeatRuns)
      .set({ scheduledRetryAt: new Date(trigger.nextRunAt!.getTime() + input.retryOffsetMs) })
      .where(eq(heartbeatRuns.id, input.pinningRunId));
    await db
      .update(routineTriggers)
      .set({ nextRunAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(routineTriggers.id, trigger.id));
    await input.svc.tickScheduledTriggers(new Date());
    return db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, input.routineId))
      .orderBy(drizzleSql`${routineRuns.triggeredAt} desc`)
      .limit(1)
      .then((rows) => rows[0]!);
  }

  // A never-started retry due at or after the next tick cannot produce work any sooner than
  // letting this tick through, so holding the pin for it only burns ticks. The retry is set an
  // hour PAST the next tick, and stays in the future, so the overdue arm cannot be what fires
  // here.
  it("reaps a pin whose retry is not due until after the next scheduled tick", async () => {
    const { companyId, pinningRunId, previousIssue, routine, svc } = await seedStaleExecutionPin({
      heartbeatRunStatus: "scheduled_retry",
      startedAt: null,
      lastOutputAt: null,
      scheduledRetryAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
    });

    const run = await fireDueScheduleTrigger({
      svc,
      routineId: routine.id,
      pinningRunId,
      retryOffsetMs: 60 * 60 * 1000,
    });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).not.toBe(previousIssue.id);

    await expect(
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, pinningRunId)),
    ).resolves.toEqual([{ status: "cancelled", errorCode: "stale_execution_pin" }]);
    await expect(
      db.select({ status: issues.status }).from(issues).where(eq(issues.id, previousIssue.id)),
    ).resolves.toEqual([{ status: "cancelled" }]);

    // AC6: the reap names itself on the issue and in the activity log.
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, previousIssue.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("redundant_retry");

    const released = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .then((rows) => rows.filter((row) => row.action === "routine.stale_execution_pin_released"));
    expect(released).toHaveLength(1);
    expect((released[0]?.details as { reason?: string })?.reason).toBe("redundant_retry");
  });

  // The mirror image. A retry due a minute BEFORE the next tick is strictly sooner than waiting
  // for the tick, so it is real work worth holding the pin for — and it is nowhere near the
  // overdue grace either. Neither arm may fire.
  it("does not reap a pin whose retry is due before the next scheduled tick", async () => {
    const { pinningRunId, previousIssue, routine, svc } = await seedStaleExecutionPin({
      heartbeatRunStatus: "scheduled_retry",
      startedAt: null,
      lastOutputAt: null,
      scheduledRetryAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    const run = await fireDueScheduleTrigger({
      svc,
      routineId: routine.id,
      pinningRunId,
      retryOffsetMs: -60 * 1000,
    });

    expect(run.status).toBe("skipped");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    await expect(
      db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, pinningRunId)),
    ).resolves.toEqual([{ status: "scheduled_retry" }]);
    await expect(
      db.select({ status: issues.status }).from(issues).where(eq(issues.id, previousIssue.id)),
    ).resolves.toEqual([{ status: "in_progress" }]);
    await expect(
      db.select().from(issueComments).where(eq(issueComments.issueId, previousIssue.id)),
    ).resolves.toHaveLength(0);
  });

  // The runless shape cannot be seeded by hand: the unique index keys on
  // originFingerprint, and a hand-made issue gets the legacy "default" fingerprint, which
  // collides with nothing. So dispatch for real once to mint an issue with the true dispatch
  // fingerprint, then strip it of live runs — that is exactly how a killed agent leaves things.
  async function seedRunlessExecutionIssue() {
    const fixture = await seedFixture();
    const { agentId, companyId, routine, svc } = fixture;
    await db
      .update(routines)
      .set({ concurrencyPolicy: "skip_if_active" })
      .where(eq(routines.id, routine.id));

    const firstRun = await svc.runRoutine(routine.id, { source: "schedule" });
    expect(firstRun.status).toBe("issue_created");
    const strandedIssueId = firstRun.linkedIssueId!;

    // Dispatch queues an assignment wakeup run, which is live. Kill it the way a session-limit
    // 429 or an OOM would, leaving the issue open with nothing left to advance it.
    await db
      .update(heartbeatRuns)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(heartbeatRuns.companyId, companyId));

    // A terminal heartbeat run: enough to satisfy the index's `execution_run_id is not null`,
    // but nothing findLiveExecutionIssue will ever count as live.
    const deadRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: deadRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "failed",
      contextSnapshot: { issueId: strandedIssueId, wakeReason: "issue_assigned" },
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await db
      .update(issues)
      .set({ executionRunId: deadRunId, status: "in_progress" })
      .where(eq(issues.id, strandedIssueId));

    return { ...fixture, strandedIssueId, deadRunId };
  }

  it("reaps a runless open execution issue that collides on the unique index", async () => {
    const { companyId, deadRunId, routine, strandedIssueId, svc } = await seedRunlessExecutionIssue();

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    // The whole point: this used to rethrow the 23505 and roll the dispatch back, so there was no
    // routine_runs row at all and the routine looked idle rather than stuck.
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).not.toBe(strandedIssueId);

    await expect(
      db.select({ status: issues.status }).from(issues).where(eq(issues.id, strandedIssueId)),
    ).resolves.toEqual([{ status: "cancelled" }]);
    // The reap only terminalises the issue; a run that already failed is left exactly as it was.
    await expect(
      db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, deadRunId)),
    ).resolves.toEqual([{ status: "failed" }]);

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, strandedIssueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("runless_issue");

    const released = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .then((rows) => rows.filter((row) => row.action === "routine.stale_execution_pin_released"));
    expect(released).toHaveLength(1);
    expect((released[0]?.details as { reason?: string })?.reason).toBe("runless_issue");
  });

  // `in_review` is open with no live run too, but it means an agent deliberately parked
  // the issue waiting on an operator — cancelling that would throw away a pending interaction.
  // Only `in_progress` is unambiguously a run that died mid-work.
  it("does not reap an execution issue parked in in_review", async () => {
    const { routine, strandedIssueId, svc } = await seedRunlessExecutionIssue();
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, strandedIssueId));

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    await expect(
      db.select({ status: issues.status }).from(issues).where(eq(issues.id, strandedIssueId)),
    ).resolves.toEqual([{ status: "in_review" }]);
    await expect(
      db.select().from(issueComments).where(eq(issueComments.issueId, strandedIssueId)),
    ).resolves.toHaveLength(0);
    expect(run.linkedIssueId).not.toBe(strandedIssueId);
  });

  // Every reap arm is scoped to originKind = 'routine_execution'; an issue that
  // merely looks stale must be invisible to all of them.
  it("never reaps a non-routine issue, however stale it looks", async () => {
    const { agentId, companyId, issueSvc, routine, strandedIssueId, svc } = await seedRunlessExecutionIssue();

    // Same company and same originId as the routine, but a different originKind — so it is stale
    // and runless in exactly the way the guard looks for, and still must not be touched.
    const bystander = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: "hand-made issue that must survive",
      status: "in_progress",
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "manual",
      originId: routine.id,
    });
    const bystanderRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: bystanderRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "failed",
      contextSnapshot: { issueId: bystander.id, wakeReason: "issue_assigned" },
      startedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });
    await db.update(issues).set({ executionRunId: bystanderRunId }).where(eq(issues.id, bystander.id));

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    // The routine's own stranded issue is reaped; the bystander is untouched.
    expect(run.status).toBe("issue_created");
    await expect(
      db.select({ status: issues.status }).from(issues).where(eq(issues.id, strandedIssueId)),
    ).resolves.toEqual([{ status: "cancelled" }]);
    await expect(
      db.select({ status: issues.status }).from(issues).where(eq(issues.id, bystander.id)),
    ).resolves.toEqual([{ status: "in_progress" }]);
    await expect(
      db.select().from(issueComments).where(eq(issueComments.issueId, bystander.id)),
    ).resolves.toHaveLength(0);
  });

  // A skip that only says "a live execution issue already exists" cannot tell an operator whether
  // the work is merely late or wedged forever. These lock the detail onto both surfaces that
  // report a skip: the run row and the trigger's last result.
  it("records the pinning retry's id, attempt, cause and due time on a skipped run", async () => {
    const { pinningRunId, previousIssue, routine, svc } = await seedStaleExecutionPin({
      heartbeatRunStatus: "scheduled_retry",
      startedAt: null,
      lastOutputAt: null,
      scheduledRetryAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    // Due before the next tick, so this is the "late, but real work is still coming" case and
    // neither reap arm may fire — exactly the case the old message could not distinguish.
    const run = await fireDueScheduleTrigger({
      svc,
      routineId: routine.id,
      pinningRunId,
      retryOffsetMs: -60 * 1000,
    });

    expect(run.status).toBe("skipped");
    expect(run.failureReason).toContain(previousIssue.id);
    expect(run.failureReason).toContain(pinningRunId);
    expect(run.failureReason).toContain("scheduled retry");
    expect(run.failureReason).toContain("attempt 4");
    expect(run.failureReason).toContain("transient_failure");
    // The due time is what makes "late" actionable, and it reads as pending rather than overdue.
    expect(run.failureReason).toContain("due in");

    const trigger = await db
      .select({ lastResult: routineTriggers.lastResult })
      .from(routineTriggers)
      .where(eq(routineTriggers.routineId, routine.id))
      .then((rows) => rows[0]!);
    expect(trigger.lastResult).toContain("Skipped because a live execution issue already exists");
    expect(trigger.lastResult).toContain(pinningRunId);
  });

  // The other side of the same question: a pin that is running carries no due time at all, so the
  // description must report the run's state instead of inventing a schedule for it.
  it("describes a running pin by its state rather than a retry due time", async () => {
    const { pinningRunId, routine, svc } = await seedStaleExecutionPin({
      heartbeatRunStatus: "running",
      startedAt: new Date(Date.now() - 5 * 60 * 1000),
      lastOutputAt: new Date(Date.now() - 30 * 1000),
      scheduledRetryAt: null,
    });

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("skipped");
    expect(run.failureReason).toContain(`run ${pinningRunId} is running`);
    expect(run.failureReason).not.toContain("due");
  });

  // A tick that had to break a pin before it could run must say so on its own row, or run history
  // shows an ordinary success and the reap is only discoverable in the activity log.
  it("names the reap arm on the run row of the tick that broke the pin", async () => {
    const { routine, strandedIssueId, svc } = await seedRunlessExecutionIssue();

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("issue_created");
    expect(run.failureReason).toContain(strandedIssueId);
    expect(run.failureReason).toContain("runless_issue");
  });

  // Guards AC9: adding the description must not change *when* a tick fires. An ordinary
  // unobstructed dispatch keeps a null reason rather than picking up a stray "released" note.
  it("leaves the reason null on an ordinary unobstructed dispatch", async () => {
    const { routine, svc } = await seedFixture();

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("issue_created");
    expect(run.failureReason).toBeNull();
  });

  it("respects a genuinely running pin with recent output", async () => {
    const { pinningRunId, previousIssue, routine, svc } = await seedStaleExecutionPin({
      heartbeatRunStatus: "running",
      startedAt: new Date(Date.now() - 5 * 60 * 1000),
      lastOutputAt: new Date(Date.now() - 30 * 1000),
      scheduledRetryAt: null,
    });

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("skipped");
    expect(run.linkedIssueId).toBe(previousIssue.id);

    const pin = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, pinningRunId))
      .then((rows) => rows[0] ?? null);
    expect(pin?.status).toBe("running");

    const staleIssue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, previousIssue.id))
      .then((rows) => rows[0] ?? null);
    expect(staleIssue?.status).toBe("in_progress");
    await expect(
      db.select().from(issueComments).where(eq(issueComments.issueId, previousIssue.id)),
    ).resolves.toHaveLength(0);
  });

  it("does not coalesce live routine runs with different resolved variables", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "pre-pr for {{branch}}",
        description: "Create a pre-PR from {{branch}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "branch", label: null, type: "text", defaultValue: null, required: true, options: [] },
        ],
      },
      {},
    );

    const first = await svc.runRoutine(variableRoutine.id, {
      source: "manual",
      variables: { branch: "feature/a" },
    });
    const second = await svc.runRoutine(variableRoutine.id, {
      source: "manual",
      variables: { branch: "feature/b" },
    });

    expect(first.status).toBe("issue_created");
    expect(second.status).toBe("issue_created");
    expect(first.linkedIssueId).toBeTruthy();
    expect(second.linkedIssueId).toBeTruthy();
    expect(first.linkedIssueId).not.toBe(second.linkedIssueId);

    const routineIssues = await db
      .select({
        id: issues.id,
        title: issues.title,
        originFingerprint: issues.originFingerprint,
      })
      .from(issues)
      .where(eq(issues.originId, variableRoutine.id));

    expect(routineIssues).toHaveLength(2);
    expect(routineIssues.map((issue) => issue.title).sort()).toEqual([
      "pre-pr for feature/a",
      "pre-pr for feature/b",
    ]);
    expect(new Set(routineIssues.map((issue) => issue.originFingerprint)).size).toBe(2);
  });

  it("interpolates routine variables into the execution issue and stores resolved values", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "repo triage for {{repo}}",
        description: "Review {{repo}} for {{priority}} bugs",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
          { name: "priority", label: null, type: "select", defaultValue: "high", required: true, options: ["high", "low"] },
        ],
      },
      {},
    );
    expect(variableRoutine.variables.map((variable) => variable.name)).toEqual(["repo", "priority"]);

    const run = await svc.runRoutine(variableRoutine.id, {
      source: "manual",
      variables: { repo: "paperclip" },
    });

    const storedIssue = await db
      .select({ title: issues.title, description: issues.description })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    const storedRun = await db
      .select({ triggerPayload: routineRuns.triggerPayload })
      .from(routineRuns)
      .where(eq(routineRuns.id, run.id))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue?.title).toBe("repo triage for paperclip");
    expect(storedIssue?.description).toBe("Review paperclip for high bugs");
    expect(storedRun?.triggerPayload).toEqual({
      variables: {
        repo: "paperclip",
        priority: "high",
      },
    });
  });

  it("infers capital-Date variables, preserves builtin date, and validates submitted date values", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const dateRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "date check {{startDate}} on {{date}}",
        description: "Range {{startDate}} to {{endDate}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    expect(dateRoutine.variables).toEqual([
      { name: "startDate", label: null, type: "date", defaultValue: null, required: true, options: [] },
      { name: "endDate", label: null, type: "date", defaultValue: null, required: true, options: [] },
    ]);

    await expect(
      svc.runRoutine(dateRoutine.id, {
        source: "manual",
        variables: { startDate: "2024-02-30", endDate: "2024-03-01" },
      }),
    ).rejects.toThrow(/valid YYYY-MM-DD date/i);

    const run = await svc.runRoutine(dateRoutine.id, {
      source: "manual",
      variables: { startDate: "2024-02-29", endDate: "2024-03-01" },
    });

    const storedIssue = await db
      .select({ title: issues.title, description: issues.description })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    const storedRun = await db
      .select({ triggerPayload: routineRuns.triggerPayload })
      .from(routineRuns)
      .where(eq(routineRuns.id, run.id))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue?.title).toMatch(/^date check 2024-02-29 on \d{4}-\d{2}-\d{2}$/);
    expect(storedIssue?.description).toBe("Range 2024-02-29 to 2024-03-01");
    expect(storedRun?.triggerPayload).toEqual({
      variables: {
        startDate: "2024-02-29",
        endDate: "2024-03-01",
      },
    });
  });

  it("attaches the selected execution workspace to manually triggered routine issues", async () => {
    const { companyId, projectId, routine, svc } = await seedFixture();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db
      .update(projects)
      .set({
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          defaultProjectWorkspaceId: projectWorkspaceId,
        },
      })
      .where(eq(projects.id, projectId));
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "routine-primary",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Routine worktree",
      status: "active",
      providerType: "git_worktree",
    });

    const run = await svc.runRoutine(routine.id, {
      source: "manual",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    const storedIssue = await db
      .select({
        projectWorkspaceId: issues.projectWorkspaceId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue).toEqual({
      projectWorkspaceId,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
  });

  it("auto-populates workspaceBranch from a reused isolated workspace", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db
      .update(projects)
      .set({
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          defaultProjectWorkspaceId: projectWorkspaceId,
        },
      })
      .where(eq(projects.id, projectId));
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "routine-primary",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Routine worktree",
      status: "active",
      providerType: "git_worktree",
      branchName: "pap-1634-routine-branch",
    });

    const branchRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Review {{workspaceBranch}}",
        description: "Use branch {{workspaceBranch}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "workspaceBranch", label: null, type: "text", defaultValue: null, required: true, options: [] },
        ],
      },
      {},
    );

    const run = await svc.runRoutine(branchRoutine.id, {
      source: "manual",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    const storedIssue = await db
      .select({ title: issues.title, description: issues.description })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    const storedRun = await db
      .select({ triggerPayload: routineRuns.triggerPayload })
      .from(routineRuns)
      .where(eq(routineRuns.id, run.id))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue?.title).toBe("Review pap-1634-routine-branch");
    expect(storedIssue?.description).toBe("Use branch pap-1634-routine-branch");
    expect(storedRun?.triggerPayload).toEqual({
      variables: {
        workspaceBranch: "pap-1634-routine-branch",
      },
    });
  });

  it("runs draft routines with one-off agent and project overrides", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const draftRoutine = await svc.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "draft dispatch",
        description: "Pick defaults at run time",
        assigneeAgentId: null,
        priority: "medium",
        status: "paused",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const run = await svc.runRoutine(draftRoutine.id, {
      source: "manual",
      projectId,
      assigneeAgentId: agentId,
    });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();

    const storedIssue = await db
      .select({
        projectId: issues.projectId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue).toEqual({
      projectId,
      assigneeAgentId: agentId,
    });
  });

  it("rejects enabling automation for routines without a default agent", async () => {
    const { companyId, svc } = await seedFixture();
    const draftRoutine = await svc.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "draft routine",
        description: null,
        assigneeAgentId: null,
        priority: "medium",
        status: "paused",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    await expect(
      svc.update(draftRoutine.id, { status: "active" }, {}),
    ).rejects.toThrow(/default agent required/i);
  });

  it("blocks schedule triggers when required variables do not have defaults", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "repo triage",
        description: "Review {{repo}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
        ],
      },
      {},
    );

    await expect(
      svc.createTrigger(variableRoutine.id, {
        kind: "schedule",
        label: "daily",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      }, {}),
    ).rejects.toThrow(/require defaults for required variables/i);
  });

  it("treats malformed stored defaults as missing when validating schedule triggers", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "ship check",
        description: "Review {{approved}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "approved", label: null, type: "boolean", defaultValue: true, required: true, options: [] },
        ],
      },
      {},
    );

    await db
      .update(routines)
      .set({
        variables: [
          {
            name: "approved",
            label: null,
            type: "boolean",
            defaultValue: "definitely",
            required: true,
            options: [],
          },
        ],
      })
      .where(eq(routines.id, variableRoutine.id));

    await expect(
      svc.createTrigger(variableRoutine.id, {
        kind: "schedule",
        label: "daily",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      }, {}),
    ).rejects.toThrow(/require defaults for required variables/i);
  });

  it("rejects invalid date defaults before persisting routine variables", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();

    await expect(
      svc.create(
        companyId,
        {
          projectId,
          goalId: null,
          parentIssueId: null,
          title: "date check {{startDate}}",
          description: null,
          assigneeAgentId: agentId,
          priority: "medium",
          status: "active",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          variables: [
            { name: "startDate", label: null, type: "date", defaultValue: "2024-02-30", required: true, options: [] },
          ],
        },
        {},
      ),
    ).rejects.toThrow(/valid YYYY-MM-DD date/i);
  });

  it("serializes concurrent dispatches until the first execution issue is linked to a queued run", async () => {
    const { routine, svc } = await seedFixture({
      wakeup: async (wakeupAgentId, wakeupOpts) => {
        const issueId =
          (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
          (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
          null;
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (!issueId) return null;
        const queuedRunId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: queuedRunId,
          companyId: routine.companyId,
          agentId: wakeupAgentId,
          invocationSource: wakeupOpts.source ?? "assignment",
          triggerDetail: wakeupOpts.triggerDetail ?? null,
          status: "queued",
          contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
        });
        await db
          .update(issues)
          .set({
            executionRunId: queuedRunId,
            executionLockedAt: new Date(),
          })
          .where(eq(issues.id, issueId));
        return { id: queuedRunId };
      },
    });

    const [first, second] = await Promise.all([
      svc.runRoutine(routine.id, { source: "manual" }),
      svc.runRoutine(routine.id, { source: "manual" }),
    ]);

    expect([first.status, second.status].sort()).toEqual(["coalesced", "issue_created"]);
    expect(first.linkedIssueId).toBeTruthy();
    expect(second.linkedIssueId).toBeTruthy();
    expect(first.linkedIssueId).toBe(second.linkedIssueId);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(1);
  });

  it("fails the run and cleans up the execution issue when wakeup queueing fails", async () => {
    const { routine, svc } = await seedFixture({
      wakeup: async () => {
        throw new Error("queue unavailable");
      },
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("failed");
    expect(run.failureReason).toContain("queue unavailable");
    expect(run.linkedIssueId).toBeNull();

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(0);
  });

  it("accepts standard second-precision webhook timestamps for HMAC triggers", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger, secretMaterial } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "hmac_sha256",
        replayWindowSec: 300,
      },
      {},
    );

    expect(trigger.publicId).toBeTruthy();
    expect(secretMaterial?.webhookSecret).toBeTruthy();

    const payload = { ok: true };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const timestampSeconds = String(Math.floor(Date.now() / 1000));
    const signature = `sha256=${createHmac("sha256", secretMaterial!.webhookSecret)
      .update(`${timestampSeconds}.`)
      .update(rawBody)
      .digest("hex")}`;

    const run = await svc.firePublicTrigger(trigger.publicId!, {
      signatureHeader: signature,
      timestampHeader: timestampSeconds,
      rawBody,
      payload,
    });

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
  });

  it("uses the configured provider for generated webhook trigger secrets", async () => {
    process.env.PAPERCLIP_SECRETS_PROVIDER = "aws_secrets_manager";
    const originalGetSecretProvider = providerRegistry.getSecretProvider;
    const getSecretProviderSpy = vi.spyOn(providerRegistry, "getSecretProvider").mockImplementation((provider) => {
      if (provider !== "aws_secrets_manager") {
        return originalGetSecretProvider(provider);
      }
      return {
        id: "aws_secrets_manager",
        descriptor: () => ({
          id: "aws_secrets_manager",
          label: "AWS Secrets Manager",
          supportsManaged: true,
          supportsExternalReference: true,
        }),
        validateConfig: async () => ({ ok: true, warnings: [] }),
        createSecret: async ({ value }) => ({
          material: { source: "managed", secretId: "arn:aws:secretsmanager:stub", versionId: "v1" },
          valueSha256: `sha:${value}`,
          fingerprintSha256: `sha:${value}`,
          externalRef: "arn:aws:secretsmanager:stub",
          providerVersionRef: "v1",
        }),
        createVersion: async ({ value }) => ({
          material: { source: "managed", secretId: "arn:aws:secretsmanager:stub", versionId: "v2" },
          valueSha256: `sha:${value}`,
          fingerprintSha256: `sha:${value}`,
          externalRef: "arn:aws:secretsmanager:stub",
          providerVersionRef: "v2",
        }),
        linkExternalSecret: async ({ externalRef, providerVersionRef }) => ({
          material: { source: "external", secretId: externalRef, versionId: providerVersionRef ?? null },
          valueSha256: "external",
          fingerprintSha256: "external",
          externalRef,
          providerVersionRef: providerVersionRef ?? null,
        }),
        resolveVersion: async () => "resolved-secret",
        deleteOrArchive: async () => undefined,
        healthCheck: async () => ({
          provider: "aws_secrets_manager",
          status: "ok",
          message: "stubbed",
        }),
      };
    });

    try {
      const { routine, svc } = await seedFixture();
      const { trigger } = await svc.createTrigger(
        routine.id,
        {
          kind: "webhook",
          signingMode: "hmac_sha256",
          replayWindowSec: 300,
        },
        {},
      );

      const [secret] = await db
        .select({
          id: companySecrets.id,
          provider: companySecrets.provider,
        })
        .from(companySecrets)
        .where(eq(companySecrets.id, trigger.secretId!));

      expect(secret).toMatchObject({
        id: trigger.secretId,
        provider: "aws_secrets_manager",
      });
    } finally {
      getSecretProviderSpy.mockRestore();
    }
  });

  it("accepts GitHub-style X-Hub-Signature-256 with github_hmac signing mode", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger, secretMaterial } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "github_hmac",
      },
      {},
    );

    const payload = { action: "opened", pull_request: { number: 1 } };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac("sha256", secretMaterial!.webhookSecret)
      .update(rawBody)
      .digest("hex")}`;

    const run = await svc.firePublicTrigger(trigger.publicId!, {
      hubSignatureHeader: signature,
      rawBody,
      payload,
    });

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
  });

  it("rejects invalid signature for github_hmac signing mode", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "github_hmac",
      },
      {},
    );

    const rawBody = Buffer.from(JSON.stringify({ ok: true }));

    await expect(
      svc.firePublicTrigger(trigger.publicId!, {
        hubSignatureHeader: "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        rawBody,
        payload: { ok: true },
      }),
    ).rejects.toThrow();
  });

  it("accepts any request with none signing mode", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "none",
      },
      {},
    );

    const run = await svc.firePublicTrigger(trigger.publicId!, {
      payload: { event: "error.created" },
    });

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
  });

  it("suppresses scheduled ticks while the routine project is paused, then resumes when unpaused", async () => {
    const { companyId, projectId, routine, svc } = await seedFixture();
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "schedule",
        label: "daily",
        cronExpression: "0 0 * * *",
        timezone: "UTC",
      },
      {},
    );

    const pastDue = new Date("2020-01-01T00:00:00.000Z");

    // Pause the project and make the schedule trigger due.
    await db
      .update(projects)
      .set({ pausedAt: new Date(), pauseReason: "manual pause" })
      .where(eq(projects.id, projectId));
    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue })
      .where(eq(routineTriggers.id, trigger.id));

    const pausedResult = await svc.tickScheduledTriggers(new Date());
    expect(pausedResult.triggered).toBe(0);

    // No execution issue should be created while paused.
    const issuesWhilePaused = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(issuesWhilePaused).toHaveLength(0);

    // One skipped routine run with pause-specific reason and no linked issue.
    const skippedRuns = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routine.id));
    expect(skippedRuns).toHaveLength(1);
    expect(skippedRuns[0]?.status).toBe("skipped");
    expect(skippedRuns[0]?.source).toBe("schedule");
    expect(skippedRuns[0]?.failureReason).toBe("paused");
    expect(skippedRuns[0]?.linkedIssueId).toBeNull();
    expect(skippedRuns[0]?.completedAt).not.toBeNull();

    // Trigger advanced past the paused firing and audit reflects the pause skip.
    const pausedTrigger = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.id, trigger.id))
      .then((rows) => rows[0]);
    expect(pausedTrigger?.nextRunAt).not.toBeNull();
    expect(pausedTrigger!.nextRunAt!.getTime()).toBeGreaterThan(pastDue.getTime());
    expect(pausedTrigger?.lastResult).toMatch(/paused/i);

    // Unpause and make the trigger due again; a normal tick now creates an issue.
    await db
      .update(projects)
      .set({ pausedAt: null, pauseReason: null })
      .where(eq(projects.id, projectId));
    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue })
      .where(eq(routineTriggers.id, trigger.id));

    const resumedResult = await svc.tickScheduledTriggers(new Date());
    expect(resumedResult.triggered).toBe(1);

    const issuesAfterResume = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(issuesAfterResume).toHaveLength(1);

    const runsAfterResume = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routine.id));
    expect(runsAfterResume).toHaveLength(2);
    expect(runsAfterResume.some((run) => run.status === "issue_created")).toBe(true);
  });
});
