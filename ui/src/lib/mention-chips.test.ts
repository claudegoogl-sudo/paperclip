import { describe, expect, it } from "vitest";
import {
  buildAgentMentionHref,
  buildProjectMentionHref,
  buildRoutineMentionHref,
  buildSkillMentionHref,
  buildUserMentionHref,
} from "@paperclipai/shared";
import { mentionChipInlineStyle, parseMentionChipHref } from "./mention-chips";

describe("parseMentionChipHref", () => {
  it("rejects absolute http(s) URLs before trying any mention scheme", () => {
    expect(parseMentionChipHref("https://example.com/issues/ABC-1")).toBeNull();
    expect(parseMentionChipHref("http://example.com")).toBeNull();
  });

  it("parses an issue reference href", () => {
    expect(parseMentionChipHref("/issues/ABC-123")).toEqual({
      kind: "issue",
      identifier: "ABC-123",
    });
  });

  it("parses an agent mention href, including its icon", () => {
    const href = buildAgentMentionHref("agent-1", "rocket");
    expect(parseMentionChipHref(href)).toEqual({
      kind: "agent",
      agentId: "agent-1",
      icon: "rocket",
    });
  });

  it("parses an agent mention href with no icon as null", () => {
    const href = buildAgentMentionHref("agent-1");
    expect(parseMentionChipHref(href)).toEqual({
      kind: "agent",
      agentId: "agent-1",
      icon: null,
    });
  });

  it("parses a project mention href, including its color", () => {
    const href = buildProjectMentionHref("proj-1", "#ff0000");
    expect(parseMentionChipHref(href)).toEqual({
      kind: "project",
      projectId: "proj-1",
      color: "#ff0000",
    });
  });

  it("parses a project mention href with no color as null", () => {
    const href = buildProjectMentionHref("proj-1");
    expect(parseMentionChipHref(href)).toEqual({
      kind: "project",
      projectId: "proj-1",
      color: null,
    });
  });

  it("parses a user mention href", () => {
    const href = buildUserMentionHref("user-1");
    expect(parseMentionChipHref(href)).toEqual({
      kind: "user",
      userId: "user-1",
    });
  });

  it("parses a skill mention href, including its slug", () => {
    const href = buildSkillMentionHref("skill-1", "my-skill");
    expect(parseMentionChipHref(href)).toEqual({
      kind: "skill",
      skillId: "skill-1",
      slug: "my-skill",
    });
  });

  it("parses a routine mention href", () => {
    const href = buildRoutineMentionHref("routine-1");
    expect(parseMentionChipHref(href)).toEqual({
      kind: "routine",
      routineId: "routine-1",
    });
  });

  it("returns null for an href that matches no known mention scheme", () => {
    expect(parseMentionChipHref("not-a-mention")).toBeNull();
    expect(parseMentionChipHref("")).toBeNull();
    expect(parseMentionChipHref("pipeline://pipe-1")).toBeNull();
  });
});

describe("mentionChipInlineStyle", () => {
  it("returns undefined for an issue mention (no decoration to apply)", () => {
    expect(mentionChipInlineStyle({ kind: "issue", identifier: "ABC-1" })).toBeUndefined();
  });

  it("returns undefined for a user mention", () => {
    expect(mentionChipInlineStyle({ kind: "user", userId: "user-1" })).toBeUndefined();
  });

  it("returns undefined for a skill mention", () => {
    expect(
      mentionChipInlineStyle({ kind: "skill", skillId: "skill-1", slug: "my-skill" }),
    ).toBeUndefined();
  });

  it("returns undefined for a routine mention", () => {
    expect(mentionChipInlineStyle({ kind: "routine", routineId: "routine-1" })).toBeUndefined();
  });

  it("returns undefined for a project mention with no color", () => {
    expect(
      mentionChipInlineStyle({ kind: "project", projectId: "proj-1", color: null }),
    ).toBeUndefined();
  });

  it("derives border/background/text color and a CSS var from a project mention color", () => {
    const style = mentionChipInlineStyle({
      kind: "project",
      projectId: "proj-1",
      color: "#ff0000",
    });
    expect(style).toMatchObject({
      borderColor: "#ff0000",
      backgroundColor: "rgba(255, 0, 0, 0.22)",
    });
    expect(typeof (style as Record<string, unknown>).color).toBe("string");
    expect((style as Record<string, unknown>)["--paperclip-mention-project-color"]).toBe(
      "#ff0000",
    );
  });

  it("still sets the CSS var but omits border/background/text color for an invalid color", () => {
    // mentionChipInlineStyle is only ever fed colors normalized by
    // parseProjectMentionHref (valid hex or null), so this exercises an
    // input shape the real parser never produces. hexToRgb() rejects the
    // value and projectMentionColors() returns {}, but the raw color is
    // still written to the CSS var unconditionally.
    const style = mentionChipInlineStyle({
      kind: "project",
      projectId: "proj-1",
      color: "not-a-hex-color",
    });
    expect(style).toEqual({
      "--paperclip-mention-project-color": "not-a-hex-color",
    });
  });

  it("sets an avatar image CSS var for an agent mention", () => {
    const style = mentionChipInlineStyle({ kind: "agent", agentId: "agent-1", icon: "rocket" });
    expect(style).toBeDefined();
    const avatar = (style as Record<string, unknown>)["--paperclip-mention-avatar-image"];
    expect(typeof avatar).toBe("string");
    expect(avatar as string).toMatch(/^url\("/);
  });

  it("still produces an avatar image for an agent mention with a null icon", () => {
    const style = mentionChipInlineStyle({ kind: "agent", agentId: "agent-1", icon: null });
    expect(style).toBeDefined();
    expect(
      typeof (style as Record<string, unknown>)["--paperclip-mention-avatar-image"],
    ).toBe("string");
  });
});
