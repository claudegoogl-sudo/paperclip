// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { getRecentStudioSkillIds, trackRecentStudioSkill } from "./recent-skills";

// Same key the module itself persists under ("paperclip:recent-studio-skills"),
// asserted against directly to confirm this module actually round-trips
// through localStorage rather than just an in-memory list.
const STORAGE_KEY = "paperclip:recent-studio-skills";

describe("recent studio skill persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns an empty list when nothing has been tracked", () => {
    expect(getRecentStudioSkillIds()).toEqual([]);
  });

  it("tracks a skill id and persists it under the dedicated storage key", () => {
    trackRecentStudioSkill("skill-1");

    expect(getRecentStudioSkillIds()).toEqual(["skill-1"]);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(["skill-1"]));
  });

  it("adds newer skills to the front of the list", () => {
    trackRecentStudioSkill("skill-1");
    trackRecentStudioSkill("skill-2");
    trackRecentStudioSkill("skill-3");

    expect(getRecentStudioSkillIds()).toEqual(["skill-3", "skill-2", "skill-1"]);
  });

  it("de-duplicates by moving a re-tracked skill back to the front instead of repeating it", () => {
    trackRecentStudioSkill("skill-1");
    trackRecentStudioSkill("skill-2");
    trackRecentStudioSkill("skill-3");
    trackRecentStudioSkill("skill-1");

    expect(getRecentStudioSkillIds()).toEqual(["skill-1", "skill-3", "skill-2"]);
  });

  it("ignores an empty skill id", () => {
    trackRecentStudioSkill("skill-1");
    trackRecentStudioSkill("");

    expect(getRecentStudioSkillIds()).toEqual(["skill-1"]);
  });

  it("caps the stored list at 10 entries, dropping the oldest", () => {
    for (let index = 1; index <= 12; index += 1) {
      trackRecentStudioSkill(`skill-${index}`);
    }

    const ids = getRecentStudioSkillIds();
    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe("skill-12");
    expect(ids[ids.length - 1]).toBe("skill-3");
    expect(ids).not.toContain("skill-1");
    expect(ids).not.toContain("skill-2");
  });

  it("falls back to an empty list when the stored value is corrupted JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not valid json");

    expect(getRecentStudioSkillIds()).toEqual([]);
  });

  it("falls back to an empty list when the stored value is not an array", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ foo: "bar" }));

    expect(getRecentStudioSkillIds()).toEqual([]);
  });

  it("filters out non-string entries from a malformed stored array", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["skill-1", 42, null, { id: "skill-2" }, "skill-3"]));

    expect(getRecentStudioSkillIds()).toEqual(["skill-1", "skill-3"]);
  });

  it("recovers cleanly by tracking a new skill after corrupted data is overwritten", () => {
    localStorage.setItem(STORAGE_KEY, "not json at all");

    trackRecentStudioSkill("skill-1");

    expect(getRecentStudioSkillIds()).toEqual(["skill-1"]);
  });
});
