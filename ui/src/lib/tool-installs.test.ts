import type { ToolConnectionInstall } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  autoExtendNotice,
  installInfoNotice,
  installPayload,
  installStateFrom,
  isAgentInstalled,
} from "./tool-installs";

function makeInstall(
  overrides: Partial<ToolConnectionInstall> = {},
): ToolConnectionInstall {
  return {
    id: "install-1",
    companyId: "company-1",
    connectionId: "connection-1",
    targetType: "agent",
    targetId: "agent-1",
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("installStateFrom", () => {
  it("returns onAll false and an empty set when there are no installs", () => {
    expect(installStateFrom([])).toEqual({ onAll: false, agentIds: new Set() });
  });

  it("returns onAll false and an empty set when installs is undefined", () => {
    expect(installStateFrom(undefined)).toEqual({ onAll: false, agentIds: new Set() });
  });

  it("collects per-agent install rows into agentIds without setting onAll", () => {
    const state = installStateFrom([
      makeInstall({ targetType: "agent", targetId: "agent-1" }),
      makeInstall({ targetType: "agent", targetId: "agent-2" }),
    ]);
    expect(state.onAll).toBe(false);
    expect(state.agentIds).toEqual(new Set(["agent-1", "agent-2"]));
  });

  it("sets onAll when a company-targeted install row is present", () => {
    const state = installStateFrom([
      makeInstall({ targetType: "company", targetId: "company-1" }),
    ]);
    expect(state.onAll).toBe(true);
    expect(state.agentIds.size).toBe(0);
  });

  it("sets onAll and still collects agent rows when both are present", () => {
    const state = installStateFrom([
      makeInstall({ targetType: "company", targetId: "company-1" }),
      makeInstall({ targetType: "agent", targetId: "agent-1" }),
    ]);
    expect(state.onAll).toBe(true);
    expect(state.agentIds).toEqual(new Set(["agent-1"]));
  });

  it("deduplicates repeated agent target ids", () => {
    const state = installStateFrom([
      makeInstall({ targetType: "agent", targetId: "agent-1" }),
      makeInstall({ targetType: "agent", targetId: "agent-1" }),
    ]);
    expect(state.agentIds).toEqual(new Set(["agent-1"]));
  });
});

describe("isAgentInstalled", () => {
  it("is true for any agent when onAll is set, even one with no explicit row", () => {
    const state = installStateFrom([
      makeInstall({ targetType: "company", targetId: "company-1" }),
    ]);
    expect(isAgentInstalled(state, "agent-unrelated")).toBe(true);
  });

  it("is true for an agent with an explicit per-agent install row", () => {
    const state = installStateFrom([makeInstall({ targetType: "agent", targetId: "agent-1" })]);
    expect(isAgentInstalled(state, "agent-1")).toBe(true);
  });

  it("is false for an agent with no install row and no onAll", () => {
    const state = installStateFrom([makeInstall({ targetType: "agent", targetId: "agent-1" })]);
    expect(isAgentInstalled(state, "agent-2")).toBe(false);
  });

  it("is false for every agent when there are no installs at all", () => {
    const state = installStateFrom([]);
    expect(isAgentInstalled(state, "agent-1")).toBe(false);
  });
});

describe("installPayload", () => {
  it("serializes onAll state as a single company-targeted row", () => {
    const state = installStateFrom([
      makeInstall({ targetType: "company", targetId: "company-1" }),
    ]);
    expect(installPayload("company-1", state)).toEqual([
      { targetType: "company", targetId: "company-1" },
    ]);
  });

  it("ignores any agent ids on the state when onAll is set", () => {
    const state = installStateFrom([
      makeInstall({ targetType: "company", targetId: "company-1" }),
      makeInstall({ targetType: "agent", targetId: "agent-1" }),
    ]);
    expect(installPayload("company-1", state)).toEqual([
      { targetType: "company", targetId: "company-1" },
    ]);
  });

  it("serializes per-agent state as one row per agent id", () => {
    const state = installStateFrom([
      makeInstall({ targetType: "agent", targetId: "agent-1" }),
      makeInstall({ targetType: "agent", targetId: "agent-2" }),
    ]);
    const payload = installPayload("company-1", state);
    expect(payload).toHaveLength(2);
    expect(payload).toEqual(
      expect.arrayContaining([
        { targetType: "agent", targetId: "agent-1" },
        { targetType: "agent", targetId: "agent-2" },
      ]),
    );
  });

  it("returns an empty array for an empty, not-installed state", () => {
    const state = installStateFrom([]);
    expect(installPayload("company-1", state)).toEqual([]);
  });
});

describe("installInfoNotice", () => {
  it("includes the app name and the per-run context cost framing", () => {
    expect(installInfoNotice("Slack")).toBe(
      "Installing adds Slack's tools to the agent's context on every run — install only where it will actually be used.",
    );
  });

  it("interpolates a different app name", () => {
    expect(installInfoNotice("GitHub")).toContain("GitHub's tools");
  });
});

describe("autoExtendNotice", () => {
  it("includes the agent name and explains the automatic access grant", () => {
    const notice = autoExtendNotice("Reviewer Bot");
    expect(notice).toBe(
      "Installing on Reviewer Bot will also grant access. A tool can't be installed on an agent that isn't allowed to use it, so we'll add Reviewer Bot to who can use it. This is logged.",
    );
  });

  it("interpolates a different agent name in both places it appears", () => {
    const notice = autoExtendNotice("Approver Bot");
    expect(notice.match(/Approver Bot/g)).toHaveLength(2);
  });
});
