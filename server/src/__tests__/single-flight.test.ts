import { afterEach, describe, expect, it, vi } from "vitest";
import { createSingleFlight } from "../services/single-flight.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSingleFlight", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips interval ticks while a run is pending and runs again after it settles", async () => {
    vi.useFakeTimers();
    const first = deferred();
    const fn = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const flush = createSingleFlight(fn);

    const timer = setInterval(() => {
      void flush();
    }, 5_000);
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fn).toHaveBeenCalledTimes(1);

      first.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      clearInterval(timer);
    }
  });

  it("shares one guard between a startup call and later ticks", async () => {
    const first = deferred();
    const fn = vi.fn().mockReturnValue(first.promise);
    const flush = createSingleFlight(fn);

    const startup = flush();
    const tick = flush();
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);

    first.resolve();
    await Promise.all([startup, tick]);
  });

  it("releases the guard when the wrapped function rejects", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const flush = createSingleFlight(fn);

    await expect(flush()).rejects.toThrow("boom");
    await flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("passes arguments through to the wrapped function", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const flush = createSingleFlight(fn);

    await flush("a", 1);
    expect(fn).toHaveBeenCalledWith("a", 1);
  });
});
