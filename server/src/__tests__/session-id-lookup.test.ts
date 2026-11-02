import { describe, expect, it } from "vitest";
import { sessionIdLookupCandidates } from "../services/session-id-lookup.js";

describe("sessionIdLookupCandidates", () => {
  const full = "01a12c33-0968-7000-9d65-fee348a075e8";
  it("matches both the full and the 16-char display id", () => {
    expect(sessionIdLookupCandidates(full)).toEqual([full, "01a12c33-0968-70"]);
  });
  it("does not match a different session sharing an 8-char prefix", () => {
    const other = "01a12c33-1111-7000-9d65-fee348a075e8".slice(0, 16);
    expect(sessionIdLookupCandidates(full)).not.toContain(other);
  });
  it("keeps a short id as is", () => {
    expect(sessionIdLookupCandidates("01a12c33-0968-70")).toEqual(["01a12c33-0968-70"]);
  });
});
