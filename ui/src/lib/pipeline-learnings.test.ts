import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineCompanyCaseEvent } from "../api/pipelines";
import {
  formatLearningEvent,
  groupLearningEventsByDay,
  learningDayKey,
  learningDayLabel,
} from "./pipeline-learnings";

function buildEvent(overrides: Partial<PipelineCompanyCaseEvent> = {}): PipelineCompanyCaseEvent {
  return {
    id: "event-1",
    companyId: "company-1",
    caseId: "case-1",
    type: "review_decided",
    actorType: "agent",
    payload: {},
    case: { id: "case-1", caseKey: null, title: "Fix the thing" },
    pipeline: { id: "pipeline-1", key: "default", name: "Default" },
    createdAt: "2026-01-15T12:00:00.000Z",
    updatedAt: "2026-01-15T12:00:00.000Z",
    ...overrides,
  } as PipelineCompanyCaseEvent;
}

describe("formatLearningEvent", () => {
  it("formats an approved review decision using the actor and item title", () => {
    const event = buildEvent({
      payload: { decision: "approve" },
      actorAgent: { id: "agent-1", name: "Reviewer Bot" },
    });

    const result = formatLearningEvent(event);

    expect(result.kind).toBe("review");
    expect(result.sentence).toBe("Reviewer Bot approved 'Fix the thing'.");
  });

  it("formats a request_changes decision as 'sent back' and includes the target stage and note", () => {
    const event = buildEvent({
      payload: { decision: "request_changes", reason: "needs tests" },
      actorAgent: { id: "agent-1", name: "Reviewer Bot" },
      toStage: { id: "stage-2", key: "in_progress", name: "In Progress", kind: "active" },
    });

    const result = formatLearningEvent(event);

    expect(result.kind).toBe("review");
    expect(result.sentence).toBe(
      "Reviewer Bot sent back 'Fix the thing' moving to In Progress - note: needs tests.",
    );
  });

  it("formats reject and drop decisions as 'declined'", () => {
    const rejected = formatLearningEvent(buildEvent({ payload: { decision: "reject" } }));
    const dropped = formatLearningEvent(buildEvent({ payload: { decision: "drop" } }));

    expect(rejected.sentence).toBe("Someone declined 'Fix the thing'.");
    expect(dropped.sentence).toBe("Someone declined 'Fix the thing'.");
  });

  it("falls back to payload-derived actor, title, and stage names when relations are absent", () => {
    const event = buildEvent({
      case: { id: "case-1", caseKey: null, title: "" },
      payload: {
        decision: "approve",
        reviewerName: "Payload Reviewer",
        caseTitle: "Payload Title",
        toStageName: "Payload Stage",
      },
    });

    const result = formatLearningEvent(event);

    expect(result.sentence).toBe("Payload Reviewer approved 'Payload Title' moving to Payload Stage.");
  });

  it("formats a forced transition with from/to stage names and a reason", () => {
    const event = buildEvent({
      type: "transition_forced",
      payload: { reason: "escalated by lead" },
      fromStage: { id: "stage-1", key: "backlog", name: "Backlog", kind: "queue" },
      toStage: { id: "stage-3", key: "done", name: "Done", kind: "terminal" },
    });

    const result = formatLearningEvent(event);

    expect(result.kind).toBe("forced_move");
    expect(result.sentence).toBe(
      "'Fix the thing' was moved by hand from Backlog to Done - reason: escalated by lead.",
    );
  });

  it("falls back to a generic sentence for an unrecognized event type", () => {
    const event = buildEvent({ type: "some_other_event" });

    const result = formatLearningEvent(event);

    expect(result.kind).toBe("unknown");
    expect(result.sentence).toBe("'Fix the thing' changed.");
  });

  it("falls back to 'Untitled item' when no title can be resolved", () => {
    const event = buildEvent({
      type: "some_other_event",
      case: { id: "case-1", caseKey: null, title: "" },
      payload: {},
    });

    const result = formatLearningEvent(event);

    expect(result.sentence).toBe("'Untitled item' changed.");
  });
});

