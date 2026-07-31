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
  scanTmpCandidates,
  evaluateTmpEntry,
  parseDfUsePercent,
  run,
} from "./host-disk-janitor.mjs";

function tmpdir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
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
    WORKTREE_HOME_GLOB_PREFIX: "pla",
  };
  const candidates = scanWorktreeCandidates(config).sort();
  assert.deepEqual(candidates, [path.join(home, "pla2004"), path.join(workDir, "fb13-publish")].sort());
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// /tmp scratch
// ---------------------------------------------------------------------------

test("scanTmpCandidates matches configured prefixes only", () => {
  const dir = tmpdir("janitor-tmproot-");
  mkdirSync(path.join(dir, "pcvt-abc"));
  mkdirSync(path.join(dir, "pla1999"));
  mkdirSync(path.join(dir, "unrelated"));
  const config = { ...CONFIG, TMP_DIR: dir, TMP_SCRATCH_PREFIXES: ["pcvt-", "pla"] };
  const candidates = scanTmpCandidates(config).map((p) => path.basename(p)).sort();
  assert.deepEqual(candidates, ["pcvt-abc", "pla1999"]);
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
    WORKTREE_HOME_GLOB_PREFIX: "__no_match__",
    TMP_DIR: tmpDir,
    TMP_SCRATCH_PREFIXES: ["pla"],
    STATE_DIR: path.join(home, "state"),
    DISK_ALARM_PATH: "/",
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
