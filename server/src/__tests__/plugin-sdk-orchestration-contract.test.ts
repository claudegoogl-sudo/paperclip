import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Issue, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createTestHarness } from "../../../packages/plugins/sdk/src/testing.js";

function manifest(capabilities: PaperclipPluginManifestV1["capabilities"]): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.test-orchestration",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Test Orchestration",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities,
    entrypoints: { worker: "./dist/worker.js" },
  };
}

function issue(input: Partial<Issue> & Pick<Issue, "id" | "companyId" | "title">): Issue {
  const now = new Date();
  return {
    id: input.id,
    companyId: input.companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: input.title,
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

describe("plugin SDK orchestration contract", () => {
  it("supports expanded issue create fields and relation helpers", async () => {
    const companyId = randomUUID();
    const blockerIssueId = randomUUID();
    const harness = createTestHarness({
      manifest: manifest(["issues.create", "issue.relations.read", "issue.relations.write", "issue.subtree.read"]),
    });
    harness.seed({
      issues: [issue({ id: blockerIssueId, companyId, title: "Blocker" })],
    });

    const created = await harness.ctx.issues.create({
      companyId,
      title: "Generated issue",
      status: "todo",
      assigneeUserId: "board-user",
      billingCode: "mission:alpha",
      originId: "mission-alpha",
      blockedByIssueIds: [blockerIssueId],
    });

    expect(created.originKind).toBe("plugin:paperclip.test-orchestration");
    expect(created.originId).toBe("mission-alpha");
    expect(created.billingCode).toBe("mission:alpha");
    expect(created.assigneeUserId).toBe("board-user");

    await expect(harness.ctx.issues.relations.get(created.id, companyId)).resolves.toEqual({
      blockedBy: [
        expect.objectContaining({
          id: blockerIssueId,
          title: "Blocker",
        }),
      ],
      blocks: [],
    });

    await expect(harness.ctx.issues.relations.removeBlockers(created.id, [blockerIssueId], companyId)).resolves.toEqual({
      blockedBy: [],
      blocks: [],
    });

    await expect(harness.ctx.issues.relations.addBlockers(created.id, [blockerIssueId], companyId)).resolves.toEqual({
      blockedBy: [expect.objectContaining({ id: blockerIssueId })],
      blocks: [],
    });

    await expect(
      harness.ctx.issues.getSubtree(created.id, companyId, { includeRelations: true }),
    ).resolves.toMatchObject({
      rootIssueId: created.id,
      issueIds: [created.id],
      relations: {
        [created.id]: {
          blockedBy: [expect.objectContaining({ id: blockerIssueId })],
        },
      },
    });
  });

  it("enforces plugin origin namespaces in the test harness", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({
      manifest: manifest(["issues.create", "issues.update", "issues.read"]),
    });

    const created = await harness.ctx.issues.create({
      companyId,
      title: "Generated issue",
      originKind: "plugin:paperclip.test-orchestration:feature",
    });

    expect(created.originKind).toBe("plugin:paperclip.test-orchestration:feature");
    await expect(
      harness.ctx.issues.list({
        companyId,
        originKind: "plugin:paperclip.test-orchestration:feature",
      }),
    ).resolves.toHaveLength(1);
    await expect(
      harness.ctx.issues.create({
        companyId,
        title: "Spoofed issue",
        originKind: "plugin:other.plugin:feature",
      }),
    ).rejects.toThrow("Plugin may only use originKind values under plugin:paperclip.test-orchestration");
    await expect(
      harness.ctx.issues.update(
        created.id,
        { originKind: "plugin:other.plugin:feature" },
        companyId,
      ),
    ).rejects.toThrow("Plugin may only use originKind values under plugin:paperclip.test-orchestration");
  });

  it("supports generic plugin operation issue visibility in the test harness", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({
      manifest: manifest(["issues.create"]),
    });

    const created = await harness.ctx.issues.create({
      companyId,
      title: "Background operation",
      surfaceVisibility: "plugin_operation",
      originId: "operation-1",
    });

    expect(created.originKind).toBe("plugin:paperclip.test-orchestration:operation");
    expect(created.originId).toBe("operation-1");
  });

  it("enforces checkout and wakeup capabilities in the test harness", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const checkedOutIssueId = randomUUID();
    const harness = createTestHarness({
      manifest: manifest(["issues.checkout", "issues.wakeup", "issues.read"]),
    });
    harness.seed({
      issues: [
        issue({
          id: checkedOutIssueId,
          companyId,
          title: "Checked out",
          status: "in_progress",
          assigneeAgentId: agentId,
          checkoutRunId: runId,
        }),
      ],
    });

    await expect(
      harness.ctx.issues.assertCheckoutOwner({
        issueId: checkedOutIssueId,
        companyId,
        actorAgentId: agentId,
        actorRunId: runId,
      }),
    ).resolves.toMatchObject({
      issueId: checkedOutIssueId,
      checkoutRunId: runId,
    });

    await expect(
      harness.ctx.issues.requestWakeup(checkedOutIssueId, companyId, {
        reason: "mission_advance",
      }),
    ).resolves.toMatchObject({ queued: true });

    await expect(
      harness.ctx.issues.requestWakeups([checkedOutIssueId], companyId, {
        reason: "mission_advance",
        idempotencyKeyPrefix: "mission:alpha",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        issueId: checkedOutIssueId,
        queued: true,
      }),
    ]);
  });

  it("rejects wakeups when blockers are unresolved", async () => {
    const companyId = randomUUID();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const harness = createTestHarness({
      manifest: manifest(["issues.wakeup", "issues.read"]),
    });
    harness.seed({
      issues: [
        issue({ id: blockerIssueId, companyId, title: "Unresolved blocker", status: "todo" }),
        issue({
          id: blockedIssueId,
          companyId,
          title: "Blocked work",
          status: "todo",
          assigneeAgentId: randomUUID(),
          blockedBy: [
            {
              id: blockerIssueId,
              identifier: null,
              title: "Unresolved blocker",
              status: "todo",
              priority: "medium",
              assigneeAgentId: null,
              assigneeUserId: null,
            },
          ],
        }),
      ],
    });

    await expect(
      harness.ctx.issues.requestWakeup(blockedIssueId, companyId),
    ).rejects.toThrow("Issue is blocked by unresolved blockers");
  });

  it("fakes issues.listWakeupRequests behind issue.wakeups.read", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const row = (status: string, minutesAgo: number, overrides: Record<string, unknown> = {}) => ({
      id: randomUUID(), companyId, issueId, agentId, status, reason: status, source: "assignment",
      requestedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(), ...overrides,
    });
    const seedRows = [
      row("queued", 1), row("deferred_issue_execution", 3), row("completed", 30), row("completed", 600),
      row("queued", 2, { companyId: randomUUID() }),
    ];

    const denied = createTestHarness({ manifest: manifest(["issues.read", "issue.subtree.read"]) });
    denied.seed({ wakeupRequests: seedRows });
    await expect(denied.ctx.issues.listWakeupRequests([issueId], companyId)).rejects.toThrow(/issue\.wakeups\.read/);

    const harness = createTestHarness({ manifest: manifest(["issue.wakeups.read"]) });
    harness.seed({ wakeupRequests: seedRows });
    const pending = await harness.ctx.issues.listWakeupRequests([issueId], companyId);
    expect(pending.map((r) => r.status)).toEqual(["queued", "deferred_issue_execution"]);
    expect(Object.keys(pending[0]!).sort()).toEqual(["agentId", "id", "issueId", "reason", "requestedAt", "source", "status"]);
    const recent = await harness.ctx.issues.listWakeupRequests([issueId], companyId, {
      since: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    });
    expect(recent.map((r) => r.status)).toEqual(["queued", "deferred_issue_execution", "completed"]);
    await expect(
      harness.ctx.issues.listWakeupRequests(Array.from({ length: 201 }, () => randomUUID()), companyId),
    ).rejects.toThrow(/at most 200/);
  });
});
