import { describe, expect, it, vi } from "vitest";
import {
  findPgErrorCode,
  findRetryablePgErrorCode,
  isRetryablePgError,
  retryOnTransientPgError,
} from "../services/pg-retry.ts";

const makePgError = (code: string, message = "synthetic") => {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
};

// PLA-638: mirror drizzle-orm's DrizzleQueryError — a wrapper Error with NO
// top-level `code`, carrying the real driver error on `.cause`. This is what
// every failed query actually throws in production (drizzle 0.45.2), and what
// PLA-597's original top-level-`code`-only check silently failed to retry.
const wrapAsDrizzleQueryError = (cause: unknown) => {
  const err = new Error(
    'Failed query: select "heartbeat_runs"."id" from "heartbeat_runs" where "heartbeat_runs"."id" = $1 for update\nparams: abc',
  ) as Error & { cause: unknown };
  err.cause = cause;
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

  // PLA-638 regression: the production failure mode.
  it("returns true for a deadlock wrapped in a DrizzleQueryError (.cause)", () => {
    const wrapped = wrapAsDrizzleQueryError(
      makePgError("40P01", "deadlock detected"),
    );
    expect((wrapped as { code?: unknown }).code).toBeUndefined();
    expect(isRetryablePgError(wrapped)).toBe(true);
  });

  it("returns true for a deadlock nested two cause-levels deep", () => {
    const wrapped = wrapAsDrizzleQueryError(
      wrapAsDrizzleQueryError(makePgError("40001", "could not serialize")),
    );
    expect(isRetryablePgError(wrapped)).toBe(true);
  });

  it("returns false when no cause in the chain is retryable", () => {
    const wrapped = wrapAsDrizzleQueryError(
      makePgError("23505", "unique violation"),
    );
    expect(isRetryablePgError(wrapped)).toBe(false);
  });

  it("does not infinite-loop on a cyclic cause chain", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isRetryablePgError(a)).toBe(false);
  });
});

describe("findRetryablePgErrorCode", () => {
  it("resolves the deep SQLSTATE through the wrapper for logging", () => {
    const wrapped = wrapAsDrizzleQueryError(
      makePgError("40P01", "deadlock detected"),
    );
    expect(findRetryablePgErrorCode(wrapped)).toBe("40P01");
  });

  it("returns null when nothing in the chain is retryable", () => {
    expect(findRetryablePgErrorCode(new Error("boom"))).toBe(null);
  });
});

describe("findPgErrorCode", () => {
  it("returns a top-level SQLSTATE code", () => {
    expect(findPgErrorCode(makePgError("22P02", "invalid input"))).toBe("22P02");
  });

  // PLA-873 regression: invalid-uuid lookups arrive drizzle-wrapped, so the
  // plugin-ui-static route's top-level-`code`-only check missed 22P02 and
  // surfaced every plugin-key UI request as a 500. The code lives on `.cause`.
  it("resolves a non-retryable SQLSTATE (22P02) through the DrizzleQueryError wrapper", () => {
    const wrapped = wrapAsDrizzleQueryError(
      makePgError("22P02", 'invalid input syntax for type uuid: "paperclip-messenger"'),
    );
    expect((wrapped as { code?: unknown }).code).toBeUndefined();
    expect(findPgErrorCode(wrapped)).toBe("22P02");
  });

  it("returns the first code found, walking outermost-first", () => {
    const wrapped = wrapAsDrizzleQueryError(makePgError("23505"));
    expect(findPgErrorCode(wrapped)).toBe("23505");
  });

  it("returns null when no code is present in the chain", () => {
    expect(findPgErrorCode(new Error("boom"))).toBe(null);
    expect(findPgErrorCode(null)).toBe(null);
    expect(findPgErrorCode(undefined)).toBe(null);
  });

  it("does not infinite-loop on a cyclic cause chain", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(findPgErrorCode(a)).toBe(null);
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

  // PLA-638 regression: before the .cause-chain fix, a wrapped deadlock was
  // classified non-retryable and thrown on the first attempt (the 500).
  it("retries a deadlock wrapped in a DrizzleQueryError and eventually succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw wrapAsDrizzleQueryError(makePgError("40P01", "deadlock detected"));
      }
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
