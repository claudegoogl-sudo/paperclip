import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyCompare,
  extractPullNumber,
  extractTicket,
  formatLedger,
  listMissingCommits,
  readInstalledManifest,
  resolveBaseCommitFromManifest,
  resolveTagCommit,
  subjectOf,
  EXIT_CLEAN,
  EXIT_DRIFT,
  EXIT_CONTROL_FAILED,
  EXIT_ENV_ERROR,
} from "./drift-check.mjs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("readInstalledManifest reports a wrong install dir as an env error", () => {
  const missing = readInstalledManifest(path.join(tmpdir(), "drift-check-no-such-dir-xyz"));
  assert.ok(missing.error.includes("wrong install dir?"));
});

test("readInstalledManifest returns version and keeps the stamp accessible", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "drift-check-install-"));
  try {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "paperclipai", version: "2026.907.1-fork.43", gitHead: "a".repeat(40) }),
    );
    const read = readInstalledManifest(dir);
    assert.equal(read.error, undefined);
    assert.equal(read.manifest.version, "2026.907.1-fork.43");
    assert.equal(resolveBaseCommitFromManifest(read.manifest).commit, "a".repeat(40));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveBaseCommitFromManifest prefers the stamp fields and rejects short shas", () => {
  const full = "b2d6b8bb08fc0d2288e99ad57e02c205841a52ba";
  assert.deepEqual(resolveBaseCommitFromManifest({ gitHead: full }), { commit: full, mode: "stamp", field: "gitHead" });
  assert.deepEqual(resolveBaseCommitFromManifest({ commit: full }), { commit: full, mode: "stamp", field: "commit" });
  assert.deepEqual(resolveBaseCommitFromManifest({ sha: full }), { commit: full, mode: "stamp", field: "sha" });
  assert.equal(resolveBaseCommitFromManifest({ gitHead: "b2d6b8bb0" }), null);
  assert.equal(resolveBaseCommitFromManifest({ version: "1.2.3" }), null);
  assert.equal(resolveBaseCommitFromManifest(null), null);
});

test("classifyCompare maps compare status to verdicts, failing closed", () => {
  assert.equal(classifyCompare({ compareStatus: "identical" }), "clean");
  assert.equal(classifyCompare({ compareStatus: "ahead" }), "drift");
  assert.equal(classifyCompare({ compareStatus: "behind" }), "control-failed");
  assert.equal(classifyCompare({ compareStatus: "diverged" }), "control-failed");
  assert.equal(classifyCompare({ compareStatus: undefined }), "control-failed");
});

test("extractPullNumber reads the trailing merge marker only", () => {
  assert.equal(extractPullNumber("feat: ship thing (#123)"), "123");
  assert.equal(extractPullNumber("feat: ship thing (#123)  "), "123");
  assert.equal(extractPullNumber("feat: reference #123 mid-subject"), null);
  assert.equal(extractPullNumber("chore: no marker"), null);
});

test("extractTicket applies the deployment-local regex and fails soft", () => {
  assert.equal(extractTicket("fix: bug\n\ndetails", null), null);
  assert.equal(extractTicket("fix: bug AB-42 done", "[A-Z]{2,8}-[0-9]{1,6}"), "AB-42");
  assert.equal(extractTicket("no ticket here", "[A-Z]{2,8}-[0-9]{1,6}"), null);
  assert.equal(extractTicket("message", "[unclosed"), null);
});

test("subjectOf returns only the first line", () => {
  assert.equal(subjectOf("feat: x\n\nbody"), "feat: x");
  assert.equal(subjectOf(undefined), "");
});

test("resolveTagCommit resolves through the injected api and reports misses as errors", () => {
  const ok = resolveTagCommit({
    repo: "example/paperclip",
    version: "2026.907.1-fork.43",
    ghApiFn: () => ({ object: { sha: "b".repeat(40) } }),
  });
  assert.equal(ok.commit, "b".repeat(40));
  assert.equal(ok.tagName, "v2026.907.1-fork.43");

  const missing = resolveTagCommit({
    repo: "example/paperclip",
    version: "0.0.0-nope",
    ghApiFn: () => {
      throw new Error("No commit found for the ref 404");
    },
  });
  assert.match(missing.error, /cannot resolve tag/);
});

