import { describe, expect, it } from "vitest";
import {
  AGENTCORE_QUALIFICATION_SUITE,
  AGENTCORE_QUALIFIED_MODEL,
  assertAgentCoreQualification,
  assertClaudeManagedQualification,
  assertProfileMetadataContainsNoSecrets,
  CLAUDE_MANAGED_QUALIFICATION,
  CLAUDE_MANAGED_QUALIFIED_MODEL,
  computeQualifiedProfileRevision,
  isQualifiedProfileRevision,
} from "./provider-profile-qualification.js";

const VALID_CLAUDE_QUALIFICATION = {
  probedAt: "2026-01-01T00:00:00Z",
  betaVersion: CLAUDE_MANAGED_QUALIFICATION.betaVersion,
  environmentPolicy: CLAUDE_MANAGED_QUALIFICATION.environmentPolicy,
  agentCapabilities: CLAUDE_MANAGED_QUALIFICATION.agentCapabilities,
};

describe("assertProfileMetadataContainsNoSecrets", () => {
  it("does not throw for metadata with no credential-shaped keys or values", () => {
    expect(() =>
      assertProfileMetadataContainsNoSecrets({ note: "plain text", version: 2 }, "Profile"),
    ).not.toThrow();
  });

  it("throws for a secret-shaped value (Bearer token)", () => {
    expect(() =>
      assertProfileMetadataContainsNoSecrets({ note: "Bearer abcdefgh" }, "Profile"),
    ).toThrow("Profile must not contain credential-shaped keys or values");
  });

  it("throws for a secret-shaped value (AWS access key id)", () => {
    expect(() =>
      assertProfileMetadataContainsNoSecrets({ note: "AKIAABCDEFGH12345678" }, "Profile"),
    ).toThrow(/must not contain credential-shaped/);
  });

  it("throws for a secret-shaped value nested inside an array", () => {
    expect(() =>
      assertProfileMetadataContainsNoSecrets({ list: ["ok", "sk-abcdefgh12345678"] }, "Profile"),
    ).toThrow(/must not contain credential-shaped/);
  });

  it("throws when a credential-shaped key is detected (sanitizeRecord redaction)", () => {
    expect(() =>
      assertProfileMetadataContainsNoSecrets({ apiKey: "anything" }, "Profile"),
    ).toThrow(/must not contain credential-shaped/);
  });

  it("does not throw for a known public qualified model value, even under a generic key name", () => {
    expect(() =>
      assertProfileMetadataContainsNoSecrets({ model: CLAUDE_MANAGED_QUALIFIED_MODEL }, "Profile"),
    ).not.toThrow();
    expect(() =>
      assertProfileMetadataContainsNoSecrets({ model: AGENTCORE_QUALIFIED_MODEL }, "Profile"),
    ).not.toThrow();
  });
});

describe("assertClaudeManagedQualification", () => {
  it("returns false for an empty qualification when not required", () => {
    expect(assertClaudeManagedQualification({}, { required: false })).toBe(false);
  });

  it("throws when the qualification is empty but required", () => {
    expect(() => assertClaudeManagedQualification({}, { required: true })).toThrow(
      "Claude Managed qualification attestation is required before enablement",
    );
  });

  it("returns true for a valid, exactly-matching qualification", () => {
    expect(assertClaudeManagedQualification(VALID_CLAUDE_QUALIFICATION, { required: true })).toBe(
      true,
    );
  });

  it("throws for a credential-shaped value before checking the field shape", () => {
    expect(() =>
      assertClaudeManagedQualification({ ...VALID_CLAUDE_QUALIFICATION, extra: "sk-abcdefgh12345678" }, { required: true }),
    ).toThrow(/must not contain credential-shaped/);
  });

  it("throws when a required field is missing", () => {
    const { probedAt, ...withoutProbedAt } = VALID_CLAUDE_QUALIFICATION;
    void probedAt;
    expect(() => assertClaudeManagedQualification(withoutProbedAt, { required: true })).toThrow(
      "Claude Managed qualification must contain the exact qualification attestation fields",
    );
  });

  it("throws when an extra field is present", () => {
    expect(() =>
      assertClaudeManagedQualification({ ...VALID_CLAUDE_QUALIFICATION, extra: "nope" }, { required: true }),
    ).toThrow("Claude Managed qualification must contain the exact qualification attestation fields");
  });

  it("throws for a non-ISO probedAt timestamp", () => {
    expect(() =>
      assertClaudeManagedQualification(
        { ...VALID_CLAUDE_QUALIFICATION, probedAt: "not-a-timestamp" },
        { required: true },
      ),
    ).toThrow("qualification.probedAt must be an ISO-8601 UTC timestamp");
  });

  it("throws when a value does not match the qualified profile", () => {
    expect(() =>
      assertClaudeManagedQualification(
        { ...VALID_CLAUDE_QUALIFICATION, betaVersion: "wrong-version" },
        { required: true },
      ),
    ).toThrow("Claude Managed qualification attestation does not match the qualified profile");
  });
});

