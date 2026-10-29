import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const checker = path.join(repoRoot, "scripts/fork-release/fork-master-verify.mjs");
const liveWorkflow = path.join(repoRoot, ".github/workflows/release.yml");

function runChecker(file) {
  return spawnSync(process.execPath, [checker, file], { encoding: "utf8" });
}

test("the shipped release.yml keeps the fork master verify delta", () => {
  const result = runChecker(liveWorkflow);
  assert.equal(result.status, 0, `checker must pass on the fork release.yml:\n${result.stderr}`);
  assert.match(result.stdout, /guard OK/);
});

test("the upstream-gated form is rejected (regression that left master unverified)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fork-master-verify-"));
  try {
    const file = path.join(dir, "release.yml");
    const body = readFileSync(liveWorkflow, "utf8")
      // Put the repository gate back on verify_canary (upstream #13233 form).
      .replace(
        "  verify_canary:\n    name: Verify master push\n    if: github.event_name == 'push' && github.ref == 'refs/heads/master'\n    uses: ./.github/workflows/release-verify.yml\n    with:\n      ref: ${{ github.sha }}\n",
        "  verify_canary:\n    name: Reuse exact-source verification\n    if: github.repository == 'paperclipai/paperclip' && github.event_name == 'push' && github.ref == 'refs/heads/master'\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
      )
      .replace(
        "  publish_canary:\n    if: github.event_name == 'push' && github.repository == 'paperclipai/paperclip'\n",
        "  publish_canary:\n    if: github.event_name == 'push'\n",
      );
    writeFileSync(file, body);
    const result = runChecker(file);
    assert.equal(result.status, 1, "the upstream-gated form must fail the guard");
    assert.match(result.stderr, /verify_canary must not gate on github\.repository/);
    assert.match(result.stderr, /publish_canary must keep the github\.repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a push-triggered verify_canary that does not call release-verify.yml is rejected", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fork-master-verify-"));
  try {
    const file = path.join(dir, "release.yml");
    const body = readFileSync(liveWorkflow, "utf8").replace(
      "    uses: ./.github/workflows/release-verify.yml\n    with:\n      ref: ${{ github.sha }}\n",
      "    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
    );
    writeFileSync(file, body);
    const result = runChecker(file);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must call the reusable \.\/\.github\/workflows\/release-verify\.yml/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
