import { describe, expect, it, vi } from "vitest";
import {
  isRetryablePgError,
  retryOnTransientPgError,
} from "../services/pg-retry.ts";

const makePgError = (code: string, message = "synthetic") => {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
};

describe("isRetryablePgError", () => {
  it("returns true for deadlock 40P01", () => {
    expect(isRetryablePgError(makePgError("40P01", "deadlock detected"))).toBe(
      true,
    );
  });

  it("returns true for serialization failure 40001", () => {
    expect(isRetryablePgError(makePgError("40001"))).toBe(true);
  });

  it("returns false for other Postgres codes", () => {
    expect(isRetryablePgError(makePgError("23505", "unique violation"))).toBe(
      false,
    );
  });

  it("returns false for plain errors without a code", () => {
    expect(isRetryablePgError(new Error("boom"))).toBe(false);
    expect(isRetryablePgError(null)).toBe(false);
    expect(isRetryablePgError(undefined)).toBe(false);
    expect(isRetryablePgError("nope")).toBe(false);
  });
});

describe("retryOnTransientPgError", () => {
  it("returns the result on first success", async () => {
    const fn = vi.fn(async () => "ok");
    await expect(retryOnTransientPgError(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on deadlock and eventually succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw makePgError("40P01", "deadlock detected");
      return "won";
    });
    await expect(
      retryOnTransientPgError(fn, { baseDelayMs: 1, maxAttempts: 5 }),
    ).resolves.toBe("won");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries on serialization failure 40001", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw makePgError("40001");
      return "ok";
    });
    await expect(
      retryOnTransientPgError(fn, { baseDelayMs: 1 }),
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable errors", async () => {
    const err = makePgError("23505", "unique violation");
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(retryOnTransientPgError(fn, { baseDelayMs: 1 })).rejects.toBe(
      err,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rethrows after exhausting maxAttempts", async () => {
    const err = makePgError("40P01", "deadlock detected");
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(
      retryOnTransientPgError(fn, { baseDelayMs: 1, maxAttempts: 3 }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("defaults to 6 attempts when maxAttempts not provided (PLA-597 headroom)", async () => {
    const err = makePgError("40P01", "deadlock detected");
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(retryOnTransientPgError(fn, { baseDelayMs: 1 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(6);
  });
});
