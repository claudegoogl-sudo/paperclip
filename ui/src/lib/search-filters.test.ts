// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  applyAssigneeToken,
  assigneeToken,
  buildFilterChips,
  clearFilterDimension,
  countActiveFilters,
  describeLoosenSuggestion,
  parseSearchSort,
  updatedWithinLabel,
  type FilterChipLookups,
  type SearchFilters,
} from "./search-filters";

const LOOKUPS: FilterChipLookups = {
  agentName: (id) => (id === "agent-1" ? "Builder Bot" : undefined),
  userName: (id) => (id === "user-2" ? "Jamie" : undefined),
  projectName: (id) => (id === "project-1" ? "Paperclip App" : undefined),
  labelName: (id) => (id === "label-1" ? "bug" : undefined),
  currentUserId: "user-1",
};

describe("updatedWithinLabel", () => {
  it("returns the friendly label for each known duration", () => {
    expect(updatedWithinLabel("24h")).toBe("Last 24 hours");
    expect(updatedWithinLabel("7d")).toBe("Last 7 days");
    expect(updatedWithinLabel("30d")).toBe("Last 30 days");
    expect(updatedWithinLabel("90d")).toBe("Last 90 days");
  });

  it("falls back to a generic label for an unrecognized duration", () => {
    expect(updatedWithinLabel("14d")).toBe("Updated ≤ 14d");
    expect(updatedWithinLabel("")).toBe("Updated ≤ ");
  });
});

describe("parseSearchSort", () => {
  it("parses each recognized sort value", () => {
    expect(parseSearchSort(new URLSearchParams("sort=relevance"))).toBe("relevance");
    expect(parseSearchSort(new URLSearchParams("sort=updated"))).toBe("updated");
    expect(parseSearchSort(new URLSearchParams("sort=created"))).toBe("created");
    expect(parseSearchSort(new URLSearchParams("sort=priority"))).toBe("priority");
  });

  it("defaults to relevance when the sort param is missing", () => {
    expect(parseSearchSort(new URLSearchParams(""))).toBe("relevance");
  });

  it("defaults to relevance for an unrecognized sort value", () => {
    expect(parseSearchSort(new URLSearchParams("sort=bogus"))).toBe("relevance");
  });

  it("defaults to relevance for an empty sort value", () => {
    expect(parseSearchSort(new URLSearchParams("sort="))).toBe("relevance");
  });
});

describe("countActiveFilters", () => {
  it("counts zero when no filter dimensions are set", () => {
    expect(countActiveFilters({})).toBe(0);
  });

  it("counts each active dimension once", () => {
    const filters: SearchFilters = {
      status: ["todo", "in_progress"],
      priority: ["high"],
      assigneeUserId: "user-1",
      projectId: "project-1",
      labelId: "label-1",
      updatedWithin: "7d",
    };
    expect(countActiveFilters(filters)).toBe(6);
  });

  it("counts an empty status/priority array as inactive", () => {
    expect(countActiveFilters({ status: [], priority: [] })).toBe(0);
  });

  it("counts assignee once regardless of which assignee field is set", () => {
    expect(countActiveFilters({ assigneeAgentId: "agent-1" })).toBe(1);
    expect(countActiveFilters({ assigneeAgentId: null })).toBe(1);
    expect(countActiveFilters({ assigneeUserId: "user-1" })).toBe(1);
  });

  it("counts updatedWithin or updatedAfter as the same single dimension", () => {
    expect(countActiveFilters({ updatedWithin: "7d" })).toBe(1);
    expect(countActiveFilters({ updatedAfter: "2026-01-01" })).toBe(1);
    expect(countActiveFilters({ updatedWithin: "7d", updatedAfter: "2026-01-01" })).toBe(1);
  });
});

describe("assigneeToken", () => {
  it("returns 'none' for explicit unassigned (assigneeAgentId === null)", () => {
    expect(assigneeToken({ assigneeAgentId: null }, "user-1")).toBe("none");
  });

  it("returns an agent token when assigneeAgentId is a string", () => {
    expect(assigneeToken({ assigneeAgentId: "agent-1" }, "user-1")).toBe("agent:agent-1");
  });

  it("returns 'me' when assigneeUserId matches the current user", () => {
    expect(assigneeToken({ assigneeUserId: "user-1" }, "user-1")).toBe("me");
  });

  it("returns a user token when assigneeUserId does not match the current user", () => {
    expect(assigneeToken({ assigneeUserId: "user-2" }, "user-1")).toBe("user:user-2");
  });

  it("returns a user token when there is no current user to compare against", () => {
    expect(assigneeToken({ assigneeUserId: "user-2" }, null)).toBe("user:user-2");
  });

  it("returns undefined when no assignee filter is set", () => {
    expect(assigneeToken({}, "user-1")).toBeUndefined();
  });
});

