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
import zlib from "node:zlib";

import {
  CONFIG,
  parseBackupTimestamp,
  classifyBackups,
  gzipUncompressedSizeBytes,
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
    entries.push({ name, sizeBytes: 280_000_000, effectiveBytes: 280_000_000 });
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
    entries.push({ name, sizeBytes: 1000, effectiveBytes: 280_000_000 });
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
    { name: "paperclip-20260731-210804.sql.gz", sizeBytes: 100, effectiveBytes: 280_000_000 },
    { name: "some-other-file.txt", sizeBytes: 50, effectiveBytes: 50 },
  ];
  const { prune, unrecognized } = classifyBackups(entries, CONFIG);
  assert.equal(unrecognized.length, 1);
  assert.equal(unrecognized[0].name, "some-other-file.txt");
  assert.ok(!prune.some((e) => e.name === "some-other-file.txt"));
});

// ---------------------------------------------------------------------------
// Corrupt/empty backup dumps: PLA-2018 fail-safe classification
// ---------------------------------------------------------------------------

test("gzipUncompressedSizeBytes reads the true decompressed size via a short trailer read, not full decompression", () => {
  const dir = tmpdir("janitor-gziptrailer-");

  const real = Buffer.alloc(500_000, "x");
  const realGz = zlib.gzipSync(real);
  writeFileSync(path.join(dir, "real.sql.gz"), realGz);
  assert.equal(gzipUncompressedSizeBytes(path.join(dir, "real.sql.gz")), 500_000);

  // The live-incident stub: a structurally valid, empty gzip stream.
  // `gzip -t` passes this; ISIZE correctly reads 0.
  const emptyGz = zlib.gzipSync(Buffer.alloc(0));
  writeFileSync(path.join(dir, "empty.sql.gz"), emptyGz);
  assert.equal(gzipUncompressedSizeBytes(path.join(dir, "empty.sql.gz")), 0);

  // Shorter than any valid gzip stream can be (10-byte header + 8-byte
  // trailer minimum) -- no trailer to read at all.
  writeFileSync(path.join(dir, "truncated.sql.gz"), Buffer.from([0x1f, 0x8b, 0x08]));
  assert.equal(gzipUncompressedSizeBytes(path.join(dir, "truncated.sql.gz")), null);

  assert.equal(gzipUncompressedSizeBytes(path.join(dir, "does-not-exist.sql.gz")), null);

  rmSync(dir, { recursive: true, force: true });
});

test("classifyBackups: live case -- 20-byte empty .gz stub sharing a timestamp with a valid dump (AC4)", () => {
  const dir = tmpdir("janitor-livecase-");
  const ts = "20260731-193824";
  const validName = `paperclip-${ts}.sql`;
  const stubName = `paperclip-${ts}.sql.gz`;

  const validPath = path.join(dir, validName);
  writeFileSync(validPath, Buffer.alloc(1_982_000, "x")); // stand-in for the real ~1.98GB dump

  const stubPath = path.join(dir, stubName);
  // Generated in-test via gzip-of-empty (equivalent to `gzip < /dev/null`)
  // rather than committing the live 20-byte binary fixture.
  const emptyGz = zlib.gzipSync(Buffer.alloc(0));
  writeFileSync(stubPath, emptyGz);
  assert.ok(emptyGz.length < 32, `fixture should reproduce the live ~20-byte empty gzip stub, got ${emptyGz.length}`);

  const entries = [
    { name: validName, sizeBytes: 1_982_000, effectiveBytes: 1_982_000 },
    { name: stubName, sizeBytes: emptyGz.length, effectiveBytes: gzipUncompressedSizeBytes(stubPath) ?? 0 },
  ];

  const { keep, prune, invalid } = classifyBackups(entries, CONFIG);
  assert.ok(keep.some((e) => e.name === validName), "the valid dump must be retained");
  assert.ok(!keep.some((e) => e.name === stubName), "the empty stub must not consume a retention slot");
  assert.ok(invalid.some((e) => e.name === stubName), "the empty stub must be classified invalid");
  assert.ok(prune.some((e) => e.name === stubName), "the empty stub must be eligible for deletion");

  rmSync(dir, { recursive: true, force: true });
});

