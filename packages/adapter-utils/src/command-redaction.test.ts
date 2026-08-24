import { describe, expect, it } from "vitest";
import { REDACTED_COMMAND_TEXT_VALUE, redactCommandText } from "./command-redaction.js";

// Synthetic, shape-valid fixtures only — never real credentials.
// Fine-grained PAT shape: `github_pat_` + 22 chars + `_` + 59 chars.
const FINE_GRAINED_PAT =
  "github_pat_11ABCDE5Y0abcdefghijkl_" +
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVW";
const CLASSIC_PAT = "ghp_0123456789abcdefghijklmnopqrstuvwx";

describe("redactCommandText fine-grained github_pat_ coverage", () => {
  it("redacts a lone fine-grained PAT with no other secret hint present", () => {
    // Regression: before this fix `maybeContainsSecretText` returned false for a
    // bare `github_pat_` token (no `--flag`/`ENV=`/classic-prefix hint), so the
    // function returned the command unchanged and leaked the PAT.
    const out = redactCommandText(`echo ${FINE_GRAINED_PAT}`);
    expect(out).not.toContain(FINE_GRAINED_PAT);
    expect(out).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts a fine-grained PAT embedded in an argument", () => {
    const out = redactCommandText(`curl -H "x: ${FINE_GRAINED_PAT}" https://api.example.com`);
    expect(out).not.toContain(FINE_GRAINED_PAT);
  });

  it("still redacts classic ghp_ tokens", () => {
    const out = redactCommandText(`git remote set-url origin https://${CLASSIC_PAT}@example.com`);
    expect(out).not.toContain(CLASSIC_PAT);
    expect(out).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("leaves commands without secrets untouched", () => {
    const cmd = "ls -la /tmp && echo done";
    expect(redactCommandText(cmd)).toBe(cmd);
  });
});
