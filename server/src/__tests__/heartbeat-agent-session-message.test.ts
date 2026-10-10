import { describe, expect, it } from "vitest";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";

describe("agent session wake messages", () => {
  it("includes the issue brief and requires fallback fetch when a long description is truncated", async () => {
    const description = [
      "Update launch-card.svg and change the CTA to Try Team free.",
      "x".repeat(13_000),
    ].join("\n");

    const wakePayload = await buildPaperclipWakePayload({
      db: {
        select: () => ({
          from: () => ({
            where: async () => [],
          }),
        }),
      } as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "issue_assigned",
        issueId: "issue-1",
      },
      issueSummary: {
        id: "issue-1",
        identifier: "PAP-15271",
        title: "Preserve the task brief",
        description,
        status: "in_progress",
        priority: "high",
        workMode: "standard",
      },
    });

    expect(wakePayload?.issue).toMatchObject({
      description: expect.stringContaining("launch-card.svg"),
      descriptionTruncated: true,
    });
    expect(wakePayload?.issue?.description).toContain("Try Team free");
    expect(wakePayload?.issue?.description).toHaveLength(12_000);
    expect(wakePayload).toMatchObject({
      truncated: true,
      fallbackFetchNeeded: true,
    });
  });

  it("turns the canonical session-message context into adapter prompt input", async () => {
    const wakePayload = await buildPaperclipWakePayload({
      db: {} as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "gateway_chat_message",
        paperclipAgentMessage: {
          text: "hello",
          source: "plugin_session",
          pluginKey: "paperclip.gateway",
          sessionId: "session-1",
        },
      },
    });

    expect(wakePayload).toMatchObject({
      reason: "gateway_chat_message",
      issue: null,
      agentMessage: {
        text: "hello",
        source: "plugin_session",
        pluginKey: "paperclip.gateway",
        sessionId: "session-1",
      },
    });
    expect(renderPaperclipWakePrompt(wakePayload)).toContain("hello");
  });

  it("leaves a normal context-only wake without a renderable payload", async () => {
    await expect(
      buildPaperclipWakePayload({
        db: {} as never,
        companyId: "company-1",
        contextSnapshot: {
          wakeReason: "timer",
        },
      }),
    ).resolves.toBeNull();
  });

  it("redacts and bounds session messages before materializing the wake payload", async () => {
    const secret = "do-not-render-this-value";
    const wakePayload = await buildPaperclipWakePayload({
      db: {} as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "gateway_chat_message",
        paperclipAgentMessage: {
          text: `OPENAI_API_KEY=${secret}\n${"x".repeat(13_000)}`,
          source: "plugin_session",
          pluginKey: "paperclip.gateway",
          sessionId: "session-1",
        },
      },
    });

    expect(wakePayload?.agentMessage?.text).not.toContain(secret);
    expect(wakePayload?.agentMessage?.text.length).toBeLessThanOrEqual(12_000);
  });
});

describe("wake payload run clock context", () => {
  const baseInput = {
    companyId: "company-1",
    contextSnapshot: {
      wakeReason: "issue_assigned",
      issueId: "issue-1",
    },
    issueSummary: {
      id: "issue-1",
      identifier: "PAP-15271",
      title: "Run clock context",
      description: null,
      status: "in_progress",
      priority: "high",
      workMode: "standard",
    },
  };

  const siblingDb = (siblingRows: unknown[]) =>
    ({
      select: () => ({
        from: () => ({
          where: async () => [],
          innerJoin: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => Promise.resolve(siblingRows),
              }),
            }),
          }),
        }),
      }),
    }) as never;

  it("stamps the run start time and same-issue sibling run metadata into the payload", async () => {
    const wakePayload = await buildPaperclipWakePayload({
      ...baseInput,
      db: siblingDb([
        {
          runId: "11111111-1111-4111-8111-111111111111",
          agentName: "QA",
          startedAt: new Date("2026-09-24T08:01:00.000Z"),
        },
      ]),
      currentRun: { id: "22222222-2222-4222-8222-222222222222", startedAt: "2026-09-24T08:00:00.000Z" },
    });

    expect(wakePayload).toMatchObject({
      runStartedAt: "2026-09-24T08:00:00.000Z",
      siblingRuns: [
        {
          runId: "11111111-1111-4111-8111-111111111111",
          agentName: "QA",
          startedAt: "2026-09-24T08:01:00.000Z",
        },
      ],
    });

    const prompt = renderPaperclipWakePrompt(wakePayload);
    expect(prompt).toContain("- run started: 2026-09-24T08:00:00.000Z");
    expect(prompt).toContain(
      "  - QA run 11111111-1111-4111-8111-111111111111 started 2026-09-24T08:01:00.000Z",
    );
    // The current run never appears in its own sibling list.
    expect(prompt).not.toContain("22222222-2222-4222-8222-222222222222");
  });

  it("leaves run clock metadata empty when no current run is provided", async () => {
    const wakePayload = await buildPaperclipWakePayload({
      ...baseInput,
      db: siblingDb([]),
    });

    expect(wakePayload?.runStartedAt ?? null).toBeNull();
    expect(wakePayload?.siblingRuns).toEqual([]);
    const prompt = renderPaperclipWakePrompt(wakePayload);
    expect(prompt).toContain("- sibling runs on this issue: none active");
  });
});
