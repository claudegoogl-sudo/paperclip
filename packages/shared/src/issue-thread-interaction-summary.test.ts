import { describe, expect, it } from "vitest";
import {
  INTERACTION_SUMMARY_MAX_CHARS,
  INTERACTION_SUMMARY_TRUNCATION_MARKER,
  summarizeIssueThreadInteractionPayload,
  truncateInteractionSummary,
} from "./issue-thread-interaction-summary.js";

describe("summarizeIssueThreadInteractionPayload", () => {
  it("renders the request_confirmation prompt text", () => {
    const summary = summarizeIssueThreadInteractionPayload("request_confirmation", {
      version: 1,
      prompt: "Restart the postgres busy-poll loop with the two-line patch?",
      acceptLabel: "Apply",
    });
    expect(summary).toBe("Restart the postgres busy-poll loop with the two-line patch?");
  });

  it("renders checkbox confirmation option labels under the prompt", () => {
    const summary = summarizeIssueThreadInteractionPayload("request_checkbox_confirmation", {
      version: 1,
      prompt: "Which mitigations should ship?",
      options: [
        { id: "a", label: "Lower the poll frequency" },
        { id: "b", label: "Add the partial index" },
      ],
    });
    expect(summary).toBe(
      "Which mitigations should ship?\n- Lower the poll frequency\n- Add the partial index",
    );
  });

  it("renders every ask_user_questions question and its options", () => {
    const summary = summarizeIssueThreadInteractionPayload("ask_user_questions", {
      version: 1,
      title: "Rollout choices",
      questions: [
        {
          id: "q1",
          prompt: "Which environment first?",
          selectionMode: "single",
          options: [
            { id: "s", label: "Staging" },
            { id: "p", label: "Production" },
          ],
        },
        {
          id: "q2",
          prompt: "Notify on completion?",
          selectionMode: "single",
          options: [{ id: "y", label: "Yes" }],
        },
      ],
    });
    expect(summary).toBe(
      [
        "Rollout choices",
        "Which environment first?",
        "- Staging",
        "- Production",
        "Notify on completion?",
        "- Yes",
      ].join("\n"),
    );
  });

  it("renders suggest_tasks titles with a count", () => {
    const summary = summarizeIssueThreadInteractionPayload("suggest_tasks", {
      version: 1,
      tasks: [
        { clientKey: "a", title: "Cap the poller concurrency" },
        { clientKey: "b", title: "Backfill the missing index" },
      ],
    });
    expect(summary).toBe(
      "Suggested task(s): 2\n- Cap the poller concurrency\n- Backfill the missing index",
    );
  });

  it("elides past the per-interaction item cap instead of listing everything", () => {
    const summary = summarizeIssueThreadInteractionPayload("suggest_tasks", {
      version: 1,
      tasks: Array.from({ length: 14 }, (_, i) => ({ clientKey: `k${i}`, title: `Task ${i}` })),
    });
    expect(summary).toContain("Suggested task(s): 14");
    expect(summary).toContain("- Task 9");
    expect(summary).not.toContain("- Task 10");
    expect(summary).toContain("…and 4 more");
  });

  it("truncates a long prompt with a visible marker rather than dropping it", () => {
    const prompt = `${"word ".repeat(400)}tail`;
    const summary = summarizeIssueThreadInteractionPayload("request_confirmation", {
      version: 1,
      prompt,
    });
    expect(summary).not.toBeNull();
    expect(summary!.length).toBeLessThanOrEqual(INTERACTION_SUMMARY_MAX_CHARS);
    expect(summary!.endsWith(INTERACTION_SUMMARY_TRUNCATION_MARKER)).toBe(true);
    expect(summary!.startsWith("word word")).toBe(true);
  });

  it("returns null when the payload carries no human-readable content", () => {
    expect(summarizeIssueThreadInteractionPayload("request_confirmation", { version: 1 })).toBeNull();
    expect(summarizeIssueThreadInteractionPayload("suggest_tasks", { version: 1, tasks: [] })).toBeNull();
    expect(summarizeIssueThreadInteractionPayload("request_confirmation", null)).toBeNull();
    expect(summarizeIssueThreadInteractionPayload("request_confirmation", "nope")).toBeNull();
  });

  it("does not leak non-prompt payload fields", () => {
    const summary = summarizeIssueThreadInteractionPayload("request_confirmation", {
      version: 1,
      prompt: "Accept the plan?",
      target: {
        type: "issue_document",
        issueId: "11111111-1111-4111-8111-111111111111",
        revisionId: "33333333-3333-4333-8333-333333333333",
      },
      detailsMarkdown: "internal-only detail",
    });
    expect(summary).toBe("Accept the plan?");
  });
});

describe("truncateInteractionSummary", () => {
  it("leaves text at or under the cap untouched", () => {
    expect(truncateInteractionSummary("short", 100)).toBe("short");
  });

  it("keeps the result within the cap including the marker", () => {
    const out = truncateInteractionSummary("a".repeat(500), 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith(INTERACTION_SUMMARY_TRUNCATION_MARKER)).toBe(true);
  });

  it("breaks on whitespace when a boundary is near the cap", () => {
    const out = truncateInteractionSummary("alpha beta gamma delta epsilon", 26);
    expect(out.endsWith(INTERACTION_SUMMARY_TRUNCATION_MARKER)).toBe(true);
    expect(out).not.toMatch(/\s…/);
  });
});
