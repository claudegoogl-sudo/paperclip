// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  fuzzyTextMatchesQuery,
  normalizeSearchText,
  scoreFuzzyTextFields,
  scoreFuzzyTextMatch,
} from "./searchable-select";

describe("normalizeSearchText", () => {
  it("trims, lowercases, and collapses internal whitespace", () => {
    expect(normalizeSearchText("  Alpha   Beta  ")).toBe("alpha beta");
  });

  it("leaves an already-normalized string unchanged", () => {
    expect(normalizeSearchText("alpha beta")).toBe("alpha beta");
  });

  it("returns an empty string for blank input", () => {
    expect(normalizeSearchText("   ")).toBe("");
  });
});

describe("scoreFuzzyTextMatch / fuzzyTextMatchesQuery - basic cases", () => {
  it("treats an empty query as a universal match with score 0", () => {
    expect(scoreFuzzyTextMatch("anything", "")).toBe(0);
    expect(fuzzyTextMatchesQuery("anything", "")).toBe(true);
  });

  it("scores an exact word match as the best possible score", () => {
    const score = scoreFuzzyTextMatch("widget", "widget");
    expect(score).toBe(0);
    expect(fuzzyTextMatchesQuery("widget", "widget")).toBe(true);
  });

  it("scores a prefix match better than no match, and worse than exact", () => {
    const prefixScore = scoreFuzzyTextMatch("widgets", "widget");
    expect(prefixScore).not.toBeNull();
    expect(prefixScore).toBeGreaterThan(0);
    expect(fuzzyTextMatchesQuery("widgets", "widget")).toBe(true);
  });

  it("scores a contiguous substring match", () => {
    const score = scoreFuzzyTextMatch("sandwidget", "widget");
    expect(score).not.toBeNull();
    expect(fuzzyTextMatchesQuery("sandwidget", "widget")).toBe(true);
  });

  it("does not match text that lacks the query entirely", () => {
    expect(scoreFuzzyTextMatch("banana", "xyz")).toBeNull();
    expect(fuzzyTextMatchesQuery("banana", "xyz")).toBe(false);
  });

  it("is case-insensitive and whitespace-tolerant", () => {
    expect(fuzzyTextMatchesQuery("  Widget  ", "WIDGET")).toBe(true);
  });
});

