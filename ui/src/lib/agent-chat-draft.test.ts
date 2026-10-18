import type { Agent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { agentChatDraft } from "./agent-chat-draft";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Alpha Agent",
    urlKey: "alpha",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("agentChatDraft", () => {
  it("builds a draft issue keyed to the agent, defaulting to standard work mode", () => {
    const agent = makeAgent();

    const draft = agentChatDraft(agent);

    expect(draft.id).toBe("chat:agent-1");
    expect(draft.companyId).toBe("company-1");
    expect(draft.title).toBe("Chat with Alpha Agent");
    expect(draft.conversationAgentId).toBe("agent-1");
    expect(draft.assigneeAgentId).toBe("agent-1");
    expect(draft.workMode).toBe("standard");
  });

  it("derives the title from the given agent's name and id, not a fixed value", () => {
    const agent = makeAgent({ id: "agent-42", companyId: "company-9", name: "Research Bot" });

    const draft = agentChatDraft(agent);

    expect(draft.id).toBe("chat:agent-42");
    expect(draft.companyId).toBe("company-9");
    expect(draft.title).toBe("Chat with Research Bot");
    expect(draft.conversationAgentId).toBe("agent-42");
    expect(draft.assigneeAgentId).toBe("agent-42");
  });

  it("passes through an explicit work mode instead of the standard default", () => {
    const agent = makeAgent();

    const draft = agentChatDraft(agent, "planning");

    expect(draft.workMode).toBe("planning");
  });

  it("builds an empty, unassigned-to-user draft with the expected conversation and review state", () => {
    const agent = makeAgent();

    const draft = agentChatDraft(agent);

    expect(draft.conversationUserId).toBe("draft");
    expect(draft.conversationState).toBe("waiting");
    expect(draft.status).toBe("in_review");
    expect(draft.priority).toBe("medium");
    expect(draft.reviewPolicy).toBeNull();
    expect(draft.description).toBeNull();
    expect(draft.assigneeUserId).toBeNull();
    expect(draft.projectId).toBeNull();
    expect(draft.projectWorkspaceId).toBeNull();
    expect(draft.goalId).toBeNull();
    expect(draft.parentId).toBeNull();
    expect(draft.checkoutRunId).toBeNull();
    expect(draft.executionRunId).toBeNull();
    expect(draft.createdByAgentId).toBeNull();
    expect(draft.createdByUserId).toBeNull();
    expect(draft.responsibleUserId).toBeNull();
    expect(draft.issueNumber).toBeNull();
    expect(draft.identifier).toBeNull();
    expect(draft.requestDepth).toBe(0);
    expect(draft.billingCode).toBeNull();
    expect(draft.documentSummaries).toEqual([]);
    expect(draft.labels).toEqual([]);
    expect(draft.createdAt).toEqual(new Date(0));
    expect(draft.updatedAt).toEqual(new Date(0));
  });

  it("returns independent array instances across calls so one draft cannot mutate another", () => {
    const agent = makeAgent();

    const first = agentChatDraft(agent);
    const second = agentChatDraft(agent);

    expect(first.labels).not.toBe(second.labels);
    expect(first.documentSummaries).not.toBe(second.documentSummaries);

    first.labels.push({ id: "l1", companyId: "company-1", name: "x", color: "#000" } as never);
    expect(second.labels).toEqual([]);
  });
});