test("classifyBackups: disk-full fail-safe -- newest 40 dumps are all empty stubs, older valid backups survive (AC5)", () => {
  const dir = tmpdir("janitor-diskfull-");
  const entries = [];
  const dayMs = 24 * 60 * 60 * 1000;
  const newest = Date.UTC(2026, 6, 31, 23, 0, 0);

  function nameFor(t) {
    return `paperclip-${t.toISOString().slice(0, 10).replace(/-/g, "")}-${t
      .toISOString()
      .slice(11, 19)
      .replace(/:/g, "")}.sql.gz`;
  }

  // Disk-full window: 40 straight hourly dumps, each an empty gzip stub --
  // exactly what a compressor failing under a full disk produces every
  // hour. This exceeds the 24+7+4=35 total keep slots, so under the old
  // (buggy) classifier these stubs alone would have consumed every slot and
  // pruned every real dump below out from under the retention window.
  for (let i = 0; i < 40; i += 1) {
    const t = new Date(newest - i * 60 * 60 * 1000);
    const name = nameFor(t);
    const filePath = path.join(dir, name);
    const emptyGz = zlib.gzipSync(Buffer.alloc(0));
    writeFileSync(filePath, emptyGz);
    entries.push({ name, sizeBytes: emptyGz.length, effectiveBytes: gzipUncompressedSizeBytes(filePath) ?? 0 });
  }

  // Pre-incident history: 10 real daily dumps, older than the entire
  // disk-full window.
  const historyStart = newest - 40 * 60 * 60 * 1000;
  const historyNames = [];
  for (let i = 1; i <= 10; i += 1) {
    const t = new Date(historyStart - i * dayMs);
    const name = nameFor(t);
    const filePath = path.join(dir, name);
    const realGz = zlib.gzipSync(Buffer.alloc(2_000_000, "x"));
    writeFileSync(filePath, realGz);
    entries.push({ name, sizeBytes: realGz.length, effectiveBytes: gzipUncompressedSizeBytes(filePath) ?? 0 });
    historyNames.push(name);
  }

  const { keep, prune, invalid, failSafeTripped } = classifyBackups(entries, CONFIG);

  assert.equal(failSafeTripped, false, "valid backups exist, the zero-valid-backups fail-safe must not trip");
  assert.equal(invalid.length, 40, "all 40 empty stubs must be classified invalid");
  for (const name of historyNames) {
    assert.ok(keep.some((e) => e.name === name), `pre-incident valid dump ${name} must be retained`);
    assert.ok(!prune.some((e) => e.name === name), `pre-incident valid dump ${name} must not be pruned`);
  }
  for (const e of entries.slice(0, 40)) {
    assert.ok(prune.some((p) => p.name === e.name), `stub ${e.name} must be pruned -- it consumed no retention slot`);
  }

  rmSync(dir, { recursive: true, force: true });
});