describe("fuzzy subsequence matching (gap-counting scorer)", () => {
  it("matches a query whose letters appear in order with a gap (cat -> coat)", () => {
    // "cat" is not a substring of "coat", but c-?-a-t is an in-order subsequence.
    const score = scoreFuzzyTextMatch("coat", "cat");
    expect(score).not.toBeNull();
    expect(fuzzyTextMatchesQuery("coat", "cat")).toBe(true);
  });

  it("does not match when the query's letters appear out of order", () => {
    // "tac" requires t before a before c, which "cat" cannot satisfy as a subsequence.
    expect(scoreFuzzyTextMatch("cat", "tac")).toBeNull();
    expect(fuzzyTextMatchesQuery("cat", "tac")).toBe(false);
  });

  it("scores a tighter (smaller-gap) subsequence match better than a looser one", () => {
    // Both "cxat" and "cxxat" contain c,a,t in order (not contiguous), but
    // the extra filler letter in "cxxat" widens the gap between the matches.
    const tight = scoreFuzzyTextMatch("cxat", "cat");
    const loose = scoreFuzzyTextMatch("cxxat", "cat");
    expect(tight).not.toBeNull();
    expect(loose).not.toBeNull();
    expect(tight as number).toBeLessThan(loose as number);
  });

  it("scores a match starting earlier in the word better than the same shape starting later", () => {
    // "xcoatx" shifts the same c-?-a-t subsequence one character later than "coatxx".
    const earlier = scoreFuzzyTextMatch("coatxx", "cat");
    const later = scoreFuzzyTextMatch("xcoatx", "cat");
    expect(earlier).not.toBeNull();
    expect(later).not.toBeNull();
    expect(earlier as number).toBeLessThan(later as number);
  });

  it("rejects a subsequence match that is spread too thin across the word", () => {
    // The gap-counting scorer caps accepted spread at 2x the query length;
    // a token's letters scattered far apart in a long word should not match.
    const word = "cXXXXXXXXXXXXXXXXXXXXaXXXXXXXXXXXXXXXXXXXXt";
    expect(scoreFuzzyTextMatch(word, "cat")).toBeNull();
  });

  it("does not require the fuzzy subsequence path for very short tokens", () => {
    // fuzzyWordSubsequenceScore bails out below length 3; a 2-letter token
    // that isn't a substring anywhere should simply not match.
    expect(scoreFuzzyTextMatch("xyz", "ba")).toBeNull();
  });

  it("handles a repeated-letter query against a word with scattered repeats", () => {
    // "aaa" is not a contiguous substring of "banana", but it is an in-order
    // subsequence (positions 1, 3, 5).
    const score = scoreFuzzyTextMatch("banana", "aaa");
    expect(score).not.toBeNull();
  });

  // --- Regression test for a fixed bug ---
  //
  // fuzzyWordSubsequenceScore used to be a single-pass, greedy (leftmost-match)
  // scanner with no backtracking: once it committed to the first occurrence of
  // the query's first letter, it never reconsidered that choice even if a
  // later occurrence would have produced a tighter (and therefore valid)
  // subsequence.
  //
  // Below, the word has an early, isolated "a" far from any "b", and a
  // separate, tightly-packed "a" + "b" + "a" run near the end. The old greedy
  // scanner locked onto the early "a", dragged the match across the whole
  // word chasing the next "b"/"a", blew past the `spread > token.length * 2`
  // cutoff, and incorrectly reported no match. The fix tries every
  // occurrence of the first letter as a candidate start and keeps the best
  // passing result, so the tight match at the tail is now found.
  it("matches via a tighter subsequence later in the word, even when an earlier start would fail the spread cutoff", () => {
    const word = "axxxxxxxxxaybza";
    // The tight match lives at the tail of the word: a(10) b(12) a(14).
    expect(word.slice(10)).toBe("aybza");

    const score = scoreFuzzyTextMatch(word, "aba");
    expect(score).not.toBeNull();
    expect(fuzzyTextMatchesQuery(word, "aba")).toBe(true);
  });
});

describe("scoreFuzzyTextFields", () => {
  it("returns 0 for an empty query regardless of fields", () => {
    expect(scoreFuzzyTextFields([{ text: "alpha" }, { text: "beta" }], "")).toBe(0);
  });

  it("returns null when no field matches any query token", () => {
    expect(scoreFuzzyTextFields([{ text: "alpha" }, { text: "beta" }], "zzz")).toBeNull();
  });

  it("sums per-token best scores across multiple query words", () => {
    const single = scoreFuzzyTextFields([{ text: "alpha" }], "alpha");
    const combined = scoreFuzzyTextFields([{ text: "alpha beta" }], "alpha beta");
    expect(single).toBe(0);
    expect(combined).not.toBeNull();
    // Both tokens match exactly in their own word, but the second word incurs
    // a per-field-index tiebreak penalty, so combined score should be > single.
    expect(combined as number).toBeGreaterThan(single as number);
  });

  it("treats a null/undefined field text as empty text", () => {
    expect(scoreFuzzyTextFields([{ text: null }, { text: undefined }], "")).toBe(0);
    expect(scoreFuzzyTextFields([{ text: null }], "alpha")).toBeNull();
  });

  it("prefers a lower explicit field weight over a higher one for the same match quality", () => {
    const lowWeightFirst = scoreFuzzyTextFields(
      [
        { text: "alpha", weight: 0 },
        { text: "alpha", weight: 100 },
      ],
      "alpha",
    );
    const onlyHighWeight = scoreFuzzyTextFields([{ text: "alpha", weight: 100 }], "alpha");
    expect(lowWeightFirst).toBe(0);
    expect(onlyHighWeight).toBe(100);
  });
});
