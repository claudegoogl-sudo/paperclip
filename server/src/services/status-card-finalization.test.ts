import { describe, expect, it, vi } from "vitest";
import { statusCards, statusCardUpdates } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { finalizeStatusCardsForStalledGeneration } from "./status-card-finalization.js";

function makeDb(returningValue: unknown[]) {
  const setCalls: unknown[] = [];
  const updateMock = vi.fn((_table: unknown) => ({
    set: vi.fn((payload: unknown) => {
      setCalls.push(payload);
      return {
        where: vi.fn(() => {
          const promise = Promise.resolve(undefined) as Promise<unknown> & { returning?: () => Promise<unknown> };
          promise.returning = () => Promise.resolve(returningValue);
          return promise;
        }),
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
  title: "Generate weekly status card",
  status: "in_progress" as const,
};

describe("finalizeStatusCardsForStalledGeneration", () => {
  it("returns an empty array and makes no DB calls for a non-stalled status", async () => {
    const db = makeDb([{ id: "card-1" }]);
    const result = await finalizeStatusCardsForStalledGeneration(db, baseIssue);
    expect(result).toEqual([]);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("finalizes stalled cards for a 'done' issue with the finished-without-summary message", async () => {
    const db = makeDb([{ id: "card-1" }]);
    const result = await finalizeStatusCardsForStalledGeneration(db, { ...baseIssue, status: "done" });
    expect(result).toEqual([{ id: "card-1" }]);
    expect(db.update).toHaveBeenNthCalledWith(1, statusCards);
    expect(db.update).toHaveBeenNthCalledWith(2, statusCardUpdates);
    expect(db.setCalls[0]).toMatchObject({
      state: "error",
      failureReason: "Status-card generation task Generate weekly status card finished without writing a summary.",
      generatingIssueId: null,
      nextEvalAt: null,
    });
    expect(db.setCalls[1]).toMatchObject({
      status: "failed",
      error: "Status-card generation task Generate weekly status card finished without writing a summary.",
    });
  });

  it("uses the cancelled-specific failure message for a 'cancelled' issue", async () => {
    const db = makeDb([]);
    await finalizeStatusCardsForStalledGeneration(db, { ...baseIssue, status: "cancelled" });
    expect(db.setCalls[0]).toMatchObject({
      failureReason: "Status-card generation task Generate weekly status card was cancelled before writing a summary.",
    });
  });

  it("uses the blocked-specific failure message for a 'blocked' issue", async () => {
    const db = makeDb([]);
    await finalizeStatusCardsForStalledGeneration(db, { ...baseIssue, status: "blocked" });
    expect(db.setCalls[0]).toMatchObject({
      failureReason: "Status-card generation task Generate weekly status card was blocked before writing a summary; re-run to retry.",
    });
  });

  it("prefixes the failure message with the issue identifier when present", async () => {
    const db = makeDb([]);
    await finalizeStatusCardsForStalledGeneration(db, {
      ...baseIssue,
      status: "done",
      identifier: "ISS-42",
    });
    expect(db.setCalls[0]).toMatchObject({
      failureReason: "Status-card generation task ISS-42: Generate weekly status card finished without writing a summary.",
    });
  });

  it("returns the cards array from the first update's returning() call", async () => {
    const db = makeDb([{ id: "card-a" }, { id: "card-b" }]);
    const result = await finalizeStatusCardsForStalledGeneration(db, { ...baseIssue, status: "done" });
    expect(result).toEqual([{ id: "card-a" }, { id: "card-b" }]);
  });
});
