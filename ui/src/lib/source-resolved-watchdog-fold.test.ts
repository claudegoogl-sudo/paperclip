import { describe, expect, it } from "vitest";
import {
  formatCleanupOutcome,
  formatSilenceAgeMs,
  parseSourceResolvedWatchdogFold,
  shortenEvidenceId,
} from "./source-resolved-watchdog-fold";

describe("parseSourceResolvedWatchdogFold", () => {
  const validPayload = {
    sourceIssueId: "issue-1",
    sourceIssueIdentifier: "ENG-1",
    sourceIssueStatus: "resolved",
    sameRunEvidenceKind: "comment",
    sameRunEvidenceId: "evidence-123456789",
    sameRunEvidenceAt: "2026-01-01T00:00:00.000Z",
    silenceStartedAt: "2026-01-01T00:05:00.000Z",
    silenceAgeMs: 120_000,
    evaluationIssueId: "issue-2",
    evaluationIssueIdentifier: "ENG-2",
    cleanup: {
      attempted: true,
      outcome: "terminated",
      adapterType: "claude-local",
      pid: 42,
      processGroupId: 42,
      error: null,
    },
  };

  it("parses a well-formed valid payload", () => {
    const result = parseSourceResolvedWatchdogFold(validPayload);
    expect(result).toEqual(validPayload);
  });

  it("defaults optional nullable fields when absent", () => {
    const result = parseSourceResolvedWatchdogFold({
      sourceIssueId: "issue-1",
      sourceIssueStatus: "resolved",
      sameRunEvidenceKind: "comment",
      sameRunEvidenceId: "evidence-1",
      sameRunEvidenceAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result).toEqual({
      sourceIssueId: "issue-1",
      sourceIssueIdentifier: null,
      sourceIssueStatus: "resolved",
      sameRunEvidenceKind: "comment",
      sameRunEvidenceId: "evidence-1",
      sameRunEvidenceAt: "2026-01-01T00:00:00.000Z",
      silenceStartedAt: null,
      silenceAgeMs: null,
      evaluationIssueId: null,
      evaluationIssueIdentifier: null,
      cleanup: {
        attempted: false,
        outcome: "no_process_metadata",
        adapterType: null,
        pid: null,
        processGroupId: null,
        error: null,
      },
    });
  });

  it("returns null when a required field is missing (sourceIssueId)", () => {
    const { sourceIssueId: _omit, ...rest } = validPayload;
    expect(parseSourceResolvedWatchdogFold(rest)).toBeNull();
  });

  it("returns null when a required field is missing (sameRunEvidenceId)", () => {
    const { sameRunEvidenceId: _omit, ...rest } = validPayload;
    expect(parseSourceResolvedWatchdogFold(rest)).toBeNull();
  });

  it("returns null when a required field has the wrong type (number instead of string)", () => {
    expect(
      parseSourceResolvedWatchdogFold({
        ...validPayload,
        sourceIssueId: 12345,
      }),
    ).toBeNull();
  });

  it("returns null when sourceIssueStatus is the wrong type (object)", () => {
    expect(
      parseSourceResolvedWatchdogFold({
        ...validPayload,
        sourceIssueStatus: { bad: "shape" },
      }),
    ).toBeNull();
  });

  it("drops malformed optional fields to their safe default instead of propagating garbage", () => {
    const result = parseSourceResolvedWatchdogFold({
      ...validPayload,
      silenceAgeMs: "not-a-number",
      evaluationIssueId: 999,
      cleanup: "not-an-object",
    });
    expect(result).not.toBeNull();
    expect(result?.silenceAgeMs).toBeNull();
    expect(result?.evaluationIssueId).toBeNull();
    expect(result?.cleanup).toEqual({
      attempted: false,
      outcome: "no_process_metadata",
      adapterType: null,
      pid: null,
      processGroupId: null,
      error: null,
    });
  });

  it("rejects NaN and non-finite values for silenceAgeMs instead of letting NaN through", () => {
    const result = parseSourceResolvedWatchdogFold({
      ...validPayload,
      silenceAgeMs: Number.NaN,
    });
    expect(result?.silenceAgeMs).toBeNull();

    const infinite = parseSourceResolvedWatchdogFold({
      ...validPayload,
      silenceAgeMs: Number.POSITIVE_INFINITY,
    });
    expect(infinite?.silenceAgeMs).toBeNull();
  });

  it("ignores extra unexpected fields on the top-level payload", () => {
    const result = parseSourceResolvedWatchdogFold({
      ...validPayload,
      somethingUnexpected: "extra",
      anotherExtra: { nested: true },
    });
    expect(result).toEqual(validPayload);
    expect(result).not.toHaveProperty("somethingUnexpected");
  });

  it("ignores extra unexpected fields inside cleanup", () => {
    const result = parseSourceResolvedWatchdogFold({
      ...validPayload,
      cleanup: { ...validPayload.cleanup, extraField: "ignored" },
    });
    expect(result?.cleanup).toEqual(validPayload.cleanup);
  });

  it("returns null for null input", () => {
    expect(parseSourceResolvedWatchdogFold(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseSourceResolvedWatchdogFold(undefined)).toBeNull();
  });

  it("returns null for non-object input (string, number, boolean)", () => {
    expect(parseSourceResolvedWatchdogFold("just a string")).toBeNull();
    expect(parseSourceResolvedWatchdogFold(42)).toBeNull();
    expect(parseSourceResolvedWatchdogFold(true)).toBeNull();
  });

  it("returns null for an array input (arrays are typeof object but not a record)", () => {
    expect(parseSourceResolvedWatchdogFold([validPayload])).toBeNull();
  });

  it("returns null for an empty object", () => {
    expect(parseSourceResolvedWatchdogFold({})).toBeNull();
  });
});

describe("formatCleanupOutcome", () => {
  it("maps known outcomes to their human-readable label", () => {
    expect(formatCleanupOutcome("terminated")).toBe("terminated");
    expect(formatCleanupOutcome("termination_sent_still_running")).toBe("termination sent (still running)");
    expect(formatCleanupOutcome("skipped_non_local_adapter")).toBe("skipped (non-local adapter)");
  });

  it("falls back to an underscore-to-space conversion for unknown outcomes", () => {
    expect(formatCleanupOutcome("some_unknown_outcome")).toBe("some unknown outcome");
  });

  it("returns an empty string unchanged for an empty outcome", () => {
    expect(formatCleanupOutcome("")).toBe("");
  });
});

describe("formatSilenceAgeMs", () => {
  it("returns null for null, undefined, zero, and negative values", () => {
    expect(formatSilenceAgeMs(null)).toBeNull();
    expect(formatSilenceAgeMs(undefined)).toBeNull();
    expect(formatSilenceAgeMs(0)).toBeNull();
    expect(formatSilenceAgeMs(-1000)).toBeNull();
  });

  it("formats sub-minute durations as 'under 1 minute'", () => {
    expect(formatSilenceAgeMs(30_000)).toBe("under 1 minute");
  });

  it("formats whole minutes with correct pluralization", () => {
    expect(formatSilenceAgeMs(60_000)).toBe("1 minute");
    expect(formatSilenceAgeMs(120_000)).toBe("2 minutes");
  });

  it("formats whole hours with correct pluralization", () => {
    expect(formatSilenceAgeMs(60 * 60_000)).toBe("1 hour");
    expect(formatSilenceAgeMs(2 * 60 * 60_000)).toBe("2 hours");
  });

  it("formats hours and minutes together", () => {
    expect(formatSilenceAgeMs(90 * 60_000)).toBe("1h 30m");
  });
});

describe("shortenEvidenceId", () => {
  it("returns short ids unchanged", () => {
    expect(shortenEvidenceId("abc")).toBe("abc");
    expect(shortenEvidenceId("123456789012")).toBe("123456789012");
  });

  it("truncates ids longer than 12 characters to the first 8", () => {
    expect(shortenEvidenceId("1234567890123")).toBe("12345678");
  });

  it("returns an empty string unchanged", () => {
    expect(shortenEvidenceId("")).toBe("");
  });
});
