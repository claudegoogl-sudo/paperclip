import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mockGetAgentWorkEligibility = vi.hoisted(() => vi.fn());
vi.mock("@paperclipai/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/shared")>();
  return { ...actual, getAgentWorkEligibility: mockGetAgentWorkEligibility };
});

import { assertAssignableAgent } from "./agent-assignability.js";

const COMPANY = "company-1";
const AGENT = "agent-1";

function makeDb(responses: unknown[][]): Db {
  let callIndex = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(responses[callIndex++] ?? []),
      }),
    }),
  } as unknown as Db;
}

const assigneeRow = { id: AGENT, companyId: COMPANY, name: "Worker", status: "active", reportsTo: null };

function stubEligible() {
  mockGetAgentWorkEligibility.mockReturnValue({
    assignable: true,
    orgChainHealth: { fullChain: [], firstInvalidAncestor: null },
  });
}

describe("assertAssignableAgent", () => {
  it("is a no-op when agentId is null or undefined", async () => {
    const db = makeDb([]);
    await expect(assertAssignableAgent(db, COMPANY, null)).resolves.toBeUndefined();
    await expect(assertAssignableAgent(db, COMPANY, undefined)).resolves.toBeUndefined();
    expect(mockGetAgentWorkEligibility).not.toHaveBeenCalled();
  });

  it("throws 404 when the assignee agent does not exist", async () => {
    const db = makeDb([[]]);
    await expect(assertAssignableAgent(db, COMPANY, AGENT)).rejects.toMatchObject({
      status: 404,
      message: "Assignee agent not found",
    });
  });

  it("throws 422 when the assignee belongs to a different company", async () => {
    const db = makeDb([[{ ...assigneeRow, companyId: "other-company" }]]);
    await expect(assertAssignableAgent(db, COMPANY, AGENT)).rejects.toMatchObject({
      status: 422,
      message: "Assignee must belong to same company",
    });
  });

  it("resolves when the eligibility check says the agent is assignable", async () => {
    const db = makeDb([[assigneeRow], []]);
    stubEligible();
    await expect(assertAssignableAgent(db, COMPANY, AGENT)).resolves.toBeUndefined();
  });

  it("throws 409 with the work-assignment message for a pending_approval assignee", async () => {
    const db = makeDb([[assigneeRow], []]);
    mockGetAgentWorkEligibility.mockReturnValue({
      assignable: false,
      assignabilityReason: "pending_approval",
      orgChainHealth: { fullChain: [], firstInvalidAncestor: null },
    });
    await expect(assertAssignableAgent(db, COMPANY, AGENT)).rejects.toMatchObject({
      status: 409,
      message: "Cannot assign work to pending approval agents",
      details: expect.objectContaining({ code: "agent_not_assignable", reason: "pending_approval" }),
    });
  });

  it("uses the routine-assignment message variant when kind is 'routine'", async () => {
    const db = makeDb([[assigneeRow], []]);
    mockGetAgentWorkEligibility.mockReturnValue({
      assignable: false,
      assignabilityReason: "terminated",
      orgChainHealth: { fullChain: [], firstInvalidAncestor: null },
    });
    await expect(
      assertAssignableAgent(db, COMPANY, AGENT, { kind: "routine" }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Cannot assign routines to terminated agents",
      details: expect.objectContaining({ reason: "assignee_terminated" }),
    });
  });

  it("maps 'unknown_status' to the unsupported-lifecycle-status message", async () => {
    const db = makeDb([[assigneeRow], []]);
    mockGetAgentWorkEligibility.mockReturnValue({
      assignable: false,
      assignabilityReason: "unknown_status",
      orgChainHealth: { fullChain: [], firstInvalidAncestor: null },
    });
    await expect(assertAssignableAgent(db, COMPANY, AGENT)).rejects.toMatchObject({
      status: 409,
      message: "Cannot assign work to agents with an unsupported lifecycle status",
      details: expect.objectContaining({ reason: "assignee_unknown_status" }),
    });
  });

  it("maps an org-chain 'terminated_ancestor' health reason to ancestor_terminated, with invalidAncestorAgentId set", async () => {
    const db = makeDb([[assigneeRow], []]);
    mockGetAgentWorkEligibility.mockReturnValue({
      assignable: false,
      assignabilityReason: "invalid_org_chain",
      orgChainHealth: {
        reason: "terminated_ancestor",
        fullChain: [assigneeRow],
        firstInvalidAncestor: { id: "manager-1", status: "terminated" },
      },
    });
    await expect(assertAssignableAgent(db, COMPANY, AGENT)).rejects.toMatchObject({
      status: 409,
      message: "Cannot assign work to agents with an invalid org chain",
      details: expect.objectContaining({
        reason: "ancestor_terminated",
        invalidAncestorAgentId: "manager-1",
        missingAncestorAgentId: null,
      }),
    });
  });

  it("maps a 'missing_manager' health reason to ancestor_missing, with missingAncestorAgentId set", async () => {
    const db = makeDb([[assigneeRow], []]);
    mockGetAgentWorkEligibility.mockReturnValue({
      assignable: false,
      assignabilityReason: "invalid_org_chain",
      orgChainHealth: {
        reason: "missing_manager",
        fullChain: [],
        firstInvalidAncestor: { id: "manager-2", status: "missing" },
      },
    });
    await expect(assertAssignableAgent(db, COMPANY, AGENT)).rejects.toMatchObject({
      details: expect.objectContaining({
        reason: "ancestor_missing",
        invalidAncestorAgentId: null,
        missingAncestorAgentId: "manager-2",
      }),
    });
  });

  it("maps a 'cycle' health reason to ancestor_cycle", async () => {
    const db = makeDb([[assigneeRow], []]);
    mockGetAgentWorkEligibility.mockReturnValue({
      assignable: false,
      assignabilityReason: "invalid_org_chain",
      orgChainHealth: { reason: "cycle", fullChain: [], firstInvalidAncestor: null },
    });
    await expect(assertAssignableAgent(db, COMPANY, AGENT)).rejects.toMatchObject({
      details: expect.objectContaining({ reason: "ancestor_cycle" }),
    });
  });

  it("falls back to ancestor_missing for an unrecognized health reason", async () => {
    const db = makeDb([[assigneeRow], []]);
    mockGetAgentWorkEligibility.mockReturnValue({
      assignable: false,
      assignabilityReason: "invalid_org_chain",
      orgChainHealth: { reason: "some_future_reason", fullChain: [], firstInvalidAncestor: null },
    });
    await expect(assertAssignableAgent(db, COMPANY, AGENT)).rejects.toMatchObject({
      details: expect.objectContaining({ reason: "ancestor_missing" }),
    });
  });
});
