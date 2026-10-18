// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  RECENT_SEARCHES_LIMIT,
  clearRecentSearches,
  loadRecentSearches,
  pushRecentSearch,
} from "./recent-searches";

describe("recent search persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns an empty list when nothing is stored", () => {
    expect(loadRecentSearches("company-1")).toEqual([]);
  });

  it("adds a new search term to the front", () => {
    pushRecentSearch("company-1", "alpha");
    const next = pushRecentSearch("company-1", "bravo");

    expect(next).toEqual(["bravo", "alpha"]);
    expect(loadRecentSearches("company-1")).toEqual(["bravo", "alpha"]);
  });

  it("re-adding an existing term (case-insensitively) dedupes and moves it to the front", () => {
    pushRecentSearch("company-1", "alpha");
    pushRecentSearch("company-1", "bravo");
    const next = pushRecentSearch("company-1", "ALPHA");

    expect(next).toEqual(["ALPHA", "bravo"]);
    expect(loadRecentSearches("company-1")).toEqual(["ALPHA", "bravo"]);
  });

  it("trims whitespace around a query before storing it", () => {
    pushRecentSearch("company-1", "  alpha  ");

    expect(loadRecentSearches("company-1")).toEqual(["alpha"]);
  });

  it("ignores an empty or whitespace-only query and leaves existing entries untouched", () => {
    pushRecentSearch("company-1", "alpha");

    const afterEmpty = pushRecentSearch("company-1", "");
    const afterWhitespace = pushRecentSearch("company-1", "   ");

    expect(afterEmpty).toEqual(["alpha"]);
    expect(afterWhitespace).toEqual(["alpha"]);
    expect(loadRecentSearches("company-1")).toEqual(["alpha"]);
  });

  it("caps stored searches at the documented limit, dropping the oldest entries", () => {
    for (let index = 0; index < RECENT_SEARCHES_LIMIT + 3; index += 1) {
      pushRecentSearch("company-1", `term-${index}`);
    }

    const stored = loadRecentSearches("company-1");
    expect(stored).toHaveLength(RECENT_SEARCHES_LIMIT);
    expect(stored[0]).toBe(`term-${RECENT_SEARCHES_LIMIT + 2}`);
    expect(stored).not.toContain("term-0");
    expect(stored).not.toContain("term-1");
    expect(stored).not.toContain("term-2");
  });

  it("scopes recent searches independently per company", () => {
    pushRecentSearch("company-1", "alpha");
    pushRecentSearch("company-2", "bravo");

    expect(loadRecentSearches("company-1")).toEqual(["alpha"]);
    expect(loadRecentSearches("company-2")).toEqual(["bravo"]);
  });

  it("treats a missing or empty companyId as a no-op", () => {
    expect(pushRecentSearch("", "alpha")).toEqual([]);
    expect(loadRecentSearches("")).toEqual([]);

    clearRecentSearches("");
    expect(loadRecentSearches("company-1")).toEqual([]);
  });

  it("falls back to an empty list when stored data is corrupted JSON", () => {
    localStorage.setItem("paperclip:recent-searches:company-1", "{not valid json");

    expect(loadRecentSearches("company-1")).toEqual([]);
  });

  it("falls back to an empty list when stored data is not an array", () => {
    localStorage.setItem("paperclip:recent-searches:company-1", JSON.stringify({ not: "an array" }));

    expect(loadRecentSearches("company-1")).toEqual([]);
  });

  it("filters out non-string and blank entries from stored data", () => {
    localStorage.setItem(
      "paperclip:recent-searches:company-1",
      JSON.stringify(["alpha", 42, null, "   ", "bravo"]),
    );

    expect(loadRecentSearches("company-1")).toEqual(["alpha", "bravo"]);
  });

  it("clears stored searches for a company without affecting other companies", () => {
    pushRecentSearch("company-1", "alpha");
    pushRecentSearch("company-2", "bravo");

    clearRecentSearches("company-1");

    expect(loadRecentSearches("company-1")).toEqual([]);
    expect(loadRecentSearches("company-2")).toEqual(["bravo"]);
  });

  it("is a no-op to clear a company that has no stored searches", () => {
    expect(() => clearRecentSearches("company-without-data")).not.toThrow();
    expect(loadRecentSearches("company-without-data")).toEqual([]);
  });
});