describe("assertAgentCoreQualification", () => {
  const configuration = { qualificationRevision: AGENTCORE_QUALIFICATION_SUITE };
  const qualification = { suite: AGENTCORE_QUALIFICATION_SUITE };

  it("returns false for an empty qualification when not required", () => {
    expect(assertAgentCoreQualification(configuration, {}, { required: false })).toBe(false);
  });

  it("throws when the qualification is empty but required", () => {
    expect(() => assertAgentCoreQualification(configuration, {}, { required: true })).toThrow(
      "AWS AgentCore qualification attestation is required before enablement",
    );
  });

  it("returns true for a matching configuration and qualification", () => {
    expect(assertAgentCoreQualification(configuration, qualification, { required: true })).toBe(
      true,
    );
  });

  it("throws when an extra field is present on the qualification", () => {
    expect(() =>
      assertAgentCoreQualification(configuration, { ...qualification, extra: 1 }, { required: true }),
    ).toThrow("AWS AgentCore qualification must contain the exact qualification attestation fields");
  });

  it("throws when the configuration's qualificationRevision does not match the suite", () => {
    expect(() =>
      assertAgentCoreQualification({ qualificationRevision: "other-suite" }, qualification, { required: true }),
    ).toThrow("AWS AgentCore qualification attestation does not match the qualified harness suite");
  });

  it("throws when the qualification's suite does not match", () => {
    expect(() =>
      assertAgentCoreQualification(configuration, { suite: "other-suite" }, { required: true }),
    ).toThrow(/does not match the qualified harness suite/);
  });
});

describe("computeQualifiedProfileRevision", () => {
  it("produces the same revision regardless of key insertion order", () => {
    expect(computeQualifiedProfileRevision({ b: 2, a: 1 })).toBe(
      computeQualifiedProfileRevision({ a: 1, b: 2 }),
    );
  });

  it("omits undefined-valued keys the same way as if they were absent", () => {
    expect(computeQualifiedProfileRevision({ a: 1, b: undefined })).toBe(
      computeQualifiedProfileRevision({ a: 1 }),
    );
  });

  it("produces a different revision for a different value", () => {
    expect(computeQualifiedProfileRevision({ a: 1 })).not.toBe(
      computeQualifiedProfileRevision({ a: 2 }),
    );
  });

  it("returns a sha256:-prefixed 64-char hex revision", () => {
    expect(computeQualifiedProfileRevision({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("throws for a value that cannot be canonicalized (e.g. NaN)", () => {
    expect(() => computeQualifiedProfileRevision({ a: Number.NaN })).toThrow(
      "Provider profile contains a value that cannot be revisioned",
    );
  });
});

describe("isQualifiedProfileRevision", () => {
  it("accepts a well-formed sha256 revision string", () => {
    expect(isQualifiedProfileRevision(`sha256:${"a".repeat(64)}`)).toBe(true);
  });

  it("rejects a revision with the wrong prefix", () => {
    expect(isQualifiedProfileRevision(`sha512:${"a".repeat(64)}`)).toBe(false);
  });

  it("rejects a revision with the wrong hex length", () => {
    expect(isQualifiedProfileRevision(`sha256:${"a".repeat(63)}`)).toBe(false);
  });

  it("rejects uppercase hex characters", () => {
    expect(isQualifiedProfileRevision(`sha256:${"A".repeat(64)}`)).toBe(false);
  });

  it("rejects a non-string value", () => {
    expect(isQualifiedProfileRevision(12345)).toBe(false);
    expect(isQualifiedProfileRevision(null)).toBe(false);
  });
});
