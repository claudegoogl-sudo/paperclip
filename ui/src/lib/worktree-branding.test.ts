// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  getWorktreeInstanceId,
  getWorktreeUiBranding,
  isWorktreeRuntime,
} from "./worktree-branding";
import { READABLE_TEXT_DARK, READABLE_TEXT_LIGHT } from "./color-contrast";

function setMeta(name: string, content: string): void {
  const meta = document.createElement("meta");
  meta.setAttribute("name", name);
  meta.setAttribute("content", content);
  document.head.appendChild(meta);
}

function clearMetaTags(): void {
  document.head.querySelectorAll("meta[name^='paperclip-']").forEach((el) => el.remove());
}

describe("isWorktreeRuntime", () => {
  afterEach(() => {
    clearMetaTags();
  });

  it("returns false when no meta tag is present", () => {
    expect(isWorktreeRuntime()).toBe(false);
  });

  it("returns true when the enabled meta tag content is exactly 'true'", () => {
    setMeta("paperclip-worktree-enabled", "true");
    expect(isWorktreeRuntime()).toBe(true);
  });

  it("returns false for any other content value", () => {
    setMeta("paperclip-worktree-enabled", "True");
    expect(isWorktreeRuntime()).toBe(false);
  });

  it("returns false when the content is empty", () => {
    setMeta("paperclip-worktree-enabled", "");
    expect(isWorktreeRuntime()).toBe(false);
  });
});

describe("getWorktreeInstanceId", () => {
  afterEach(() => {
    clearMetaTags();
  });

  it("returns null when no meta tag is present", () => {
    expect(getWorktreeInstanceId()).toBeNull();
  });

  it("returns the trimmed instance id from the meta tag", () => {
    setMeta("paperclip-instance-id", "  worktree-abc123  ");
    expect(getWorktreeInstanceId()).toBe("worktree-abc123");
  });

  it("returns null when the content is blank", () => {
    setMeta("paperclip-instance-id", "   ");
    expect(getWorktreeInstanceId()).toBeNull();
  });
});

describe("getWorktreeUiBranding", () => {
  afterEach(() => {
    clearMetaTags();
  });

  it("returns null when the worktree is not enabled", () => {
    setMeta("paperclip-worktree-name", "feature-x");
    setMeta("paperclip-worktree-color", "#336699");
    expect(getWorktreeUiBranding()).toBeNull();
  });

  it("returns null when enabled but the name is missing", () => {
    setMeta("paperclip-worktree-enabled", "true");
    setMeta("paperclip-worktree-color", "#336699");
    expect(getWorktreeUiBranding()).toBeNull();
  });

  it("returns null when enabled but the color is missing or invalid", () => {
    setMeta("paperclip-worktree-enabled", "true");
    setMeta("paperclip-worktree-name", "feature-x");
    setMeta("paperclip-worktree-color", "not-a-color");
    expect(getWorktreeUiBranding()).toBeNull();
  });

  it("normalizes a 3-digit hex color and expands it to 6 digits", () => {
    setMeta("paperclip-worktree-enabled", "true");
    setMeta("paperclip-worktree-name", "feature-x");
    setMeta("paperclip-worktree-color", "#0f0");
    const branding = getWorktreeUiBranding();
    expect(branding).not.toBeNull();
    expect(branding?.color).toBe("#00ff00");
  });

  it("uses the explicit text color when provided and valid", () => {
    setMeta("paperclip-worktree-enabled", "true");
    setMeta("paperclip-worktree-name", "feature-x");
    setMeta("paperclip-worktree-color", "#112233");
    setMeta("paperclip-worktree-text-color", "#abc");
    const branding = getWorktreeUiBranding();
    expect(branding).toEqual({
      enabled: true,
      name: "feature-x",
      color: "#112233",
      textColor: "#aabbcc",
    });
  });

  it("derives a light readable text color for a dark background when no text color is given", () => {
    setMeta("paperclip-worktree-enabled", "true");
    setMeta("paperclip-worktree-name", "feature-x");
    setMeta("paperclip-worktree-color", "#000000");
    const branding = getWorktreeUiBranding();
    expect(branding?.textColor).toBe(READABLE_TEXT_LIGHT);
  });

  it("derives a dark readable text color for a light background when no text color is given", () => {
    setMeta("paperclip-worktree-enabled", "true");
    setMeta("paperclip-worktree-name", "feature-x");
    setMeta("paperclip-worktree-color", "#ffffff");
    const branding = getWorktreeUiBranding();
    expect(branding?.textColor).toBe(READABLE_TEXT_DARK);
  });

  it("falls back to the derived text color when the provided text-color meta is invalid", () => {
    setMeta("paperclip-worktree-enabled", "true");
    setMeta("paperclip-worktree-name", "feature-x");
    setMeta("paperclip-worktree-color", "#000000");
    setMeta("paperclip-worktree-text-color", "not-a-color");
    const branding = getWorktreeUiBranding();
    expect(branding?.textColor).toBe(READABLE_TEXT_LIGHT);
  });
});
