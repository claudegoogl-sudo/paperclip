import { describe, expect, it } from "vitest";
import { learningDayKey, learningDayLabel } from "./pipeline-learnings";

describe("learningDayKey (local-day boundary fix)", () => {
  it("keys an event by its local calendar day, not its UTC calendar day", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles"; // UTC-8 (standard time)
    try {
      // 2026-01-15T23:30:00-08:00 is still "Jan 15" locally, even though it
      // is 2026-01-16T07:30:00Z, i.e. "Jan 16" in UTC. Before this fix,
      // learningDayKey keyed this as "2026-01-16" (the UTC day), which did
      // not match learningDayLabel's local-day notion of "today". The fixed
      // implementation keys it as "2026-01-15" instead.
      const lateLocalEvening = "2026-01-15T23:30:00-08:00";
      expect(learningDayKey(lateLocalEvening)).toBe("2026-01-15");
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it("gives the same key to two events on the same local day that straddle a UTC midnight boundary", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles"; // UTC-8 (standard time)
    try {
      // 23:30 and 23:45 local time on Jan 15 are both before UTC midnight
      // rolls over into Jan 16 UTC at 00:00 UTC (= 16:00 local on Jan 15),
      // wait — pick times that straddle the *UTC* midnight boundary while
      // staying on the same *local* day: 2026-01-15T23:30:00-08:00 (07:30Z
      // Jan 16) and 2026-01-15T22:30:00-08:00 (06:30Z Jan 16) are both after
      // UTC midnight but still "Jan 15" locally.
      const beforeUtcMidnightLocally = "2026-01-15T15:30:00-08:00"; // 23:30Z Jan 15
      const afterUtcMidnightLocally = "2026-01-15T23:30:00-08:00"; // 07:30Z Jan 16
      expect(learningDayKey(beforeUtcMidnightLocally)).toBe(learningDayKey(afterUtcMidnightLocally));
      expect(learningDayKey(beforeUtcMidnightLocally)).toBe("2026-01-15");
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it("still returns the UTC day's date components when running in UTC (no behavior change for UTC)", () => {
    expect(learningDayKey("2026-01-15T23:59:59.999Z")).toBe("2026-01-15");
    expect(learningDayKey("2026-01-16T00:00:00.000Z")).toBe("2026-01-16");
  });

  it("stays consistent with learningDayLabel's local-day notion of 'today'", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const timestamp = "2026-01-15T23:30:00-08:00";
      const key = learningDayKey(timestamp);
      // learningDayLabel compares against "now"; here we just confirm the
      // key reflects the same local year/month/day learningDayLabel's
      // startOfDay calculation would use for this timestamp.
      const date = new Date(timestamp);
      const expectedKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      expect(key).toBe(expectedKey);
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it("returns 'Unknown' for an unparsable value", () => {
    expect(learningDayKey("not-a-date")).toBe("Unknown");
    expect(learningDayLabel("not-a-date")).toBe("Unknown");
  });
});