test("classifyBackups: fail-safe refuses to prune when zero valid backups would remain (AC3)", () => {
  const dir = tmpdir("janitor-allcorrupt-");
  const entries = [];
  const newest = Date.UTC(2026, 6, 31, 23, 0, 0);
  for (let i = 0; i < 5; i += 1) {
    const t = new Date(newest - i * 60 * 60 * 1000);
    const name = `paperclip-${t.toISOString().slice(0, 10).replace(/-/g, "")}-${t
      .toISOString()
      .slice(11, 19)
      .replace(/:/g, "")}.sql.gz`;
    const filePath = path.join(dir, name);
    const emptyGz = zlib.gzipSync(Buffer.alloc(0));
    writeFileSync(filePath, emptyGz);
    entries.push({ name, sizeBytes: emptyGz.length, effectiveBytes: gzipUncompressedSizeBytes(filePath) ?? 0 });
  }

  const { keep, prune, invalid, failSafeTripped } = classifyBackups(entries, CONFIG);
  assert.equal(keep.length, 0, "sanity: no valid backups exist in this fixture");
  assert.equal(invalid.length, 5);
  assert.equal(prune.length, 0, "must retain everything rather than empty the backups directory");
  assert.equal(failSafeTripped, true);

  rmSync(dir, { recursive: true, force: true });
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

  // 30 hourly backups -- only the newest 24 should survive. Real (small but
  // genuinely valid) gzip content, not placeholder bytes: these fixtures
  // exercise rotation/worktree/tmp behavior, not backup-corruption
  // classification, so they must read as valid under the new
  // decompressed-size gate rather than tripping the invalid-stub fail-safe.
  const start = Date.UTC(2026, 6, 31, 12, 0, 0);
  const validBackupContent = zlib.gzipSync(Buffer.alloc(2_000_000, "x"));
  for (let i = 0; i < 30; i += 1) {
    const t = new Date(start - i * 60 * 60 * 1000);
    const name = `paperclip-${t.toISOString().slice(0, 10).replace(/-/g, "")}-${t
      .toISOString()
      .slice(11, 19)
      .replace(/:/g, "")}.sql.gz`;
    writeFileSync(path.join(backupsDir, name), validBackupContent);
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

test("run() end-to-end: an empty .gz stub sharing a timestamp with a valid dump is pruned, the dump survives --apply (PLA-2018)", async () => {
  const home = tmpdir("janitor-e2e-corrupt-");
  const backupsDir = path.join(home, "backups");
  mkdirSync(backupsDir, { recursive: true });

  const ts = "20260731-193824";
  const validName = `paperclip-${ts}.sql`;
  const stubName = `paperclip-${ts}.sql.gz`;
  writeFileSync(path.join(backupsDir, validName), Buffer.alloc(1_982_000, "x"));
  writeFileSync(path.join(backupsDir, stubName), zlib.gzipSync(Buffer.alloc(0)));

  const config = {
    ...CONFIG,
    BACKUPS_DIR: backupsDir,
    RUN_LOGS_DIR: path.join(home, "run-logs-unused"),
    WORKTREE_SCAN_DIRS: [path.join(home, "work-unused")],
    WORKTREE_HOME_GLOB_ROOT: home,
    WORKTREE_HOME_GLOB_PATTERNS: [],
    WORKTREE_OBJECT_STORE_DIR: path.join(home, "no-such-object-store"),
    TMP_DIR: path.join(home, "tmp-unused"),
    TMP_SCRATCH_PATTERNS: [],
    STATE_DIR: path.join(home, "state"),
    PAPERCLIP_AUTH_JSON_PATH: path.join(home, "no-such-auth.json"),
    SELF_SCRIPT_PATH: path.join(home, "__self_not_under_any_candidate__", "host-disk-janitor.mjs"),
  };

  const dryRun = await run({ apply: false, config });
  assert.equal(dryRun.categories.backups.totalFiles, 2);
  assert.equal(dryRun.categories.backups.keptFiles, 1);
  assert.equal(dryRun.categories.backups.invalidFiles, 1, "the summary must surface the corrupt count (AC6)");
  assert.equal(dryRun.categories.backups.prunedFiles, 1);
  assert.equal(dryRun.categories.backups.failSafeTripped, false);
  // Dry-run must not have touched disk.
  assert.ok(existsSync(path.join(backupsDir, stubName)));

  const applied = await run({ apply: true, config });
  assert.equal(applied.categories.backups.prunedFiles, 1);
  assert.ok(existsSync(path.join(backupsDir, validName)), "the valid dump must survive --apply");
  assert.ok(!existsSync(path.join(backupsDir, stubName)), "the corrupt stub must be deleted by --apply");

  rmSync(home, { recursive: true, force: true });
});
