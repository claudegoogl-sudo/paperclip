import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { PLUGIN_EVENT_TYPES } from "@paperclipai/shared";

const mockGetGeneral = vi.hoisted(() => vi.fn(async () => ({ censorUsernameInLogs: false })));
const mockPublishLiveEvent = vi.hoisted(() => vi.fn());

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ getGeneral: mockGetGeneral }),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: mockPublishLiveEvent,
}));

const {
  eventTypeForActivityAction,
  pluginPayloadExtrasForActivityAction,
  projectInteractionForPluginEvent,
  logActivity,
  setPluginEventBus,
} = await import("../services/activity-log.ts");

type PluginEventBusLike = Parameters<typeof setPluginEventBus>[0];

function makeFakeDb() {
  const insertedValues: unknown[] = [];
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn((value: unknown) => {
        insertedValues.push(value);
        return {
          returning: vi.fn(async () => [{ id: "activity-1" }]),
        };
      }),
    })),
    // Upstream v2026.824.1: logActivity resolves the run's responsible user
    // before persisting; no runs exist in this suite's stub.
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
    })),
  };
  return { db: db as unknown as Parameters<typeof logActivity>[0], insertedValues };
}

function makeCapturingBus() {
  const emitted: PluginEvent[] = [];
  const bus = {
    emit: vi.fn(async (event: PluginEvent) => {
      emitted.push(event);
      return { errors: [] as Array<{ pluginId: string; error: unknown }> };
    }),
  } satisfies Partial<PluginEventBusLike>;
  return { bus: bus as unknown as PluginEventBusLike, emitted };
}

