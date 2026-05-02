import { describe, expect, it } from "vitest";
import { REDACTED_COMMAND_TEXT_VALUE, redactCommandText } from "./command-redaction.js";

describe("redactCommandText", () => {
  it("redacts classic GitHub token prefixes", () => {
    const tokens = [
      "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      "gho_1234567890abcdefghijklmnopqrstuvwxyz",
      "ghu_1234567890abcdefghijklmnopqrstuvwxyz",
      "ghs_1234567890abcdefghijklmnopqrstuvwxyz",
      "ghr_1234567890abcdefghijklmnopqrstuvwxyz",
    ];
    for (const token of tokens) {
      const input = `gh auth login --with-token ${token}`;
      const result = redactCommandText(input);
      expect(result).not.toContain(token);
      expect(result).toContain(REDACTED_COMMAND_TEXT_VALUE);
    }
  });

  it("redacts fine-grained GitHub PATs (github_pat_*)", () => {
    // Synthetic value matching the github_pat_ shape (prefix + base62/_ body).
    // Never use a real token here.
    const fineGrainedPat =
      "github_pat_11ABCDEFG0aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const input = `curl -H "Authorization: token ${fineGrainedPat}" https://api.github.com/user`;
    const result = redactCommandText(input);
    expect(result).not.toContain(fineGrainedPat);
    expect(result).not.toContain("github_pat_");
    expect(result).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts a fine-grained PAT exposed via an env-var assignment", () => {
    const fineGrainedPat =
      "github_pat_11CCCCCCC0xxxxxxxxxxxx_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";
    const input = `GITHUB_TOKEN=${fineGrainedPat} ./deploy.sh`;
    const result = redactCommandText(input);
    expect(result).not.toContain(fineGrainedPat);
    // The env-assignment path is what handles this case; assert a sentinel landed.
    expect(result).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("does not alter inputs that contain neither classic nor fine-grained tokens", () => {
    const input = "git status && git log --oneline -5";
    expect(redactCommandText(input)).toBe(input);
  });

  it("does not match strings that merely start with 'github_pat' but lack the underscore separator", () => {
    // Word boundary + required `github_pat_` prefix means a bare 'github_patch' identifier
    // (which has no trailing underscore before the body) should not be redacted.
    const input = "echo github_patch_notes_v2";
    expect(redactCommandText(input)).toBe(input);
  });
});
