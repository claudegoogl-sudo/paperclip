import { describe, expect, it } from "vitest";
import {
  displayPipelineItemFields,
  formatFieldValue,
  humanizePipelineItemStatus,
  isLongPipelineItemField,
  splitPipelineItemFields,
  type PipelineItemDisplayField,
} from "./pipeline-item-detail";

describe("humanizePipelineItemStatus", () => {
  it("returns 'Open' for null, undefined, or blank status", () => {
    expect(humanizePipelineItemStatus(null)).toBe("Open");
    expect(humanizePipelineItemStatus(undefined)).toBe("Open");
    expect(humanizePipelineItemStatus("   ")).toBe("Open");
    expect(humanizePipelineItemStatus("")).toBe("Open");
  });

  it("maps known statuses to their labels, case- and whitespace-insensitively", () => {
    expect(humanizePipelineItemStatus("open")).toBe("Open");
    expect(humanizePipelineItemStatus("working")).toBe("In progress");
    expect(humanizePipelineItemStatus("done")).toBe("Done");
    expect(humanizePipelineItemStatus("cancelled")).toBe("Removed");
    expect(humanizePipelineItemStatus("in_review")).toBe("In review");
    expect(humanizePipelineItemStatus("review")).toBe("In review");
    expect(humanizePipelineItemStatus("in_progress")).toBe("In progress");
    expect(humanizePipelineItemStatus("  DONE  ")).toBe("Done");
    expect(humanizePipelineItemStatus("Working")).toBe("In progress");
  });

  it("humanizes an unrecognized status into a readable label", () => {
    expect(humanizePipelineItemStatus("blocked_on_review")).toBe("Blocked on review");
    expect(humanizePipelineItemStatus("archived")).toBe("Archived");
  });

  it("lowercases the status before humanizing, so camelCase word boundaries are lost", () => {
    // Status is normalized with .toLowerCase() before the camelCase-splitting
    // regex in humanizeKey runs, so an unrecognized camelCase status collapses
    // into a single word rather than being split back apart.
    expect(humanizePipelineItemStatus("needsInput")).toBe("Needsinput");
  });
});

describe("formatFieldValue", () => {
  it("formats null, undefined, and empty string as 'None'", () => {
    expect(formatFieldValue(null)).toBe("None");
    expect(formatFieldValue(undefined)).toBe("None");
    expect(formatFieldValue("")).toBe("None");
  });

  it("formats booleans as Yes/No", () => {
    expect(formatFieldValue(true)).toBe("Yes");
    expect(formatFieldValue(false)).toBe("No");
  });

  it("formats numbers as strings, including zero", () => {
    expect(formatFieldValue(42)).toBe("42");
    expect(formatFieldValue(0)).toBe("0");
    expect(formatFieldValue(-3.5)).toBe("-3.5");
  });

  it("passes strings through unchanged", () => {
    expect(formatFieldValue("hello world")).toBe("hello world");
  });

  it("formats an object by preferring label, then name, then title", () => {
    expect(formatFieldValue({ label: "Label value", name: "Name value", title: "Title value" })).toBe(
      "Label value",
    );
    expect(formatFieldValue({ name: "Name value", title: "Title value" })).toBe("Name value");
    expect(formatFieldValue({ title: "Title value" })).toBe("Title value");
  });

  it("falls back to 'Added details' for an object with no label/name/title", () => {
    expect(formatFieldValue({ foo: "bar" })).toBe("Added details");
    expect(formatFieldValue({})).toBe("Added details");
  });

  it("ignores non-string label/name/title values when falling back", () => {
    expect(formatFieldValue({ label: 123, name: null })).toBe("Added details");
  });

  it("joins array values recursively, dropping empty entries", () => {
    expect(formatFieldValue(["a", "b", "c"])).toBe("a, b, c");
    expect(formatFieldValue([1, 2, 3])).toBe("1, 2, 3");
    expect(formatFieldValue([true, false])).toBe("Yes, No");
    expect(formatFieldValue([{ label: "First" }, { name: "Second" }])).toBe("First, Second");
  });

  it("formats an empty array as 'None'", () => {
    expect(formatFieldValue([])).toBe("None");
  });

  it("renders empty/null array entries as the literal 'None' per-entry (filter(Boolean) never drops them, since formatFieldValue always returns a non-empty string)", () => {
    expect(formatFieldValue(["a", "", null, "b"])).toBe("a, None, None, b");
    expect(formatFieldValue([null, undefined])).toBe("None, None");
  });

  it("stringifies other non-object, non-primitive values as a last resort", () => {
    expect(formatFieldValue(123n as unknown)).toBe("123");
  });

  it("treats an object (e.g. a Date) without label/name/title as 'Added details'", () => {
    expect(formatFieldValue(new Date("2026-01-01T00:00:00Z"))).toBe("Added details");
  });
});

