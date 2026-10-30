import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Production middleware always stamps `source`; fixtures that hand-build an
// actor without one must get the provenance the middleware would have set,
// because getActorInfo now denies an unset source.
function withActorSource<T extends Record<string, any>>(actor: T): T {
  if (actor.source) return actor;
  return { ...actor, source: actor.type === "agent" ? "agent_key" : "local_implicit" };
}

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const routineId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const otherAgentId = "55555555-5555-4555-8555-555555555555";
const revisionId = "77777777-7777-4777-8777-777777777777";

const routine = {
  id: routineId,
  companyId,
  projectId,
  goalId: null,
  parentIssueId: null,
  title: "Daily routine",
  description: null,
  assigneeAgentId: agentId,
  priority: "medium",
  status: "active",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
  variables: [],
  latestRevisionId: revisionId,
  latestRevisionNumber: 1,
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  lastTriggeredAt: null,
  lastEnqueuedAt: null,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
  updatedAt: new Date("2026-03-20T00:00:00.000Z"),
};

const revision = {
  id: revisionId,
  companyId,
  routineId,
  revisionNumber: 1,
  title: "Daily routine",
  description: null,
  snapshot: {
    version: 1,
    routine: {
      id: routineId,
      companyId,
      projectId,
      goalId: null,
      parentIssueId: null,
      title: "Daily routine",
      description: null,
      assigneeAgentId: agentId,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [],
    },
    triggers: [],
  },
  changeSummary: "Created routine",
  restoredFromRevisionId: null,
  createdByAgentId: null,
  createdByUserId: "board-user",
  createdByRunId: null,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
};
const pausedRoutine = {
  ...routine,
  status: "paused",
};
const trigger = {
  id: "66666666-6666-4666-8666-666666666666",
  companyId,
  routineId,
  kind: "schedule",
  label: "weekday",
  enabled: false,
  cronExpression: "0 10 * * 1-5",
  timezone: "UTC",
  nextRunAt: null,
  lastFiredAt: null,
  publicId: null,
  secretId: null,
  signingMode: null,
  replayWindowSec: null,
  lastRotatedAt: null,
  lastResult: null,
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
  updatedAt: new Date("2026-03-20T00:00:00.000Z"),
};

const mockRoutineService = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  getDetail: vi.fn(),
  getDescriptionDocument: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  listRevisions: vi.fn(),
  restoreRevision: vi.fn(),
  listRuns: vi.fn(),
  createTrigger: vi.fn(),
  getTrigger: vi.fn(),
  updateTrigger: vi.fn(),
  deleteTrigger: vi.fn(),
  rotateTriggerSecret: vi.fn(),
  runRoutine: vi.fn(),
  firePublicTrigger: vi.fn(),
}));

