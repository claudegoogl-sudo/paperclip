import { describe, expect, it } from "vitest";
import { checkCrossCompanyPatch, type CrossCompanyPatchLookups } from "../routes/cross-company-issue-access.js";

const T = "22222222-2222-4222-8222-222222222222";
const H = "11111111-1111-4111-8111-111111111111";
const SELF = "b30654b6-2c2f-48b9-b108-1e07e417996d";
const map: Record<string, string> = { tAgent: T, hAgent: H, tIssue: T, hIssue: H, tProj: T, hProj: H, tGoal: T, hGoal: H, tLabel: T, hLabel: H };
const lk: CrossCompanyPatchLookups = {
  agentCompany: async (id) => (map[id] ? { companyId: map[id], active: true } : null),
  userIsMember: async (c, u) => c === T && u === "tUser",
  labelCompany: async (id) => map[id] ?? null,
  issueCompany: async (id) => map[id] ?? null,
  projectCompany: async (id) => map[id] ?? null,
  goalCompany: async (id) => map[id] ?? null,
};
const run = (b: Record<string, unknown>) => checkCrossCompanyPatch(b, T, SELF, lk);

describe("cross-company PATCH field guard (M4/M5/M6)", () => {
  it("allows plain edits and same-company references; returns field names only", async () => {
    expect(await run({ title: "x", status: "todo", assigneeAgentId: "tAgent", parentId: "tIssue", projectId: "tProj",
      goalId: "tGoal", blockedByIssueIds: ["tIssue"], labelIds: ["tLabel"], assigneeUserId: "tUser" }))
      .toEqual({ ok: true, changedFields: ["assigneeAgentId", "assigneeUserId", "blockedByIssueIds", "goalId", "labelIds", "parentId", "projectId", "status", "title"] });
  });
  it.each(["executionPolicy", "executionWorkspaceSettings", "executionEnvironmentId", "reviewRequest", "reopen", "resume", "interrupt", "hiddenAt", "somethingUnknown"])(
    "rejects field %s with 422", async (f) => {
      expect(await run({ [f]: {} })).toMatchObject({ ok: false, status: 422, field: f });
    });
  it("rejects status cancelled (no run control)", async () => {
    expect(await run({ status: "cancelled" })).toMatchObject({ ok: false, field: "status" });
  });
  it("rejects self-assign", async () => {
    expect(await run({ assigneeAgentId: SELF })).toMatchObject({ ok: false, field: "assigneeAgentId" });
  });
  it.each([
    ["assigneeAgentId", "hAgent"], ["assigneeAgentId", "missing"], ["assigneeUserId", "hUser"], ["parentId", "hIssue"],
    ["projectId", "hProj"], ["goalId", "hGoal"], ["blockedByIssueIds", ["tIssue", "hIssue"]], ["labelIds", ["hLabel"]],
  ])("rejects foreign reference %s", async (f, v) => {
    expect(await run({ [f]: v })).toMatchObject({ ok: false, status: 422, field: f });
  });
  it("allows clearing references with null", async () => {
    expect(await run({ parentId: null, assigneeAgentId: null })).toMatchObject({ ok: true });
  });
});
