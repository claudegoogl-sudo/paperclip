import { describe, expect, it, vi } from "vitest";
import { toolRuntimeMetricCounters } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  incrementToolRuntimeMetricCounter,
  recordToolRuntimeAuditWriteFailure,
  TOOL_RUNTIME_AUDIT_WRITE_FAILURE_METRIC,
} from "./tool-runtime-metrics.js";

function makeDb(onConflictImpl: () => Promise<unknown> = () => Promise.resolve(undefined)) {
  const valuesCalls: unknown[] = [];
  const onConflictCalls: unknown[] = [];
  const insert = vi.fn((_table: unknown) => ({
    values: vi.fn((payload: unknown) => {
      valuesCalls.push(payload);
      return {
        onConflictDoUpdate: vi.fn((config: unknown) => {
          onConflictCalls.push(config);
          return onConflictImpl();
        }),
      };
    }),
  }));
  return { insert, valuesCalls, onConflictCalls } as unknown as Db & {
    valuesCalls: unknown[];
    onConflictCalls: unknown[];
  };
}

describe("incrementToolRuntimeMetricCounter", () => {
  it("floors the timestamp to the start of its minute for bucketStartAt", async () => {
    const db = makeDb();
    const at = new Date("2026-01-01T10:15:45.678Z");
    await incrementToolRuntimeMetricCounter(db, { companyId: "company-1", metric: "my_metric", at });
    expect(db.valuesCalls[0]).toMatchObject({
      companyId: "company-1",
      metric: "my_metric",
      bucketStartAt: new Date("2026-01-01T10:15:00.000Z"),
      count: 1,
      createdAt: at,
      updatedAt: at,
    });
  });

  it("defaults to the current time when 'at' is not provided", async () => {
    const db = makeDb();
    const before = Date.now();
    await incrementToolRuntimeMetricCounter(db, { companyId: "company-1", metric: "my_metric" });
    const after = Date.now();
    const payload = db.valuesCalls[0] as { createdAt: Date };
    expect(payload.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(payload.createdAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("targets the (companyId, metric, bucketStartAt) unique key and increments count on conflict", async () => {
    const db = makeDb();
    const at = new Date("2026-01-01T10:15:45.678Z");
    await incrementToolRuntimeMetricCounter(db, { companyId: "company-1", metric: "my_metric", at });
    const config = db.onConflictCalls[0] as { target: unknown[]; set: { updatedAt: Date } };
    expect(config.target).toEqual([
      toolRuntimeMetricCounters.companyId,
      toolRuntimeMetricCounters.metric,
      toolRuntimeMetricCounters.bucketStartAt,
    ]);
    expect(config.set.updatedAt).toBe(at);
  });
});

describe("recordToolRuntimeAuditWriteFailure", () => {
  it("records the audit-write-failure metric for the given company", async () => {
    const db = makeDb();
    await recordToolRuntimeAuditWriteFailure(db, "company-1");
    expect(db.valuesCalls[0]).toMatchObject({
      companyId: "company-1",
      metric: TOOL_RUNTIME_AUDIT_WRITE_FAILURE_METRIC,
    });
  });

  it("swallows a DB error (Error instance) instead of throwing, and logs it", async () => {
    const db = makeDb(() => Promise.reject(new Error("insert failed")));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(recordToolRuntimeAuditWriteFailure(db, "company-1")).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        "[tool-runtime-metrics] Failed to record audit write failure counter",
        expect.objectContaining({ companyId: "company-1", error: "insert failed" }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("swallows a non-Error thrown value, stringifying it for the log", async () => {
    const db = makeDb(() => Promise.reject("not an Error instance"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(recordToolRuntimeAuditWriteFailure(db, "company-1")).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        "[tool-runtime-metrics] Failed to record audit write failure counter",
        expect.objectContaining({ error: "not an Error instance" }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