describe("learningDayKey", () => {
  it("returns the UTC calendar day as an ISO date string", () => {
    expect(learningDayKey("2026-01-15T12:00:00.000Z")).toBe("2026-01-15");
  });

  it("accepts a Date instance as well as a string", () => {
    expect(learningDayKey(new Date("2026-01-15T12:00:00.000Z"))).toBe("2026-01-15");
  });

  it("returns 'Unknown' for an unparsable value", () => {
    expect(learningDayKey("not-a-date")).toBe("Unknown");
  });

  it("assigns different keys to two timestamps 1ms apart that straddle a UTC midnight boundary", () => {
    // These two instants are only 1 millisecond apart in absolute time, but
    // learningDayKey buckets purely by UTC calendar day (via toISOString),
    // so they land in different day keys.
    const justBeforeUtcMidnight = learningDayKey("2026-01-15T23:59:59.999Z");
    const justAfterUtcMidnight = learningDayKey("2026-01-16T00:00:00.000Z");

    expect(justBeforeUtcMidnight).toBe("2026-01-15");
    expect(justAfterUtcMidnight).toBe("2026-01-16");
    expect(justBeforeUtcMidnight).not.toBe(justAfterUtcMidnight);
  });

  it(
    "KNOWN BUG: uses UTC day boundaries, inconsistent with learningDayLabel's local-day boundaries " +
      "(tracked for a follow-up fix PR, not fixed here)",
    () => {
      // learningDayLabel (below) buckets "today"/"yesterday" using the LOCAL
      // calendar day (new Date(y, m, d) constructed from local getters), while
      // learningDayKey buckets using the UTC calendar day (toISOString().slice(0, 10)).
      // In a non-UTC timezone this means groupLearningEventsByDay can key two
      // events that fall on the same *local* calendar day into two different
      // groups (or merge events from two different local days into one group),
      // whenever the local day boundary and the UTC day boundary fall on
      // opposite sides of an event's timestamp. This test pins the current
      // (buggy) UTC-only behavior of learningDayKey so a regression test in
      // the follow-up fix PR can flip it once the boundary is made consistent
      // with learningDayLabel.
      const originalTz = process.env.TZ;
      process.env.TZ = "America/Los_Angeles"; // UTC-8 (standard time)
      try {
        // 2026-01-15T23:30:00-08:00 local time is still "Jan 15" locally,
        // but it is 2026-01-16T07:30:00Z, i.e. "Jan 16" in UTC.
        const lateLocalEvening = "2026-01-15T23:30:00-08:00";
        expect(learningDayKey(lateLocalEvening)).toBe("2026-01-16");

        // Confirm the same instant's *local* label still calls it "Jan 15"-ish,
        // i.e. a different calendar day than the key above reports.
        const localDate = new Date(lateLocalEvening);
        expect(localDate.getFullYear()).toBe(2026);
        expect(localDate.getMonth()).toBe(0); // January
        expect(localDate.getDate()).toBe(15);
      } finally {
        process.env.TZ = originalTz;
      }
    },
  );
});

describe("learningDayLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("labels an event from the current local calendar day as 'Today'", () => {
    vi.setSystemTime(new Date("2026-01-15T18:00:00.000Z"));
    expect(learningDayLabel("2026-01-15T08:00:00.000Z")).toBe("Today");
  });

  it("labels an event from the previous local calendar day as 'Yesterday'", () => {
    vi.setSystemTime(new Date("2026-01-15T18:00:00.000Z"));
    expect(learningDayLabel("2026-01-14T23:00:00.000Z")).toBe("Yesterday");
  });

  it("falls back to a short formatted date for events older than yesterday", () => {
    vi.setSystemTime(new Date("2026-01-15T18:00:00.000Z"));
    expect(learningDayLabel("2026-01-01T12:00:00.000Z")).toBe("Jan 1");
  });

  it("treats a timestamp 1ms before local midnight as 'Yesterday', not 'Today'", () => {
    // The test environment's timezone is UTC, so local midnight coincides
    // with UTC midnight here; this pins learningDayLabel's intent to bucket
    // by local calendar day boundaries.
    vi.setSystemTime(new Date("2026-01-15T00:00:00.000Z"));
    expect(learningDayLabel("2026-01-14T23:59:59.999Z")).toBe("Yesterday");
    expect(learningDayLabel("2026-01-15T00:00:00.000Z")).toBe("Today");
  });

  it("returns 'Unknown' for an unparsable value", () => {
    expect(learningDayLabel("not-a-date")).toBe("Unknown");
  });
});

describe("groupLearningEventsByDay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T18:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("groups events into day buckets in first-seen order, preserving within-day event order", () => {
    const todayEarly = { createdAt: "2026-01-15T08:00:00.000Z", id: "a" };
    const todayLate = { createdAt: "2026-01-15T10:00:00.000Z", id: "b" };
    const yesterday = { createdAt: "2026-01-14T09:00:00.000Z", id: "c" };

    const groups = groupLearningEventsByDay([todayEarly, yesterday, todayLate]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ key: "2026-01-15", label: "Today" });
    expect(groups[0].events.map((e) => e.id)).toEqual(["a", "b"]);
    expect(groups[1]).toMatchObject({ key: "2026-01-14", label: "Yesterday" });
    expect(groups[1].events.map((e) => e.id)).toEqual(["c"]);
  });

  it("returns an empty array for an empty input", () => {
    expect(groupLearningEventsByDay([])).toEqual([]);
  });

  it("buckets an unparsable createdAt under the 'Unknown' key", () => {
    const groups = groupLearningEventsByDay([{ createdAt: "garbage", id: "z" }]);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("Unknown");
    expect(groups[0].label).toBe("Unknown");
  });
});
