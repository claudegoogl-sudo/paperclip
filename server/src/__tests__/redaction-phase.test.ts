import { describe, expect, it } from "vitest";
import { sanitizeRecord, REDACTED_EVENT_VALUE } from "../redaction.js";

describe("redaction phase names", () => {
  it("keeps dotted lifecycle phase names", () => {
    expect(sanitizeRecord({ phase: "task.run.measured" })).toEqual({ phase: "task.run.measured" });
  });
  it("still redacts JWT-shaped values under phase and other keys", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
    expect(sanitizeRecord({ phase: jwt }).phase).toBe(REDACTED_EVENT_VALUE);
    expect(sanitizeRecord({ other: "task.run.measured" }).other).toBe(REDACTED_EVENT_VALUE);
  });
});
