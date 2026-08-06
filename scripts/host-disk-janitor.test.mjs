import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
  lutimesSync,
  existsSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
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
  extractPcvtPid,
  isPathReferencedByLiveProcess,
  parseDfUsePercent,
  run,
} from "./host-disk-janitor.mjs";

function tmpdir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

const HOUR_MS_TEST = 60 * 60 * 1000;

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
// /tmp scratch: liveness gate
//
// The 30-day age-only gate above is the bug this ticket exists to fix: every
// real scratch dir on the host is 0 days old at any given moment, so it
// never fired. These tests cover the replacement liveness mechanism instead
// of age: isPathReferencedByLiveProcess (fd/cwd scan) and the pcvt-<pid>
// embedded-PID check, using a synthetic PROC_ROOT so no test depends on or
// touches the real process table.
// ---------------------------------------------------------------------------

/** Builds a fake /proc tree: procs = [{ pid, cwd?, fds?: string[] }]. */
function buildFakeProcRoot(prefix, procs) {
  const procRoot = tmpdir(prefix);
  for (const proc of procs) {
    const pidDir = path.join(procRoot, String(proc.pid));
    mkdirSync(pidDir, { recursive: true });
    if (proc.cwd) symlinkSync(proc.cwd, path.join(pidDir, "cwd"));
    if (proc.fds) {
      const fdDir = path.join(pidDir, "fd");
      mkdirSync(fdDir, { recursive: true });
      proc.fds.forEach((target, i) => symlinkSync(target, path.join(fdDir, String(i))));
    }
  }
  return procRoot;
}

test("isPathReferencedByLiveProcess is true when a live process holds an open fd inside the directory", () => {
  const dir = tmpdir("janitor-live-fd-");
  const procRoot = buildFakeProcRoot("janitor-proc-", [
    { pid: 5001, cwd: "/some/unrelated/cwd", fds: [path.join(dir, "socket")] },
  ]);
  const config = { ...CONFIG, PROC_ROOT: procRoot };
  assert.equal(isPathReferencedByLiveProcess(dir, config), true);
  rmSync(dir, { recursive: true, force: true });
  rmSync(procRoot, { recursive: true, force: true });
});

test("isPathReferencedByLiveProcess is true when a live process's cwd is inside the directory", () => {
  const dir = tmpdir("janitor-live-cwd-");
  const nested = path.join(dir, "work", "repo");
  mkdirSync(nested, { recursive: true });
  const procRoot = buildFakeProcRoot("janitor-proc-", [{ pid: 5002, cwd: nested }]);
  const config = { ...CONFIG, PROC_ROOT: procRoot };
  assert.equal(isPathReferencedByLiveProcess(dir, config), true);
  rmSync(dir, { recursive: true, force: true });
  rmSync(procRoot, { recursive: true, force: true });
});

test("isPathReferencedByLiveProcess is false when no live process references the directory", () => {
  const dir = tmpdir("janitor-dead-");
  const procRoot = buildFakeProcRoot("janitor-proc-", [
    { pid: 5003, cwd: "/home/paperclip", fds: ["/dev/null", "/var/log/somewhere.log"] },
  ]);
  const config = { ...CONFIG, PROC_ROOT: procRoot };
  assert.equal(isPathReferencedByLiveProcess(dir, config), false);
  rmSync(dir, { recursive: true, force: true });
  rmSync(procRoot, { recursive: true, force: true });
});

test("extractPcvtPid parses the run-vitest-stable.mjs naming shape and rejects everything else", () => {
  assert.equal(extractPcvtPid("pcvt-306204-1-aUFt2B"), 306204);
  assert.equal(extractPcvtPid("pcvt-42-13-zzz"), 42);
  assert.equal(extractPcvtPid("pla1999_verify"), null);
  assert.equal(extractPcvtPid("pcvt-alone-h"), null); // non-numeric shard, not a pid
});

test("evaluateTmpEntry never treats a live run's scratch as a candidate, however stale its mtime (AC2)", () => {
  const dir = tmpdir("janitor-tmpentry-live-");
  const scratch = path.join(dir, "pla1999_verify");
  // Simulates a run blocked on a long build: content is far older than the
  // hour-scale floor, but a process still has the directory open.
  touch(path.join(scratch, "partial-build.log"), { mtime: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) });
  const procRoot = buildFakeProcRoot("janitor-proc-", [{ pid: 6001, fds: [path.join(scratch, "partial-build.log")] }]);
  const config = { ...CONFIG, PROC_ROOT: procRoot };
  const result = evaluateTmpEntry(scratch, Date.now(), config);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "live-process-reference");
  rmSync(dir, { recursive: true, force: true });
  rmSync(procRoot, { recursive: true, force: true });
});

test("evaluateTmpEntry never treats a pcvt-<pid> scratch as a candidate while the embedded pid is alive, even with no fd/cwd reference yet (AC2)", () => {
  const dir = tmpdir("janitor-tmpentry-pcvt-live-");
  const scratch = path.join(dir, "pcvt-6002-1-XyzAbc");
  // A test group with nothing written into TMPDIR yet: no fd/cwd reference
  // exists at all, only the parent run-vitest-stable.mjs PID being alive.
  mkdirSync(scratch, { recursive: true });
  const procRoot = buildFakeProcRoot("janitor-proc-", [{ pid: 6002 }]); // alive, but references nothing
  const config = { ...CONFIG, PROC_ROOT: procRoot };
  const result = evaluateTmpEntry(scratch, Date.now(), config);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "owning-pid-alive");
  rmSync(dir, { recursive: true, force: true });
  rmSync(procRoot, { recursive: true, force: true });
});