describe("displayPipelineItemFields", () => {
  it("returns an empty array for null or undefined input", () => {
    expect(displayPipelineItemFields(null)).toEqual([]);
    expect(displayPipelineItemFields(undefined)).toEqual([]);
    expect(displayPipelineItemFields({})).toEqual([]);
  });

  it("maps each field to a key/label/value entry", () => {
    const result = displayPipelineItemFields({
      ownerName: "Jane Doe",
      retryCount: 3,
      isUrgent: true,
    });

    expect(result).toEqual([
      { key: "ownerName", label: "Owner Name", value: "Jane Doe" },
      { key: "retryCount", label: "Retry Count", value: "3" },
      { key: "isUrgent", label: "Is Urgent", value: "Yes" },
    ]);
  });

  it("filters out internal field keys", () => {
    const result = displayPipelineItemFields({
      nextSuggestedStageId: "stage-2",
      suggestionResolution: "accepted",
      upstreamDrift: true,
      upstreamChanged: true,
      changeAcknowledgedAt: "2026-01-01",
      thisChanged: true,
      summary: "Visible field",
    });

    expect(result).toEqual([{ key: "summary", label: "Summary", value: "Visible field" }]);
  });
});

describe("isLongPipelineItemField", () => {
  it("treats an empty or 'None' value as short", () => {
    expect(isLongPipelineItemField({ value: "" })).toBe(false);
    expect(isLongPipelineItemField({ value: "   " })).toBe(false);
    expect(isLongPipelineItemField({ value: "None" })).toBe(false);
  });

  it("treats a value containing a newline as long regardless of length", () => {
    expect(isLongPipelineItemField({ value: "short\nvalue" })).toBe(true);
  });

  it("treats values under the character threshold as short", () => {
    expect(isLongPipelineItemField({ value: "a".repeat(179) })).toBe(false);
  });

  it("treats values at or over the character threshold as long", () => {
    expect(isLongPipelineItemField({ value: "a".repeat(180) })).toBe(true);
    expect(isLongPipelineItemField({ value: "a".repeat(181) })).toBe(true);
  });

  it("trims whitespace before measuring length", () => {
    const padded = `  ${"a".repeat(180)}  `;
    expect(isLongPipelineItemField({ value: padded })).toBe(true);
    const paddedShort = `  ${"a".repeat(179)}  `;
    expect(isLongPipelineItemField({ value: paddedShort })).toBe(false);
  });
});

describe("splitPipelineItemFields", () => {
  const field = (key: string, value: string): PipelineItemDisplayField => ({
    key,
    label: key,
    value,
  });

  it("returns empty short/long arrays for an empty field list", () => {
    expect(splitPipelineItemFields([])).toEqual({ shortFields: [], longFields: [] });
  });

  it("partitions fields into shortFields and longFields, preserving order", () => {
    const fields = [
      field("a", "short value"),
      field("b", "x".repeat(200)),
      field("c", "None"),
      field("d", "multi\nline"),
      field("e", "another short value"),
    ];

    const { shortFields, longFields } = splitPipelineItemFields(fields);

    expect(shortFields.map((f) => f.key)).toEqual(["a", "c", "e"]);
    expect(longFields.map((f) => f.key)).toEqual(["b", "d"]);
  });

  it("puts every field in shortFields when none qualify as long", () => {
    const fields = [field("a", "one"), field("b", "two")];
    const { shortFields, longFields } = splitPipelineItemFields(fields);
    expect(shortFields).toHaveLength(2);
    expect(longFields).toHaveLength(0);
  });
});
