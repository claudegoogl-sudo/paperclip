import { afterEach, describe, expect, it } from "vitest";
import {
  admitBoardKeyAuthEventBadKey,
  resetBoardKeyAuthEventThrottleForTests,
} from "../middleware/auth.ts";

// The unattributed bad_key path is attacker-controlled traffic, so the write
// path must bound it: at most one row per source per window, with further
// attempts carried as suppressed_count on the source's NEXT row (the table
// itself stays append-only). These tests drive the admission decision
// directly with injected time so no clock or DB is needed.

afterEach(() => {
  resetBoardKeyAuthEventThrottleForTests();
});

describe("admitBoardKeyAuthEventBadKey", () => {
  it("writes the first row of a window and suppresses the rest", () => {
    expect(admitBoardKeyAuthEventBadKey("203.0.113.7", 1_000)).toEqual({
      write: true,
      suppressedCount: 0,
    });
    for (let i = 0; i < 50; i++) {
      expect(admitBoardKeyAuthEventBadKey("203.0.113.7", 2_000 + i)).toEqual({
        write: false,
        suppressedCount: 0,
      });
    }
  });

  it("carries the suppressed count on the next window's row", () => {
    admitBoardKeyAuthEventBadKey("203.0.113.7", 0);
    for (let i = 0; i < 58; i++) {
      admitBoardKeyAuthEventBadKey("203.0.113.7", 1_000 + i);
    }
    // Window rolls: the next admitted row carries what was suppressed since
    // the source's previous row.
    expect(admitBoardKeyAuthEventBadKey("203.0.113.7", 61_000)).toEqual({
      write: true,
      suppressedCount: 58,
    });
    // The counter restarts with the new window.
    expect(admitBoardKeyAuthEventBadKey("203.0.113.7", 61_500)).toEqual({
      write: false,
      suppressedCount: 0,
    });
  });

  it("isolates sources so one flooding source never silences another", () => {
    expect(admitBoardKeyAuthEventBadKey("203.0.113.7", 0)).toEqual({ write: true, suppressedCount: 0 });
    expect(admitBoardKeyAuthEventBadKey("203.0.113.8", 0)).toEqual({ write: true, suppressedCount: 0 });
    expect(admitBoardKeyAuthEventBadKey("203.0.113.7", 500)).toEqual({
      write: false,
      suppressedCount: 0,
    });
    expect(admitBoardKeyAuthEventBadKey("203.0.113.8", 500)).toEqual({
      write: false,
      suppressedCount: 0,
    });
  });

  it("forgets sources that go quiet, so memory stays bounded", () => {
    admitBoardKeyAuthEventBadKey("203.0.113.7", 0);
    admitBoardKeyAuthEventBadKey("203.0.113.7", 1_000);
    // Past the 10-minute TTL the source's state (including its pending
    // suppression counter) is dropped rather than accumulated indefinitely.
    expect(admitBoardKeyAuthEventBadKey("203.0.113.7", 11 * 60_000)).toEqual({
      write: true,
      suppressedCount: 0,
    });
  });
});