describe("applyAssigneeToken", () => {
  const base: SearchFilters = { status: ["todo"], assigneeUserId: "user-2" };

  it("clears assignee fields when the token is undefined", () => {
    const result = applyAssigneeToken(base, undefined, "user-1");
    expect(result).toEqual({ status: ["todo"] });
  });

  it("sets assigneeAgentId to null for the 'none' token", () => {
    const result = applyAssigneeToken(base, "none", "user-1");
    expect(result.assigneeAgentId).toBeNull();
    expect(result.assigneeUserId).toBeUndefined();
  });

  it("sets assigneeUserId to the current user for the 'me' token", () => {
    const result = applyAssigneeToken(base, "me", "user-1");
    expect(result.assigneeUserId).toBe("user-1");
    expect(result.assigneeAgentId).toBeUndefined();
  });

  it("does not set assigneeUserId for 'me' when there is no current user", () => {
    const result = applyAssigneeToken(base, "me", null);
    expect(result.assigneeUserId).toBeUndefined();
    expect(result.assigneeAgentId).toBeUndefined();
  });

  it("parses an agent:<id> token", () => {
    const result = applyAssigneeToken(base, "agent:agent-9", "user-1");
    expect(result.assigneeAgentId).toBe("agent-9");
    expect(result.assigneeUserId).toBeUndefined();
  });

  it("parses a user:<id> token", () => {
    const result = applyAssigneeToken(base, "user:user-9", "user-1");
    expect(result.assigneeUserId).toBe("user-9");
    expect(result.assigneeAgentId).toBeUndefined();
  });

  it("round-trips through assigneeToken for each token shape", () => {
    for (const token of ["none", "me", "agent:agent-1", "user:user-2"] as const) {
      const applied = applyAssigneeToken({}, token, "user-1");
      expect(assigneeToken(applied, "user-1")).toBe(token);
    }
  });

  it("leaves other filter fields untouched", () => {
    const result = applyAssigneeToken(base, "none", "user-1");
    expect(result.status).toEqual(["todo"]);
  });
});

describe("buildFilterChips", () => {
  it("returns no chips for an empty filter state", () => {
    expect(buildFilterChips({}, LOOKUPS)).toEqual([]);
  });

  it("builds one chip per status value", () => {
    const chips = buildFilterChips({ status: ["in_progress", "in_review"] }, LOOKUPS);
    expect(chips.map((chip) => chip.id)).toEqual(["status:in_progress", "status:in_review"]);
    expect(chips.map((chip) => chip.label)).toEqual(["Status: In Progress", "Status: In Review"]);
  });

  it("removing a status chip drops only that status and keeps the rest", () => {
    const filters: SearchFilters = { status: ["todo", "done"] };
    const chips = buildFilterChips(filters, LOOKUPS);
    const todoChip = chips.find((chip) => chip.id === "status:todo")!;
    expect(todoChip.remove(filters)).toEqual({ status: ["done"] });
  });

  it("removing the last status value deletes the status key entirely", () => {
    const filters: SearchFilters = { status: ["todo"] };
    const chips = buildFilterChips(filters, LOOKUPS);
    const todoChip = chips.find((chip) => chip.id === "status:todo")!;
    const result = todoChip.remove(filters);
    expect(result).not.toHaveProperty("status");
  });

  it("builds a priority chip even though the priority UI is hidden", () => {
    const chips = buildFilterChips({ priority: ["high"] }, LOOKUPS);
    expect(chips).toEqual([
      expect.objectContaining({ id: "priority:high", label: "Priority: High" }),
    ]);
  });

  it("builds an assignee chip using the agent name lookup", () => {
    const chips = buildFilterChips({ assigneeAgentId: "agent-1" }, LOOKUPS);
    expect(chips).toEqual([expect.objectContaining({ id: "assignee", label: "Assignee: Builder Bot" })]);
  });

  it("builds an 'Unassigned' assignee chip for assigneeAgentId === null", () => {
    const chips = buildFilterChips({ assigneeAgentId: null }, LOOKUPS);
    expect(chips).toEqual([expect.objectContaining({ id: "assignee", label: "Assignee: Unassigned" })]);
  });

  it("builds a 'Me' assignee chip when assigneeUserId matches the current user", () => {
    const chips = buildFilterChips({ assigneeUserId: "user-1" }, LOOKUPS);
    expect(chips).toEqual([expect.objectContaining({ id: "assignee", label: "Assignee: Me" })]);
  });

  it("falls back to generic labels when a lookup misses", () => {
    const chips = buildFilterChips(
      { assigneeAgentId: "agent-unknown", projectId: "project-unknown", labelId: "label-unknown" },
      LOOKUPS,
    );
    const byId = Object.fromEntries(chips.map((chip) => [chip.id, chip.label]));
    expect(byId.assignee).toBe("Assignee: Agent");
    expect(byId.project).toBe("Project: Project");
    expect(byId.label).toBe("Label: Label");
  });

  it("builds project, label, and updated chips with resolved names", () => {
    const filters: SearchFilters = { projectId: "project-1", labelId: "label-1", updatedWithin: "7d" };
    const chips = buildFilterChips(filters, LOOKUPS);
    const byId = Object.fromEntries(chips.map((chip) => [chip.id, chip.label]));
    expect(byId.project).toBe("Project: Paperclip App");
    expect(byId.label).toBe("Label: bug");
    expect(byId.updated).toBe("Updated: Last 7 days");
  });

  it("removing the updated chip clears both updatedWithin and updatedAfter", () => {
    const filters: SearchFilters = { updatedWithin: "7d", updatedAfter: "2026-01-01" };
    const chips = buildFilterChips(filters, LOOKUPS);
    const updatedChip = chips.find((chip) => chip.id === "updated")!;
    const result = updatedChip.remove(filters);
    expect(result).not.toHaveProperty("updatedWithin");
    expect(result).not.toHaveProperty("updatedAfter");
  });

  it("builds a full chip row for a representative multi-filter state in a stable order", () => {
    const filters: SearchFilters = {
      status: ["todo"],
      priority: ["high"],
      assigneeUserId: "user-2",
      projectId: "project-1",
      labelId: "label-1",
      updatedWithin: "30d",
    };
    const chips = buildFilterChips(filters, LOOKUPS);
    expect(chips.map((chip) => chip.id)).toEqual([
      "status:todo",
      "priority:high",
      "assignee",
      "project",
      "label",
      "updated",
    ]);
    expect(chips.map((chip) => chip.label)).toEqual([
      "Status: Todo",
      "Priority: High",
      "Assignee: Jamie",
      "Project: Paperclip App",
      "Label: bug",
      "Updated: Last 30 days",
    ]);
  });
});

