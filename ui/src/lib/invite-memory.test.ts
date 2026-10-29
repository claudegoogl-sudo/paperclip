// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingInviteToken,
  getRememberedInvitePath,
  rememberPendingInviteToken,
} from "./invite-memory";

const STORAGE_KEY = "paperclip:pending-invite-token";

describe("pending invite memory", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("remembers a token and surfaces it as an invite path", () => {
    rememberPendingInviteToken("abc123");

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("abc123");
    expect(getRememberedInvitePath()).toBe("/invite/abc123");
  });

  it("trims whitespace around the token before storing and reading it", () => {
    rememberPendingInviteToken("  abc123  ");

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("abc123");
    expect(getRememberedInvitePath()).toBe("/invite/abc123");
  });

  it("ignores an empty or whitespace-only token", () => {
    rememberPendingInviteToken("   ");

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(getRememberedInvitePath()).toBeNull();
  });

  it("clears the remembered token", () => {
    rememberPendingInviteToken("abc123");
    clearPendingInviteToken();

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(getRememberedInvitePath()).toBeNull();
  });

  it("clears unconditionally when no expected token is passed", () => {
    rememberPendingInviteToken("abc123");
    clearPendingInviteToken(undefined);

    expect(getRememberedInvitePath()).toBeNull();
  });

  it("only clears when the expected token matches the stored one", () => {
    rememberPendingInviteToken("abc123");
    clearPendingInviteToken("different-token");

    // A mismatched expected token must not wipe out someone else's pending invite.
    expect(getRememberedInvitePath()).toBe("/invite/abc123");

    clearPendingInviteToken("abc123");
    expect(getRememberedInvitePath()).toBeNull();
  });

  it("trims the expected token before comparing it to the stored one", () => {
    rememberPendingInviteToken("abc123");
    clearPendingInviteToken("  abc123  ");

    expect(getRememberedInvitePath()).toBeNull();
  });

  it("returns null when nothing has been remembered", () => {
    expect(getRememberedInvitePath()).toBeNull();
  });

  it("clearing when nothing is stored does not throw", () => {
    expect(() => clearPendingInviteToken()).not.toThrow();
    expect(() => clearPendingInviteToken("whatever")).not.toThrow();
  });

  it("treats a corrupted (whitespace-only) stored value as no invite", () => {
    window.localStorage.setItem(STORAGE_KEY, "   ");

    expect(getRememberedInvitePath()).toBeNull();
  });

  it("does not blow up when localStorage access throws", () => {
    const original = window.localStorage.getItem.bind(window.localStorage);
    window.localStorage.getItem = () => {
      throw new Error("storage unavailable");
    };

    try {
      expect(getRememberedInvitePath()).toBeNull();
      expect(() => clearPendingInviteToken()).not.toThrow();
    } finally {
      window.localStorage.getItem = original;
    }
  });

  it("does not blow up when localStorage.setItem throws", () => {
    const original = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = () => {
      throw new Error("storage full");
    };

    try {
      expect(() => rememberPendingInviteToken("abc123")).not.toThrow();
    } finally {
      window.localStorage.setItem = original;
    }
  });
});
