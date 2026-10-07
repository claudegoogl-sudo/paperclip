import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  lstatSync,
  utimesSync,
  lutimesSync,
  existsSync,
  readdirSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONFIG,
  parseBackupTimestamp,
  classifyBackups,
  directoryHasFileNewerThan,
  collectFiles,
  classifyRunLogFiles,
  classifyWorktree,
  scanWorktreeCandidates,
  evaluateWorktree,
  isPathAncestorOf,
  scanTmpCandidates,
  evaluateTmpEntry,
  parseDfUsePercent,
  parseEmbeddedPostgresDataDir,
  parsePostmasterOpts,
  resolveDbCredential,
  loadRegisteredPackagePaths,
  findRegisteredOverlap,
  tmpUnmatchedExclusionReason,
  collectLiveProcessPaths,
  collectDockerMountSources,
  strictNewestLeafMtime,
  isEntryInUse,
  evaluateTmpUnmatched,
  scanOwnerDecisionPaths,
  fileDiskAlarmIssue,
  dailyBumpMarker,
  run as runRaw,
  loadReferencedPaths,
  extractPathsFromText,
  extractPathsFromUnit,
  parseKeepList,
  findReferenceOverlap,
} from "./host-disk-janitor.mjs";

function tmpdir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 2026-09-09 reap fix: run() consults the embedded Postgres for registered plugin install
// roots and FAILS CLOSED (deletes nothing in the worktree/tmp categories) when
// that lookup does not answer. Tests must be hermetic -- and a CI runner has
// no Postgres at all -- so every run() call in this file injects this stub
// instead of letting the real DB lookup run.
function testRegistered(paths = []) {
  return async () => ({ status: "ok", paths, source: "test" });
}

// 2026-10-03 reap fix: run() also reads live references (crontab, systemd
// user units, routines, agents). Same hermeticity rule: default to an empty
// "ok" stub; reference tests below pass a real sandboxed loader explicitly.
function testReferences(refs = []) {
  return async () => ({ status: "ok", refs, errors: [] });
}
function run(opts = {}) {
  return runRaw({ loadReferences: testReferences(), ...opts });
}

function touch(filePath, { mtime } = {}) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "x");
  if (mtime) utimesSync(filePath, mtime, mtime);
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// Backups: filename parsing + GFS rotation math
// ---------------------------------------------------------------------------

test("parseBackupTimestamp parses the canonical filename shape", () => {
  const ts = parseBackupTimestamp("paperclip-20260731-210804.sql.gz");
  assert.ok(ts);
  assert.equal(ts.toISOString(), "2026-07-31T21:08:04.000Z");
});

test("parseBackupTimestamp accepts uncompressed .sql and rejects unrecognized names", () => {
  assert.ok(parseBackupTimestamp("paperclip-20260731-210804.sql"));
  assert.equal(parseBackupTimestamp("readme.txt"), null);
  assert.equal(parseBackupTimestamp("paperclip-bad-name.sql"), null);
});

test("classifyBackups keeps at most 24 hourly + 7 daily + 4 weekly, prunes the rest", () => {
  // Build 74 hourly dumps counting back from now, matching the real
  // data/backups shape (74 files, no retention) described in the ticket.
  const entries = [];
  const start = Date.UTC(2026, 6, 31, 21, 8, 4); // 2026-07-31T21:08:04Z
  for (let i = 0; i < 74; i += 1) {
    const t = new Date(start - i * 60 * 60 * 1000);
    const name = `paperclip-${t.toISOString().slice(0, 10).replace(/-/g, "")}-${t
      .toISOString()
      .slice(11, 19)
      .replace(/:/g, "")}.sql.gz`;
    entries.push({ name, sizeBytes: 280_000_000 });
  }

  const { keep, prune, unrecognized } = classifyBackups(entries, CONFIG);
  assert.equal(unrecognized.length, 0);
  // 24 hourly are always kept. Since the fixture is hourly for 74 hours
  // (~3 days), the daily bucket picks up at most a handful of additional
  // distinct calendar days, and there aren't 4 distinct weeks in ~3 days of
  // history, so the weekly bucket contributes nothing extra here.
  assert.ok(keep.length >= 24);
  assert.ok(keep.length < entries.length, "must prune something out of 74 unretained hourly dumps");
  assert.equal(keep.length + prune.length, entries.length);
  // The newest 24 are always in the keep set.
  const keptNames = new Set(keep.map((e) => e.name));
  for (let i = 0; i < 24; i += 1) assert.ok(keptNames.has(entries[i].name), `hour -${i} should be kept`);
});

test("classifyBackups spans hourly/daily/weekly across a long history", () => {
  const entries = [];
  const start = Date.UTC(2026, 6, 31, 0, 0, 0);
  // One dump per day for 200 days -> exercises daily AND weekly buckets.
  for (let i = 0; i < 200; i += 1) {
    const t = new Date(start - i * 24 * 60 * 60 * 1000);
    const name = `paperclip-${t.toISOString().slice(0, 10).replace(/-/g, "")}-000000.sql.gz`;
    entries.push({ name, sizeBytes: 1000 });
  }
  const { keep, prune } = classifyBackups(entries, CONFIG);
  // 1/day means "hourly" bucket just grabs the newest 24 distinct days,
  // daily grabs the next 7 distinct days, weekly grabs up to 4 more distinct
  // ISO weeks beyond that -- so keep count is bounded well under the full
  // 200, proving real pruning happens over a long history.
  assert.ok(keep.length <= 24 + 7 + 4);
  assert.ok(prune.length > 0);
});

test("classifyBackups never drops unrecognized filenames (conservative default)", () => {
  const entries = [
    { name: "paperclip-20260731-210804.sql.gz", sizeBytes: 100 },
    { name: "some-other-file.txt", sizeBytes: 50 },
  ];
  const { prune, unrecognized } = classifyBackups(entries, CONFIG);
  assert.equal(unrecognized.length, 1);
  assert.equal(unrecognized[0].name, "some-other-file.txt");
  assert.ok(!prune.some((e) => e.name === "some-other-file.txt"));
});

test("classifyBackups excludes unverified archives from keep slots (AC7)", () => {
  // 74 hourly dumps, newest 24 are normally always kept. Mark the newest one
  // as unverified (ISIZE=0 / truncated) -- it must NOT take a keep slot, so
  // the 25th-newest gets promoted into the hourly keep set instead.
  const entries = [];
  const start = Date.UTC(2026, 6, 31, 21, 8, 4);
  for (let i = 0; i < 74; i += 1) {
    const t = new Date(start - i * 60 * 60 * 1000);
    const name = `paperclip-${t.toISOString().slice(0, 10).replace(/-/g, "")}-${t
      .toISOString()
      .slice(11, 19)
      .replace(/:/g, "")}.sql.gz`;
    entries.push({ name, sizeBytes: 280_000_000, verified: i !== 0 });
  }
  const { keep, unverified } = classifyBackups(entries, CONFIG);
  // The newest entry is unverified, so it must not occupy a keep slot.
  const newestName = entries[0].name;
  assert.ok(!keep.some((e) => e.name === newestName), "unverified archive must not be in keep");
  assert.ok(unverified.some((e) => e.name === newestName), "unverified archive must be surfaced");
  // run() deletes both `unverified` and `prune`, so unverified archives are
  // their own bucket (disjoint from prune) -- the keep-slot exclusion is the
  // load-bearing assertion for AC7.
  // Promoted: the 25th-newest would normally be pruned but here takes the
  // freed hourly slot, so keep still has the full complement.
  assert.ok(keep.length >= 24);
});

test("classifyBackups treats undefined `verified` as verified (purity default)", () => {
  // Synthetic test fixtures and callers that do not care about content checks
  // must keep working: omitting `verified` is the same as `verified: true`.
  const entries = [
    { name: "paperclip-20260731-210804.sql.gz", sizeBytes: 100 },
    { name: "paperclip-20260730-210804.sql.gz", sizeBytes: 100, verified: true },
    { name: "paperclip-20260729-210804.sql.gz", sizeBytes: 100, verified: false },
  ];
  const { keep, unverified } = classifyBackups(entries, CONFIG);
  const keepNames = new Set(keep.map((e) => e.name));
  assert.ok(keepNames.has("paperclip-20260731-210804.sql.gz"), "undefined verified keeps slot");
  assert.ok(keepNames.has("paperclip-20260730-210804.sql.gz"), "verified:true keeps slot");
  assert.ok(
    !keepNames.has("paperclip-20260729-210804.sql.gz"),
    "verified:false excluded from keep",
  );
  assert.equal(unverified.length, 1);
});

// ---------------------------------------------------------------------------
// Age helper: newest-inner-file, not top-level mtime
// ---------------------------------------------------------------------------

