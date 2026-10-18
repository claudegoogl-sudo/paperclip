import { afterEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  decideCrossCompanyIssueAccess,
  parseCrossCompanyAllowlist,
  type CrossCompanyDeps,
  checkCrossCompanyWriteCap,
  crossCompanyMarker,
  withCrossCompanyMarker,
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
    countWrites: async () => 0,
    describeActor: async () => ({ agentName: "Concierge", homeKey: "HOME" }),
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

  it("scoped agent keys never get the exemption", async () => {
    const d = await decideCrossCompanyIssueAccess(
      req({ keyScope: { kind: "notify_only", issueIds: [] } as never }), TARGET, "issue.read", deps());
    expect(d).toEqual({ allowed: false, reason: "scoped_key" });
  });

  it("standard keyScope (real middleware shape) is ALLOWED for read and comments.list", async () => {
    const std = req({ keyScope: { kind: "standard" } as never });
    expect((await decideCrossCompanyIssueAccess(std, TARGET, "issue.read", deps())).allowed).toBe(true);
    expect((await decideCrossCompanyIssueAccess(std, TARGET, "comments.list" as never, deps())).allowed).toBe(true);
  });

  it("narrowed scopes notify_only/skill_test/task_bridge are denied scoped_key", async () => {
    for (const kind of ["notify_only", "skill_test", "task_bridge"]) {
      expect(await decideCrossCompanyIssueAccess(req({ keyScope: { kind } as never }), TARGET, "issue.read", deps()))
        .toEqual({ allowed: false, reason: "scoped_key" });
    }
  });

  it("standard scope: non-allowlisted, same-company, paused target keep their denials", async () => {
    const k = { keyScope: { kind: "standard" } as never };
    const other = "33333333-3333-4333-8333-333333333333";
    expect(await decideCrossCompanyIssueAccess(req({ ...k, agentId: other }), TARGET, "issue.read", deps({ grants: [[HOME, other]] })))
      .toEqual({ allowed: false, reason: "not_allowlisted" });
    expect(await decideCrossCompanyIssueAccess(req(k), HOME, "issue.read", deps())).toEqual({ allowed: false, reason: "same_company" });
    expect(await decideCrossCompanyIssueAccess(req(k), TARGET, "issue.read", deps({ isTargetCompanyActive: async () => false })))
      .toEqual({ allowed: false, reason: "target_company_inactive" });
  });

  it("control agent with grant row but not allowlisted => deny", async () => {
    const other = "33333333-3333-4333-8333-333333333333";
    const d = await decideCrossCompanyIssueAccess(req({ agentId: other }), TARGET, "issue.read", deps({ grants: [[HOME, other]] }));
    expect(d).toEqual({ allowed: false, reason: "not_allowlisted" });
  });

  it("M10 write cap: 10 per run, 60 per hour, from counted audit rows", async () => {
    const mk = (run: number, hour: number) => ({
      countWrites: async (_a: string, since: Date, runId?: string | null) => (runId ? run : hour),
    });
    expect(await checkCrossCompanyWriteCap(mk(9, 59), AGENT, "r1")).toEqual({ ok: true });
    expect(await checkCrossCompanyWriteCap(mk(10, 0), AGENT, "r1")).toEqual({ ok: false, scope: "run" });
    expect(await checkCrossCompanyWriteCap(mk(0, 60), AGENT, "r1")).toEqual({ ok: false, scope: "hour" });
    expect(await checkCrossCompanyWriteCap(mk(0, 60), AGENT, null)).toEqual({ ok: false, scope: "hour" });
  });

  it("M8 marker: host-written, sanitised, always prepended", () => {
    const m = crossCompanyMarker("Conc\nierge]", "HO>ME", "run-1");
    expect(m).not.toMatch(/[\n\]]/);
    expect(m.startsWith("> cross-company agent action — ")).toBe(true);
    expect(m).toContain("run run-1 — not an operator decision");
    expect(withCrossCompanyMarker(m, "x").startsWith(m)).toBe(true);
  });
});
