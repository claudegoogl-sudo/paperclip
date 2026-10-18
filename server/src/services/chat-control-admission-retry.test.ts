import { afterEach, expect, it, vi } from "vitest";
import { retryChatControlAdmission } from "./chat-control-admission-retry.js";

afterEach(() => vi.useRealTimers());

it("retries a rolled-back lock conflict and returns the fresh admission result", async () => {
  vi.useFakeTimers();
  const attempt = vi.fn()
    .mockRejectedValueOnce(new Error("query failed", { cause: { code: "55P03" } }))
    .mockResolvedValueOnce(null);
  const result = retryChatControlAdmission(attempt);
  await vi.advanceTimersByTimeAsync(150);
  await expect(result).resolves.toBeNull();
  expect(attempt).toHaveBeenCalledTimes(2);
});

it("does not retry unrelated database failures", async () => {
  const error = new Error("constraint violation", { cause: { code: "23505" } });
  const attempt = vi.fn().mockRejectedValue(error);
  await expect(retryChatControlAdmission(attempt)).rejects.toBe(error);
  expect(attempt).toHaveBeenCalledTimes(1);
});

it("stops persistent contention after fifty delays", async () => {
  vi.useFakeTimers();
  const error = new Error("query failed", { cause: { code: "55P03" } });
  const attempt = vi.fn().mockRejectedValue(error);
  const rejected = expect(retryChatControlAdmission(attempt)).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(7_500);
  await rejected;
  expect(attempt).toHaveBeenCalledTimes(51);
  expect(vi.getTimerCount()).toBe(0);
});

it("sleeps a bounded, varying jittered delay between attempts", async () => {
  const error = new Error("query failed", { cause: { code: "55P03" } });
  const attempt = vi.fn().mockRejectedValue(error);
  const delays: number[] = [];
  const draws = [0, 0.25, 0.5, 0.75, 0.999999];
  let draw = 0;
  await expect(
    retryChatControlAdmission(attempt, {
      random: () => draws[draw++ % draws.length]!,
      sleep: async (ms) => {
        delays.push(ms);
      },
    }),
  ).rejects.toBe(error);
  expect(delays).toHaveLength(50);
  for (const delay of delays) {
    expect(delay).toBeGreaterThanOrEqual(50);
    expect(delay).toBeLessThanOrEqual(150);
  }
  expect(new Set(delays).size).toBeGreaterThan(1);
  expect(delays.slice(0, 5)).toEqual([50, 75, 100, 125, 150]);
});