test("directoryHasFileNewerThan ignores top-level mtime and looks inside the tree", () => {
  const dir = tmpdir("janitor-age-");
  const oldTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  touch(path.join(dir, "nested", "old-file.txt"), { mtime: oldTime });
  // Simulate a host reboot resetting the top-level directory's own mtime to
  // "now" while the content inside remains old.
  utimesSync(dir, new Date(), new Date());

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  assert.equal(directoryHasFileNewerThan(dir, cutoff), false);

  touch(path.join(dir, "nested", "fresh-file.txt"));
  assert.equal(directoryHasFileNewerThan(dir, cutoff), true);
  rmSync(dir, { recursive: true, force: true });
});

test("directoryHasFileNewerThan treats a brand-new empty tree as recent, not vacuously old (blocker 1 regression)", () => {
  const dir = tmpdir("janitor-empty-fresh-");
  // Zero leaf files anywhere -- the exact shape of a directory mid `mkdir &&
  // git worktree add`, or an empty run-log/tmp dir created moments ago. A
  // realistic 30-day cutoff must NOT read this as "no evidence of recent
  // activity" -> "old enough to delete".
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  assert.equal(directoryHasFileNewerThan(dir, cutoff), true, "empty dir just created must count as recent");
  rmSync(dir, { recursive: true, force: true });
});

test("directoryHasFileNewerThan lets a genuinely old empty tree age out via ctime fallback", () => {
  const dir = tmpdir("janitor-empty-old-");
  // Can't backdate ctime directly (the OS manages it), so simulate the
  // passage of time by moving the cutoff into the future relative to this
  // directory's real (just-now) ctime instead.
  const cutoffInFuture = Date.now() + 5000;
  assert.equal(directoryHasFileNewerThan(dir, cutoffInFuture), false, "empty dir must still be prunable once its own ctime clears the cutoff");
  rmSync(dir, { recursive: true, force: true });
});

