import { describe, expect, it } from "vitest";
import { extractModelName, extractProviderId, extractProviderIdWithFallback } from "./model-utils";

describe("extractProviderId", () => {
  it("returns the provider segment when the model id has a provider prefix", () => {
    expect(extractProviderId("anthropic/claude-sonnet-5")).toBe("anthropic");
  });

  it("returns null for a bare model name with no provider prefix", () => {
    expect(extractProviderId("claude-sonnet-5")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractProviderId("")).toBeNull();
  });

  it("trims surrounding whitespace before checking for a separator", () => {
    expect(extractProviderId("  anthropic/claude-sonnet-5  ")).toBe("anthropic");
  });

  it("returns null when the provider segment is empty (leading slash)", () => {
    expect(extractProviderId("/claude-sonnet-5")).toBeNull();
  });

  it("uses only the first slash when the model id has multiple segments", () => {
    expect(extractProviderId("anthropic/claude/sonnet-5")).toBe("anthropic");
  });

  it("trims whitespace around the provider segment itself", () => {
    expect(extractProviderId("anthropic /claude-sonnet-5")).toBe("anthropic");
  });
});

describe("extractProviderIdWithFallback", () => {
  it("returns the provider id when the model id has a provider prefix", () => {
    expect(extractProviderIdWithFallback("anthropic/claude-sonnet-5")).toBe("anthropic");
  });

  it("returns the default fallback of 'other' for a bare model name", () => {
    expect(extractProviderIdWithFallback("claude-sonnet-5")).toBe("other");
  });

  it("returns the default fallback of 'other' for an empty string", () => {
    expect(extractProviderIdWithFallback("")).toBe("other");
  });

  it("returns a custom fallback when provided and no provider prefix exists", () => {
    expect(extractProviderIdWithFallback("claude-sonnet-5", "unknown")).toBe("unknown");
  });

  it("prefers the extracted provider id over a custom fallback when a prefix exists", () => {
    expect(extractProviderIdWithFallback("anthropic/claude-sonnet-5", "unknown")).toBe("anthropic");
  });

  it("falls back when the provider segment is empty (leading slash)", () => {
    expect(extractProviderIdWithFallback("/claude-sonnet-5", "unknown")).toBe("unknown");
  });
});

describe("extractModelName", () => {
  it("returns the segment after the provider prefix", () => {
    expect(extractModelName("anthropic/claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("returns the whole string when there is no provider prefix", () => {
    expect(extractModelName("claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("returns an empty string for an empty input", () => {
    expect(extractModelName("")).toBe("");
  });

  it("trims whitespace from the input and the resulting model name", () => {
    expect(extractModelName("  anthropic/ claude-sonnet-5  ")).toBe("claude-sonnet-5");
  });

  it("joins back together with a slash when the model id has multiple segments", () => {
    expect(extractModelName("anthropic/claude/sonnet-5")).toBe("claude/sonnet-5");
  });

  it("returns an empty string when the model id ends with the provider separator", () => {
    expect(extractModelName("anthropic/")).toBe("");
  });
});
