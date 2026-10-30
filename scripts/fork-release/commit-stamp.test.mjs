import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { verifyCommitStamp } from "./lib.mjs";
import { resolveSourceCommit } from "../source-commit.mjs";
import { applyCommitStamp } from "../pack-public-packages.mjs";
import { materializePublishManifest } from "../prepare-bundled-package.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function packFakeTarball(outPath, manifest) {
  const work = mkdtempSync(path.join(tmpdir(), "commit-stamp-pkg-"));
  mkdirSync(path.join(work, "package"), { recursive: true });
  writeFileSync(path.join(work, "package", "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const result = spawnSync("tar", ["-czf", outPath, "-C", work, "package"], { encoding: "utf8" });
  rmSync(work, { recursive: true, force: true });
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`);
}

test("verifyCommitStamp accepts a full set of correctly stamped tarballs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "commit-stamp-ok-"));
  try {
    packFakeTarball(path.join(dir, "paperclipai-1.0.0.tgz"), { name: "paperclipai", version: "1.0.0", gitHead: SHA_A });
    packFakeTarball(path.join(dir, "paperclipai-server-1.0.0.tgz"), { name: "@paperclipai/server", version: "1.0.0", gitHead: SHA_A });
    const verdict = verifyCommitStamp({ assetsDir: dir, expectedCommit: SHA_A });
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.violations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyCommitStamp fails closed on missing and mismatched stamps", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "commit-stamp-bad-"));
  try {
    packFakeTarball(path.join(dir, "unstamped.tgz"), { name: "pkg", version: "1.0.0" });
    packFakeTarball(path.join(dir, "mismatched.tgz"), { name: "pkg2", version: "1.0.0", gitHead: SHA_B });
    const verdict = verifyCommitStamp({ assetsDir: dir, expectedCommit: SHA_A });
    assert.equal(verdict.ok, false);
    const problems = Object.fromEntries(verdict.violations.map((v) => [v.asset, v.problem]));
    assert.match(problems["unstamped.tgz"], /no gitHead stamp/);
    assert.match(problems["mismatched.tgz"], /does not match/);
    assert.equal(problems["mismatched.tgz"] === undefined ? null : verdict.violations.find((v) => v.asset === "mismatched.tgz").actual, SHA_B);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyCommitStamp rejects malformed expected commits up front", () => {
  assert.throws(() => verifyCommitStamp({ assetsDir: "/tmp", expectedCommit: "abc123" }), /40-hex/);
});

test("resolveSourceCommit prefers the env override and validates it", () => {
  assert.deepEqual(resolveSourceCommit({ env: { RELEASE_SOURCE_COMMIT: SHA_B }, repoRoot: "/nonexistent", execFileSync: () => { throw new Error("must not run git"); } }),
    { commit: SHA_B, source: "env" });
  assert.throws(() => resolveSourceCommit({ env: { RELEASE_SOURCE_COMMIT: "deadbeef" }, repoRoot: "/nonexistent" }), /40-hex/);
});

test("resolveSourceCommit returns null without git metadata and uses HEAD otherwise", () => {
  const plain = mkdtempSync(path.join(tmpdir(), "commit-stamp-nogit-"));
  try {
    assert.equal(resolveSourceCommit({ env: {}, repoRoot: plain }), null);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
  // This test file lives inside the real repository checkout, so HEAD resolves.
  const resolved = resolveSourceCommit({ env: {} });
  assert.ok(resolved);
  assert.equal(resolved.source, "git");
  assert.match(resolved.commit, /^[0-9a-f]{40}$/);
});

test("applyCommitStamp stamps when a commit is available and is a no-op otherwise", () => {
  assert.deepEqual(applyCommitStamp({ name: "x", version: "1" }, { commit: SHA_A }), { name: "x", version: "1", gitHead: SHA_A });
  assert.deepEqual(applyCommitStamp({ name: "x", version: "1" }, null), { name: "x", version: "1" });
});

test("materializePublishManifest stamps staged packages (injectable commit)", () => {
  const manifest = materializePublishManifest(
    { name: "@paperclipai/db", version: "1.0.0", dependencies: { "@paperclipai/shared": "workspace:^" } },
    { sourceCommit: { commit: SHA_A } },
  );
  assert.equal(manifest.gitHead, SHA_A);
  assert.equal(manifest.dependencies["@paperclipai/shared"], "^1.0.0");
  const unstamped = materializePublishManifest(
    { name: "@paperclipai/db", version: "1.0.0" },
    { sourceCommit: null },
  );
  assert.equal(unstamped.gitHead, undefined);
});
