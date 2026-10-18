import { describe, expect, it } from "vitest";
import {
  asBoolean,
  asString,
  asStringArray,
  isPlainRecord,
  parseFrontmatterMarkdown,
} from "./frontmatter.js";

describe("isPlainRecord", () => {
  it("accepts a plain object", () => {
    expect(isPlainRecord({ a: 1 })).toBe(true);
  });

  it("rejects arrays, null, and primitives", () => {
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord("text")).toBe(false);
    expect(isPlainRecord(42)).toBe(false);
  });
});

describe("asString", () => {
  it("trims and returns a non-empty string", () => {
    expect(asString("  hello  ")).toBe("hello");
  });

  it("returns null for an empty or whitespace-only string", () => {
    expect(asString("")).toBeNull();
    expect(asString("   ")).toBeNull();
  });

  it("returns null for non-string values", () => {
    expect(asString(42)).toBeNull();
    expect(asString(null)).toBeNull();
    expect(asString(undefined)).toBeNull();
  });
});

describe("asBoolean", () => {
  it("passes through boolean values", () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean(false)).toBe(false);
  });

  it("returns null for non-boolean values", () => {
    expect(asBoolean("true")).toBeNull();
    expect(asBoolean(1)).toBeNull();
    expect(asBoolean(null)).toBeNull();
  });
});

describe("asStringArray", () => {
  it("returns an empty array when the value is undefined", () => {
    expect(asStringArray(undefined)).toEqual([]);
  });

  it("returns null when the value is not an array", () => {
    expect(asStringArray("not-an-array")).toBeNull();
    expect(asStringArray(null)).toBeNull();
    expect(asStringArray({})).toBeNull();
  });

  it("trims each string item and preserves order", () => {
    expect(asStringArray([" a ", "b"])).toEqual(["a", "b"]);
  });

  it("returns null when any item is not a non-empty string", () => {
    expect(asStringArray(["a", 1])).toBeNull();
    expect(asStringArray(["a", ""])).toBeNull();
    expect(asStringArray(["a", null])).toBeNull();
  });
});

describe("parseFrontmatterMarkdown", () => {
  it("returns no frontmatter when the document does not open with a --- block", () => {
    const result = parseFrontmatterMarkdown("# Title\n\nBody text.");
    expect(result).toEqual({
      frontmatter: {},
      body: "# Title\n\nBody text.",
      hasFrontmatter: false,
    });
  });

  it("returns no frontmatter when the opening --- is never closed", () => {
    const result = parseFrontmatterMarkdown("---\nname: foo\n\nBody without a closing marker.");
    expect(result.hasFrontmatter).toBe(false);
    expect(result.frontmatter).toEqual({});
  });

  it("parses scalar frontmatter fields and keeps the body separate", () => {
    const raw = [
      "---",
      "name: Example Team",
      "enabled: true",
      "count: 3",
      "---",
      "",
      "# Body heading",
      "",
      "Body content.",
    ].join("\n");

    const result = parseFrontmatterMarkdown(raw);
    expect(result.hasFrontmatter).toBe(true);
    expect(result.frontmatter).toEqual({ name: "Example Team", enabled: true, count: 3 });
    expect(result.body).toBe("# Body heading\n\nBody content.");
  });

  it("parses a nested list field under a key", () => {
    const raw = ["---", "tags:", "  - alpha", "  - beta", "---", "body"].join("\n");

    const result = parseFrontmatterMarkdown(raw);
    expect(result.frontmatter).toEqual({ tags: ["alpha", "beta"] });
  });

  it("normalizes CRLF line endings before parsing", () => {
    const raw = "---\r\nname: foo\r\n---\r\nbody text";

    const result = parseFrontmatterMarkdown(raw);
    expect(result.hasFrontmatter).toBe(true);
    expect(result.frontmatter).toEqual({ name: "foo" });
    expect(result.body).toBe("body text");
  });
});
