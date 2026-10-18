import { describe, expect, it } from "vitest";
import type { CurrentBoardAccess } from "../api/access";
import { canBoardManageRuntime } from "./recovery-reconcile";

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

describe("canBoardManageRuntime", () => {
  // Regression test: the server's `runtime:manage` gate (see `normalizeHumanRole` in
  // server/src/services/company-member-roles.ts and the `membership.membershipRole !==
  // "viewer"` check in server/src/services/authorization.ts) treats a null `membershipRole` on
  // an active membership as defaulting to a non-viewer role, so it allows that actor. Before
  // this fix, this client mirror additionally denied when `membershipRole === null`, hiding the
  // "reconcile anyway" affordance from an actor the server would actually allow.
  it("grants an active, non-viewer member whose membershipRole is null", () => {
    const access = boardAccess({
      memberships: [{ companyId: "company-1", membershipRole: null, status: "active" }],
    });
    expect(canBoardManageRuntime("company-1", access)).toBe(true);
  });

  it("still denies a viewer, even when active", () => {
    const access = boardAccess({
      memberships: [{ companyId: "company-1", membershipRole: "viewer", status: "active" }],
    });
    expect(canBoardManageRuntime("company-1", access)).toBe(false);
  });

  it("still grants a named non-viewer role, e.g. operator", () => {
    const access = boardAccess({
      memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
    });
    expect(canBoardManageRuntime("company-1", access)).toBe(true);
  });

  it("still denies when there is no active membership in the target company", () => {
    const access = boardAccess({
      memberships: [{ companyId: "company-2", membershipRole: null, status: "active" }],
    });
    expect(canBoardManageRuntime("company-1", access)).toBe(false);
  });
});
