import { describe, expect, it } from "vitest";
import {
  GIT_BRANCH_OWNERSHIP_METADATA_KEY,
  GIT_BRANCH_OWNERSHIP_METADATA_VERSION,
  isRuntimeOwnedGitBranch,
} from "./execution-workspace-branch-ownership.js";

describe("isRuntimeOwnedGitBranch", () => {
  it("returns true when the version key matches and createdByRuntime is true", () => {
    expect(
      isRuntimeOwnedGitBranch({
        [GIT_BRANCH_OWNERSHIP_METADATA_KEY]: GIT_BRANCH_OWNERSHIP_METADATA_VERSION,
        createdByRuntime: true,
      }),
    ).toBe(true);
  });

  it("returns false when the version key is stale", () => {
    expect(
      isRuntimeOwnedGitBranch({
        [GIT_BRANCH_OWNERSHIP_METADATA_KEY]: GIT_BRANCH_OWNERSHIP_METADATA_VERSION - 1,
        createdByRuntime: true,
      }),
    ).toBe(false);
  });

  it("returns false when the version key is absent", () => {
    expect(isRuntimeOwnedGitBranch({ createdByRuntime: true })).toBe(false);
  });

  it("returns false when createdByRuntime is false even with a current version", () => {
    expect(
      isRuntimeOwnedGitBranch({
        [GIT_BRANCH_OWNERSHIP_METADATA_KEY]: GIT_BRANCH_OWNERSHIP_METADATA_VERSION,
        createdByRuntime: false,
      }),
    ).toBe(false);
  });

  it("returns false when createdByRuntime is truthy but not strictly true", () => {
    expect(
      isRuntimeOwnedGitBranch({
        [GIT_BRANCH_OWNERSHIP_METADATA_KEY]: GIT_BRANCH_OWNERSHIP_METADATA_VERSION,
        createdByRuntime: 1,
      }),
    ).toBe(false);
  });

  it("returns false when createdByRuntime is absent", () => {
    expect(
      isRuntimeOwnedGitBranch({ [GIT_BRANCH_OWNERSHIP_METADATA_KEY]: GIT_BRANCH_OWNERSHIP_METADATA_VERSION }),
    ).toBe(false);
  });

  it("returns false for null or undefined metadata without throwing", () => {
    expect(isRuntimeOwnedGitBranch(null)).toBe(false);
    expect(isRuntimeOwnedGitBranch(undefined)).toBe(false);
  });

  it("returns false for an empty metadata object", () => {
    expect(isRuntimeOwnedGitBranch({})).toBe(false);
  });
});
