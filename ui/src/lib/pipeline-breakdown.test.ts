import { describe, expect, it } from "vitest";
import {
  hasStageBreakdown,
  isCarryOverFieldEnabled,
  isCarryOverIdentityFieldKey,
  joinWithAnd,
  pieceNounPlural,
  type BreakdownCarryOverPolicy,
} from "./pipeline-breakdown";
import type { PipelineStage } from "../api/pipelines";

function stageWithConfig(config: Record<string, unknown> | null | undefined): PipelineStage {
  return {
    id: "stage-1",
    pipelineId: "pipeline-1",
    key: "stage-key",
    name: "Stage",
    kind: "normal",
    position: 0,
    config,
  };
}

describe("isCarryOverIdentityFieldKey", () => {
  it("matches name/title identity keys regardless of case and punctuation", () => {
    expect(isCarryOverIdentityFieldKey("name")).toBe(true);
    expect(isCarryOverIdentityFieldKey("Name")).toBe(true);
    expect(isCarryOverIdentityFieldKey("title")).toBe(true);
    expect(isCarryOverIdentityFieldKey("caseName")).toBe(true);
    expect(isCarryOverIdentityFieldKey("case_title")).toBe(true);
    expect(isCarryOverIdentityFieldKey("Case Title")).toBe(true);
  });

  it("does not match unrelated field keys", () => {
    expect(isCarryOverIdentityFieldKey("priority")).toBe(false);
    expect(isCarryOverIdentityFieldKey("assignee")).toBe(false);
    expect(isCarryOverIdentityFieldKey("")).toBe(false);
    expect(isCarryOverIdentityFieldKey("nickname")).toBe(false);
  });
});

describe("isCarryOverFieldEnabled", () => {
  it("returns false when there is no policy", () => {
    expect(isCarryOverFieldEnabled(null, "priority")).toBe(false);
    expect(isCarryOverFieldEnabled(undefined, "priority")).toBe(false);
  });

  it("always excludes identity fields regardless of mode", () => {
    const onlyPolicy: BreakdownCarryOverPolicy = {
      version: 1,
      mode: "only",
      includeFields: ["name", "priority"],
      excludeFields: [],
    };
    expect(isCarryOverFieldEnabled(onlyPolicy, "name")).toBe(false);

    const allExceptPolicy: BreakdownCarryOverPolicy = {
      version: 1,
      mode: "all_except",
      includeFields: [],
      excludeFields: [],
    };
    expect(isCarryOverFieldEnabled(allExceptPolicy, "title")).toBe(false);
  });

  it("'only' mode enables exactly the fields in includeFields", () => {
    const policy: BreakdownCarryOverPolicy = {
      version: 1,
      mode: "only",
      includeFields: ["priority"],
      excludeFields: [],
    };
    expect(isCarryOverFieldEnabled(policy, "priority")).toBe(true);
    expect(isCarryOverFieldEnabled(policy, "assignee")).toBe(false);
  });

  it("'all_except' mode enables everything not in excludeFields", () => {
    const policy: BreakdownCarryOverPolicy = {
      version: 1,
      mode: "all_except",
      includeFields: [],
      excludeFields: ["assignee"],
    };
    expect(isCarryOverFieldEnabled(policy, "priority")).toBe(true);
    expect(isCarryOverFieldEnabled(policy, "assignee")).toBe(false);
  });
});

describe("hasStageBreakdown", () => {
  it("is false for a stage with no config, null config, or a non-breakdown config", () => {
    expect(hasStageBreakdown(null)).toBe(false);
    expect(hasStageBreakdown(undefined)).toBe(false);
    expect(hasStageBreakdown(stageWithConfig(undefined))).toBe(false);
    expect(hasStageBreakdown(stageWithConfig(null))).toBe(false);
    expect(hasStageBreakdown(stageWithConfig({}))).toBe(false);
    expect(hasStageBreakdown(stageWithConfig({ breakdown: "not-an-object" }))).toBe(false);
    expect(hasStageBreakdown(stageWithConfig({ breakdown: ["array", "not", "record"] }))).toBe(false);
  });

  it("is true once the stage carries a breakdown object, even if mostly empty", () => {
    expect(hasStageBreakdown(stageWithConfig({ breakdown: {} }))).toBe(true);
    expect(
      hasStageBreakdown(
        stageWithConfig({
          breakdown: { targetPipelineId: "p2", targetStageKey: "entry", pieceNoun: "lead" },
        }),
      ),
    ).toBe(true);
  });
});

describe("pieceNounPlural", () => {
  // `pieceNounPlural` is intentionally NOT a general-purpose English
  // pluralizer. Per the module doc comment, it mirrors the server's naive
  // derivation (`${pieceNoun}s`) exactly so copy stays consistent between
  // the UI and the server's health checks. It does not special-case
  // irregular nouns (e.g. "child" -> "children", "box" -> "boxes") and does
  // not vary output by count; count-sensitive copy is handled by callers,
  // not by this function. These tests pin down that simple "+s" behavior.
  it("appends 's' to a configured noun regardless of count context", () => {
    expect(pieceNounPlural("lead")).toBe("leads");
    expect(pieceNounPlural("case")).toBe("cases");
    expect(pieceNounPlural("item")).toBe("items");
    expect(pieceNounPlural("task")).toBe("tasks");
  });

  it("does not special-case irregular/sibilant-ending nouns (naive +s, matching the server)", () => {
    // A real pluralizer would produce "boxes" / "children" / "parties" here.
    // This is documented, intentional behavior, not a bug: both the UI and
    // the server derive the plural the same naive way.
    expect(pieceNounPlural("box")).toBe("boxs");
    expect(pieceNounPlural("child")).toBe("childs");
    expect(pieceNounPlural("party")).toBe("partys");
  });

  it("defaults to 'piece' when the noun is empty or whitespace-only", () => {
    expect(pieceNounPlural("")).toBe("pieces");
    expect(pieceNounPlural("   ")).toBe("pieces");
  });

  it("trims surrounding whitespace before pluralizing", () => {
    expect(pieceNounPlural("  lead  ")).toBe("leads");
  });
});

describe("joinWithAnd", () => {
  it("returns an empty string for an empty list", () => {
    expect(joinWithAnd([])).toBe("");
  });

  it("returns the single item unchanged for a one-item list", () => {
    expect(joinWithAnd(["priority"])).toBe("priority");
  });

  it("joins two items with 'and' and no comma", () => {
    expect(joinWithAnd(["priority", "assignee"])).toBe("priority and assignee");
  });

  it("joins three or more items with commas and a final 'and'", () => {
    expect(joinWithAnd(["priority", "assignee", "due date"])).toBe("priority, assignee and due date");
    expect(joinWithAnd(["a", "b", "c", "d"])).toBe("a, b, c and d");
  });

  it("filters out blank/whitespace-only entries before joining", () => {
    expect(joinWithAnd(["priority", "", "  ", "assignee"])).toBe("priority and assignee");
    expect(joinWithAnd(["", "  "])).toBe("");
  });
});
