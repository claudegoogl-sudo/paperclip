import { afterEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  decideCrossCompanyIssueAccess,
  parseCrossCompanyAllowlist,
  type CrossCompanyDeps,
} from "../routes/cross-company-issue-access.js";

const AGENT = "b30654b6-2c2f-48b9-b108-1e07e417996d";
const HOME = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";

function req(actor: Partial<Request["actor"]>): Request {
  return { actor: { type: "agent", agentId: AGENT, companyId: HOME, ...actor } } as unknown as Request;
}

function deps(over: Partial<CrossCompanyDeps> & { grants?: Array<[string, string]> } = {}): CrossCompanyDeps {
  const grants = over.grants ?? [[HOME, AGENT]];
  return {
    allowlist: () => new Set([AGENT]),
    hasHomeGrant: async (c, a) => grants.some(([gc, ga]) => gc === c && ga === a),
    isTargetCompanyActive: async () => true,
    isLowTrust: async () => false,
    ...over,
  };
}

describe("cross-company issue access helper", () => {
  afterEach(() => undefined);

  it("parses allowlist: trims, exact UUIDs only, empty = off", () => {
    expect(parseCrossCompanyAllowlist(undefined).size).toBe(0);
    expect(parseCrossCompanyAllowlist("").size).toBe(0);
    expect([...parseCrossCompanyAllowlist(` ${AGENT} , not-a-uuid, *, ${AGENT}x`)]).toEqual([AGENT]);
  });

  it("both keys present => allow", async () => {
    expect(await decideCrossCompanyIssueAccess(req({}), TARGET, "issue.read", deps())).toEqual({
      allowed: true, homeCompanyId: HOME, agentId: AGENT,
    });
  });

  it("env only (no grant row) => deny", async () => {
    const d = await decideCrossCompanyIssueAccess(req({}), TARGET, "issue.read", deps({ grants: [] }));
    expect(d).toEqual({ allowed: false, reason: "no_grant" });
  });

  it("row only (env empty) => deny", async () => {
    const d = await decideCrossCompanyIssueAccess(req({}), TARGET, "issue.read", deps({ allowlist: () => new Set() }));
    expect(d).toEqual({ allowed: false, reason: "not_allowlisted" });
  });

  it("row in TARGET company instead of home => deny", async () => {
    const d = await decideCrossCompanyIssueAccess(req({}), TARGET, "issue.read", deps({ grants: [[TARGET, AGENT]] }));
    expect(d).toEqual({ allowed: false, reason: "no_grant" });
  });

  it("row deleted => next request denied (no cache)", async () => {
    const grants: Array<[string, string]> = [[HOME, AGENT]];
    const dd = deps({ grants });
    expect((await decideCrossCompanyIssueAccess(req({}), TARGET, "issue.read", dd)).allowed).toBe(true);
    grants.length = 0;
    expect((await decideCrossCompanyIssueAccess(req({}), TARGET, "issue.read", dd)).allowed).toBe(false);
  });

  it("excludes onBehalfOfUserId, board, low-trust, inactive target, same company", async () => {
    expect(await decideCrossCompanyIssueAccess(req({ onBehalfOfUserId: "u1" }), TARGET, "issue.update", deps()))
      .toEqual({ allowed: false, reason: "on_behalf_of_user" });
    expect(await decideCrossCompanyIssueAccess(req({ type: "board", userId: "u" }), TARGET, "issue.read", deps()))
      .toEqual({ allowed: false, reason: "not_agent" });
    expect(await decideCrossCompanyIssueAccess(req({}), TARGET, "issue.read", deps({ isLowTrust: async () => true })))
      .toEqual({ allowed: false, reason: "low_trust" });
    expect(await decideCrossCompanyIssueAccess(req({}), TARGET, "issue.read", deps({ isTargetCompanyActive: async () => false })))
      .toEqual({ allowed: false, reason: "target_company_inactive" });
    expect(await decideCrossCompanyIssueAccess(req({}), HOME, "issue.read", deps()))
      .toEqual({ allowed: false, reason: "same_company" });
  });

  it("control agent with grant row but not allowlisted => deny", async () => {
    const other = "33333333-3333-4333-8333-333333333333";
    const d = await decideCrossCompanyIssueAccess(req({ agentId: other }), TARGET, "issue.read", deps({ grants: [[HOME, other]] }));
    expect(d).toEqual({ allowed: false, reason: "not_allowlisted" });
  });
});