describe("describeLoosenSuggestion", () => {
  it("describes status and priority suggestions", () => {
    expect(describeLoosenSuggestion("status", ["in_progress", "done"], LOOKUPS)).toBe(
      "Status: In Progress, Done",
    );
    expect(describeLoosenSuggestion("priority", ["high"], LOOKUPS)).toBe("Priority: High");
  });

  it("describes assignee suggestions using the agent/user name lookups", () => {
    expect(describeLoosenSuggestion("assigneeAgentId", ["agent-1"], LOOKUPS)).toBe("Assignee: Builder Bot");
    expect(describeLoosenSuggestion("assigneeUserId", ["user-1"], LOOKUPS)).toBe("Assignee: Me");
    expect(describeLoosenSuggestion("assigneeUserId", ["user-2"], LOOKUPS)).toBe("Assignee: Jamie");
  });

  it("describes project and label suggestions", () => {
    expect(describeLoosenSuggestion("projectId", ["project-1"], LOOKUPS)).toBe("Project: Paperclip App");
    expect(describeLoosenSuggestion("labelId", ["label-1"], LOOKUPS)).toBe("Label: bug");
  });

  it("describes updated-window suggestions without listing raw values", () => {
    expect(describeLoosenSuggestion("updatedWithin", ["7d"], LOOKUPS)).toBe("Updated window");
    expect(describeLoosenSuggestion("updatedAfter", ["2026-01-01"], LOOKUPS)).toBe("Updated window");
  });

  it("humanizes an unrecognized filter key as a fallback", () => {
    expect(describeLoosenSuggestion("some_unknown_key", [], LOOKUPS)).toBe("Some Unknown Key");
  });
});

describe("clearFilterDimension", () => {
  const filters: SearchFilters = {
    status: ["todo"],
    priority: ["high"],
    assigneeAgentId: "agent-1",
    assigneeUserId: "user-2",
    projectId: "project-1",
    labelId: "label-1",
    updatedWithin: "7d",
    updatedAfter: "2026-01-01",
  };

  it("clears only the status dimension", () => {
    const result = clearFilterDimension(filters, "status");
    expect(result).not.toHaveProperty("status");
    expect(result.priority).toEqual(["high"]);
  });

  it("clears only the priority dimension", () => {
    const result = clearFilterDimension(filters, "priority");
    expect(result).not.toHaveProperty("priority");
    expect(result.status).toEqual(["todo"]);
  });

  it("clears both assignee fields for either assignee key", () => {
    expect(clearFilterDimension(filters, "assigneeAgentId")).not.toHaveProperty("assigneeAgentId");
    expect(clearFilterDimension(filters, "assigneeAgentId")).not.toHaveProperty("assigneeUserId");
    expect(clearFilterDimension(filters, "assigneeUserId")).not.toHaveProperty("assigneeAgentId");
    expect(clearFilterDimension(filters, "assigneeUserId")).not.toHaveProperty("assigneeUserId");
  });

  it("clears the project and label dimensions", () => {
    expect(clearFilterDimension(filters, "projectId")).not.toHaveProperty("projectId");
    expect(clearFilterDimension(filters, "labelId")).not.toHaveProperty("labelId");
  });

  it("clears both updated fields for either updated key", () => {
    expect(clearFilterDimension(filters, "updatedWithin")).not.toHaveProperty("updatedWithin");
    expect(clearFilterDimension(filters, "updatedWithin")).not.toHaveProperty("updatedAfter");
    expect(clearFilterDimension(filters, "updatedAfter")).not.toHaveProperty("updatedWithin");
    expect(clearFilterDimension(filters, "updatedAfter")).not.toHaveProperty("updatedAfter");
  });

  it("is a no-op for an unrecognized filter key", () => {
    expect(clearFilterDimension(filters, "nonsense")).toEqual(filters);
  });
});
