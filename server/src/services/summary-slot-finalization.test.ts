import { describe, expect, it, vi } from "vitest";
import { summarySlots } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { finalizeSummarySlotsForTerminalIssue } from "./summary-slot-finalization.js";

function makeDb(returningValue: unknown[]) {
  const setCalls: unknown[] = [];
  const updateMock = vi.fn((_table: unknown) => ({
    set: vi.fn((payload: unknown) => {
      setCalls.push(payload);
      return {
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve(returningValue)),
        })),
      };
    }),
  }));
  return { update: updateMock, setCalls } as unknown as Pick<Db, "update"> & {
    setCalls: unknown[];
  };
}

const baseIssue = {
  id: "issue-1",
  companyId: "company-1",
  identifier: null as string | null,
  title: "Summarize sprint results",
  status: "in_progress" as const,
};

describe("finalizeSummarySlotsForTerminalIssue", () => {
  it("returns an empty array and makes no DB calls for a non-terminal status", async () => {
    const db = makeDb([{ id: "slot-1" }]);
    const result = await finalizeSummarySlotsForTerminalIssue(db, baseIssue);
    expect(result).toEqual([]);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("treats 'blocked' as non-terminal, unlike the sibling status-card finalizer", async () => {
    const db = makeDb([{ id: "slot-1" }]);
    const result = await finalizeSummarySlotsForTerminalIssue(db, { ...baseIssue, status: "blocked" });
    expect(result).toEqual([]);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("finalizes slots for a 'done' issue with the finished-without-summary message", async () => {
    const db = makeDb([{ id: "slot-1" }]);
    const result = await finalizeSummarySlotsForTerminalIssue(db, { ...baseIssue, status: "done" });
    expect(result).toEqual([{ id: "slot-1" }]);
    expect(db.update).toHaveBeenCalledWith(summarySlots);
    expect(db.setCalls[0]).toMatchObject({
      status: "failed",
      failureReason: "Summary generation task Summarize sprint results finished without writing a summary.",
    });
  });

  it("uses the cancelled-specific failure message for a 'cancelled' issue", async () => {
    const db = makeDb([]);
    await finalizeSummarySlotsForTerminalIssue(db, { ...baseIssue, status: "cancelled" });
    expect(db.setCalls[0]).toMatchObject({
      failureReason: "Summary generation task Summarize sprint results was cancelled before writing a summary.",
    });
  });

  it("prefixes the failure message with the issue identifier when present", async () => {
    const db = makeDb([]);
    await finalizeSummarySlotsForTerminalIssue(db, { ...baseIssue, status: "done", identifier: "ISS-7" });
    expect(db.setCalls[0]).toMatchObject({
      failureReason: "Summary generation task ISS-7: Summarize sprint results finished without writing a summary.",
    });
  });

  it("returns the slots array from the update's returning() call", async () => {
    const db = makeDb([{ id: "slot-a" }, { id: "slot-b" }]);
    const result = await finalizeSummarySlotsForTerminalIssue(db, { ...baseIssue, status: "cancelled" });
    expect(result).toEqual([{ id: "slot-a" }, { id: "slot-b" }]);
  });
});
