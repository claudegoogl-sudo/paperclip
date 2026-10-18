import { describe, expect, it } from "vitest";
import {
  createFeedbackRedactionState,
  finalizeFeedbackRedactionSummary,
  sanitizeFeedbackText,
  sanitizeFeedbackValue,
  sha256Digest,
  stableStringify,
} from "./feedback-redaction.js";

function freshState() {
  return createFeedbackRedactionState();
}

describe("sanitizeFeedbackText", () => {
  it("leaves plain text unchanged and records nothing", () => {
    const state = freshState();
    const output = sanitizeFeedbackText("nothing sensitive here", state, "body", 1000);
    expect(output).toBe("nothing sensitive here");
    expect(state.redactedFields.size).toBe(0);
    expect(state.counts.size).toBe(0);
  });

  it("redacts a key=value secret assignment, preserving the key name", () => {
    const state = freshState();
    const output = sanitizeFeedbackText("api_key=sk-abcdef123456", state, "body", 1000);
    expect(output).toBe("api_key=[REDACTED]");
    expect(state.redactedFields).toEqual(new Set(["body"]));
    expect(state.counts.get("secret_assignment")).toBe(1);
  });

  it("redacts a Bearer token", () => {
    const state = freshState();
    const output = sanitizeFeedbackText("the request sent Bearer abc.def-ghi", state, "body", 1000);
    expect(output).toContain("Bearer [REDACTED_TOKEN]");
    expect(state.counts.get("bearer_token")).toBe(1);
  });

  it("redacts a GitHub personal access token", () => {
    const state = freshState();
    const token = `ghp_${"a".repeat(36)}`;
    const output = sanitizeFeedbackText(`token: ${token}`, state, "body", 1000);
    expect(output).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(output).not.toContain(token);
  });

  it("redacts an Anthropic-style provider API key", () => {
    const state = freshState();
    const key = `sk-ant-${"x".repeat(20)}`;
    const output = sanitizeFeedbackText(`key is ${key}`, state, "body", 1000);
    expect(output).toContain("[REDACTED_API_KEY]");
    expect(output).not.toContain(key);
  });

  it("redacts a PEM block", () => {
    const state = freshState();
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----";
    const output = sanitizeFeedbackText(`cert:\n${pem}`, state, "body", 1000);
    expect(output).toContain("[REDACTED_PEM_BLOCK]");
    expect(output).not.toContain("MIIB");
  });

  it("redacts a database connection string", () => {
    const state = freshState();
    const output = sanitizeFeedbackText(
      "postgresql://user:pass@localhost:5432/db",
      state,
      "body",
      1000,
    );
    expect(output).toBe("[REDACTED_CONNECTION_STRING]");
    expect(state.counts.get("dsn")).toBe(1);
  });

  it("redacts an email address", () => {
    const state = freshState();
    const output = sanitizeFeedbackText("contact me at user@example.com", state, "body", 1000);
    expect(output).toBe("contact me at [REDACTED_EMAIL]");
  });

  it("redacts a phone number", () => {
    const state = freshState();
    const output = sanitizeFeedbackText("call +1 555-123-4567", state, "body", 1000);
    expect(output).toContain("[REDACTED_PHONE]");
    expect(output).not.toContain("555-123-4567");
  });

  it("truncates output longer than maxLength and records the field as truncated", () => {
    const state = freshState();
    const output = sanitizeFeedbackText("a".repeat(50), state, "body", 10);
    expect(output).toBe(`${"a".repeat(9)}...`);
    expect(state.truncatedFields).toEqual(new Set(["body"]));
  });

  it("does not record an empty field path even when a pattern matches", () => {
    const state = freshState();
    sanitizeFeedbackText("user@example.com", state, "  ", 1000);
    expect(state.redactedFields.size).toBe(0);
    expect(state.counts.get("email")).toBe(1);
  });

  it("accumulates multiple matches of the same pattern kind into one count", () => {
    const state = freshState();
    sanitizeFeedbackText("a@example.com and b@example.com", state, "body", 1000);
    expect(state.counts.get("email")).toBe(2);
    expect(state.redactedFields).toEqual(new Set(["body"]));
  });
});

