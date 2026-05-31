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
  logActivity,
  setPluginEventBus,
} = await import("../services/activity-log.ts");

type PluginEventBusLike = Parameters<typeof setPluginEventBus>[0];

function makeFakeDb() {
  const insertedValues: unknown[] = [];
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn(async (value: unknown) => {
        insertedValues.push(value);
      }),
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
