import { describe, expect, it } from "vitest";

import { createTestHarness } from "../src/testing.js";
import type { Issue, PaperclipPluginManifestV1, PluginIssueAttachment } from "../src/types.js";

function manifestWith(capabilities: PaperclipPluginManifestV1["capabilities"]): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.test-attachments",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Test Attachments",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities,
    entrypoints: {},
  } satisfies PaperclipPluginManifestV1;
}

const issue = { id: "issue-1", companyId: "company-a", identifier: "PLA-1" } as unknown as Issue;

const attachments: PluginIssueAttachment[] = [
  {
    id: "att-1",
    companyId: "company-a",
    issueId: "issue-1",
    issueCommentId: "comment-1",
    assetId: "asset-1",
    contentType: "image/png",
    byteSize: 11,
    originalFilename: "a.png",
    createdAt: new Date("2026-06-13T00:00:00.000Z"),
  },
  {
    id: "att-2",
    companyId: "company-a",
    issueId: "issue-1",
    issueCommentId: "comment-2",
    assetId: "asset-2",
    contentType: "audio/ogg",
    byteSize: 22,
    originalFilename: "voice.ogg",
    createdAt: new Date("2026-06-13T00:01:00.000Z"),
  },
  {
    id: "att-3",
    companyId: "company-a",
    issueId: "issue-1",
    issueCommentId: "comment-1",
    assetId: "asset-3",
    contentType: "application/pdf",
    byteSize: 33,
    originalFilename: "doc.pdf",
    createdAt: new Date("2026-06-13T00:02:00.000Z"),
  },
];

describe("ctx.issues.listAttachments (PLA-1050)", () => {
  it("returns seeded attachments and lets the worker map a comment to its asset ids", async () => {
    const harness = createTestHarness({ manifest: manifestWith(["issues.read", "issue.attachments.read"]) });
    harness.seed({ issues: [issue], issueAttachments: attachments });

    const all = await harness.ctx.issues.listAttachments("issue-1", "company-a");
    expect(all.map((row) => row.assetId)).toEqual(["asset-1", "asset-2", "asset-3"]);

    // The comment-created consumer filters by issueCommentId to find a comment's
    // assets, then fetches each via ctx.artifacts.fetch(assetId).
    const forComment1 = all.filter((row) => row.issueCommentId === "comment-1").map((row) => row.assetId);
    expect(forComment1).toEqual(["asset-1", "asset-3"]);
  });

  it("is company-scoped: returns [] for an issue outside the caller's company", async () => {
    const harness = createTestHarness({ manifest: manifestWith(["issues.read", "issue.attachments.read"]) });
    harness.seed({ issues: [issue], issueAttachments: attachments });

    await expect(harness.ctx.issues.listAttachments("issue-1", "company-b")).resolves.toEqual([]);
  });

  it("throws clearly when issue.attachments.read is not declared", async () => {
    const harness = createTestHarness({ manifest: manifestWith(["issues.read"]) });
    harness.seed({ issues: [issue], issueAttachments: attachments });

    await expect(harness.ctx.issues.listAttachments("issue-1", "company-a")).rejects.toThrow(
      /issue\.attachments\.read/,
    );
  });
});
