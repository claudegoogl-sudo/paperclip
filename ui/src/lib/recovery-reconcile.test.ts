import type { IssueRecoveryAction } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import type { CurrentBoardAccess } from "../api/access";
import { canBoardManageRuntime, readRecoveryReconcileWorkspaceId } from "./recovery-reconcile";

function boardAccess(overrides: Partial<CurrentBoardAccess>): CurrentBoardAccess {
  return {
    user: null,
    userId: "user-1",
    isInstanceAdmin: false,
    companyIds: [],
    source: "session",
    keyId: null,
    ...overrides,
  };
}

function recoveryAction(overrides: Partial<IssueRecoveryAction>): IssueRecoveryAction {
  return {
    id: "recovery-1",
    companyId: "company-1",
    sourceIssueId: "issue-1",
    recoveryIssueId: null,
    kind: "workspace_validation",
    status: "open",
    ownerType: "agent",
    ownerAgentId: null,
    ownerUserId: null,
    previousOwnerAgentId: null,
    returnOwnerAgentId: null,
    cause: "branch_incoherence",
    fingerprint: "fp-1",
    evidence: {},
    nextAction: "reconcile",
    wakePolicy: null,
    monitorPolicy: null,
    attemptCount: 0,
    maxAttempts: null,
    timeoutAt: null,
    lastAttemptAt: null,
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as IssueRecoveryAction;
}

describe("canBoardManageRuntime", () => {
  it("denies when companyId or boardAccess is missing", () => {
    expect(canBoardManageRuntime(null, boardAccess({}))).toBe(false);
    expect(canBoardManageRuntime(undefined, boardAccess({}))).toBe(false);
    expect(canBoardManageRuntime("company-1", undefined)).toBe(false);
  });

  it("grants local-implicit access (single-tenant / CLI-auth board context)", () => {
    const access = boardAccess({ source: "local_implicit" });
    expect(canBoardManageRuntime("company-1", access)).toBe(true);
  });

  it("grants instance admins regardless of membership shape", () => {
    const access = boardAccess({ isInstanceAdmin: true, memberships: [] });
    expect(canBoardManageRuntime("company-1", access)).toBe(true);
  });

  it("falls back to companyIds when no memberships array is present", () => {
    const withAccess = boardAccess({ companyIds: ["company-1"] });
    const withoutAccess = boardAccess({ companyIds: ["company-2"] });
    expect(canBoardManageRuntime("company-1", withAccess)).toBe(true);
    expect(canBoardManageRuntime("company-1", withoutAccess)).toBe(false);
  });

  it("grants a non-viewer active member of the matching company", () => {
    const access = boardAccess({
      memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
    });
    expect(canBoardManageRuntime("company-1", access)).toBe(true);
  });

  it("denies a viewer, even if actively a member of the company", () => {
    const access = boardAccess({
      memberships: [{ companyId: "company-1", membershipRole: "viewer", status: "active" }],
    });
    expect(canBoardManageRuntime("company-1", access)).toBe(false);
  });

  it("denies when the membership for the company is not active", () => {
    const access = boardAccess({
      memberships: [{ companyId: "company-1", membershipRole: "operator", status: "pending" }],
    });
    expect(canBoardManageRuntime("company-1", access)).toBe(false);
  });

  it("denies when the board actor has no membership in the target company (cross-company isolation)", () => {
    const access = boardAccess({
      memberships: [{ companyId: "company-2", membershipRole: "owner", status: "active" }],
    });
    expect(canBoardManageRuntime("company-1", access)).toBe(false);
  });

  // KNOWN BUG (flagged for a follow-up fix PR, not fixed here): the server's `runtime:manage`
  // gate (server/src/services/authorization.ts) treats a null `membershipRole` on an active
  // membership as defaulting to a non-viewer role (see `normalizeHumanRole(value, "operator")`
  // in server/src/services/company-member-roles.ts, and the generic
  // `membership.membershipRole !== "viewer"` check used for runtime:manage), so an active member
  // with no explicit role is still allowed to manage runtime server-side. This client mirror adds
  // an extra `&& membership.membershipRole !== null` condition that the server does not have,
  // so it incorrectly hides the "reconcile anyway" affordance for that same active, non-viewer
  // member. This is a false negative (an allowed action is hidden from the UI), not a permission
  // escalation — the server remains authoritative and still allows the request if attempted.
  it("documents a client/server mismatch for an active member with a null membershipRole", () => {
    const access = boardAccess({
      memberships: [{ companyId: "company-1", membershipRole: null, status: "active" }],
    });
    // Server-side `runtime:manage` would allow this actor; the client mirror denies it.
    expect(canBoardManageRuntime("company-1", access)).toBe(false);
  });
});

describe("readRecoveryReconcileWorkspaceId", () => {
  it("returns null when the action is missing", () => {
    expect(readRecoveryReconcileWorkspaceId(null)).toBeNull();
    expect(readRecoveryReconcileWorkspaceId(undefined)).toBeNull();
  });

  it("returns null when the action kind is not workspace_validation", () => {
    const action = recoveryAction({
      kind: "missing_disposition",
      evidence: { workspaceValidation: { executionWorkspaceId: "workspace-1" } },
    });
    // Only workspace_validation actions are recognized by this helper regardless of evidence shape.
    expect(readRecoveryReconcileWorkspaceId(action)).toBeNull();
  });

  it("returns null when there is no workspaceValidation evidence", () => {
    expect(readRecoveryReconcileWorkspaceId(recoveryAction({ evidence: {} }))).toBeNull();
    expect(
      readRecoveryReconcileWorkspaceId(recoveryAction({ evidence: { workspaceValidation: null } })),
    ).toBeNull();
    expect(
      readRecoveryReconcileWorkspaceId(recoveryAction({ evidence: { workspaceValidation: "not-an-object" } })),
    ).toBeNull();
  });

  it("prefers persistedExecutionWorkspaceId (the branch-incoherence shape)", () => {
    const action = recoveryAction({
      evidence: {
        workspaceValidation: {
          persistedExecutionWorkspaceId: "workspace-persisted",
          executionWorkspaceId: "workspace-fallback",
        },
      },
    });
    expect(readRecoveryReconcileWorkspaceId(action)).toBe("workspace-persisted");
  });

  it("falls back to executionWorkspaceId (the not-reusable shape) when persisted is absent", () => {
    const action = recoveryAction({
      evidence: { workspaceValidation: { executionWorkspaceId: "workspace-fallback" } },
    });
    expect(readRecoveryReconcileWorkspaceId(action)).toBe("workspace-fallback");
  });

  it("ignores empty-string or non-string workspace id values", () => {
    const emptyPersisted = recoveryAction({
      evidence: {
        workspaceValidation: { persistedExecutionWorkspaceId: "", executionWorkspaceId: "workspace-fallback" },
      },
    });
    expect(readRecoveryReconcileWorkspaceId(emptyPersisted)).toBe("workspace-fallback");

    const nonString = recoveryAction({
      evidence: { workspaceValidation: { persistedExecutionWorkspaceId: 123, executionWorkspaceId: null } },
    });
    expect(readRecoveryReconcileWorkspaceId(nonString)).toBeNull();
  });
});