describe("sanitizeFeedbackValue", () => {
  it("passes through non-string, non-array, non-record primitives unchanged", () => {
    const state = freshState();
    expect(sanitizeFeedbackValue(42, state, "n", 1000)).toBe(42);
    expect(sanitizeFeedbackValue(true, state, "b", 1000)).toBe(true);
    expect(sanitizeFeedbackValue(null, state, "x", 1000)).toBeNull();
  });

  it("sanitizes a string value through sanitizeFeedbackText", () => {
    const state = freshState();
    const output = sanitizeFeedbackValue("email me at user@example.com", state, "field", 1000);
    expect(output).toBe("email me at [REDACTED_EMAIL]");
    expect(state.redactedFields).toEqual(new Set(["field"]));
  });

  it("recurses into array entries with an [index] path suffix", () => {
    const state = freshState();
    const output = sanitizeFeedbackValue(
      ["safe", "user@example.com"],
      state,
      "list",
      1000,
    );
    expect(output).toEqual(["safe", "[REDACTED_EMAIL]"]);
    expect(state.redactedFields).toEqual(new Set(["list[1]"]));
  });

  it("recurses into record keys with a .key path suffix", () => {
    const state = freshState();
    const output = sanitizeFeedbackValue(
      { note: "contact user@example.com" },
      state,
      "root",
      1000,
    );
    expect(output).toEqual({ note: "contact [REDACTED_EMAIL]" });
    expect(state.redactedFields).toEqual(new Set(["root.note"]));
  });

  it("records a structured_secret when sanitizeRecord's key-based redaction changes the record", () => {
    const state = freshState();
    const output = sanitizeFeedbackValue({ apiKey: "benign-looking-value" }, state, "root", 1000);
    expect(output).toEqual({ apiKey: "***REDACTED***" });
    expect(state.redactedFields).toEqual(new Set(["root"]));
    expect(state.counts.get("structured_secret")).toBe(1);
  });

  it("does not record structured_secret when sanitizeRecord makes no change", () => {
    const state = freshState();
    sanitizeFeedbackValue({ safe: "ok" }, state, "root", 1000);
    expect(state.counts.get("structured_secret")).toBeUndefined();
  });
});

describe("finalizeFeedbackRedactionSummary", () => {
  it("sorts every field list and the counts object", () => {
    const state = freshState();
    state.redactedFields.add("b");
    state.redactedFields.add("a");
    state.counts.set("zeta", 2);
    state.counts.set("alpha", 1);
    const summary = finalizeFeedbackRedactionSummary(state);
    expect(summary).toEqual({
      strategy: "deterministic_feedback_v2",
      redactedFields: ["a", "b"],
      truncatedFields: [],
      omittedFields: [],
      notes: [],
      counts: { alpha: 1, zeta: 2 },
    });
  });
});

describe("stableStringify", () => {
  it("produces the same output regardless of key insertion order", () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));
  });

  it("preserves array order", () => {
    expect(stableStringify([1, 2, 3])).toBe("[1,2,3]");
    expect(stableStringify([3, 2, 1])).not.toBe(stableStringify([1, 2, 3]));
  });

  it("stringifies primitives and null directly", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify("x")).toBe('"x"');
    expect(stableStringify(5)).toBe("5");
  });
});

describe("sha256Digest", () => {
  it("produces the same digest for key-order-equivalent objects", () => {
    expect(sha256Digest({ a: 1, b: 2 })).toBe(sha256Digest({ b: 2, a: 1 }));
  });

  it("produces a different digest for different values", () => {
    expect(sha256Digest({ a: 1 })).not.toBe(sha256Digest({ a: 2 }));
  });

  it("produces a 64-character hex digest", () => {
    expect(sha256Digest("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});