const mockAnnotationService = vi.hoisted(() => ({
  listThreadsForRoutineDocument: vi.fn(),
  getThreadForRoutineDocument: vi.fn(),
  createRoutineThread: vi.fn(),
  addRoutineComment: vi.fn(),
  updateRoutineThread: vi.fn(),
  remapOpenThreadsForRoutineDocument: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackRoutineCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

// Hoisted module mocks, not per-test vi.doMock + vi.resetModules: the mock
// registry must be in place before ANY import of the routes module, in every
// test. createApp concurrently imports middleware and route modules whose
// graphs both contain services/index.js. With doMock-registered mocks that
// first evaluation could race the registry under load and bind the REAL
// services module, rejecting the request under test with a 500 (observed on
// CI in the serialized shard; see PRs #381/#383). A hoisted vi.mock applies
// to every import graph deterministically.
vi.mock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackRoutineCreated: mockTrackRoutineCreated,
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/routines.js", () => ({
  routineService: () => mockRoutineService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  documentAnnotationService: () => mockAnnotationService,
  logActivity: mockLogActivity,
  routineService: () => mockRoutineService,
}));

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { routineRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/routines.js")>("../routes/routines.js"),
  ]);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
  app.use((req, _res, next) => {
    (req as any).actor = withActorSource(actor as any);
    next();
  });
  app.use("/api", routineRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("routine routes", () => {
  it("forwards the Fireflies signature and exact raw JSON to the public handler", async () => {
    const app = await createApp({ type: "none" });
    const raw = '{ "event": "meeting.summarized", "meeting_id": "meeting-1", "timestamp": 1780000000000 }';
    mockRoutineService.firePublicTrigger.mockResolvedValue({ status: "ignored", routineStarted: false });
    const res = await request(app).post("/api/routine-triggers/public/fireflies-public/fire")
      .set("Content-Type", "application/json").set("X-Hub-Signature", "sha256=fixture").send(raw);
    expect(res.status).toBe(202);
    expect(mockRoutineService.firePublicTrigger).toHaveBeenCalledWith("fireflies-public", expect.objectContaining({
      firefliesSignatureHeader: "sha256=fixture", rawBody: Buffer.from(raw), payload: JSON.parse(raw),
    }));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockRoutineService.list.mockResolvedValue([routine]);
    mockRoutineService.create.mockResolvedValue(routine);
    mockRoutineService.get.mockResolvedValue(routine);
    mockRoutineService.getTrigger.mockResolvedValue(trigger);
    mockRoutineService.update.mockResolvedValue({ ...routine, assigneeAgentId: otherAgentId });
    mockRoutineService.listRevisions.mockResolvedValue([revision]);
    mockRoutineService.restoreRevision.mockResolvedValue({
      routine,
      revision: { ...revision, revisionNumber: 2, restoredFromRevisionId: revision.id },
      restoredFromRevisionId: revision.id,
      restoredFromRevisionNumber: revision.revisionNumber,
      secretMaterials: [],
    });
    mockRoutineService.runRoutine.mockResolvedValue({
      id: "run-1",
      source: "manual",
      status: "issue_created",
    });
    mockAccessService.canUser.mockResolvedValue(false);
    mockRoutineService.deleteTrigger.mockResolvedValue({ revision: null });
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      action: "routines:manage",
      reason: "deny_missing_grant",
      explanation: "Missing permission: routines:manage.",
    });
    mockLogActivity.mockResolvedValue(undefined);
    mockRoutineService.getDescriptionDocument.mockResolvedValue({
      id: "99999999-9999-4999-8999-999999999999",
      companyId,
      routineId,
      key: "description",
      title: "Routine description",
      format: "markdown",
      body: "Alpha selected text omega",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: null,
      updatedByAgentId: null,
      updatedByUserId: null,
      createdAt: new Date("2026-03-20T00:00:00.000Z"),
      updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    });
    mockAnnotationService.listThreadsForRoutineDocument.mockResolvedValue([]);
    mockAnnotationService.getThreadForRoutineDocument.mockResolvedValue(null);
    const annotationThread = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId,
      issueId: null,
      routineId,
      documentId: "99999999-9999-4999-8999-999999999999",
      documentKey: "description",
      status: "open",
      anchorState: "active",
      anchorConfidence: "exact",
      originalRevisionId: revisionId,
      originalRevisionNumber: 1,
      currentRevisionId: revisionId,
      currentRevisionNumber: 1,
      selectedText: "selected text",
      prefixText: "Alpha ",
      suffixText: " omega",
      normalizedStart: 6,
      normalizedEnd: 19,
      markdownStart: 6,
      markdownEnd: 19,
      anchorSelector: {
        quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
        position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
      },
      createdByAgentId: null,
      createdByUserId: "board-user",
      resolvedByAgentId: null,
      resolvedByUserId: null,
      resolvedAt: null,
      createdAt: new Date("2026-03-20T00:00:00.000Z"),
      updatedAt: new Date("2026-03-20T00:00:00.000Z"),
      comments: [{
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        companyId,
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        issueId: null,
        routineId,
        documentId: "99999999-9999-4999-8999-999999999999",
        body: "Please review",
        authorType: "user",
        authorAgentId: null,
        authorUserId: "board-user",
        createdByRunId: null,
        issueCommentId: null,
        createdAt: new Date("2026-03-20T00:00:00.000Z"),
        updatedAt: new Date("2026-03-20T00:00:00.000Z"),
      }],
    };
    mockAnnotationService.createRoutineThread.mockResolvedValue(annotationThread);
    mockAnnotationService.addRoutineComment.mockResolvedValue({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      companyId,
      threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      issueId: null,
      routineId,
      documentId: "99999999-9999-4999-8999-999999999999",
      body: "Reply",
      authorType: "user",
      authorAgentId: null,
      authorUserId: "board-user",
      createdByRunId: null,
      issueCommentId: null,
      createdAt: new Date("2026-03-20T00:00:00.000Z"),
      updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    });
    mockAnnotationService.updateRoutineThread.mockResolvedValue({
      ...annotationThread,
      status: "resolved",
    });
    mockAnnotationService.remapOpenThreadsForRoutineDocument.mockResolvedValue([]);
  });

  it("passes project filters to the routine list service", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/routines`)
      .query({ projectId });

    expect(res.status).toBe(200);
    expect(mockRoutineService.list).toHaveBeenCalledWith(companyId, { projectId });
  });

  it.each([
    ["1.5", 1],
    ["7.9", 7],
    ["25", 25],
    ["abc", 50],
    [undefined, 50],
  ])("passes an integer run limit to the routine runs service (limit=%s)", async (rawLimit, expected) => {
    mockRoutineService.listRuns.mockResolvedValue([]);
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const req = request(app).get(`/api/routines/${routineId}/runs`);
    const res = await (rawLimit === undefined ? req : req.query({ limit: rawLimit }));

    expect(res.status).toBe(200);
    expect(mockRoutineService.listRuns).toHaveBeenCalledWith(routineId, expected);
    expect(Number.isInteger(mockRoutineService.listRuns.mock.calls.at(-1)?.[1])).toBe(true);
  });

  it("lists routine revisions for a board member in newest-first service order", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/routines/${routineId}/revisions`);

    expect(res.status).toBe(200);
    expect(mockRoutineService.listRevisions).toHaveBeenCalledWith(routineId);
    expect(res.body[0]).toMatchObject({ id: revisionId, revisionNumber: 1 });
  });

  it("creates, replies to, and resolves routine description annotation threads", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const selector = {
      quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
      position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
    };

    const created = await request(app)
      .post(`/api/routines/${routineId}/description/annotations`)
      .send({
        baseRevisionId: revisionId,
        baseRevisionNumber: 1,
        selector,
        body: "Please review",
      })
      .expect(201);

    expect(created.body).toMatchObject({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      routineId,
      issueId: null,
      documentKey: "description",
    });
    expect(mockAnnotationService.createRoutineThread).toHaveBeenCalledWith(
      routineId,
      "description",
      expect.objectContaining({ body: "Please review" }),
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "routine.document_annotation_thread_created",
      entityType: "routine",
      entityId: routineId,
      details: expect.objectContaining({ documentKey: "description" }),
    }));

    await request(app)
      .post(`/api/routines/${routineId}/description/annotations/${created.body.id}/comments`)
      .send({ body: "Reply" })
      .expect(201);
    expect(mockAnnotationService.addRoutineComment).toHaveBeenCalledWith(
      routineId,
      "description",
      created.body.id,
      expect.objectContaining({ body: "Reply" }),
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "routine.document_annotation_comment_added",
      entityType: "routine",
      entityId: routineId,
    }));

    const resolved = await request(app)
      .patch(`/api/routines/${routineId}/description/annotations/${created.body.id}`)
      .send({ status: "resolved" })
      .expect(200);

    expect(resolved.body.status).toBe("resolved");
    expect(mockAnnotationService.updateRoutineThread).toHaveBeenCalledWith(
      routineId,
      "description",
      created.body.id,
      expect.objectContaining({ status: "resolved" }),
      expect.objectContaining({ actorType: "user", userId: "board-user" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "routine.document_annotation_thread_resolved",
      entityType: "routine",
      entityId: routineId,
    }));
  });

  it("blocks routine revision reads across company scope", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["99999999-9999-4999-8999-999999999999"],
    });

    const res = await request(app).get(`/api/routines/${routineId}/revisions`);

    expect(res.status).toBe(404);
    expect(mockRoutineService.listRevisions).not.toHaveBeenCalled();
  });

  it("returns an identical 404 body for missing and cross-tenant routine triggers", async () => {
    const crossTenantApp = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["99999999-9999-4999-8999-999999999999"],
    });
    const crossTenant = await request(crossTenantApp)
      .patch(`/api/routine-triggers/${trigger.id}`)
      .send({ kind: "cron", config: { expression: "0 9 * * *" } });

    mockRoutineService.getTrigger.mockResolvedValue(null);
    const missing = await request(crossTenantApp)
      .patch(`/api/routine-triggers/${trigger.id}`)
      .send({ kind: "cron", config: { expression: "0 9 * * *" } });

    expect(crossTenant.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(crossTenant.body).toEqual(missing.body);
    expect(mockRoutineService.updateTrigger).not.toHaveBeenCalled();
  });

  it("requires an assigned agent for routine revision history access", async () => {
    const app = await createApp({
      type: "agent",
      agentId: otherAgentId,
      companyId,
    });

    const res = await request(app).get(`/api/routines/${routineId}/revisions`);

    expect(res.status).toBe(403);
    expect(mockRoutineService.listRevisions).not.toHaveBeenCalled();
  });

  it("restores routine revisions with existing routine-management permissions", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "88888888-8888-4888-8888-888888888888",
    });

    const res = await request(app).post(`/api/routines/${routineId}/revisions/${revisionId}/restore`).send({});

    expect(res.status).toBe(200);
    expect(mockRoutineService.restoreRevision).toHaveBeenCalledWith(routineId, revisionId, {
      agentId,
      userId: null,
      runId: "88888888-8888-4888-8888-888888888888",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "routine.revision_restored",
      entityId: routineId,
      runId: "88888888-8888-4888-8888-888888888888",
    }));
  });

  it("requires tasks:assign permission for non-admin board routine creation", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Daily routine",
        assigneeAgentId: agentId,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.create).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to retarget a routine assignee", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({
        assigneeAgentId: otherAgentId,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.update).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to reactivate a routine", async () => {
    mockRoutineService.get.mockResolvedValue(pausedRoutine);
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({
        status: "active",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.update).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to create a trigger", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/routines/${routineId}/triggers`)
      .send({
        kind: "schedule",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.createTrigger).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to update a trigger", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/routine-triggers/${trigger.id}`)
      .send({
        enabled: true,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.updateTrigger).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to manually run a routine", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/routines/${routineId}/run`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.runRoutine).not.toHaveBeenCalled();
  });

  it("passes the board actor through when manually running a routine", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/routines/${routineId}/run`)
      .send({});

    expect(res.status).toBe(202);
    expect(mockRoutineService.runRoutine).toHaveBeenCalledWith(routineId, {
      source: "manual",
    }, {
      agentId: null,
      userId: "board-user",
    });
  });

  it("allows routine creation when the board user has tasks:assign", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Daily routine",
        assigneeAgentId: agentId,
      });

    expect(res.status).toBe(201);
    expect(mockRoutineService.create).toHaveBeenCalledWith(companyId, expect.objectContaining({
      projectId,
      title: "Daily routine",
      assigneeAgentId: agentId,
    }), {
      agentId: null,
      userId: "board-user",
      runId: null,
    });
    expect(mockTrackRoutineCreated).toHaveBeenCalledWith(expect.anything());
  });

  it("rejects a nested triggers array on routine creation instead of silently dropping it", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Daily routine",
        assigneeAgentId: agentId,
        triggers: [{ kind: "schedule", cronExpression: "0 9 * * *", timezone: "UTC" }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(res.body.details).toEqual([expect.objectContaining({
      code: "unrecognized_keys",
      keys: ["triggers"],
      // Merged zod (v4, pinned by upstream v2026.831.1) wording for the same issue.
      message: "Unrecognized key: \"triggers\"",
    })]);
    expect(mockRoutineService.create).not.toHaveBeenCalled();
  });

  it("rejects a nested triggers array on routine update instead of silently dropping it", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({
        title: "Daily routine",
        triggers: [{ kind: "schedule", cronExpression: "0 9 * * *", timezone: "UTC" }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(res.body.details).toEqual([expect.objectContaining({
      code: "unrecognized_keys",
      keys: ["triggers"],
      // Merged zod (v4, pinned by upstream v2026.831.1) wording for the same issue.
      message: "Unrecognized key: \"triggers\"",
    })]);
    expect(mockRoutineService.update).not.toHaveBeenCalled();
  });
  describe("routines:manage grant for non-assignee agents", () => {
    const grantee = { type: "agent", agentId: otherAgentId, companyId, runId: "88888888-8888-4888-8888-888888888888" };
    const allowManage = () =>
      mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
        allowed: input.action === "routines:manage",
        action: input.action,
        reason: input.action === "routines:manage" ? "allow_explicit_grant" : "deny_missing_grant",
        explanation: "test",
      }));

    const routeCases: Array<{ name: string; send: (app: express.Express) => request.Test }> = [
      { name: "PATCH /routines/:id", send: (app) => request(app).patch(`/api/routines/${routineId}`).send({ title: "Renamed" }) },
      { name: "GET /routines/:id/revisions", send: (app) => request(app).get(`/api/routines/${routineId}/revisions`) },
      { name: "GET /routines/:id/description/annotations", send: (app) => request(app).get(`/api/routines/${routineId}/description/annotations`) },
      { name: "POST /routines/:id/revisions/:revisionId/restore", send: (app) => request(app).post(`/api/routines/${routineId}/revisions/${revisionId}/restore`).send({}) },
      { name: "DELETE /routine-triggers/:id", send: (app) => request(app).delete(`/api/routine-triggers/${trigger.id}`) },
    ];

    for (const routeCase of routeCases) {
      it(`${routeCase.name}: 403 without grant, passes the gate with grant`, async () => {
        const app = await createApp(grantee);
        const denied = await routeCase.send(app);
        expect(denied.status).toBe(403);
        expect(denied.body.error).toBe("Agents can only manage routines assigned to themselves");

        allowManage();
        const allowed = await routeCase.send(app);
        expect(allowed.status).not.toBe(403);
        expect(allowed.status).toBeLessThan(500);
        expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
          action: "routines:manage",
          resource: { type: "agent", companyId, agentId },
          scope: { targetAgentId: agentId },
        }));
      });
    }

    it("PATCH returns 200 for a grantee and logs routine.updated with the acting agent", async () => {
      allowManage();
      mockRoutineService.update.mockResolvedValue({ ...routine, title: "Renamed" });
      const app = await createApp(grantee);
      const res = await request(app).patch(`/api/routines/${routineId}`).send({ title: "Renamed" });
      expect(res.status).toBe(200);
      expect(mockRoutineService.update).toHaveBeenCalledWith(routineId, { title: "Renamed" }, expect.objectContaining({
        agentId: otherAgentId,
      }));
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "routine.updated",
        actorType: "agent",
        agentId: otherAgentId,
      }));
    });

    it("lets a grantee echo the unchanged assignee but never re-assign", async () => {
      allowManage();
      mockRoutineService.update.mockResolvedValue(routine);
      const app = await createApp(grantee);
      const echo = await request(app).patch(`/api/routines/${routineId}`).send({ assigneeAgentId: agentId });
      expect(echo.status).toBe(200);

      mockRoutineService.update.mockClear();
      const toSelf = await request(app).patch(`/api/routines/${routineId}`).send({ assigneeAgentId: otherAgentId });
      expect(toSelf.status).toBe(403);
      expect(toSelf.body.error).toBe("Agents can only assign routines to themselves");
      const third = "99999999-9999-4999-8999-999999999990";
      const toThird = await request(app).patch(`/api/routines/${routineId}`).send({ assigneeAgentId: third });
      expect(toThird.status).toBe(403);
      expect(toThird.body.error).toBe("Agents can only assign routines to themselves");
      expect(mockRoutineService.update).not.toHaveBeenCalled();
    });

    it("requires tasks:assign for a grantee to activate another agent's routine", async () => {
      allowManage();
      mockRoutineService.get.mockResolvedValue(pausedRoutine);
      const app = await createApp(grantee);
      const denied = await request(app).patch(`/api/routines/${routineId}`).send({ status: "active" });
      expect(denied.status).toBe(403);
      expect(denied.body.error).toContain("tasks:assign");
      expect(mockRoutineService.update).not.toHaveBeenCalled();

      mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
        allowed: true, action: input.action, reason: "allow_explicit_grant", explanation: "test",
      }));
      mockRoutineService.update.mockResolvedValue(routine);
      const allowed = await request(app).patch(`/api/routines/${routineId}`).send({ status: "active" });
      expect(allowed.status).toBe(200);
      expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({ action: "tasks:assign" }));
    });

    const startWorkCases: Array<{ name: string; send: (app: express.Express) => request.Test; svcFn: () => ReturnType<typeof vi.fn> }> = [
      { name: "POST /routines/:id/run", send: (app) => request(app).post(`/api/routines/${routineId}/run`).send({}), svcFn: () => mockRoutineService.runRoutine },
      { name: "POST /routines/:id/triggers", send: (app) => request(app).post(`/api/routines/${routineId}/triggers`).send({ kind: "schedule", cronExpression: "0 * * * *", timezone: "UTC" }), svcFn: () => mockRoutineService.createTrigger },
      { name: "PATCH /routine-triggers/:id enabled=true", send: (app) => request(app).patch(`/api/routine-triggers/${trigger.id}`).send({ enabled: true }), svcFn: () => mockRoutineService.updateTrigger },
      { name: "POST /routine-triggers/:id/rotate-secret", send: (app) => request(app).post(`/api/routine-triggers/${trigger.id}/rotate-secret`).send({}), svcFn: () => mockRoutineService.rotateTriggerSecret },
    ];

    for (const c of startWorkCases) {
      it(`${c.name}: grantee without tasks:assign gets 403 and starts no work`, async () => {
        allowManage();
        const app = await createApp(grantee);
        const denied = await c.send(app);
        expect(denied.status).toBe(403);
        expect(denied.body.error).toContain("tasks:assign");
        expect(c.svcFn()).not.toHaveBeenCalled();
        expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
          action: "tasks:assign",
          scope: { assigneeAgentId: agentId },
        }));

        mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
          allowed: true, action: input.action, reason: "allow_explicit_grant", explanation: "test",
        }));
        mockRoutineService.createTrigger.mockResolvedValue({
          trigger,
          secretMaterial: null,
          revision: { id: revisionId, revisionNumber: 2, changeSummary: null, snapshot: { triggers: [trigger] } },
        });
        mockRoutineService.rotateTriggerSecret.mockResolvedValue({
          trigger,
          secretMaterial: { webhookUrl: "https://example.test/hook", webhookSecret: "test-only" },
          revision: { id: revisionId, revisionNumber: 2, changeSummary: null, snapshot: { triggers: [trigger] } },
        });
        const allowed = await c.send(app);
        expect(allowed.status).not.toBe(403);
        expect(allowed.status).toBeLessThan(500);
      });
    }

    it("PATCH /routine-triggers/:id without enabled=true does not need tasks:assign", async () => {
      allowManage();
      const app = await createApp(grantee);
      const res = await request(app).patch(`/api/routine-triggers/${trigger.id}`).send({ enabled: false });
      expect(res.status).not.toBe(403);
      expect(res.status).toBeLessThan(500);
      expect(mockAccessService.decide).not.toHaveBeenCalledWith(expect.objectContaining({ action: "tasks:assign" }));
    });

    it("does not let a grantee create routines for another agent", async () => {
      allowManage();
      const app = await createApp(grantee);
      const res = await request(app)
        .post(`/api/companies/${companyId}/routines`)
        .send({ projectId, title: "Other", assigneeAgentId: agentId });
      expect(res.status).toBe(403);
      expect(mockRoutineService.create).not.toHaveBeenCalled();
    });

    it("stays 403 cross-company even when the grant check would allow", async () => {
      allowManage();
      mockRoutineService.get.mockResolvedValue({ ...routine, companyId: "99999999-9999-4999-8999-999999999991" });
      const app = await createApp(grantee);
      const res = await request(app).patch(`/api/routines/${routineId}`).send({ title: "x" });
      expect([403, 404]).toContain(res.status);
      expect(mockRoutineService.update).not.toHaveBeenCalled();
      expect(mockAccessService.decide).not.toHaveBeenCalled();
    });
  });
});