test("listMissingCommits paginates and stops when the target is drained", () => {
  const calls = [];
  const page = (n, count) => ({
    status: "ahead",
    ahead_by: 120,
    commits: Array.from({ length: count }, (_, i) => ({
      sha: `${n}`.padStart(2, "0") + `${i}`.padStart(38, "0"),
      commit: { message: `commit ${n}-${i} (#${n}${i})` },
      html_url: `https://example.invalid/commit/${n}-${i}`,
    })),
  });
  const ghApiFn = (p) => {
    calls.push(p);
    if (p.endsWith("page=1")) return page(1, 100);
    return page(2, 20);
  };
  const result = listMissingCommits({ repo: "example/paperclip", base: "a".repeat(40), target: "b".repeat(40), ghApiFn });
  assert.equal(result.compareStatus, "ahead");
  assert.equal(result.aheadBy, 120);
  assert.equal(result.commits.length, 120);
  assert.equal(calls.filter((p) => p.includes("page=")).length, 2);
});

test("formatLedger renders the clean verdict with the positive-control line", () => {
  const ledger = formatLedger({
    repo: "example/paperclip",
    installVersion: "2026.907.1-fork.43",
    baseCommit: "b".repeat(40),
    baseMode: "stamp",
    targetRef: "master",
    targetCommit: "b".repeat(40),
    missing: [],
  });
  assert.match(ledger, /Drift: NONE/);
  assert.match(ledger, /Positive control: .*PASS/);
  assert.match(ledger, /stamped in the installed artifact/);
});

test("formatLedger names every missing commit with PR and ticket refs", () => {
  const ledger = formatLedger({
    repo: "example/paperclip",
    installVersion: "2026.824.1-fork.42",
    baseCommit: "5".repeat(40),
    baseMode: "tag",
    targetRef: "master",
    targetCommit: "b".repeat(40),
    ticketRegexSource: "[A-Z]{2,8}-[0-9]{1,6}",
    missing: [
      { sha: "f3b8bfe4d" + "0".repeat(31), subject: "fix: host-wide run ceiling (#167)", message: "fix: host-wide run ceiling (#167)\n\nAB-42", htmlUrl: null },
      { sha: "5f3d7a173" + "0".repeat(31), subject: "feat: readiness probe transport (#172)", message: "feat: readiness probe transport (#172)", htmlUrl: null },
    ],
  });
  assert.match(ledger, /Drift: 2 commit\(s\)/);
  assert.match(ledger, /f3b8bfe4d000  \(PR #167, ticket AB-42\) fix: host-wide run ceiling/);
  assert.match(ledger, /5f3d7a173000  \(PR #172\) feat: readiness probe transport/);
  assert.match(ledger, /resolved via release tag/);
});

test("formatLedger respects the display limit while counting all commits", () => {
  const missing = Array.from({ length: 4 }, (_, i) => ({
    sha: `${i}`.repeat(40),
    subject: `commit ${i}`,
    message: `commit ${i}`,
    htmlUrl: null,
  }));
  const ledger = formatLedger({
    repo: "example/paperclip",
    installVersion: "1.0.0",
    baseCommit: "a".repeat(40),
    baseMode: "stamp",
    targetRef: "master",
    targetCommit: "b".repeat(40),
    missing,
    limit: 2,
  });
  assert.match(ledger, /Drift: 4 commit\(s\)/);
  assert.match(ledger, /and 2 more/);
  assert.equal(ledger.includes("commit 3"), false);
});

test("exit codes are stable API", () => {
  assert.equal(EXIT_CLEAN, 0);
  assert.equal(EXIT_DRIFT, 1);
  assert.equal(EXIT_ENV_ERROR, 2);
  assert.equal(EXIT_CONTROL_FAILED, 3);
});
