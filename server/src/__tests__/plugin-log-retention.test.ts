import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { prunePluginLogs, startPluginLogRetention } from "../services/plugin-log-retention.js";

function makeDb(deleteResults: Array<number | Promise<number>>) {
  const limits: number[] = [];
  let deleteCalls = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (n: number) => {
              limits.push(n);
              return { __subquery: true };
            },
          }),
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          const next = deleteResults[deleteCalls++] ?? 0;
          const count = await next;
          return Array.from({ length: count }, (_, i) => ({ id: String(i) }));
        },
      }),
    }),
  };
  return { db: db as never, limits, deleteCallCount: () => deleteCalls };
}

describe("prunePluginLogs", () => {
  it("deletes in bounded batches until a short batch", async () => {
    const { db, limits, deleteCallCount } = makeDb([5_000, 5_000, 12]);
    const total = await prunePluginLogs(db, 7);
    expect(total).toBe(10_012);
    expect(deleteCallCount()).toBe(3);
    expect(limits).toEqual([5_000, 5_000, 5_000]);
  });

  it("stops after one batch when nothing is expired", async () => {
    const { db, deleteCallCount } = makeDb([0]);
    expect(await prunePluginLogs(db, 7)).toBe(0);
    expect(deleteCallCount()).toBe(1);
  });
});

describe("startPluginLogRetention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips overlapping ticks while a sweep is still running", async () => {
    let release!: (n: number) => void;
    const slow = new Promise<number>((resolve) => {
      release = resolve;
    });
    const { db, deleteCallCount } = makeDb([slow, 0]);

    const stop = startPluginLogRetention(db, 1_000, 7);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deleteCallCount()).toBe(1);

    release(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deleteCallCount()).toBe(2);
    stop();
  });

  it("does not keep the process alive", () => {
    const unref = vi.fn();
    const realSetInterval = global.setInterval;
    vi.spyOn(global, "setInterval").mockImplementation(((fn: () => void, ms: number) => {
      const t = realSetInterval(fn, ms);
      t.unref = unref as never;
      return t;
    }) as never);
    const { db } = makeDb([0]);
    const stop = startPluginLogRetention(db, 1_000, 7);
    expect(unref).toHaveBeenCalled();
    stop();
    vi.restoreAllMocks();
  });
});
