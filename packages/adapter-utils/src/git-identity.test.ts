import { describe, expect, it } from "vitest";
import {
  AGENT_GIT_IDENTITY_EMAIL_DOMAIN,
  buildAgentGitIdentityEnv,
  deriveAgentGitIdentity,
} from "./git-identity.js";

const AGENT_ID = "558b662c-0f1f-473a-ab7d-d4e56fb3c29b";
const COMPANY_ID = "d49b266c-50dc-42c5-b45e-308c7f3ffc1f";

describe("deriveAgentGitIdentity", () => {
  it("is stable for the same agent across calls", () => {
    const a = deriveAgentGitIdentity({ id: AGENT_ID, name: "Coder", companyId: COMPANY_ID });
    const b = deriveAgentGitIdentity({ id: AGENT_ID, name: "Coder", companyId: COMPANY_ID });
    expect(a).toEqual(b);
  });

  it("follows the documented name/email scheme", () => {
    const identity = deriveAgentGitIdentity({ id: AGENT_ID, name: "Coder", companyId: COMPANY_ID });
    expect(identity.name).toBe("Paperclip Agent coder (558b662c)");
    expect(identity.email).toBe(
      `coder.${AGENT_ID}@${COMPANY_ID}.${AGENT_GIT_IDENTITY_EMAIL_DOMAIN}`,
    );
  });

  it("keeps agents with identical names distinct (collision-free)", () => {
    const a = deriveAgentGitIdentity({ id: AGENT_ID, name: "LayoutEngineer", companyId: COMPANY_ID });
    const b = deriveAgentGitIdentity({
      id: "00000000-1111-4222-8333-444444444444",
      name: "LayoutEngineer",
      companyId: COMPANY_ID,
    });
    expect(a.email).not.toBe(b.email);
    expect(a.name).not.toBe(b.name);
  });

  it("discriminates companies for the same agent id input shape", () => {
    const a = deriveAgentGitIdentity({ id: AGENT_ID, name: "Coder", companyId: COMPANY_ID });
    const b = deriveAgentGitIdentity({
      id: AGENT_ID,
      name: "Coder",
      companyId: "ffffffff-0000-4000-8000-000000000001",
    });
    expect(a.email).not.toBe(b.email);
    expect(a.email).toContain(`${COMPANY_ID}.`);
    expect(b.email).toContain("ffffffff-0000-4000-8000-000000000001.");
  });

  it("folds unicode and homoglyph names to a safe ASCII slug", () => {
    const accented = deriveAgentGitIdentity({ id: AGENT_ID, name: "Cöder Ünit", companyId: COMPANY_ID });
    expect(accented.name).toBe("Paperclip Agent coder-unit (558b662c)");
    // Cyrillic С (U+0421) is not the latin C: after folding it disappears, and
    // the id segment still keeps the identity unique and non-confusable.
    const homoglyph = deriveAgentGitIdentity({ id: AGENT_ID, name: "Сoder", companyId: COMPANY_ID });
    expect(homoglyph.email).toContain(AGENT_ID);
    expect(/^[\x20-\x7e]+$/.test(homoglyph.name)).toBe(true);
  });

  it("never produces an empty or unattributed identity for degenerate names", () => {
    for (const name of ["", "   ", null, "日本語テスト", "!!!@@@###", "​"]) {
      const identity = deriveAgentGitIdentity({ id: AGENT_ID, name, companyId: COMPANY_ID });
      expect(identity.name.length).toBeGreaterThan(0);
      expect(identity.email.length).toBeGreaterThan(0);
      // The bare id fallback keeps the email deliverable-shaped and unique.
      expect(identity.email).toContain(`${AGENT_ID}@`);
      expect(identity.email.startsWith(".")).toBe(false);
    }
  });

  it("cannot be confusable with a real user email, even when the name mimics one", () => {
    const identity = deriveAgentGitIdentity({
      id: AGENT_ID,
      name: "coppercto@copperworks.local",
      companyId: COMPANY_ID,
    });
    expect(identity.email.endsWith(`.${AGENT_GIT_IDENTITY_EMAIL_DOMAIN}`)).toBe(true);
    expect(identity.email.endsWith("@copperworks.local")).toBe(false);
    expect(identity.name.startsWith("Paperclip Agent ")).toBe(true);
  });

  it("caps name-derived segments to a bounded length", () => {
    const identity = deriveAgentGitIdentity({
      id: AGENT_ID,
      name: "x".repeat(500),
      companyId: COMPANY_ID,
    });
    expect(identity.name.length).toBeLessThan(80);
    expect(identity.email.length).toBeLessThan(160);
    expect(identity.email).toContain(AGENT_ID);
  });

  it("tolerates non-uuid ids without emitting unsafe characters", () => {
    const identity = deriveAgentGitIdentity({ id: "weird id/with$stuff", name: "Coder", companyId: "co;1" });
    expect(identity.email).toBe(`coder.weirdidwithstuff@co1.${AGENT_GIT_IDENTITY_EMAIL_DOMAIN}`);
  });

  it("falls back to id-based labels when ids are empty", () => {
    const identity = deriveAgentGitIdentity({ id: "***", name: "", companyId: "" });
    expect(identity.email).toContain("agent@company.");
  });
});

describe("buildAgentGitIdentityEnv", () => {
  it("sets all four GIT_* variables to the derived identity", () => {
    const env = buildAgentGitIdentityEnv({ id: AGENT_ID, name: "Coder", companyId: COMPANY_ID });
    const identity = deriveAgentGitIdentity({ id: AGENT_ID, name: "Coder", companyId: COMPANY_ID });
    expect(env).toEqual({
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    });
  });
});