describe("activity-log plugin event bridge — issue.interaction.*", () => {
  beforeEach(() => {
    mockGetGeneral.mockReset();
    mockGetGeneral.mockResolvedValue({ censorUsernameInLogs: false });
    mockPublishLiveEvent.mockReset();
  });

  it("registers the new issue.interaction.* event types in PLUGIN_EVENT_TYPES", () => {
    expect(PLUGIN_EVENT_TYPES).toContain("issue.interaction.created");
    expect(PLUGIN_EVENT_TYPES).toContain("issue.interaction.responded");
  });

  it("maps interaction activity actions to plugin event types", () => {
    expect(eventTypeForActivityAction("issue.thread_interaction_created")).toBe("issue.interaction.created");
    expect(eventTypeForActivityAction("issue.thread_interaction_accepted")).toBe("issue.interaction.responded");
    expect(eventTypeForActivityAction("issue.thread_interaction_rejected")).toBe("issue.interaction.responded");
    expect(eventTypeForActivityAction("issue.thread_interaction_answered")).toBe("issue.interaction.responded");
  });

  it("does not bridge cancellation or expiration to a plugin event", () => {
    expect(eventTypeForActivityAction("issue.thread_interaction_cancelled")).toBeNull();
    expect(eventTypeForActivityAction("issue.thread_interaction_expired")).toBeNull();
  });

  it("supplies an outcome only for bridged interaction actions", () => {
    expect(pluginPayloadExtrasForActivityAction("issue.thread_interaction_created")).toEqual({ outcome: "created" });
    expect(pluginPayloadExtrasForActivityAction("issue.thread_interaction_accepted")).toEqual({ outcome: "accepted" });
    expect(pluginPayloadExtrasForActivityAction("issue.thread_interaction_rejected")).toEqual({ outcome: "rejected" });
    expect(pluginPayloadExtrasForActivityAction("issue.thread_interaction_answered")).toEqual({ outcome: "answered" });
    expect(pluginPayloadExtrasForActivityAction("issue.comment.created")).toEqual({});
  });

  it("emits issue.interaction.created with the expected payload shape", async () => {
    const { bus, emitted } = makeCapturingBus();
    setPluginEventBus(bus);
    const { db } = makeFakeDb();

    const companyId = "00000000-0000-4000-8000-000000000001";
    const issueId = "00000000-0000-4000-8000-000000000002";
    const interactionId = "00000000-0000-4000-8000-000000000003";
    const actorId = "00000000-0000-4000-8000-000000000004";
    const agentId = "00000000-0000-4000-8000-000000000005";
    const runId = "00000000-0000-4000-8000-000000000006";

    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId,
      agentId,
      runId,
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: issueId,
      details: {
        interactionId,
        interactionKind: "request_confirmation",
        interactionStatus: "pending",
        continuationPolicy: "wake_assignee",
      },
    });

    await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: 1_000 });

    const event = emitted[0];
    expect(event).toMatchObject({
      eventType: "issue.interaction.created",
      entityType: "issue",
      entityId: issueId,
      companyId,
      actorType: "agent",
      actorId,
    });
    expect(event.payload).toMatchObject({
      interactionId,
      interactionKind: "request_confirmation",
      outcome: "created",
      agentId,
      runId,
    });
  });

  it("carries the projected interaction questions/options on issue.interaction.created", async () => {
    const { bus, emitted } = makeCapturingBus();
    setPluginEventBus(bus);
    const { db } = makeFakeDb();

    const issueId = "00000000-0000-4000-8000-0000000000a2";
    const interaction = {
      id: "00000000-0000-4000-8000-0000000000a3",
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        title: "Pick a deploy target",
        questions: [
          {
            id: "q1",
            prompt: "Which environment?",
            selectionMode: "single",
            options: [
              { id: "staging", label: "Staging", description: "Non-prod" },
              { id: "prod", label: "Production" },
            ],
          },
        ],
      },
    };

    await logActivity(db, {
      companyId: "00000000-0000-4000-8000-0000000000a1",
      actorType: "agent",
      actorId: "00000000-0000-4000-8000-0000000000a4",
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: issueId,
      details: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: interaction.status,
        continuationPolicy: interaction.continuationPolicy,
        interaction: projectInteractionForPluginEvent(interaction),
      },
    });

    await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: 1_000 });
    expect(emitted[0].payload).toMatchObject({
      interactionId: interaction.id,
      interactionKind: "ask_user_questions",
      interaction: {
        id: interaction.id,
        kind: "ask_user_questions",
        title: "Pick a deploy target",
        questions: [
          {
            id: "q1",
            prompt: "Which environment?",
            selectionMode: "single",
            options: [
              { id: "staging", label: "Staging", description: "Non-prod" },
              { id: "prod", label: "Production" },
            ],
          },
        ],
      },
    });
  });

  describe("projectInteractionForPluginEvent", () => {
    it("projects request_confirmation into a single-select accept/reject question", () => {
      const projected = projectInteractionForPluginEvent({
        id: "int-1",
        kind: "request_confirmation",
        payload: {
          version: 1,
          prompt: "Ship the release?",
          acceptLabel: "Ship it",
          rejectLabel: "Hold",
        },
      });
      expect(projected).toEqual({
        id: "int-1",
        kind: "request_confirmation",
        questions: [
          {
            id: "int-1",
            prompt: "Ship the release?",
            selectionMode: "single",
            options: [
              { id: "accept", label: "Ship it" },
              { id: "reject", label: "Hold" },
            ],
          },
        ],
      });
    });

    it("defaults accept/reject labels for request_confirmation", () => {
      const projected = projectInteractionForPluginEvent({
        id: "int-1b",
        kind: "request_confirmation",
        payload: { version: 1, prompt: "Proceed?" },
      });
      expect(projected?.questions[0].options).toEqual([
        { id: "accept", label: "Accept" },
        { id: "reject", label: "Reject" },
      ]);
    });

    it("projects request_checkbox_confirmation into a multi-select question", () => {
      const projected = projectInteractionForPluginEvent({
        id: "int-2",
        kind: "request_checkbox_confirmation",
        payload: {
          version: 1,
          prompt: "Pick files to delete",
          options: [
            { id: "a", label: "a.txt", description: "old" },
            { id: "b", label: "b.txt" },
          ],
        },
      });
      expect(projected).toEqual({
        id: "int-2",
        kind: "request_checkbox_confirmation",
        questions: [
          {
            id: "int-2",
            prompt: "Pick files to delete",
            selectionMode: "multi",
            options: [
              { id: "a", label: "a.txt", description: "old" },
              { id: "b", label: "b.txt" },
            ],
          },
        ],
      });
    });

    it("projects suggest_tasks into a multi-select of task drafts", () => {
      const projected = projectInteractionForPluginEvent({
        id: "int-3",
        kind: "suggest_tasks",
        payload: {
          version: 1,
          tasks: [
            { clientKey: "t1", title: "Fix bug", description: "the login bug" },
            { clientKey: "t2", title: "Write docs" },
          ],
        },
      });
      expect(projected).toEqual({
        id: "int-3",
        kind: "suggest_tasks",
        questions: [
          {
            id: "int-3",
            prompt: "Proposed tasks",
            selectionMode: "multi",
            options: [
              { id: "t1", label: "Fix bug", description: "the login bug" },
              { id: "t2", label: "Write docs" },
            ],
          },
        ],
      });
    });

    it("caps option description to 200 chars and total options/questions", () => {
      const longDescription = "x".repeat(500);
      const manyOptions = Array.from({ length: 40 }, (_, i) => ({
        id: `o${i}`,
        label: `Option ${i}`,
        description: longDescription,
      }));
      const manyQuestions = Array.from({ length: 25 }, (_, i) => ({
        id: `q${i}`,
        prompt: `Question ${i}`,
        selectionMode: "single" as const,
        options: manyOptions,
      }));
      const projected = projectInteractionForPluginEvent({
        id: "int-4",
        kind: "ask_user_questions",
        payload: { version: 1, questions: manyQuestions },
      });
      expect(projected?.questions.length).toBe(20);
      expect(projected?.questions[0].options.length).toBe(30);
      expect(projected?.questions[0].options[0].description?.length).toBe(200);
    });

    it("returns null for a missing or malformed interaction", () => {
      expect(projectInteractionForPluginEvent(null)).toBeNull();
      expect(projectInteractionForPluginEvent(undefined)).toBeNull();
      expect(projectInteractionForPluginEvent({ id: "x" } as never)).toBeNull();
    });

    it("projects an unknown kind to an empty questions list without throwing", () => {
      const projected = projectInteractionForPluginEvent({
        id: "int-5",
        kind: "something_new",
        payload: { anything: true },
      });
      expect(projected).toEqual({ id: "int-5", kind: "something_new", questions: [] });
    });
  });

  it("emits issue.interaction.responded with outcome=accepted for accept activities", async () => {
    const { bus, emitted } = makeCapturingBus();
    setPluginEventBus(bus);
    const { db } = makeFakeDb();

    const issueId = "00000000-0000-4000-8000-000000000010";
    const interactionId = "00000000-0000-4000-8000-000000000011";

    await logActivity(db, {
      companyId: "00000000-0000-4000-8000-000000000020",
      actorType: "user",
      actorId: "00000000-0000-4000-8000-000000000021",
      action: "issue.thread_interaction_accepted",
      entityType: "issue",
      entityId: issueId,
      details: {
        interactionId,
        interactionKind: "suggest_tasks",
        interactionStatus: "accepted",
        createdTaskCount: 2,
        skippedTaskCount: 0,
      },
    });

    await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: 1_000 });

    expect(emitted[0]).toMatchObject({
      eventType: "issue.interaction.responded",
      entityType: "issue",
      entityId: issueId,
    });
    expect(emitted[0].payload).toMatchObject({
      interactionId,
      interactionKind: "suggest_tasks",
      outcome: "accepted",
    });
  });

  it("emits issue.interaction.responded with outcome=rejected for reject activities", async () => {
    const { bus, emitted } = makeCapturingBus();
    setPluginEventBus(bus);
    const { db } = makeFakeDb();

    await logActivity(db, {
      companyId: "00000000-0000-4000-8000-000000000030",
      actorType: "user",
      actorId: "00000000-0000-4000-8000-000000000031",
      action: "issue.thread_interaction_rejected",
      entityType: "issue",
      entityId: "00000000-0000-4000-8000-000000000032",
      details: {
        interactionId: "00000000-0000-4000-8000-000000000033",
        interactionKind: "request_confirmation",
        interactionStatus: "rejected",
        rejectionReason: "not aligned",
      },
    });

    await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: 1_000 });
    expect(emitted[0].eventType).toBe("issue.interaction.responded");
    expect(emitted[0].payload).toMatchObject({ outcome: "rejected" });
  });

  it("emits issue.interaction.responded with outcome=answered for answer activities", async () => {
    const { bus, emitted } = makeCapturingBus();
    setPluginEventBus(bus);
    const { db } = makeFakeDb();

    await logActivity(db, {
      companyId: "00000000-0000-4000-8000-000000000040",
      actorType: "user",
      actorId: "00000000-0000-4000-8000-000000000041",
      action: "issue.thread_interaction_answered",
      entityType: "issue",
      entityId: "00000000-0000-4000-8000-000000000042",
      details: {
        interactionId: "00000000-0000-4000-8000-000000000043",
        interactionKind: "ask_user_questions",
        interactionStatus: "answered",
        answeredQuestionCount: 3,
      },
    });

    await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: 1_000 });
    expect(emitted[0].eventType).toBe("issue.interaction.responded");
    expect(emitted[0].payload).toMatchObject({ outcome: "answered", answeredQuestionCount: 3 });
  });

  it("does not emit a plugin event for cancelled or expired interactions", async () => {
    const { bus, emitted } = makeCapturingBus();
    setPluginEventBus(bus);
    const { db } = makeFakeDb();

    await logActivity(db, {
      companyId: "00000000-0000-4000-8000-000000000050",
      actorType: "system",
      actorId: "system",
      action: "issue.thread_interaction_cancelled",
      entityType: "issue",
      entityId: "00000000-0000-4000-8000-000000000051",
      details: { interactionId: "00000000-0000-4000-8000-000000000052", interactionKind: "ask_user_questions" },
    });

    await logActivity(db, {
      companyId: "00000000-0000-4000-8000-000000000060",
      actorType: "system",
      actorId: "system",
      action: "issue.thread_interaction_expired",
      entityType: "issue",
      entityId: "00000000-0000-4000-8000-000000000061",
      details: { interactionId: "00000000-0000-4000-8000-000000000062" },
    });

    // give microtasks a chance to flush — there should be no emissions.
    await new Promise((resolve) => setImmediate(resolve));
    expect(emitted).toEqual([]);
  });
});
