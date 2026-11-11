import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression guard for #713 (full and 16-char session-id lookups). An upstream sync once
// reverted these call sites because heartbeat logic moved into this module.
describe("run-state session id lookups", () => {
  const source = readFileSync(new URL("./run-state.ts", import.meta.url), "utf8");

  it("matches session ids through sessionIdLookupCandidates", () => {
    expect(source).toContain('from "../session-id-lookup.js"');
    expect(source).toContain("sessionIdLookupCandidates(sessionId)");
  });

  it("never compares sessionIdAfter to a raw session id", () => {
    expect(source).not.toMatch(/eq\(heartbeatRuns\.sessionIdAfter,\s*sessionId\)/);
    expect(source.match(/sessionIdAfterMatches\(sessionId\)/g)?.length).toBe(3);
  });
});
