import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { timeAgo } from "./timeAgo";

const NOW = new Date("2026-06-15T12:00:00.000Z");

describe("timeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for timestamps under a minute old", () => {
    expect(timeAgo(new Date(NOW.getTime() - 0))).toBe("just now");
    expect(timeAgo(new Date(NOW.getTime() - 59_000))).toBe("just now");
  });

  it("returns 'just now' for a timestamp in the future", () => {
    expect(timeAgo(new Date(NOW.getTime() + 5_000))).toBe("just now");
  });

  it("formats minutes", () => {
    expect(timeAgo(new Date(NOW.getTime() - 60_000))).toBe("1m ago");
    expect(timeAgo(new Date(NOW.getTime() - 5 * 60_000))).toBe("5m ago");
    expect(timeAgo(new Date(NOW.getTime() - 59 * 60_000))).toBe("59m ago");
  });

  it("formats hours", () => {
    expect(timeAgo(new Date(NOW.getTime() - 60 * 60_000))).toBe("1h ago");
    expect(timeAgo(new Date(NOW.getTime() - 23 * 60 * 60_000))).toBe("23h ago");
  });

  it("formats days", () => {
    expect(timeAgo(new Date(NOW.getTime() - 24 * 60 * 60_000))).toBe("1d ago");
    expect(timeAgo(new Date(NOW.getTime() - 6 * 24 * 60 * 60_000))).toBe("6d ago");
  });

  it("formats weeks", () => {
    expect(timeAgo(new Date(NOW.getTime() - 7 * 24 * 60 * 60_000))).toBe("1w ago");
    expect(timeAgo(new Date(NOW.getTime() - 3 * 7 * 24 * 60 * 60_000))).toBe("3w ago");
  });

  it("formats months", () => {
    expect(timeAgo(new Date(NOW.getTime() - 30 * 24 * 60 * 60_000))).toBe("1mo ago");
    expect(timeAgo(new Date(NOW.getTime() - 90 * 24 * 60 * 60_000))).toBe("3mo ago");
  });

  it("accepts an ISO date string in addition to a Date object", () => {
    const isoString = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    expect(timeAgo(isoString)).toBe("5m ago");
  });
});
