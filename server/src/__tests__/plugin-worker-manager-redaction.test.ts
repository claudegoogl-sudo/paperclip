import { describe, expect, it } from "vitest";
import { redactHostHandlerErrorMessage } from "../services/plugin-worker-manager.js";
import { redactSensitiveText, REDACTED_EVENT_VALUE } from "../redaction.js";

// Synthetic shape-valid GitHub PAT — never a real token. Built at runtime so
// the literal does not appear in the source as scannable secret material.
// `\bgh[pousr]_[A-Za-z0-9_]{20,}\b` (see packages/adapter-utils/src/command-redaction.ts)
// matches any `ghp_` followed by ≥20 word chars; 36 trailing `A`s satisfies it.
const SYNTHETIC_GHP = `ghp_${"A".repeat(36)}`;

describe("plugin-worker-manager defense-in-depth host-handler error redaction (PLA-197)", () => {
  it("redacts shape-valid ghp_* tokens from Error.message before they reach logs/JSON-RPC", () => {
    // Simulates the same `try { … } catch (err) { … }` chokepoint used by
    // handleWorkerRequest: the catch block runs `err` through
    // redactHostHandlerErrorMessage before passing the result to both
    // `log.error` and `createErrorResponse`. If a future change drops the
    // redaction wrap, this assertion fails.
    const thrown = new Error(`secret rejected: ref=${SYNTHETIC_GHP}`);
    const errorMessage = redactHostHandlerErrorMessage(thrown);

    expect(errorMessage).not.toContain(SYNTHETIC_GHP);
    expect(errorMessage).not.toContain("ghp_");
    expect(errorMessage).toContain(REDACTED_EVENT_VALUE);
  });

  it("redacts shape-valid ghp_* tokens from non-Error throwables (String(err) path)", () => {
    // The catch block uses `err instanceof Error ? err.message : String(err)`,
    // so a plain string throw must also be redacted.
    const errorMessage = redactHostHandlerErrorMessage(`raw: ${SYNTHETIC_GHP}`);

    expect(errorMessage).not.toContain(SYNTHETIC_GHP);
    expect(errorMessage).not.toContain("ghp_");
    expect(errorMessage).toContain(REDACTED_EVENT_VALUE);
  });

  it("leaves non-secret error messages intact", () => {
    expect(redactHostHandlerErrorMessage(new Error("config.get failed: unknown key"))).toBe(
      "config.get failed: unknown key",
    );
  });

  it("converts non-string non-Error throwables via String() before redacting", () => {
    // Object throws stringify to "[object Object]" — proves the helper does
    // not crash on unusual throwables and still produces a string output.
    expect(redactHostHandlerErrorMessage({ shape: "weird" })).toBe("[object Object]");
  });
});

describe("redactSensitiveText invariant for synthetic GitHub PAT (PLA-197 wired-correctly proof)", () => {
  // Parallel direct-call test: establishes that the underlying redaction
  // primitive treats `ghp_` + ≥20 word chars as sensitive. If this assertion
  // ever flips, the wrap above is no longer sufficient — both tests must be
  // re-evaluated together. Preferred over a temporarily-bypass-then-revert
  // proof per CTO routing on PLA-197 (no production-code touch required to
  // demonstrate the invariant).
  it("redacts a synthetic shape-valid ghp_* token to ***REDACTED***", () => {
    const out = redactSensitiveText(SYNTHETIC_GHP);

    expect(out).not.toContain(SYNTHETIC_GHP);
    expect(out).not.toContain("ghp_");
    expect(out).toContain(REDACTED_EVENT_VALUE);
  });
});
