import { describe, expect, it } from "vitest";
import type { Goal } from "@paperclipai/shared";

import {
  isExistingCompanyMissionUnresolved,
  planMissionPersistence,
  selectExistingCompanyMission,
} from "./onboarding-mission";

function makeGoal(overrides: Partial<Goal> & { id: string }): Goal {
  return {
    companyId: "company-1",
    title: "",
    description: null,
    level: "company",
    status: "active",
    parentId: null,
    ownerAgentId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("selectExistingCompanyMission", () => {
  it("returns an empty mission when there is no company-level goal", () => {
    const goals: Goal[] = [
      makeGoal({ id: "g1", level: "task", title: "Ship the thing" }),
    ];

    expect(selectExistingCompanyMission(goals)).toEqual({ goalId: null, goalInput: "" });
  });

  it("returns an empty mission when there are no goals at all", () => {
    expect(selectExistingCompanyMission([])).toEqual({ goalId: null, goalInput: "" });
  });

  it("reads back the active root company goal's title and description", () => {
    const goals: Goal[] = [
      makeGoal({
        id: "g1",
        title: "Grow revenue",
        description: "Focus on enterprise accounts",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      }),
    ];

    expect(selectExistingCompanyMission(goals)).toEqual({
      goalId: "g1",
      goalInput: "Grow revenue\n\nFocus on enterprise accounts",
    });
  });

  it("formats a title-only mission without a trailing description", () => {
    const goals: Goal[] = [makeGoal({ id: "g1", title: "Grow revenue", description: null })];

    expect(selectExistingCompanyMission(goals)).toEqual({
      goalId: "g1",
      goalInput: "Grow revenue",
    });
  });

  it("picks the earliest active root company goal when several qualify", () => {
    const goals: Goal[] = [
      makeGoal({
        id: "newer",
        title: "Newer mission",
        createdAt: new Date("2026-02-01T00:00:00Z"),
      }),
      makeGoal({
        id: "older",
        title: "Older mission",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      }),
    ];

    expect(selectExistingCompanyMission(goals)).toEqual({
      goalId: "older",
      goalInput: "Older mission",
    });
  });

  it("falls back to a non-root company goal when no root goal qualifies", () => {
    const goals: Goal[] = [
      makeGoal({ id: "g1", title: "Sub-goal", parentId: "parent-1" }),
    ];

    expect(selectExistingCompanyMission(goals)).toEqual({
      goalId: "g1",
      goalInput: "Sub-goal",
    });
  });
});

describe("isExistingCompanyMissionUnresolved", () => {
  it("is resolved (false) when there is no existing company", () => {
    expect(
      isExistingCompanyMissionUnresolved({
        existingCompanyId: null,
        goalsLoaded: false,
        goalsFetching: true,
      }),
    ).toBe(false);
  });

  it("is unresolved while goals are fetching, even if goals are already loaded", () => {
    expect(
      isExistingCompanyMissionUnresolved({
        existingCompanyId: "company-1",
        goalsLoaded: true,
        goalsFetching: true,
      }),
    ).toBe(true);
  });

  it("is unresolved when goals have not loaded yet and are not fetching", () => {
    expect(
      isExistingCompanyMissionUnresolved({
        existingCompanyId: "company-1",
        goalsLoaded: false,
        goalsFetching: false,
      }),
    ).toBe(true);
  });

  it("is resolved once goals are loaded and not fetching", () => {
    expect(
      isExistingCompanyMissionUnresolved({
        existingCompanyId: "company-1",
        goalsLoaded: true,
        goalsFetching: false,
      }),
    ).toBe(false);
  });

  it("treats a missing goalsFetching flag as not fetching", () => {
    expect(
      isExistingCompanyMissionUnresolved({
        existingCompanyId: "company-1",
        goalsLoaded: true,
      }),
    ).toBe(false);
  });
});

describe("planMissionPersistence", () => {
  it("skips when the mission input is empty", () => {
    expect(
      planMissionPersistence({ goalInput: "", existingGoalId: null }),
    ).toEqual({ kind: "skip" });
  });

  it("skips when the mission input is only whitespace", () => {
    expect(
      planMissionPersistence({ goalInput: "   \n  ", existingGoalId: "g1" }),
    ).toEqual({ kind: "skip" });
  });

  it("plans a create with no description when there is no existing goal", () => {
    expect(
      planMissionPersistence({ goalInput: "Grow revenue", existingGoalId: null }),
    ).toEqual({
      kind: "create",
      payload: { title: "Grow revenue", level: "company", status: "active" },
    });
  });

  it("plans a create including the description when one is present", () => {
    expect(
      planMissionPersistence({
        goalInput: "Grow revenue\n\nFocus on enterprise accounts",
        existingGoalId: null,
      }),
    ).toEqual({
      kind: "create",
      payload: {
        title: "Grow revenue",
        description: "Focus on enterprise accounts",
        level: "company",
        status: "active",
      },
    });
  });

  it("plans an update against the existing goal id, preserving a null description", () => {
    expect(
      planMissionPersistence({ goalInput: "Grow revenue", existingGoalId: "g1" }),
    ).toEqual({
      kind: "update",
      goalId: "g1",
      payload: { title: "Grow revenue", description: null },
    });
  });

  it("plans an update including a description when one is present", () => {
    expect(
      planMissionPersistence({
        goalInput: "Grow revenue\n\nFocus on enterprise accounts",
        existingGoalId: "g1",
      }),
    ).toEqual({
      kind: "update",
      goalId: "g1",
      payload: { title: "Grow revenue", description: "Focus on enterprise accounts" },
    });
  });
});
