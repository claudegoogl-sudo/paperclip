import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import { createSkillSourceScanLimiter } from "./skill-source-scan-limit.js";

function makeClock(start = 0) {
  let current = start;
  return { now: () => current, advance: (ms: number) => (current += ms) };
}

describe("createSkillSourceScanLimiter", () => {
  it("allows a scan and releases it cleanly", () => {
    const { now } = makeClock();
    const limiter = createSkillSourceScanLimiter(now);
    const lease = limiter("company-1", "caller-1");
    expect(lease.release).toBeInstanceOf(Function);
    expect(lease.beforeDownload).toBeInstanceOf(Function);
    lease.release();
  });

  it("rejects a second concurrent scan for the same caller with 429 and a 5s retry hint", () => {
    const { now } = makeClock();
    const limiter = createSkillSourceScanLimiter(now);
    limiter("company-1", "caller-1");
    try {
      limiter("company-1", "caller-1");
      throw new Error("expected limiter to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const httpError = err as HttpError;
      expect(httpError.status).toBe(429);
      expect(httpError.message).toMatch(/already running/i);
      expect(httpError.details).toMatchObject({
        code: "skill_source_scan_limited",
        retryAfterSeconds: 5,
      });
    }
  });

  it("allows a second scan for the same caller once the first is released", () => {
    const { now } = makeClock();
    const limiter = createSkillSourceScanLimiter(now);
    const first = limiter("company-1", "caller-1");
    first.release();
    expect(() => limiter("company-1", "caller-1")).not.toThrow();
  });

  it("allows two different callers in the same company up to the company active limit", () => {
    const { now } = makeClock();
    const limiter = createSkillSourceScanLimiter(now);
    limiter("company-1", "caller-1");
    limiter("company-1", "caller-2");
    expect(() => limiter("company-1", "caller-3")).toThrow(/already running/i);
  });

  it("does not let one company's active scans block a different company", () => {
    const { now } = makeClock();
    const limiter = createSkillSourceScanLimiter(now);
    limiter("company-1", "caller-1");
    limiter("company-1", "caller-2");
    expect(() => limiter("company-2", "caller-3")).not.toThrow();
  });

  it("rejects once the per-caller scan-count limit (30 within 60s) is reached", () => {
    const { now } = makeClock();
    const limiter = createSkillSourceScanLimiter(now);
    for (let i = 0; i < 30; i += 1) {
      limiter("company-1", "caller-1").release();
    }
    try {
      limiter("company-1", "caller-1");
      throw new Error("expected limiter to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const httpError = err as HttpError;
      expect(httpError.status).toBe(429);
      expect(httpError.message).toMatch(/scan limit reached/i);
      expect(httpError.details).toMatchObject({ retryAfterSeconds: 60 });
    }
  });

  it("drops scan counts older than the 60s window, allowing new scans again", () => {
    const { now, advance } = makeClock();
    const limiter = createSkillSourceScanLimiter(now);
    for (let i = 0; i < 30; i += 1) {
      limiter("company-1", "caller-1").release();
    }
    advance(60_001);
    expect(() => limiter("company-1", "caller-1")).not.toThrow();
  });

  it("rejects a download once the per-caller download limit (6 within 60s) is reached", () => {
    const { now } = makeClock();
    const limiter = createSkillSourceScanLimiter(now);
    const lease = limiter("company-1", "caller-1");
    for (let i = 0; i < 6; i += 1) {
      lease.beforeDownload();
    }
    try {
      lease.beforeDownload();
      throw new Error("expected limiter to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const httpError = err as HttpError;
      expect(httpError.status).toBe(429);
      expect(httpError.message).toMatch(/download limit reached/i);
      expect(httpError.details).toMatchObject({ retryAfterSeconds: 60 });
    }
  });

  it("makes release() idempotent: calling it twice does not double-free the active slot", () => {
    const { now } = makeClock();
    const limiter = createSkillSourceScanLimiter(now);
    const lease = limiter("company-1", "caller-1");
    lease.release();
    lease.release();
    // Two more callers should still only be bound by the company active
    // limit (2), proving the first caller's slot was freed exactly once.
    limiter("company-1", "caller-2");
    limiter("company-1", "caller-3");
    expect(() => limiter("company-1", "caller-4")).toThrow(/already running/i);
  });
});
