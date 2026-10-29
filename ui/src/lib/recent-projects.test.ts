// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { getRecentProjectIds, trackRecentProject } from "./recent-projects";

const STORAGE_KEY = "paperclip:recent-projects";

describe("recent projects persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns an empty list when nothing has been tracked", () => {
    expect(getRecentProjectIds()).toEqual([]);
  });

  it("tracks a new project as the most recent entry", () => {
    trackRecentProject("project-1");

    expect(getRecentProjectIds()).toEqual(["project-1"]);
  });

  it("moves an already-tracked project to the front instead of duplicating it", () => {
    trackRecentProject("project-1");
    trackRecentProject("project-2");
    trackRecentProject("project-3");
    trackRecentProject("project-1");

    expect(getRecentProjectIds()).toEqual(["project-1", "project-3", "project-2"]);
  });

  it("caps the stored list at 10 entries, dropping the oldest", () => {
    for (let i = 1; i <= 11; i += 1) {
      trackRecentProject(`project-${i}`);
    }

    const ids = getRecentProjectIds();
    expect(ids).toHaveLength(10);
    // Newest (project-11) first; oldest (project-1) evicted.
    expect(ids[0]).toBe("project-11");
    expect(ids).not.toContain("project-1");
  });

  it("ignores a blank project id instead of writing it to storage", () => {
    trackRecentProject("");

    expect(getRecentProjectIds()).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("falls back to an empty list when stored data is corrupted JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not valid json");

    expect(getRecentProjectIds()).toEqual([]);
  });

  it("falls back to an empty list when stored data is valid JSON but not an array", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ not: "an array" }));

    expect(getRecentProjectIds()).toEqual([]);
  });

  it("filters out non-string entries from stored data", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["project-1", 42, null, "project-2"]));

    expect(getRecentProjectIds()).toEqual(["project-1", "project-2"]);
  });

  it("recovers cleanly after corrupted data by tracking a fresh project", () => {
    localStorage.setItem(STORAGE_KEY, "not json at all");

    trackRecentProject("project-1");

    expect(getRecentProjectIds()).toEqual(["project-1"]);
  });
});
