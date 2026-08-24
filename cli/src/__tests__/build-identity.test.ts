import { describe, expect, it } from "vitest";
import { assertBuildIdentity, describeBuildIdentity, readIdentityEnv } from "../build-identity.js";

describe("describeBuildIdentity", () => {
  it("classifies a fork build by its -fork.<n> marker", () => {
    const id = describeBuildIdentity("2026.428.1-fork.9");
    expect(id.isForkBuild).toBe(true);
    expect(id.channel).toBe("fork");
  });

  it("classifies a plain upstream release as upstream", () => {
    const id = describeBuildIdentity("2026.525.0");
    expect(id.isForkBuild).toBe(false);
    expect(id.channel).toBe("upstream");
  });

  it("does not treat unrelated prerelease tags as a fork build", () => {
    expect(describeBuildIdentity("2026.525.0-rc.1").isForkBuild).toBe(false);
    expect(describeBuildIdentity("2026.525.0-fork").isForkBuild).toBe(false);
  });
});

describe("assertBuildIdentity", () => {
  it("passes a fork build with no operator expectations", () => {
    const res = assertBuildIdentity("2026.428.1-fork.9", {});
    expect(res.ok).toBe(true);
    expect(res.message).toContain("fork build");
  });

  it("passes an upstream build by default (does not break upstream users)", () => {
    const res = assertBuildIdentity("2026.525.0", {});
    expect(res.ok).toBe(true);
    expect(res.failureReason).toBeUndefined();
  });

  it("aborts an upstream build when PAPERCLIP_REQUIRE_FORK_BUILD is set", () => {
    const res = assertBuildIdentity("2026.525.0", { requireForkBuild: "1" });
    expect(res.ok).toBe(false);
    expect(res.failureReason).toBe("not-fork-build");
    expect(res.message).toContain("/usr/bin/paperclipai run");
  });

  it("passes a fork build when fork is required", () => {
    const res = assertBuildIdentity("2026.428.1-fork.9", { requireForkBuild: "true" });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("fork required: satisfied");
  });

  it("aborts on an expected-version mismatch (wrong binary resolved)", () => {
    const res = assertBuildIdentity("2026.525.0", { expectedVersion: "2026.428.1-fork.9" });
    expect(res.ok).toBe(false);
    expect(res.failureReason).toBe("version-mismatch");
  });

  it("passes when the running version matches the expected version exactly", () => {
    const res = assertBuildIdentity("2026.428.1-fork.9", {
      expectedVersion: "2026.428.1-fork.9",
      requireForkBuild: "1",
    });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("matched");
  });

  it("checks the expected version before the fork requirement", () => {
    // expected-version mismatch should win even when fork is also required.
    const res = assertBuildIdentity("2026.428.1-fork.9", {
      expectedVersion: "2026.428.1-fork.8",
      requireForkBuild: "1",
    });
    expect(res.ok).toBe(false);
    expect(res.failureReason).toBe("version-mismatch");
  });

  it("ignores blank/whitespace expected version and falsey require flags", () => {
    expect(assertBuildIdentity("2026.525.0", { expectedVersion: "   " }).ok).toBe(true);
    expect(assertBuildIdentity("2026.525.0", { requireForkBuild: "0" }).ok).toBe(true);
    expect(assertBuildIdentity("2026.525.0", { requireForkBuild: "false" }).ok).toBe(true);
    expect(assertBuildIdentity("2026.525.0", { requireForkBuild: "" }).ok).toBe(true);
  });
});

describe("readIdentityEnv", () => {
  it("maps the PAPERCLIP_* env vars onto the identity env shape", () => {
    const env = readIdentityEnv({
      PAPERCLIP_REQUIRE_FORK_BUILD: "1",
      PAPERCLIP_EXPECTED_VERSION: "2026.428.1-fork.9",
    } as NodeJS.ProcessEnv);
    expect(env.requireForkBuild).toBe("1");
    expect(env.expectedVersion).toBe("2026.428.1-fork.9");
  });
});
