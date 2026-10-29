import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearLegacyChatMessageRequests } from "./chat-message-request";

describe("clearLegacyChatMessageRequests", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("removes the legacy pending-request key for the given scope", () => {
    const scope = "company-1:user-1:agent-1";
    const key = `paperclip:agent-chat-pending:${scope}`;
    localStorage.setItem(key, JSON.stringify([{ id: "old", body: "retry me" }]));

    clearLegacyChatMessageRequests(scope);

    expect(localStorage.getItem(key)).toBeNull();
  });

  it("is a no-op and does not throw when no matching key exists", () => {
    const scope = "company-2:user-2:agent-2";
    const key = `paperclip:agent-chat-pending:${scope}`;
    expect(localStorage.getItem(key)).toBeNull();

    expect(() => clearLegacyChatMessageRequests(scope)).not.toThrow();

    expect(localStorage.getItem(key)).toBeNull();
  });

  it("does not touch keys for other scopes or unrelated keys", () => {
    const targetScope = "company-3:user-3:agent-3";
    const targetKey = `paperclip:agent-chat-pending:${targetScope}`;
    const otherScopeKey = "paperclip:agent-chat-pending:company-3:user-3:agent-OTHER";
    const unrelatedKey = "paperclip.recentAgentChats:company-3:user-3";

    localStorage.setItem(targetKey, "target-value");
    localStorage.setItem(otherScopeKey, "other-scope-value");
    localStorage.setItem(unrelatedKey, "unrelated-value");

    clearLegacyChatMessageRequests(targetScope);

    expect(localStorage.getItem(targetKey)).toBeNull();
    expect(localStorage.getItem(otherScopeKey)).toBe("other-scope-value");
    expect(localStorage.getItem(unrelatedKey)).toBe("unrelated-value");
  });

  it("swallows errors when localStorage access throws", () => {
    const scope = "company-4:user-4:agent-4";
    const removeItemSpy = vi
      .spyOn(localStorage, "removeItem")
      .mockImplementation(() => {
        throw new Error("storage disabled");
      });

    expect(() => clearLegacyChatMessageRequests(scope)).not.toThrow();

    removeItemSpy.mockRestore();
  });
});