test("evaluateTmpEntry reaps a completed run's scratch once liveness clears and it's older than the min-age floor (AC2/AC4)", () => {
  const dir = tmpdir("janitor-tmpentry-done-");
  const scratch = path.join(dir, "pla1999-ac5");
  touch(path.join(scratch, "output.txt"), { mtime: new Date(Date.now() - 5 * HOUR_MS_TEST) });
  // Empty process table -- no process anywhere references this path.
  const procRoot = buildFakeProcRoot("janitor-proc-", []);
  const config = { ...CONFIG, PROC_ROOT: procRoot, TMP_SCRATCH_MIN_AGE_HOURS: 4 };
  const result = evaluateTmpEntry(scratch, Date.now(), config);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, null);
  rmSync(dir, { recursive: true, force: true });
  rmSync(procRoot, { recursive: true, force: true });
});

test("evaluateTmpEntry reaps a pcvt-<pid> scratch once the embedded pid is dead and nothing references it (AC2/AC4)", () => {
  const dir = tmpdir("janitor-tmpentry-pcvt-done-");
  const scratch = path.join(dir, "pcvt-6003-1-DeadPid");
  touch(path.join(scratch, "t", "leftover.sock"), { mtime: new Date(Date.now() - 5 * HOUR_MS_TEST) });
  // procRoot has no pid 6003 dir at all -- process has exited.
  const procRoot = buildFakeProcRoot("janitor-proc-", [{ pid: 9999, cwd: "/home/paperclip" }]);
  const config = { ...CONFIG, PROC_ROOT: procRoot, TMP_SCRATCH_MIN_AGE_HOURS: 4 };
  const result = evaluateTmpEntry(scratch, Date.now(), config);
  assert.equal(result.eligible, true);
  rmSync(dir, { recursive: true, force: true });
  rmSync(procRoot, { recursive: true, force: true });
});

test("evaluateTmpEntry still excludes a too-fresh scratch dir even once liveness clears (race-window floor)", () => {
  const dir = tmpdir("janitor-tmpentry-fresh-");
  const scratch = path.join(dir, "pla2019-fresh");
  touch(path.join(scratch, "just-started.txt")); // mtime = now
  const procRoot = buildFakeProcRoot("janitor-proc-", []);
  const config = { ...CONFIG, PROC_ROOT: procRoot, TMP_SCRATCH_MIN_AGE_HOURS: 4 };
  const result = evaluateTmpEntry(scratch, Date.now(), config);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "too-recent");
  rmSync(dir, { recursive: true, force: true });
  rmSync(procRoot, { recursive: true, force: true });
});

test("evaluateTmpEntry handles an empty scratch dir under the liveness gate (empty-tree ctime fallback, blocker 1 regression)", () => {
  const dir = tmpdir("janitor-tmpentry-empty-live-");
  const emptyEntry = path.join(dir, "pla9004");
  mkdirSync(emptyEntry);
  const procRoot = buildFakeProcRoot("janitor-proc-", []);
  const config = { ...CONFIG, PROC_ROOT: procRoot, TMP_SCRATCH_MIN_AGE_HOURS: 4 };
  // Created moments ago -- must not be reaped even though nothing
  // references it, same "absence of evidence must mean keep" invariant
  // directoryHasFileNewerThan already enforces for worktrees/run-logs.
  assert.equal(evaluateTmpEntry(emptyEntry, Date.now(), config).eligible, false);
  // Once "now" clears the empty dir's own ctime by more than the floor
  // (can't backdate ctime directly -- see the directoryHasFileNewerThan
  // ctime-fallback test above), it becomes eligible.
  const future = Date.now() + (config.TMP_SCRATCH_MIN_AGE_HOURS * HOUR_MS_TEST + 5000);
  assert.equal(evaluateTmpEntry(emptyEntry, future, config).eligible, true);
  rmSync(dir, { recursive: true, force: true });
  rmSync(procRoot, { recursive: true, force: true });
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
  };
  return { home, remotes: [staleRemote, liveRemote], config };
}

test("run() dry-run reports correct candidates without touching disk", async () => {
  const { home, remotes, config } = buildSandbox();
  const before = {
    backups: readdirSync(config.BACKUPS_DIR).length,
    worktrees: readdirSync(path.join(home, "work")).length,
  };

  const summary = await run({ apply: false, config });

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
  const summary = await run({ apply: true, config });

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
  const first = await run({ apply: true, config });
  assert.ok(first.categories.backups.prunedFiles > 0);

  const second = await run({ apply: true, config });
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

  const summary = await run({ apply: true, config });

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
  const summary = await run({ apply: false, config: alarmConfig });
  assert.equal(summary.diskAlarm.alarmed, true);
  assert.equal(summary.diskAlarm.wouldFileIssue, true);
  assert.equal(summary.diskAlarm.action, null);
  rmSync(home, { recursive: true, force: true });
  for (const remote of remotes) rmSync(remote, { recursive: true, force: true });
});
