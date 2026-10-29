import { describe, expect, it } from "vitest";
import { normalizeUrlKeySlug } from "./url-key-slug.js";
import { deriveAgentUrlKey, normalizeAgentUrlKey } from "./agent-url-key.js";
import { deriveProjectUrlKey, normalizeProjectUrlKey } from "./project-url-key.js";

describe("normalizeUrlKeySlug", () => {
  it("lowercases and collapses non-alphanumeric runs to a single dash", () => {
    expect(normalizeUrlKeySlug("My Cool Agent!!")).toBe("my-cool-agent");
  });

  it("trims leading and trailing dashes", () => {
    expect(normalizeUrlKeySlug("  --Weird--  ")).toBe("weird");
  });

  it("returns null for non-string input", () => {
    expect(normalizeUrlKeySlug(null)).toBeNull();
    expect(normalizeUrlKeySlug(undefined)).toBeNull();
  });

  it("returns null when nothing alphanumeric remains", () => {
    expect(normalizeUrlKeySlug("!!!")).toBeNull();
  });
});

describe("normalizeAgentUrlKey / normalizeProjectUrlKey share the same slug rules", () => {
  it("produce identical output for the same input", () => {
    expect(normalizeAgentUrlKey("My Cool Thing")).toBe(normalizeProjectUrlKey("My Cool Thing"));
  });
});

describe("deriveAgentUrlKey", () => {
  it("falls back to the fallback name, then to \"agent\"", () => {
    expect(deriveAgentUrlKey(null, "Fallback Name")).toBe("fallback-name");
    expect(deriveAgentUrlKey(null, null)).toBe("agent");
  });
});

describe("deriveProjectUrlKey", () => {
  it("uses the normalized name when it is pure ASCII", () => {
    expect(deriveProjectUrlKey("My Project", null)).toBe("my-project");
  });

  it("appends a short UUID suffix when the name is non-ASCII and a UUID fallback is given", () => {
    const result = deriveProjectUrlKey("プロジェクト", "11111111-2222-4333-8444-555555555555");
    expect(result).toBe("11111111");
  });

  it("falls back to \"project\" when nothing usable is given", () => {
    expect(deriveProjectUrlKey(null, null)).toBe("project");
  });
});