test("directoryHasFileNewerThan does not follow symlinked directories", () => {
  const dir = tmpdir("janitor-symlink-");
  const oldTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  touch(path.join(dir, "old.txt"), { mtime: oldTime });

  const outside = tmpdir("janitor-symlink-target-");
  touch(path.join(outside, "fresh.txt")); // fresh mtime, outside the tree

  const linkPath = path.join(dir, "link-to-outside");
  symlinkSync(outside, linkPath);
  // The symlink's own creation timestamp is "now" and legitimately fresh;
  // age it explicitly (without following it) so this test isolates what it
  // means to check: that the fresh file *inside the linked-to directory*
  // must not be traversed into and does not count.
  lutimesSync(linkPath, oldTime, oldTime);

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  assert.equal(directoryHasFileNewerThan(dir, cutoff), false, "must not traverse through the symlink");

  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// run-logs
// ---------------------------------------------------------------------------

test("classifyRunLogFiles splits on the age cutoff", () => {
  const now = Date.now();
  const files = [
    { path: "/a", mtimeMs: now - 40 * 24 * 60 * 60 * 1000 },
    { path: "/b", mtimeMs: now - 5 * 24 * 60 * 60 * 1000 },
  ];
  const { keep, prune } = classifyRunLogFiles(files, now, 30);
  assert.equal(prune.length, 1);
  assert.equal(prune[0].path, "/a");
  assert.equal(keep.length, 1);
  assert.equal(keep[0].path, "/b");
});

test("collectFiles recurses and skips nothing but directories themselves", () => {
  const dir = tmpdir("janitor-runlogs-");
  touch(path.join(dir, "company", "agent", "run.ndjson"));
  touch(path.join(dir, "company", "agent2", "run2.ndjson"));
  const files = collectFiles(dir);
  assert.equal(files.length, 2);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Worktree classification
// ---------------------------------------------------------------------------

function makeBareRemote() {
  const remoteDir = tmpdir("janitor-remote-");
  git(["init", "--bare", "-q"], remoteDir);
  return remoteDir;
}

function makeWorktreeRepo(remoteDir, { dirty = false, pushed = true } = {}) {
  const dir = tmpdir("janitor-worktree-");
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  touch(path.join(dir, "file.txt"));
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "initial"], dir);
  git(["remote", "add", "origin", remoteDir], dir);
  if (pushed) {
    git(["push", "-q", "origin", "main"], dir);
  }
  if (dirty) {
    writeFileSync(path.join(dir, "file.txt"), "changed");
  }
  return dir;
}

test("classifyWorktree: not-a-repo when there is no .git entry", () => {
  const dir = tmpdir("janitor-plain-");
  touch(path.join(dir, "some-extracted-file.txt"));
  assert.equal(classifyWorktree(dir), "not-a-repo");
  rmSync(dir, { recursive: true, force: true });
});

test("classifyWorktree: safe when clean and pushed to a remote", () => {
  const remote = makeBareRemote();
  const dir = makeWorktreeRepo(remote, { dirty: false, pushed: true });
  assert.equal(classifyWorktree(dir), "safe");
  rmSync(dir, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

test("classifyWorktree: review when there are tracked modifications", () => {
  const remote = makeBareRemote();
  const dir = makeWorktreeRepo(remote, { dirty: true, pushed: true });
  assert.equal(classifyWorktree(dir), "review");
  rmSync(dir, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

test("classifyWorktree: review when HEAD has stranded commits (never pushed)", () => {
  const remote = makeBareRemote();
  const dir = makeWorktreeRepo(remote, { dirty: false, pushed: false });
  assert.equal(classifyWorktree(dir), "review");
  rmSync(dir, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

test("classifyWorktree: untracked-only files do not count as tracked edits (matches spec's chosen test)", () => {
  const remote = makeBareRemote();
  const dir = makeWorktreeRepo(remote, { dirty: false, pushed: true });
  touch(path.join(dir, "untracked-scratch.txt"));
  assert.equal(classifyWorktree(dir), "safe");
  rmSync(dir, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

test("evaluateWorktree requires both safety AND age", () => {
  const remote = makeBareRemote();
  const dir = makeWorktreeRepo(remote, { dirty: false, pushed: true });
  const now = Date.now();

  // Freshly committed -> too young to be eligible even though it's "safe".
  const fresh = evaluateWorktree(dir, now, CONFIG);
  assert.equal(fresh.classification, "safe");
  assert.equal(fresh.isOldEnough, false);
  assert.equal(fresh.eligible, false);

  // Same repo, evaluated as if 40 days had passed -> now eligible.
  const future = now + 40 * 24 * 60 * 60 * 1000;
  const aged = evaluateWorktree(dir, future, CONFIG);
  assert.equal(aged.eligible, true);

  rmSync(dir, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

test("evaluateWorktree excludes a directory created moments ago even with zero files (blocker 1 regression: mkdir-before-worktree-add race)", () => {
  const workDir = tmpdir("janitor-race-");
  const racingDir = path.join(workDir, "plaNNNN");
  mkdirSync(racingDir); // no .git yet, no files yet -- mid `mkdir && git worktree add`
  const config = { ...CONFIG, WORKTREE_MAX_AGE_DAYS: 30 };
  const result = evaluateWorktree(racingDir, Date.now(), config);
  assert.equal(result.classification, "not-a-repo");
  assert.equal(result.isOldEnough, false, "an empty dir created just now must not read as 30 days old");
  assert.equal(result.eligible, false);
  rmSync(workDir, { recursive: true, force: true });
});

test("evaluateWorktree hard-excludes the janitor's own resolved directory regardless of age/classification", () => {
  const remote = makeBareRemote();
  const dir = makeWorktreeRepo(remote, { dirty: false, pushed: true });
  const selfPath = path.join(dir, "scripts", "host-disk-janitor.mjs");
  const config = { ...CONFIG, SELF_SCRIPT_PATH: selfPath };
  const future = Date.now() + 40 * 24 * 60 * 60 * 1000; // otherwise-eligible by age
  const result = evaluateWorktree(dir, future, config);
  assert.equal(result.classification, "safe");
  assert.equal(result.isOldEnough, true);
  assert.equal(result.isSelf, true);
  assert.equal(result.eligible, false, "must never delete the checkout the running script lives under");
  rmSync(dir, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

test("isPathAncestorOf", () => {
  assert.equal(isPathAncestorOf("/a/b", "/a/b/c.mjs"), true);
  assert.equal(isPathAncestorOf("/a/b", "/a/b/c/d.mjs"), true);
  assert.equal(isPathAncestorOf("/a/b", "/a/bc/d.mjs"), false);
  assert.equal(isPathAncestorOf("/a/b", "/a/b"), false);
  assert.equal(isPathAncestorOf("/a/b", "/a/other.mjs"), false);
});

test("scanWorktreeCandidates covers both ~/work/* and ~/pla*-style roots without duplicates", () => {
  const home = tmpdir("janitor-home-");
  const workDir = path.join(home, "work");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(path.join(workDir, "fb13-publish"));
  mkdirSync(path.join(home, "pla2004"));
  mkdirSync(path.join(home, "not-in-scope"));
  writeFileSync(path.join(home, "pla-file-not-a-dir.tgz"), "x");

  const config = {
    ...CONFIG,
    WORKTREE_SCAN_DIRS: [workDir],
    WORKTREE_HOME_GLOB_ROOT: home,
    WORKTREE_HOME_GLOB_PATTERNS: [/^pla\d/],
  };
  const candidates = scanWorktreeCandidates(config).sort();
  assert.deepEqual(candidates, [path.join(home, "pla2004"), path.join(workDir, "fb13-publish")].sort());
  rmSync(home, { recursive: true, force: true });
});

test("scanWorktreeCandidates does not over-match 'platform-*' / 'playwright-*' names sharing the 'pla' prefix in $HOME", () => {
  const home = tmpdir("janitor-home-glob-");
  mkdirSync(path.join(home, "pla2012"));
  mkdirSync(path.join(home, "platform-something"));
  mkdirSync(path.join(home, "playwright-cache"));

  const config = {
    ...CONFIG,
    WORKTREE_SCAN_DIRS: [path.join(home, "work-does-not-exist")],
    WORKTREE_HOME_GLOB_ROOT: home,
    WORKTREE_HOME_GLOB_PATTERNS: CONFIG.WORKTREE_HOME_GLOB_PATTERNS,
  };
  const candidates = scanWorktreeCandidates(config).map((p) => path.basename(p)).sort();
  assert.deepEqual(candidates, ["pla2012"]);

  // Even old and not-a-git-repo, the excluded names must never become
  // eligible -- they aren't candidates at all, so evaluateWorktree is never
  // even called on them in the real run() pipeline.
  const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  utimesSync(path.join(home, "platform-something"), oldTime, oldTime);
  utimesSync(path.join(home, "playwright-cache"), oldTime, oldTime);
  const candidatesAfterAging = scanWorktreeCandidates(config).map((p) => path.basename(p)).sort();
  assert.deepEqual(candidatesAfterAging, ["pla2012"]);

  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// /tmp scratch
// ---------------------------------------------------------------------------

test("scanTmpCandidates matches configured patterns only", () => {
  const dir = tmpdir("janitor-tmproot-");
  mkdirSync(path.join(dir, "pcvt-abc"));
  mkdirSync(path.join(dir, "pla1999"));
  mkdirSync(path.join(dir, "unrelated"));
  const config = { ...CONFIG, TMP_DIR: dir, TMP_SCRATCH_PATTERNS: [/^pcvt-/, /^pla\d/] };
  const candidates = scanTmpCandidates(config).map((p) => path.basename(p)).sort();
  assert.deepEqual(candidates, ["pcvt-abc", "pla1999"]);
  rmSync(dir, { recursive: true, force: true });
});

test("scanTmpCandidates does not over-match playwright scratch dirs sharing the 'pla' prefix (blocker 2 regression)", () => {
  const dir = tmpdir("janitor-tmproot-");
  mkdirSync(path.join(dir, "pla2008-runs"));
  mkdirSync(path.join(dir, "playwright-artifacts-x1y2"));
  mkdirSync(path.join(dir, "playwright_chromiumdev_profile-z9"));
  const config = { ...CONFIG, TMP_DIR: dir, TMP_SCRATCH_PATTERNS: CONFIG.TMP_SCRATCH_PATTERNS };
  const candidates = scanTmpCandidates(config).map((p) => path.basename(p)).sort();
  assert.deepEqual(candidates, ["pla2008-runs"]);
  rmSync(dir, { recursive: true, force: true });
});

test("evaluateTmpEntry respects the age cutoff", () => {
  const dir = tmpdir("janitor-tmpentry-");
  touch(path.join(dir, "old.txt"), { mtime: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) });
  const now = Date.now();
  assert.equal(evaluateTmpEntry(dir, now, CONFIG).eligible, true);
  touch(path.join(dir, "fresh.txt"));
  assert.equal(evaluateTmpEntry(dir, now, CONFIG).eligible, false);
  rmSync(dir, { recursive: true, force: true });
});

test("evaluateTmpEntry excludes an empty scratch dir created moments ago (blocker 1 regression)", () => {
  const dir = tmpdir("janitor-tmpentry-empty-");
  const emptyEntry = path.join(dir, "pla9003");
  mkdirSync(emptyEntry);
  const now = Date.now();
  assert.equal(evaluateTmpEntry(emptyEntry, now, CONFIG).eligible, false);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// df parsing
// ---------------------------------------------------------------------------

test("parseDfUsePercent reads the Use% column from df -kP output", () => {
  const sample = "Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/sda1      202080820 181677312   9977284       92% /\n";
  assert.equal(parseDfUsePercent(sample), 92);
});

// ---------------------------------------------------------------------------
// End-to-end: run() against an isolated sandbox, dry-run vs apply,
// and apply-twice idempotency (AC4).
// ---------------------------------------------------------------------------

// Test-only lstat: dirs contribute nothing and ctime reads as mtime, so
// fixtures aged with utimes behave as "old" under the real age signal.
function leafOnlyLstat(p) {
  const st = lstatSync(p);
  const out = Object.assign(Object.create(Object.getPrototypeOf(st)), st);
  if (st.isDirectory()) Object.assign(out, { mtimeMs: 0, ctimeMs: 0 });
  else out.ctimeMs = st.mtimeMs;
  return out;
}

function buildSandbox() {
  const home = tmpdir("janitor-sandbox-");
  const backupsDir = path.join(home, "backups");
  const runLogsDir = path.join(home, "run-logs");
  const workDir = path.join(home, "work");
  const tmpDir = path.join(home, "tmpscratch");
  mkdirSync(backupsDir, { recursive: true });
  mkdirSync(runLogsDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  // 30 hourly backups -- only the newest 24 should survive.
  const start = Date.UTC(2026, 6, 31, 12, 0, 0);
  for (let i = 0; i < 30; i += 1) {
    const t = new Date(start - i * 60 * 60 * 1000);
    const name = `paperclip-${t.toISOString().slice(0, 10).replace(/-/g, "")}-${t
      .toISOString()
      .slice(11, 19)
      .replace(/:/g, "")}.sql.gz`;
    writeFileSync(path.join(backupsDir, name), "x".repeat(10));
  }

  // run-logs: one old, one fresh.
  touch(path.join(runLogsDir, "company", "agent", "old-run.ndjson"), {
    mtime: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
  });
  touch(path.join(runLogsDir, "company", "agent", "fresh-run.ndjson"));

  // worktrees: one stale+not-a-repo (deletable), one stale+safe git repo
  // (deletable), one fresh safe git repo (must survive -- regression guard
  // for the 17 live 2026-07-31 worktrees in the real audit).
  const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  touch(path.join(workDir, "derived-extract", "some-file.txt"), { mtime: oldTime });

  const staleRemote = makeBareRemote();
  const staleRepo = path.join(workDir, "stale-safe-repo");
  mkdirSync(staleRepo);
  git(["init", "-q", "-b", "main"], staleRepo);
  git(["config", "user.email", "test@example.com"], staleRepo);
  git(["config", "user.name", "Test"], staleRepo);
  writeFileSync(path.join(staleRepo, "f.txt"), "x");
  git(["add", "."], staleRepo);
  git(["commit", "-q", "-m", "c"], staleRepo);
  git(["remote", "add", "origin", staleRemote], staleRepo);
  git(["push", "-q", "origin", "main"], staleRepo);
  utimesSync(path.join(staleRepo, "f.txt"), oldTime, oldTime);

  const liveRemote = makeBareRemote();
  const liveRepo = path.join(workDir, "live-2026-07-31-repo");
  mkdirSync(liveRepo);
  git(["init", "-q", "-b", "main"], liveRepo);
  git(["config", "user.email", "test@example.com"], liveRepo);
  git(["config", "user.name", "Test"], liveRepo);
  writeFileSync(path.join(liveRepo, "f.txt"), "x");
  git(["add", "."], liveRepo);
  git(["commit", "-q", "-m", "c"], liveRepo);
  git(["remote", "add", "origin", liveRemote], liveRepo);
  git(["push", "-q", "origin", "main"], liveRepo);
  // Freshly touched -- must NOT be deleted.

  // tmp scratch: one old pla* dir, one fresh.
  touch(path.join(tmpDir, "pla9001", "scratch.txt"), { mtime: oldTime });
  touch(path.join(tmpDir, "pla9002", "scratch.txt"));

  const config = {
    ...CONFIG,
    BACKUPS_DIR: backupsDir,
    RUN_LOGS_DIR: runLogsDir,
    WORKTREE_SCAN_DIRS: [workDir],
    WORKTREE_HOME_GLOB_ROOT: home,
    WORKTREE_HOME_GLOB_PATTERNS: [],
    // Points at a nonexistent dir so pruneWorktreeRegistrations() is a
    // no-op here -- these generic tests don't model a shared object store,
    // and must never touch the real one the janitor targets on the host.
    WORKTREE_OBJECT_STORE_DIR: path.join(home, "no-such-object-store"),
    TMP_DIR: tmpDir,
    TMP_SCRATCH_PATTERNS: [/^pla/],
    STATE_DIR: path.join(home, "state"),
    DISK_ALARM_PATH: "/",
    // Deliberately points at a nonexistent file so readApiCredential() can
    // never find a real credential. The real host this suite runs on can be
    // at or above the alarm threshold at any given time (it was at 92% when
    // this was written) -- without this, an --apply sandbox test would read
    // the operator's actual ~/.paperclip/auth.json and file a real
    // production issue purely as a side effect of the disk being full,
    // which is exactly the kind of blast radius this janitor must not have.
    PAPERCLIP_AUTH_JSON_PATH: path.join(home, "no-such-auth.json"),
    SELF_SCRIPT_PATH: path.join(home, "__self_not_under_any_candidate__", "host-disk-janitor.mjs"),
    // Report-only owner-decision scan must never walk the real $HOME in tests.
    OWNER_DECISION_GLOBS: [],
    OWNER_DECISION_PATHS: [],
    // Fixtures can only age leaf mtimes (ctime is not settable); never shell out to docker.
    TMP_AGE_LSTAT: leafOnlyLstat,
    DOCKER_MOUNTS: () => ({ ok: true, paths: new Set() }),
  };
  return { home, remotes: [staleRemote, liveRemote], config };
}

test("run() dry-run reports correct candidates without touching disk", async () => {
  const { home, remotes, config } = buildSandbox();
  const before = {
    backups: readdirSync(config.BACKUPS_DIR).length,
    worktrees: readdirSync(path.join(home, "work")).length,
  };

  const summary = await run({ apply: false, config, loadRegistered: testRegistered() });

  assert.equal(summary.categories.backups.totalFiles, 30);
  // 24 kept by the hourly bucket, +1 by daily (newest of the single
  // remaining calendar day), +1 by weekly (newest of the single remaining
  // ISO week not already covered) = 26 kept, 4 pruned.
  assert.equal(summary.categories.backups.prunedFiles, 4);
  assert.equal(summary.categories.runLogs.prunedFiles, 1);
  assert.equal(summary.categories.worktrees.eligible, 2); // derived-extract + stale-safe-repo
  assert.ok(!summary.categories.worktrees.eligiblePaths.some((p) => p.includes("live-2026-07-31-repo")));
  assert.equal(summary.categories.tmpScratch.eligible, 1);

  // Dry-run must not have deleted anything.
  assert.equal(readdirSync(config.BACKUPS_DIR).length, before.backups);
  assert.equal(readdirSync(path.join(home, "work")).length, before.worktrees);

  rmSync(home, { recursive: true, force: true });
  for (const remote of remotes) rmSync(remote, { recursive: true, force: true });
});

test("run() --apply deletes eligible items and excludes live/dirty ones (AC3 regression guard)", async () => {
  const { home, remotes, config } = buildSandbox();
  const summary = await run({ apply: true, config, loadRegistered: testRegistered() });

  assert.equal(summary.categories.backups.prunedFiles, 4);
  assert.equal(readdirSync(config.BACKUPS_DIR).length, 26);

  const remainingWork = readdirSync(path.join(home, "work"));
  assert.ok(!remainingWork.includes("derived-extract"));
  assert.ok(!remainingWork.includes("stale-safe-repo"));
  assert.ok(remainingWork.includes("live-2026-07-31-repo"), "must not delete a fresh, live worktree");

  assert.ok(!existsSync(path.join(config.TMP_DIR, "pla9001")));
  assert.ok(existsSync(path.join(config.TMP_DIR, "pla9002")));

  rmSync(home, { recursive: true, force: true });
  for (const remote of remotes) rmSync(remote, { recursive: true, force: true });
});

test("run() --apply twice in a row is a no-op the second time (AC4 idempotency)", async () => {
  const { home, remotes, config } = buildSandbox();
  const first = await run({ apply: true, config, loadRegistered: testRegistered() });
  assert.ok(first.categories.backups.prunedFiles > 0);

  const second = await run({ apply: true, config, loadRegistered: testRegistered() });
  assert.equal(second.categories.backups.prunedFiles, 0);
  assert.equal(second.categories.runLogs.prunedFiles, 0);
  assert.equal(second.categories.worktrees.eligible, 0);
  assert.equal(second.categories.tmpScratch.eligible, 0);

  rmSync(home, { recursive: true, force: true });
  for (const remote of remotes) rmSync(remote, { recursive: true, force: true });
});

test("run() --apply prunes stale git-worktree registrations after deleting eligible worktree dirs (blocker 3 regression)", async () => {
  const home = tmpdir("janitor-wtprune-");
  const mainRepo = path.join(home, "main-repo");
  mkdirSync(mainRepo);
  git(["init", "-q", "-b", "main"], mainRepo);
  git(["config", "user.email", "test@example.com"], mainRepo);
  git(["config", "user.name", "Test"], mainRepo);
  writeFileSync(path.join(mainRepo, "f.txt"), "x");
  git(["add", "."], mainRepo);
  git(["commit", "-q", "-m", "c"], mainRepo);
  const remote = makeBareRemote();
  git(["remote", "add", "origin", remote], mainRepo);
  git(["push", "-q", "origin", "main"], mainRepo);

  const workDir = path.join(home, "work");
  mkdirSync(workDir, { recursive: true });
  const wtPath = path.join(workDir, "stale-worktree");
  git(["worktree", "add", "-q", "-b", "stale-branch", wtPath], mainRepo);
  git(["push", "-q", "origin", "stale-branch"], wtPath);
  const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  utimesSync(path.join(wtPath, "f.txt"), oldTime, oldTime);

  assert.ok(existsSync(path.join(mainRepo, ".git", "worktrees", "stale-worktree")), "sanity: worktree registered");

  const config = {
    ...CONFIG,
    BACKUPS_DIR: path.join(home, "backups-unused"),
    RUN_LOGS_DIR: path.join(home, "run-logs-unused"),
    WORKTREE_SCAN_DIRS: [workDir],
    WORKTREE_HOME_GLOB_ROOT: home,
    WORKTREE_HOME_GLOB_PATTERNS: [],
    WORKTREE_OBJECT_STORE_DIR: mainRepo,
    TMP_DIR: path.join(home, "tmp-unused"),
    TMP_SCRATCH_PATTERNS: [],
    STATE_DIR: path.join(home, "state"),
    PAPERCLIP_AUTH_JSON_PATH: path.join(home, "no-such-auth.json"),
    SELF_SCRIPT_PATH: path.join(home, "__self_not_under_any_candidate__", "host-disk-janitor.mjs"),
  };

  assert.equal(evaluateWorktree(wtPath, Date.now(), config).eligible, true, "sanity: stale worktree is eligible");

  const summary = await run({ apply: true, config, loadRegistered: testRegistered() });

  assert.ok(!existsSync(wtPath), "stale worktree directory must be deleted");
  assert.ok(
    !existsSync(path.join(mainRepo, ".git", "worktrees", "stale-worktree")),
    "git worktree prune must clear the now-dangling registration",
  );
  assert.ok(summary.categories.worktrees.registrationPrune, "run() must report the registration-prune outcome");
  assert.equal(summary.categories.worktrees.registrationPrune.pruned, 1);

  rmSync(home, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

test("run() dry-run alarm never makes a network call even when threshold is exceeded", async () => {
  const { home, remotes, config } = buildSandbox();
  const alarmConfig = { ...config, DISK_ALARM_THRESHOLD_PCT: 0 }; // guaranteed to alarm
  const summary = await run({ apply: false, config: alarmConfig, loadRegistered: testRegistered() });
  assert.equal(summary.diskAlarm.alarmed, true);
  assert.equal(summary.diskAlarm.wouldFileIssue, true);
  assert.equal(summary.diskAlarm.action, null);
  rmSync(home, { recursive: true, force: true });
  for (const remote of remotes) rmSync(remote, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 2026-09-09 reap fix: DB-registered plugin package paths are never deletion-eligible
// ---------------------------------------------------------------------------

test("parseEmbeddedPostgresDataDir prefers the instance data dir over unrelated postgres processes", () => {
  const psText = [
    "  123 /usr/lib/postgresql/15/bin/postgres -D /var/lib/postgresql/15/main -p 5432",
    "  456 /work/pg18-tools/bin/postgres -D /tmp/sync8241-staging/pgdata -p 55432 -c listen_addresses=127.0.0.1",
    "  789 @embedded-postgres/native/bin/postgres -D /home/op/.paperclip/instances/default/db -p 54329 -c listen_addresses=",
  ].join("\n");
  assert.equal(parseEmbeddedPostgresDataDir(psText), "/home/op/.paperclip/instances/default/db");
  assert.equal(parseEmbeddedPostgresDataDir("no postgres here"), null);
});

test("parsePostmasterOpts tolerates the per-argument quoting postmaster.opts uses", () => {
  const opts = '"-p" "54329" "-c" "unix_socket_directories=/tmp/paperclip-pg-abc" "-c" "listen_addresses="';
  const parsed = parsePostmasterOpts(opts);
  assert.equal(parsed.port, 54329);
  assert.equal(parsed.socketDir, "/tmp/paperclip-pg-abc");
});

test("resolveDbCredential reads a 0600 credential file and refuses looser modes (value never logged)", () => {
  const io = {
    exists: () => true,
    mode: (p) => (p.startsWith("/good") ? 0o600 : 0o644),
    read: () => "secret-value-must-never-be-printed",
  };
  assert.deepEqual(
    { source: resolveDbCredential({ env: {}, dataDir: "/good/db", io }).source },
    { source: "credfile" },
  );
  assert.throws(() => resolveDbCredential({ env: {}, dataDir: "/bad/db", io }), /expected 600/);
  assert.throws(() => resolveDbCredential({ env: {}, dataDir: null, io }), /data dir/);
});

test("findRegisteredOverlap matches equal, candidate-inside-root, and root-inside-candidate", () => {
  const roots = ["/live/tree", "/other/root"];
  assert.equal(findRegisteredOverlap("/live/tree", roots), "/live/tree"); // equal
  assert.equal(findRegisteredOverlap("/live/tree/sub/dir", roots), "/live/tree"); // candidate inside root
  assert.equal(findRegisteredOverlap("/live", roots), "/live/tree"); // root inside candidate
  assert.equal(findRegisteredOverlap("/unrelated/path", roots), null);
  assert.equal(findRegisteredOverlap("/unrelated/path", []), null);
  assert.equal(findRegisteredOverlap("/live/./tree", roots), "/live/tree"); // normalization
});

test("evaluateWorktree never makes a registered plain-copy install eligible (2026-09-09 reap regression)", () => {
  const home = tmpdir("janitor-registered-");
  const work = path.join(home, "work");
  const deployTree = path.join(work, "deploy-tree");
  mkdirSync(deployTree, { recursive: true });
  // A plain-copy install: no .git, every file 60 days old -> old not-a-repo,
  // which is exactly the shape the janitor reaped on 2026-09-09.
  writeFileSync(path.join(deployTree, "index.js"), "old");
  const oldTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  utimesSync(path.join(deployTree, "index.js"), oldTime, oldTime);
  const config = {
    ...CONFIG,
    SELF_SCRIPT_PATH: path.join(home, "elsewhere", "host-disk-janitor.mjs"),
  };

  const withoutDb = evaluateWorktree(deployTree, Date.now(), config, []);
  assert.equal(withoutDb.eligible, true, "sanity: without the registry the old not-a-repo dir is eligible");

  const withDb = evaluateWorktree(deployTree, Date.now(), config, [deployTree]);
  assert.equal(withDb.eligible, false, "registered root must never be eligible");
  assert.equal(withDb.registeredRoot, deployTree);
  assert.equal(withDb.classification, "not-a-repo");
  assert.equal(withDb.isOldEnough, true, "exclusion must not depend on age");

  rmSync(home, { recursive: true, force: true });
});

test("evaluateTmpEntry applies the same registered-path guard", () => {
  const home = tmpdir("janitor-tmpreg-");
  const scratch = path.join(home, "pla9001");
  mkdirSync(scratch, { recursive: true });
  writeFileSync(path.join(scratch, "f.txt"), "x");
  const oldTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  utimesSync(path.join(scratch, "f.txt"), oldTime, oldTime);
  const config = { ...CONFIG };
  assert.equal(evaluateTmpEntry(scratch, Date.now(), config, [scratch]).eligible, false);
  assert.equal(evaluateTmpEntry(scratch, Date.now(), config, []).eligible, true);
  rmSync(home, { recursive: true, force: true });
});

test("loadRegisteredPackagePaths JSON override dedupes and resolves; malformed override fails unavailable", async () => {
  const ok = await loadRegisteredPackagePaths({
    config: { ...CONFIG, REGISTERED_PATHS_JSON_OVERRIDE: '["/a/b", "/a/b/"]' },
  });
  assert.equal(ok.status, "ok");
  assert.equal(ok.source, "json-override");
  assert.deepEqual(ok.paths, ["/a/b"]);

  const bad = await loadRegisteredPackagePaths({
    config: { ...CONFIG, REGISTERED_PATHS_JSON_OVERRIDE: '{"not":"an array"}' },
  });
  assert.equal(bad.status, "unavailable");
  assert.match(bad.error, /not a JSON array/);
});

test("run() fails CLOSED when the registered-path lookup is unavailable (registry-outage fail-safe)", async () => {
  const { home, remotes, config } = buildSandbox();
  const summary = await run({
    apply: false,
    config,
    loadRegistered: async () => ({ status: "unavailable", paths: [], source: "db", error: "injected outage" }),
  });
  assert.equal(summary.registeredPackagePaths.status, "unavailable");
  assert.equal(summary.categories.worktrees.eligible, 0, "no worktree may be deleted while the registry is unreachable");
  assert.equal(summary.categories.worktrees.eligibleBeforeRegisteredGuard, 2);
  assert.equal(summary.categories.worktrees.guardFailureExcludedPaths.length, 2);
  assert.equal(summary.categories.tmpScratch.eligible, 0);
  assert.equal(summary.categories.tmpScratch.guardFailureExcludedPaths.length, 1);
  rmSync(home, { recursive: true, force: true });
  for (const remote of remotes) rmSync(remote, { recursive: true, force: true });
});

test("run() excludes a registered candidate and reports the exclusion with its root", async () => {
  const { home, remotes, config } = buildSandbox();
  const registeredRoot = path.join(config.WORKTREE_SCAN_DIRS[0], "derived-extract");
  const summary = await run({
    apply: false,
    config,
    loadRegistered: testRegistered([registeredRoot]),
  });
  assert.equal(summary.registeredPackagePaths.count, 1);
  assert.equal(summary.categories.worktrees.eligible, 1); // only stale-safe-repo remains
  assert.equal(summary.categories.worktrees.excludedRegistered.length, 1);
  assert.deepEqual(
    summary.categories.worktrees.excludedRegistered[0],
    { path: registeredRoot, registeredRoot },
  );
  assert.ok(
    !summary.categories.worktrees.eligiblePaths.includes(registeredRoot),
    "registered candidate must not appear among deletion candidates",
  );
  rmSync(home, { recursive: true, force: true });
  for (const remote of remotes) rmSync(remote, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// /tmp unmatched category (any name, agent uid, >= TMP_UNMATCHED_MAX_AGE_DAYS)
// ---------------------------------------------------------------------------

const UID = process.getuid();
const OLD = new Date(Date.now() - 40 * 24 * 3600 * 1000);

function unmatchedConfig(tmpDir, extra = {}) {
  return { ...CONFIG, TMP_DIR: tmpDir, TMP_OWNER_UID: UID, TMP_UNMATCHED_MAX_AGE_DAYS: 14, TMP_AGE_LSTAT: leafOnlyLstat, DOCKER_MOUNTS: () => ({ ok: true, paths: new Set() }), ...extra };
}

test("tmpUnmatchedExclusionReason: protected names, special files, foreign owner fail closed", () => {
  const cfg = { ...CONFIG, TMP_OWNER_UID: 1000 };
  const ok = (name, kind = "dir", uid = 1000) => tmpUnmatchedExclusionReason({ name, kind, uid }, cfg);
  assert.equal(ok("f53rb"), null);
  assert.equal(ok("sync8241-staging"), null);
  assert.equal(ok("notes.json", "file"), null);
  assert.equal(ok("paperclip-pg-abc"), "protected-name");
  assert.equal(ok("systemd-private-xyz-llama.service-1"), "protected-name");
  assert.equal(ok(".X11-unix"), "protected-name");
  assert.equal(ok(".ICE-unix"), "protected-name");
  assert.equal(ok(".hidden-anything"), "protected-name");
  assert.equal(ok("tmux-1000"), "protected-name");
  assert.equal(ok("some.sock", "socket"), "special-file:socket");
  assert.equal(ok("pipe", "fifo"), "special-file:fifo");
  assert.equal(ok("link", "symlink"), "special-file:symlink");
  assert.equal(ok("rootdir", "dir", 0), "foreign-owner");
  assert.equal(ok("pla7777"), "pattern-category"); // owned by the 30-day pattern rule
});

test("evaluateTmpUnmatched: old uid-owned any-name entries are candidates; fresh, protected, socket, registered are not", async () => {
  const dir = tmpdir("janitor-unmatched-");
  touch(path.join(dir, "f53rb", "deep", "a.bin"), { mtime: OLD });
  touch(path.join(dir, "old-file.json"), { mtime: OLD });
  touch(path.join(dir, "fresh-dir", "x"));
  touch(path.join(dir, "mixed", "old"), { mtime: OLD });
  touch(path.join(dir, "mixed", "new")); // one fresh leaf keeps the whole entry
  touch(path.join(dir, "paperclip-pg-1", "x"), { mtime: OLD });
  touch(path.join(dir, "tmux-1000", "x"), { mtime: OLD });
  touch(path.join(dir, ".X11-unix", "x"), { mtime: OLD });
  touch(path.join(dir, "registered-plugin", "x"), { mtime: OLD });
  const sockPath = path.join(dir, "live.sock");
  const server = net.createServer();
  await new Promise((r) => server.listen(sockPath, r));
  try {
    const live = { ok: true, paths: new Set() };
    const res = evaluateTmpUnmatched(Date.now(), unmatchedConfig(dir), {
      live,
      registeredPaths: [path.join(dir, "registered-plugin")],
    });
    const cands = res.candidates.map((c) => path.basename(c.path)).sort();
    assert.deepEqual(cands, ["f53rb", "old-file.json"]);
    const reasons = Object.fromEntries(res.excluded.map((e) => [path.basename(e.path), e.reason]));
    assert.equal(reasons["paperclip-pg-1"], "protected-name");
    assert.equal(reasons["tmux-1000"], "protected-name");
    assert.equal(reasons[".X11-unix"], "protected-name");
    assert.equal(reasons["live.sock"], "special-file:socket");
    assert.equal(reasons["registered-plugin"], "registered-package-path");
  } finally {
    server.close();
  }
});

test("evaluateTmpUnmatched: entry that is a live cwd or holds an open fd is excluded", () => {
  const dir = tmpdir("janitor-unmatched-live-");
  touch(path.join(dir, "cwd-of-proc", "x"), { mtime: OLD });
  touch(path.join(dir, "fd-holder", "sub", "db.sqlite"), { mtime: OLD });
  touch(path.join(dir, "idle", "x"), { mtime: OLD });
  const live = {
    ok: true,
    paths: new Set([path.join(dir, "cwd-of-proc"), path.join(dir, "fd-holder", "sub", "db.sqlite")]),
  };
  const res = evaluateTmpUnmatched(Date.now(), unmatchedConfig(dir), { live });
  assert.deepEqual(res.candidates.map((c) => path.basename(c.path)), ["idle"]);
  assert.equal(res.excluded.filter((e) => e.reason === "in-use-by-live-process").length, 2);
});

test("evaluateTmpUnmatched: failed /proc scan keeps everything (fail closed)", () => {
  const dir = tmpdir("janitor-unmatched-procfail-");
  touch(path.join(dir, "idle", "x"), { mtime: OLD });
  const res = evaluateTmpUnmatched(Date.now(), unmatchedConfig(dir), { live: { ok: false, paths: new Set() } });
  assert.equal(res.candidates.length, 0);
  assert.equal(res.excluded[0].reason, "live-process-scan-failed");
  // and collectLiveProcessPaths itself reports !ok on an unreadable proc dir
  assert.equal(collectLiveProcessPaths(path.join(dir, "no-such-proc")).ok, false);
  // an empty proc dir (no readable cwd at all) is also a failure, not "no users"
  const emptyProc = tmpdir("janitor-emptyproc-");
  assert.equal(collectLiveProcessPaths(emptyProc).ok, false);
});

test("collectLiveProcessPaths sees this test process's own cwd and open fds", () => {
  const live = collectLiveProcessPaths("/proc");
  assert.equal(live.ok, true);
  assert.ok(live.paths.has(process.cwd()));
  assert.equal(isEntryInUse(path.dirname(process.cwd()), live.paths), true);
});

test("run(): unmatched category is report-only unless TMP_UNMATCHED_DELETE is on; deletes when on; idempotent", async () => {
  const { config } = buildSandbox();
  touch(path.join(config.TMP_DIR, "free-form-scratch", "x"), { mtime: OLD });
  const cfg = { ...config, TMP_OWNER_UID: UID, TMP_SCRATCH_PATTERNS: [/^pla/] };
  const gated = await run({ apply: true, config: { ...cfg, TMP_UNMATCHED_DELETE: false }, loadRegistered: testRegistered() });
  assert.equal(gated.categories.tmpUnmatched.deleted, false);
  assert.ok(gated.categories.tmpUnmatched.candidates.some((c) => c.path.endsWith("free-form-scratch")));
  assert.ok(existsSync(path.join(config.TMP_DIR, "free-form-scratch")));
  const on = await run({ apply: true, config: { ...cfg, TMP_UNMATCHED_DELETE: true }, loadRegistered: testRegistered() });
  assert.equal(on.categories.tmpUnmatched.deleted, true);
  assert.ok(!existsSync(path.join(config.TMP_DIR, "free-form-scratch")));
  const again = await run({ apply: true, config: { ...cfg, TMP_UNMATCHED_DELETE: true }, loadRegistered: testRegistered() });
  assert.ok(!again.categories.tmpUnmatched.candidates.some((c) => c.path.endsWith("free-form-scratch")));
});

test("run(): unmatched category fails closed when the registered-path lookup is unavailable", async () => {
  const { config } = buildSandbox();
  touch(path.join(config.TMP_DIR, "free-form-scratch", "x"), { mtime: OLD });
  const summary = await run({
    apply: true,
    config: { ...config, TMP_OWNER_UID: UID, TMP_UNMATCHED_DELETE: true },
    loadRegistered: async () => ({ status: "unavailable", paths: [], source: "test", error: "down" }),
  });
  assert.equal(summary.categories.tmpUnmatched.eligible, 0);
  assert.ok(existsSync(path.join(config.TMP_DIR, "free-form-scratch")));
});

test("scanOwnerDecisionPaths lists but never deletes", () => {
  const home = tmpdir("janitor-owner-");
  touch(path.join(home, ".pap1886-build", "big"), { mtime: OLD });
  touch(path.join(home, "hist.sqlite"));
  const cfg = {
    ...CONFIG,
    OWNER_DECISION_GLOBS: [{ dir: home, pattern: /^\.pap18/ }],
    OWNER_DECISION_PATHS: [path.join(home, "hist.sqlite"), path.join(home, "missing")],
  };
  const out = scanOwnerDecisionPaths(cfg).map((e) => path.basename(e.path));
  assert.deepEqual(out, [".pap1886-build", "hist.sqlite"]);
  assert.ok(existsSync(path.join(home, ".pap1886-build", "big")));
});

// ---------------------------------------------------------------------------
// Disk alarm wakes an owner
// ---------------------------------------------------------------------------

function fakeFetch({ open = [], comments = [] } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined });
    const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });
    if (method === "GET" && url.includes("/companies/")) return json(open);
    if (method === "GET" && url.endsWith("/comments")) return json(comments);
    if (method === "POST" && url.includes("/companies/")) return json({ id: "new-id", identifier: "ALARM-2" }, 201);
    return json({}, 200);
  };
  return { impl, calls };
}

const CRED = { apiBase: "http://api.test", token: "t" };
const ALARM_CFG = { ...CONFIG, DISK_ALARM_ASSIGNEE_AGENT_ID: "cto-agent" };
const NOW = Date.parse("2026-09-28T02:00:00Z");

test("fileDiskAlarmIssue: create assigns the owner with status todo", async () => {
  const f = fakeFetch();
  const r = await fileDiskAlarmIssue({ usePercent: 91, threshold: 85, companyId: "c", credential: CRED, nowMs: NOW, config: ALARM_CFG, fetchImpl: f.impl });
  assert.equal(r.created, true);
  const post = f.calls.find((c) => c.method === "POST");
  assert.equal(post.body.assigneeAgentId, "cto-agent");
  assert.equal(post.body.status, "todo");
});

test("fileDiskAlarmIssue: dedup hit on unassigned backlog alarm reassigns to owner + todo and posts the daily bump", async () => {
  const f = fakeFetch({ open: [{ id: "a1", identifier: "ALARM-1", title: "[host-disk-alarm] x", status: "backlog", assigneeAgentId: null }] });
  const r = await fileDiskAlarmIssue({ usePercent: 91, threshold: 85, companyId: "c", credential: CRED, nowMs: NOW, config: ALARM_CFG, fetchImpl: f.impl });
  assert.equal(r.created, false);
  assert.equal(r.reassigned, true);
  assert.equal(r.commented, true);
  const patch = f.calls.find((c) => c.method === "PATCH");
  assert.deepEqual(patch.body, { assigneeAgentId: "cto-agent", status: "todo" });
  const post = f.calls.find((c) => c.method === "POST");
  assert.match(post.body.body, /91%/);
  assert.ok(post.body.body.includes(dailyBumpMarker(NOW)));
  assert.equal(f.calls.filter((c) => c.method === "POST" && c.url.includes("/companies/")).length, 0);
});

test("fileDiskAlarmIssue: keeps an existing assignee, bumps a backlog one to todo", async () => {
  const f = fakeFetch({ open: [{ id: "a1", title: "[host-disk-alarm] x", status: "backlog", assigneeAgentId: "someone" }] });
  await fileDiskAlarmIssue({ usePercent: 90, threshold: 85, companyId: "c", credential: CRED, nowMs: NOW, config: ALARM_CFG, fetchImpl: f.impl });
  assert.deepEqual(f.calls.find((c) => c.method === "PATCH").body, { assigneeAgentId: "someone", status: "todo" });
});

test("fileDiskAlarmIssue: at most one comment per UTC day; no reassign when already owned + active", async () => {
  const open = [{ id: "a1", title: "[host-disk-alarm] x", status: "todo", assigneeAgentId: "cto-agent" }];
  const same = fakeFetch({ open, comments: [{ body: `earlier\n${dailyBumpMarker(NOW - 3600 * 1000)}` }] });
  const r1 = await fileDiskAlarmIssue({ usePercent: 91, threshold: 85, companyId: "c", credential: CRED, nowMs: NOW, config: ALARM_CFG, fetchImpl: same.impl });
  assert.equal(r1.commented, false);
  assert.equal(r1.reassigned, false);
  assert.equal(same.calls.filter((c) => c.method !== "GET").length, 0);
  const nextDay = fakeFetch({ open, comments: [{ body: dailyBumpMarker(NOW - 86400 * 1000) }] });
  const r2 = await fileDiskAlarmIssue({ usePercent: 92, threshold: 85, companyId: "c", credential: CRED, nowMs: NOW, config: ALARM_CFG, fetchImpl: nextDay.impl });
  assert.equal(r2.commented, true);
});

test("fileDiskAlarmIssue: unreadable comments => no comment (never spam on a flaky read)", async () => {
  const open = [{ id: "a1", title: "[host-disk-alarm] x", status: "todo", assigneeAgentId: "cto-agent" }];
  const f = fakeFetch({ open });
  const impl = async (url, init = {}) =>
    url.endsWith("/comments") && !init.method ? { ok: false, status: 500, json: async () => ({}) } : f.impl(url, init);
  const r = await fileDiskAlarmIssue({ usePercent: 91, threshold: 85, companyId: "c", credential: CRED, nowMs: NOW, config: ALARM_CFG, fetchImpl: impl });
  assert.equal(r.commented, false);
  assert.match(r.commentError, /skipped/);
});

test("addendum: /proc/*/maps paths count as live-process use", () => {
  const proc = mkdtempSync(path.join(os.tmpdir(), "jan-proc-"));
  mkdirSync(path.join(proc, "42"));
  symlinkSync("/", path.join(proc, "42", "cwd"));
  writeFileSync(path.join(proc, "42", "maps"), "7f00-7f01 r-xp 0 08:01 9 /tmp/scratchX/lib/addon.node\n7f02-7f03 rw-p 0 0 0 [heap]\n");
  const live = collectLiveProcessPaths(proc);
  assert.equal(live.ok, true);
  assert.ok(live.paths.has("/tmp/scratchX/lib/addon.node"));
});

test("addendum: strict age walk fails closed on unreadable subdir and uses newest-inside mtime", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jan-age-"));
  const f = path.join(root, "a.txt");
  writeFileSync(f, "x");
  const old = new Date(Date.now() - 40 * 86400000);
  utimesSync(f, old, old);
  const r = strictNewestLeafMtime(root, leafOnlyLstat);
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.newestMtimeMs - old.getTime()) < 2000);
  if (process.getuid() !== 0) {
    const locked = path.join(root, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try { assert.equal(strictNewestLeafMtime(root, leafOnlyLstat).ok, false); } finally { chmodSync(locked, 0o755); }
  }
});

test("addendum: claude-*/prime-* session dirs are protected names", () => {
  const cfg = { TMP_UNMATCHED_EXCLUDE_PATTERNS: [/^\./, /^claude-/, /^prime-/], TMP_SCRATCH_PATTERNS: [], TMP_OWNER_UID: 1000 };
  for (const n of ["claude-abc", "prime-xyz"]) assert.equal(tmpUnmatchedExclusionReason({ name: n, kind: "dir", uid: 1000 }, { ...cfg }), "protected-name");
});

test("age signal: copied tree with old leaf mtimes but fresh root ctime/dir mtimes is kept", () => {
  const dir = tmpdir("janitor-copied-");
  touch(path.join(dir, "copied-yesterday", "deep", "x"), { mtime: OLD }); // cp -a / tar x shape
  const r = strictNewestLeafMtime(path.join(dir, "copied-yesterday"));
  assert.equal(r.ok, true);
  assert.ok(Date.now() - r.newestMtimeMs < 60000, "real lstat must see the fresh ctime/dir mtime");
  // real lstat in the category => fresh => not a candidate
  const res = evaluateTmpUnmatched(Date.now(), unmatchedConfig(dir, { TMP_AGE_LSTAT: lstatSync }), {
    live: { ok: true, paths: new Set() },
  });
  assert.equal(res.candidates.length, 0);
  // the leaf-only view (old behaviour) would have called it old
  const leaf = strictNewestLeafMtime(path.join(dir, "copied-yesterday"), leafOnlyLstat);
  assert.ok(Date.now() - leaf.newestMtimeMs > 20 * 86400000);
});

test("collectDockerMountSources: mount sources are live; docker failure fails closed", () => {
  const exec = (bin, args) => {
    if (args[0] === "ps") return "abc\ndef\n";
    return JSON.stringify([{ Mounts: [{ Source: "/tmp/juk-data" }] }, { Mounts: [{ Source: "/srv/x" }, {}] }]);
  };
  const ok = collectDockerMountSources(exec);
  assert.equal(ok.ok, true);
  assert.deepEqual([...ok.paths].sort(), ["/srv/x", "/tmp/juk-data"]);
  assert.equal(collectDockerMountSources(() => "").paths.size, 0);
  assert.equal(collectDockerMountSources(() => "").ok, true);
  const bad = collectDockerMountSources(() => { throw new Error("ENOENT docker"); });
  assert.equal(bad.ok, false);
});

test("run(): docker-mounted entry is kept; docker scan failure keeps the whole category", async () => {
  const { config } = buildSandbox();
  touch(path.join(config.TMP_DIR, "mounted", "x"), { mtime: OLD });
  touch(path.join(config.TMP_DIR, "idle", "x"), { mtime: OLD });
  const cfg = { ...config, TMP_OWNER_UID: UID, TMP_SCRATCH_PATTERNS: [/^pla/], TMP_UNMATCHED_DELETE: true };
  const mounted = path.join(config.TMP_DIR, "mounted");
  const s1 = await run({
    apply: true,
    config: { ...cfg, DOCKER_MOUNTS: () => ({ ok: true, paths: new Set([path.join(mounted, "x")]) }) },
    loadRegistered: testRegistered(),
  });
  assert.ok(existsSync(mounted));
  assert.ok(!existsSync(path.join(config.TMP_DIR, "idle")));
  assert.ok(s1.categories.tmpUnmatched.excluded.some((e) => e.path === mounted && e.reason === "in-use-by-live-process"));
  const s2 = await run({
    apply: true,
    config: { ...cfg, DOCKER_MOUNTS: () => ({ ok: false, error: "down", paths: new Set() }) },
    loadRegistered: testRegistered(),
  });
  assert.equal(s2.categories.tmpUnmatched.eligible, 0);
  assert.ok(existsSync(mounted));
});

test("run(): re-check at delete time skips entries that became live; rm failures are not counted as freed", async () => {
  const { config } = buildSandbox();
  touch(path.join(config.TMP_DIR, "turns-live", "x"), { mtime: OLD });
  touch(path.join(config.TMP_DIR, "rm-fails", "x"), { mtime: OLD });
  touch(path.join(config.TMP_DIR, "ok", "x"), { mtime: OLD });
  let calls = 0;
  const turnsLive = path.join(config.TMP_DIR, "turns-live");
  const summary = await run({
    apply: true,
    config: {
      ...config,
      TMP_OWNER_UID: UID,
      TMP_SCRATCH_PATTERNS: [/^pla/],
      TMP_UNMATCHED_DELETE: true,
      // first scan: nothing live; second (pre-delete) scan: turns-live is a docker mount
      DOCKER_MOUNTS: () => ({ ok: true, paths: calls++ === 0 ? new Set() : new Set([turnsLive]) }),
      TMP_RM: (p, opts) => {
        if (p.endsWith("rm-fails")) throw Object.assign(new Error("perm"), { code: "EACCES" });
        return rmSync(p, opts);
      },
    },
    loadRegistered: testRegistered(),
  });
  const u = summary.categories.tmpUnmatched;
  const by = Object.fromEntries(u.candidates.map((c) => [path.basename(c.path), c]));
  assert.equal(by["turns-live"].result, "skipped-at-delete (in-use)");
  assert.equal(by["rm-fails"].result, "failed:EACCES");
  assert.equal(by.ok.result, "deleted");
  assert.equal(u.deletedCount, 1);
  assert.equal(u.reclaimedBytes, by.ok.sizeBytes);
  assert.ok(existsSync(turnsLive));
});

// ---------------------------------------------------------------------------
// Live-reference guard (2026-10-03: a cron/routine-driven tool that nobody
// had edited in 30 days was reaped as an "abandoned worktree")
// ---------------------------------------------------------------------------

function refSandbox({ crontab = "", units = {}, db = { routines: [], agents: [] }, keepList = null } = {}) {
  const home = tmpdir("janitor-refs-");
  const workDir = path.join(home, "work");
  mkdirSync(workDir, { recursive: true });
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  for (const name of ["inbox-watchdog", "fork-drift", "routine-tool", "kept-tool", "listed-tool", "abandoned"]) {
    touch(path.join(workDir, name, "sweep.sh"), { mtime: old });
  }
  const crontabFile = path.join(home, "crontab.txt");
  writeFileSync(crontabFile, crontab.replaceAll("$SANDBOX", home));
  const unitDir = path.join(home, ".config/systemd/user");
  mkdirSync(unitDir, { recursive: true });
  for (const [name, text] of Object.entries(units)) writeFileSync(path.join(unitDir, name), text);
  const keepFile = path.join(home, ".config/host-disk-janitor/keep.txt");
  if (keepList !== null) {
    mkdirSync(path.dirname(keepFile), { recursive: true });
    writeFileSync(keepFile, keepList.replaceAll("$SANDBOX", home));
  }
  const config = {
    ...CONFIG,
    BACKUPS_DIR: path.join(home, "none-backups"),
    RUN_LOGS_DIR: path.join(home, "none-runlogs"),
    WORKTREE_SCAN_DIRS: [workDir],
    WORKTREE_HOME_GLOB_ROOT: home,
    WORKTREE_OBJECT_STORE_DIR: path.join(home, "no-store"),
    SELF_SCRIPT_PATH: path.join(home, "elsewhere/janitor.mjs"),
    TMP_DIR: path.join(home, "none-tmp"),
    TMP_UNMATCHED_DELETE: false,
    DISK_ALARM_PATH: home,
    DISK_ALARM_THRESHOLD_PERCENT: 101,
    CRONTAB_FILE_OVERRIDE: crontabFile,
    SYSTEMD_USER_DIR: unitDir,
    DB_REFS_JSON_OVERRIDE: JSON.stringify(db).replaceAll("$SANDBOX", home),
    KEEP_LIST_FILE: keepFile,
  };
  const loadReferences = ({ config: c }) => loadReferencedPaths({ config: c, home });
  return { home, workDir, config, loadReferences };
}

async function refRun(sb, apply = true) {
  return runRaw({ apply, config: sb.config, loadRegistered: testRegistered(), loadReferences: sb.loadReferences });
}

test("extractPathsFromText expands ~ / $HOME / %h and ignores URL fragments", () => {
  const home = "/h";
  assert.deepEqual(
    extractPathsFromText("0 * * * * bash /h/work/a/sweep.sh --apply >> ~/logs/x.log 2>&1", home).sort(),
    ["/h/logs/x.log", "/h/work/a/sweep.sh"],
  );
  assert.deepEqual(extractPathsFromText("run $HOME/work/b/x and ${HOME}/work/c", home).sort(), ["/h/work/b/x", "/h/work/c"]);
  assert.deepEqual(extractPathsFromText("see http://127.0.0.1:3100/api/issues", home), []);
  assert.deepEqual(extractPathsFromUnit("[Service]\nExecStart=/usr/bin/bash %h/work/fork-drift/run.sh\nDescription=/nope\n", home).sort(), [
    "/h/work/fork-drift/run.sh",
    "/usr/bin/bash",
  ]);
  assert.deepEqual(parseKeepList("# c\n\n~/work/x\nrelative/ignored\n/abs/y # tail\n", home), ["/h/work/x", "/abs/y"]);
});

test("findReferenceOverlap ignores references at/above a scan root (agent cwd = $HOME)", () => {
  const refs = [{ path: "/h", source: "agent a" }, { path: "/h/work", source: "crontab" }];
  assert.equal(findReferenceOverlap("/h/work/x", refs, ["/h/work", "/h"]), null);
  assert.equal(findReferenceOverlap("/h/work/x", [{ path: "/h/work/x/a/b", source: "s" }], ["/h/work"]).source, "s");
  assert.equal(findReferenceOverlap("/h/work/x/sub", [{ path: "/h/work/x", source: "s" }], ["/h/work"]).source, "s");
});

test("(i) old non-git dir referenced by a crontab line is kept", async () => {
  const sb = refSandbox({ crontab: "# bash $SANDBOX/work/abandoned/sweep.sh (comment: ignored)\n*/5 * * * * bash $SANDBOX/work/inbox-watchdog/sweep.sh --apply\n" });
  const s = await refRun(sb);
  const wt = s.categories.worktrees;
  assert.ok(existsSync(path.join(sb.workDir, "inbox-watchdog")));
  assert.deepEqual(wt.excludedReferenced.map((e) => [path.basename(e.path), e.source]), [["inbox-watchdog", "crontab"]]);
  assert.ok(!existsSync(path.join(sb.workDir, "abandoned")), "commented-out cron line must not protect");
  rmSync(sb.home, { recursive: true, force: true });
});

test("(ii) old non-git dir referenced by a systemd user unit with %h is kept", async () => {
  const sb = refSandbox({
    units: {
      "paperclip-fork-drift.service": "[Service]\nType=oneshot\nWorkingDirectory=%h/work/fork-drift\nExecStart=/usr/bin/env bash %h/work/fork-drift/check.sh\n",
      "paperclip-fork-drift.timer": "[Timer]\nOnCalendar=daily\n",
    },
  });
  const s = await refRun(sb);
  assert.ok(existsSync(path.join(sb.workDir, "fork-drift")));
  const e = s.categories.worktrees.excludedReferenced.find((x) => path.basename(x.path) === "fork-drift");
  assert.equal(e.source, "systemd paperclip-fork-drift.service");
  rmSync(sb.home, { recursive: true, force: true });
});

test("(iii) exact 2026-10-03 case: inbox-watchdog/sweep.sh referenced only in a routine description is kept; agent adapter_config too", async () => {
  const sb = refSandbox({
    db: {
      routines: [{ id: "r1", title: "ScanBot", description: "CHECK7: run `bash $SANDBOX/work/inbox-watchdog/sweep.sh --apply` every tick" }],
      agents: [{ name: "bot", adapter_config: { cwd: "$SANDBOX", env: { TOOL: "$SANDBOX/work/routine-tool/bin" } } }],
    },
  });
  const s = await refRun(sb);
  assert.ok(existsSync(path.join(sb.workDir, "inbox-watchdog")));
  assert.ok(existsSync(path.join(sb.workDir, "routine-tool")));
  const bySource = Object.fromEntries(s.categories.worktrees.excludedReferenced.map((e) => [path.basename(e.path), e.source]));
  assert.equal(bySource["inbox-watchdog"], "routine r1");
  assert.equal(bySource["routine-tool"], "agent bot");
  assert.ok(!existsSync(path.join(sb.workDir, "abandoned")), "agent cwd = $HOME must not shield everything");
  rmSync(sb.home, { recursive: true, force: true });
});

test("(iv) .janitor-keep marker and keep.txt entries are kept", async () => {
  const sb = refSandbox({ keepList: "# operator keep-list\n$SANDBOX/work/listed-tool\n" });
  const marker = path.join(sb.workDir, "kept-tool", ".janitor-keep");
  writeFileSync(marker, "");
  utimesSync(marker, new Date(Date.now() - 400 * 86400000), new Date(Date.now() - 400 * 86400000)); // marker age is irrelevant
  const s = await refRun(sb);
  assert.ok(existsSync(path.join(sb.workDir, "kept-tool")));
  assert.ok(existsSync(path.join(sb.workDir, "listed-tool")));
  assert.deepEqual(s.categories.worktrees.excludedKeepMarker.map((p) => path.basename(p)), ["kept-tool"]);
  assert.match(s.categories.worktrees.excludedReferenced.find((e) => path.basename(e.path) === "listed-tool").source, /^keep-list /);
  rmSync(sb.home, { recursive: true, force: true });
});

test("(v) old unreferenced dir is still deleted, idempotently", async () => {
  const sb = refSandbox({ crontab: "0 2 * * * bash $SANDBOX/work/inbox-watchdog/sweep.sh\n" });
  const s = await refRun(sb);
  assert.ok(!existsSync(path.join(sb.workDir, "abandoned")));
  assert.ok(s.categories.worktrees.eligiblePaths.some((p) => path.basename(p) === "abandoned"));
  const again = await refRun(sb);
  assert.equal(again.categories.worktrees.eligible, 0);
  assert.ok(existsSync(path.join(sb.workDir, "inbox-watchdog")));
  rmSync(sb.home, { recursive: true, force: true });
});

test("(vi) any reference source read failure => worktree category deletes nothing", async () => {
  for (const breakIt of [
    (sb) => { sb.config.CRONTAB_FILE_OVERRIDE = path.join(sb.home, "missing-crontab"); },
    (sb) => { sb.config.DB_REFS_JSON_OVERRIDE = JSON.stringify({ fail: "injected DB outage" }); },
  ]) {
    const sb = refSandbox();
    breakIt(sb);
    const s = await refRun(sb);
    assert.equal(s.referencedPaths.status, "unavailable");
    assert.equal(s.categories.worktrees.eligible, 0);
    assert.ok(s.categories.worktrees.referenceGuardFailureExcludedPaths.length >= 6);
    for (const name of ["abandoned", "inbox-watchdog", "fork-drift"]) assert.ok(existsSync(path.join(sb.workDir, name)));
    rmSync(sb.home, { recursive: true, force: true });
  }
});
