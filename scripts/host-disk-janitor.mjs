#!/usr/bin/env node
/**
 * host-disk-janitor.mjs
 *
 * Durable disk-retention janitor for a Paperclip operator host. Prunes four
 * categories that otherwise grow without bound: DB backup dumps, run-log
 * files, stale `~/work` / `~/pla*` git worktrees and clones, and `/tmp` agent
 * scratch. Also checks host disk usage against an alarm threshold and (in
 * --apply mode) files a Paperclip issue when it is exceeded.
 *
 * Safety model:
 *   - `--dry-run` is the default. Nothing is deleted and no network call is
 *     made unless `--apply` is passed explicitly.
 *   - Worktrees/clones are only ever deletion-eligible if they are either not
 *     a git repository at all, or are a git repo with zero tracked
 *     modifications (`git status --porcelain --untracked-files=no`) whose
 *     HEAD is reachable from at least one remote-tracking branch. Anything
 *     else (stranded commits, tracked edits) is left alone regardless of age.
 *   - Backups, run-logs, and worktrees additionally require the directory/
 *     file to be older than its retention threshold, where "age" is the
 *     newest mtime of any file *inside* the tree (never a top-level
 *     directory mtime, which a host reboot resets for everything at once).
 *   - `/tmp` agent scratch is gated on *liveness*, not age: every real
 *     scratch directory on this host is 0 days old at any given moment (an
 *     agent run creates one, uses it, and never cleans it up), so an
 *     age-only cutoff -- even a short one -- would either delete a live
 *     run's scratch the instant it goes quiet for a build, or never fire at
 *     all. A directory is only reap-eligible once no live process anywhere
 *     on the host has it open as a cwd or file descriptor (see
 *     isPathReferencedByLiveProcess), which stays true for a run that is
 *     blocked and has touched nothing for hours. Age is then only a
 *     small defense-in-depth floor against the sub-second `mkdtemp` race,
 *     not the liveness determination itself.
 *   - Deleting a worktree directory does not destroy any commit: this host's
 *     worktrees all share one object store (see WORKTREE_ROOTS below) and
 *     branches are additionally pushed to `fork` and `origin`. Only
 *     uncommitted *tracked* edits are at risk, and those are excluded above.
 *     Fully untracked (never `git add`ed) files are NOT protected by this
 *     check -- see README notes in the PR description.
 *
 * All retention values live in one place: CONFIG below. Every path is also
 * overridable via environment variable so this script can be pointed at an
 * isolated sandbox directory tree for testing without touching production
 * paths (see host-disk-janitor.test.mjs).
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  lstatSync,
  rmSync,
  unlinkSync,
  mkdirSync,
  writeFileSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// CONFIG -- every retention/threshold value lives here. No magic numbers
// below this block.
// ---------------------------------------------------------------------------
const HOME = process.env.PLA_JANITOR_HOME_DIR || os.homedir();
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const CONFIG = {
  // -- DB backup dumps: ~/.paperclip/instances/default/data/backups --
  // Grandfather-father-son rotation. Filenames encode their own timestamp
  // (paperclip-YYYYMMDD-HHMMSS.sql[.gz]), so retention does not depend on
  // wall-clock "now" -- it is purely relative to the most recent dump.
  BACKUPS_DIR:
    process.env.PLA_JANITOR_BACKUPS_DIR ||
    path.join(HOME, ".paperclip/instances/default/data/backups"),
  BACKUPS_FILENAME_PATTERN: /^paperclip-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.sql(\.gz)?$/,
  BACKUPS_KEEP_HOURLY: 24,
  BACKUPS_KEEP_DAILY: 7,
  BACKUPS_KEEP_WEEKLY: 4,

  // -- run-logs: ~/.paperclip/instances/default/data/run-logs --
  // Flat age retention on individual leaf files, then prune emptied dirs.
  RUN_LOGS_DIR:
    process.env.PLA_JANITOR_RUN_LOGS_DIR ||
    path.join(HOME, ".paperclip/instances/default/data/run-logs"),
  RUN_LOGS_MAX_AGE_DAYS: 30,

  // -- worktrees/clones: ~/work/* and ~/pla* --
  // Both roots' immediate directory entries are in scope. All of them share
  // one object store at ~/upstream-paperclip/.git; branches are additionally
  // pushed to `fork` and `origin`, so directory deletion never destroys a
  // commit -- only uncommitted tracked edits are at risk (excluded below).
  WORKTREE_SCAN_DIRS: [process.env.PLA_JANITOR_WORK_DIR || path.join(HOME, "work")],
  WORKTREE_HOME_GLOB_ROOT: process.env.PLA_JANITOR_HOME_GLOB_ROOT || HOME,
  // Patterns, not a bare prefix: a bare `startsWith("pla")` also captures
  // `platform-*` (e.g. a stray `platform-*.tgz`, or a future
  // `~/platform-scratch` directory) and `playwright-*` scratch dirs that
  // share the "pla" prefix -- exactly the over-match bug class the /tmp
  // scratch fix above closed. Anchor to `pla` followed by a digit
  // (ticket-numbered dirs like `pla2008-...`), same shape as
  // TMP_SCRATCH_PATTERNS.
  WORKTREE_HOME_GLOB_PATTERNS: [/^pla\d/],
  WORKTREE_MAX_AGE_DAYS: 30,
  // The shared object store all `~/work/*` / `~/pla*` worktrees register
  // against. After deleting eligible worktree directories, `git worktree
  // prune` here clears their now-dangling registrations so re-adding a
  // worktree at the same path later doesn't collide with a stale entry.
  WORKTREE_OBJECT_STORE_DIR:
    process.env.PLA_JANITOR_OBJECT_STORE_DIR || path.join(HOME, "upstream-paperclip"),
  // The cron entry points this very script at a checkout that lives under
  // one of the roots it scans. Without this, the janitor could delete the
  // copy of itself that cron invokes, silently disabling both pruning and
  // the disk alarm from that point on. Never rely on a crontab comment
  // alone for this -- the guard belongs in code.
  SELF_SCRIPT_PATH: process.env.PLA_JANITOR_SELF_PATH || fileURLToPath(import.meta.url),

  // -- /tmp agent scratch --
  // Patterns, not bare prefixes: a bare `startsWith("pla")` also captures
  // `playwright-artifacts-*` / `playwright_chromiumdev_profile-*`, which are
  // unrelated live browser-test scratch dirs. Anchor the agent-scratch
  // pattern to `pla` followed by a digit (ticket-numbered dirs like
  // `pla2008-...`) so it cannot collide with `playwright*`.
  TMP_DIR: process.env.PLA_JANITOR_TMP_DIR || os.tmpdir(),
  TMP_SCRATCH_PATTERNS: [/^pcvt-/, /^pla\d/],
  // Liveness -- not age -- is the primary reap gate for this bucket (see
  // isPathReferencedByLiveProcess/evaluateTmpEntry below). A 30-day age
  // cutoff was the actual bug this ticket exists to fix: every real
  // scratch directory on the host is 0 days old at any given moment, so a
  // day-scale TTL reclaims nothing, indefinitely, while /tmp fills the disk
  // in hours. TMP_SCRATCH_MIN_AGE_HOURS is a much shorter defense-in-depth
  // floor -- it only guards the sub-second race between `mkdtemp` and the
  // owning process's first write -- never the primary "is this run done"
  // determination, which is liveness, not staleness.
  TMP_SCRATCH_MIN_AGE_HOURS: 4,
  // Root of the process table to scan for cwd/fd references into a
  // candidate scratch directory. Overridable so tests can point this at a
  // synthetic tree of fake pid/cwd/fd symlinks instead of the real live
  // process table.
  PROC_ROOT: process.env.PLA_JANITOR_PROC_ROOT || "/proc",

  // -- disk alarm --
  DISK_ALARM_PATH: process.env.PLA_JANITOR_DISK_PATH || "/",
  DISK_ALARM_THRESHOLD_PCT: 85,
  DISK_ALARM_ISSUE_TITLE_MARKER: "[host-disk-alarm]",
  // companyId is not a secret (it is a UUID identifying the operator
  // company, not a credential) so it is safe to keep as a plain config
  // default. The bearer token itself is never stored here -- see
  // readApiToken() below, which reads it from the operator's existing
  // ~/.paperclip/auth.json at run time.
  DISK_ALARM_COMPANY_ID: process.env.PAPERCLIP_COMPANY_ID || "d49b266c-50dc-42c5-b45e-308c7f3ffc1f",
  PAPERCLIP_AUTH_JSON_PATH:
    process.env.PLA_JANITOR_AUTH_JSON || path.join(HOME, ".paperclip/auth.json"),
  PAPERCLIP_API_BASE_FALLBACK: "http://localhost:3100",

  // -- observability --
  STATE_DIR: process.env.PLA_JANITOR_STATE_DIR || path.join(HOME, ".paperclip/host-disk-janitor"),
};

// ---------------------------------------------------------------------------
// Backups: hourly/daily/weekly rotation
// ---------------------------------------------------------------------------

/** Parse a backup filename into a comparable Date, or null if unrecognized. */
export function parseBackupTimestamp(filename, pattern = CONFIG.BACKUPS_FILENAME_PATTERN) {
  const match = pattern.exec(filename);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  // Constructed from the filename's literal digits (no timezone conversion)
  // so grouping by "calendar date" and "ISO week" is stable and reproducible.
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
}

function isoDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function isoWeekKey(date) {
  // ISO 8601 week-year key, e.g. "2026-W31".
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * Classify backup dump files into keep/prune/unrecognized sets.
 * `entries` is [{ name, sizeBytes }]. Pure function -- no filesystem or
 * wall-clock access -- so it is fully unit-testable.
 */
export function classifyBackups(entries, config = CONFIG) {
  const parsed = [];
  const unrecognized = [];
  for (const entry of entries) {
    const ts = parseBackupTimestamp(entry.name, config.BACKUPS_FILENAME_PATTERN);
    if (!ts) {
      unrecognized.push(entry);
      continue;
    }
    parsed.push({ ...entry, ts });
  }
  parsed.sort((a, b) => b.ts.getTime() - a.ts.getTime());

  const keep = new Set();
  const hourly = parsed.slice(0, config.BACKUPS_KEEP_HOURLY);
  for (const e of hourly) keep.add(e.name);

  const remaining = parsed.slice(config.BACKUPS_KEEP_HOURLY);
  const seenDays = new Set();
  for (const e of remaining) {
    const key = isoDateKey(e.ts);
    if (seenDays.has(key)) continue;
    if (seenDays.size >= config.BACKUPS_KEEP_DAILY) continue;
    seenDays.add(key);
    keep.add(e.name);
  }

  const remainingAfterDaily = remaining.filter((e) => !keep.has(e.name));
  const seenWeeks = new Set();
  for (const e of remainingAfterDaily) {
    const key = isoWeekKey(e.ts);
    if (seenWeeks.has(key)) continue;
    if (seenWeeks.size >= config.BACKUPS_KEEP_WEEKLY) continue;
    seenWeeks.add(key);
    keep.add(e.name);
  }

  const prune = parsed.filter((e) => !keep.has(e.name));
  return {
    keep: parsed.filter((e) => keep.has(e.name)),
    prune,
    unrecognized,
  };
}

// ---------------------------------------------------------------------------
// Age helper shared by run-logs, worktrees, and /tmp scratch: "age" is always
// the newest mtime of any file *inside* the tree, never the top-level
// directory mtime (a host reboot resets every top-level /tmp mtime at once).
// ---------------------------------------------------------------------------

/**
 * Returns true as soon as it finds any *leaf* file (or symlink) inside
 * `rootPath` with mtimeMs > cutoffMs, short-circuiting the walk. Directory
 * entries' own mtimes are never compared -- a directory's mtime changes any
 * time an entry is added or removed inside it (e.g. `.git/objects`,
 * `.git/logs` churn from a routine `git status`/`push` even on an otherwise
 * abandoned branch), so treating it as content age would make every git
 * worktree look permanently "fresh". `skipDirNames` lets callers exclude
 * whole subtrees (worktree evaluation uses this to skip `.git` entirely, so
 * VCS bookkeeping never counts as working-tree activity).
 *
 * Does not follow symlinked directories (pnpm-style circular symlinks are
 * common under node_modules). If `rootPath` is itself a plain file, checks
 * its own mtime.
 *
 * A tree with *zero* leaf files anywhere (a brand-new empty directory, e.g.
 * mid `mkdir && git worktree add`) has no file-age evidence at all. Treating
 * that absence as "vacuously old" is the bug this function used to have: it
 * always returned `false` for an empty tree, which every caller inverted
 * into "old enough to delete" -- so a directory created seconds ago read as
 * 30+ days old. Absence of evidence must mean keep, not delete, so an empty
 * tree instead falls back to the root directory's own ctime (inode change
 * time -- the closest available proxy for "created" on Linux, since
 * birthtime isn't reliably exposed) compared against the same cutoff.
 */
export function directoryHasFileNewerThan(rootPath, cutoffMs, skipDirNames = []) {
  let rootStat;
  try {
    rootStat = lstatSync(rootPath);
  } catch {
    return false;
  }
  if (!rootStat.isDirectory()) {
    return rootStat.mtimeMs > cutoffMs;
  }

  const skip = new Set(skipDirNames);
  const stack = [rootPath];
  let sawLeafFile = false;
  while (stack.length > 0) {
    const dir = stack.pop();
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (skip.has(child.name)) continue;
      const childPath = path.join(dir, child.name);
      let st;
      try {
        st = lstatSync(childPath);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(childPath);
      } else {
        sawLeafFile = true;
        if (st.mtimeMs > cutoffMs) return true;
      }
    }
  }
  if (sawLeafFile) return false;
  return rootStat.ctimeMs > cutoffMs;
}

// ---------------------------------------------------------------------------
// run-logs: flat age retention + empty-dir cleanup
// ---------------------------------------------------------------------------

/** Recursively collects every regular file under `rootDir` with its mtime. */
export function collectFiles(rootDir) {
  const results = [];
  if (!existsSync(rootDir)) return results;
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      const childPath = path.join(dir, child.name);
      if (child.isDirectory() && !child.isSymbolicLink()) {
        stack.push(childPath);
      } else {
        let st;
        try {
          st = lstatSync(childPath);
        } catch {
          continue;
        }
        results.push({ path: childPath, mtimeMs: st.mtimeMs, sizeBytes: st.size });
      }
    }
  }
  return results;
}

export function classifyRunLogFiles(files, nowMs, maxAgeDays) {
  const cutoffMs = nowMs - maxAgeDays * DAY_MS;
  const prune = [];
  const keep = [];
  for (const f of files) {
    if (f.mtimeMs < cutoffMs) prune.push(f);
    else keep.push(f);
  }
  return { keep, prune };
}

/** Removes directories left empty after file deletion, deepest-first. */
function pruneEmptyDirs(rootDir) {
  if (!existsSync(rootDir)) return 0;
  let removed = 0;
  function walk(dir) {
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    let allEmpty = true;
    for (const child of children) {
      const childPath = path.join(dir, child.name);
      if (child.isDirectory() && !child.isSymbolicLink()) {
        const childEmpty = walk(childPath);
        if (childEmpty) {
          try {
            rmSync(childPath, { recursive: false });
            removed += 1;
          } catch {
            allEmpty = false;
          }
        } else {
          allEmpty = false;
        }
      } else {
        allEmpty = false;
      }
    }
    return allEmpty;
  }
  walk(rootDir);
  return removed;
}

// ---------------------------------------------------------------------------
// Worktrees / clones: ~/work/* and ~/pla*
// ---------------------------------------------------------------------------

function runGit(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/**
 * Classifies a directory as one of:
 *   - "not-a-repo"  -- no .git entry at all
 *   - "safe"        -- git repo, zero tracked modifications, HEAD reachable
 *                       from at least one remote-tracking branch
 *   - "review"      -- git repo with stranded commits and/or tracked edits;
 *                       never deletion-eligible regardless of age
 */
export function classifyWorktree(dirPath) {
  if (!existsSync(path.join(dirPath, ".git"))) {
    return "not-a-repo";
  }
  const status = runGit(["status", "--porcelain", "--untracked-files=no"], dirPath);
  if (status === null) return "review"; // can't prove safety -> exclude
  if (status.trim().length > 0) return "review"; // tracked edits

  const head = runGit(["rev-parse", "HEAD"], dirPath);
  if (head === null) return "review";
  const containing = runGit(["branch", "-r", "--contains", head.trim()], dirPath);
  if (containing === null || containing.trim().length === 0) return "review"; // stranded

  return "safe";
}

/** Lists immediate subdirectories (not files) of `dir`. */
function listSubdirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(dir, e.name));
}

/** Lists immediate entries of `dir` that are directories and match any of `patterns`. */
function listGlobDirs(dir, patterns) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && patterns.some((pattern) => pattern.test(e.name)))
    .map((e) => path.join(dir, e.name));
}

export function scanWorktreeCandidates(config = CONFIG) {
  const seen = new Set();
  const candidates = [];
  for (const root of config.WORKTREE_SCAN_DIRS) {
    for (const p of listSubdirs(root)) {
      if (seen.has(p)) continue;
      seen.add(p);
      candidates.push(p);
    }
  }
  for (const p of listGlobDirs(config.WORKTREE_HOME_GLOB_ROOT, config.WORKTREE_HOME_GLOB_PATTERNS)) {
    if (seen.has(p)) continue;
    seen.add(p);
    candidates.push(p);
  }
  return candidates;
}

/** True if `targetPath` resolves to a location inside `candidateDir`. */
export function isPathAncestorOf(candidateDir, targetPath) {
  const rel = path.relative(path.resolve(candidateDir), path.resolve(targetPath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function evaluateWorktree(dirPath, nowMs, config = CONFIG) {
  const classification = classifyWorktree(dirPath);
  const cutoffMs = nowMs - config.WORKTREE_MAX_AGE_DAYS * DAY_MS;
  const isOldEnough = !directoryHasFileNewerThan(dirPath, cutoffMs, [".git"]);
  const isSelf = isPathAncestorOf(dirPath, config.SELF_SCRIPT_PATH);
  const eligible = (classification === "not-a-repo" || classification === "safe") && isOldEnough && !isSelf;
  return { path: dirPath, classification, isOldEnough, isSelf, eligible };
}

/**
 * Counts `git worktree list` registrations under `storeDir`, or `null` if
 * `storeDir` isn't a usable git directory (e.g. not present in a sandbox).
 */
function countWorktreeRegistrations(storeDir) {
  const out = runGit(["worktree", "list", "--porcelain"], storeDir);
  if (out === null) return null;
  return out.split("\n").filter((line) => line.startsWith("worktree ")).length;
}

/**
 * Runs `git worktree prune` against the shared object store so directories
 * this janitor just deleted don't leave dangling worktree registrations
 * behind. Best-effort: returns `null` (not an error) if `storeDir` doesn't
 * exist or isn't a git directory, which is expected in isolated test
 * sandboxes that don't model the real shared store.
 */
function pruneWorktreeRegistrations(storeDir) {
  if (!existsSync(storeDir)) return null;
  const before = countWorktreeRegistrations(storeDir);
  if (before === null) return null;
  runGit(["worktree", "prune"], storeDir);
  const after = countWorktreeRegistrations(storeDir);
  if (after === null) return null;
  return { before, after, pruned: before - after };
}

// ---------------------------------------------------------------------------
// /tmp agent scratch
// ---------------------------------------------------------------------------

export function scanTmpCandidates(config = CONFIG) {
  if (!existsSync(config.TMP_DIR)) return [];
  return readdirSync(config.TMP_DIR, { withFileTypes: true })
    .filter((e) => config.TMP_SCRATCH_PATTERNS.some((pattern) => pattern.test(e.name)))
    .map((e) => path.join(config.TMP_DIR, e.name));
}

/**
 * Extracts the PID embedded in a `pcvt-<pid>-<invocation>-<rand>` vitest
 * scratch-root name (see scripts/run-vitest-stable.mjs, which mints one via
 * `mkdtempSync` and never cleans it up -- that's the whole reason this
 * bucket exists). Returns `null` for any other shape, including the ad hoc
 * `pla<ticket>...` agent-scratch directories, which carry no embedded PID.
 */
export function extractPcvtPid(dirName) {
  const match = /^pcvt-(\d+)-/.exec(dirName);
  return match ? Number(match[1]) : null;
}

/** True if `pid` names a currently-running process under `procRoot`. */
function pidIsAlive(pid, procRoot) {
  return existsSync(path.join(procRoot, String(pid)));
}

/**
 * Resolves the cwd and every open file-descriptor target for every process
 * currently visible under `config.PROC_ROOT`, in one pass over the process
 * table. Best-effort: a process that exits mid-scan, or a fd/cwd link that
 * disappears between `readdir` and `readlink`, is skipped, never treated as
 * an error -- the janitor runs as the same user as every agent/build
 * process on this host, so a persistent EACCES here would only ever come
 * from a kernel thread that cannot hold a /tmp scratch handle in the first
 * place.
 *
 * Callers evaluating many candidates (see `run()`) must call this exactly
 * once and reuse the result -- re-walking every process's every open fd
 * per-candidate turns an O(processes) scan into O(candidates * processes),
 * which is minutes of disk-bound syscalls on a host with a few hundred
 * scratch dirs and a few hundred processes, and is not an acceptable cost
 * for a job meant to run unattended and frequently.
 */
export function collectLiveProcessTargets(config = CONFIG) {
  const procRoot = config.PROC_ROOT;
  const targets = [];
  let pidDirs;
  try {
    pidDirs = readdirSync(procRoot, { withFileTypes: true });
  } catch {
    return targets;
  }
  for (const entry of pidDirs) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pidDir = path.join(procRoot, entry.name);
    try {
      targets.push(readlinkSync(path.join(pidDir, "cwd")));
    } catch {
      // process gone, or no cwd link (kernel thread) -- skip
    }
    let fdEntries;
    try {
      fdEntries = readdirSync(path.join(pidDir, "fd"));
    } catch {
      continue;
    }
    for (const fd of fdEntries) {
      try {
        targets.push(readlinkSync(path.join(pidDir, "fd", fd)));
      } catch {
        // fd closed between readdir and readlink -- skip
      }
    }
  }
  return targets;
}

/**
 * The positive liveness signal /tmp scratch reaping is gated on: true if
 * any currently-running process has `dirPath` (or anything inside it) open
 * as its cwd or as a file descriptor. Unlike file mtime, this stays true
 * for a process that is blocked -- mid network call, mid build -- and has
 * touched nothing inside the directory for hours. That is exactly the case
 * acceptance criterion 2 calls out: absence of recent writes must never be
 * read as "the run is done".
 *
 * A file descriptor pointing at an unlinked-but-still-open path (which the
 * kernel renders as `<path> (deleted)`) still counts as a live reference --
 * create-then-unlink-but-keep-open is a common temp-file pattern (Postgres
 * fixtures in particular), and treating it as "no longer referenced" would
 * be exactly the wrong direction to be wrong in here.
 *
 * `liveTargets` lets a caller iterating many candidates pass in a single
 * `collectLiveProcessTargets()` result instead of re-scanning /proc per
 * candidate; when omitted it is collected fresh (used by direct/test
 * callers evaluating one path in isolation).
 */
export function isPathReferencedByLiveProcess(dirPath, config = CONFIG, liveTargets = null) {
  let resolvedDir;
  try {
    resolvedDir = realpathSync(dirPath);
  } catch {
    return false; // already gone -- nothing left to protect
  }
  const targets = liveTargets ?? collectLiveProcessTargets(config);
  for (const target of targets) {
    if (target === resolvedDir || isPathAncestorOf(resolvedDir, target)) return true;
  }
  return false;
}

/**
 * A scratch entry is eligible only once liveness is positively ruled out
 * two ways, then confirmed old enough to clear the race-window floor:
 *
 *   1. No live process anywhere on the host has the directory open as its
 *      cwd or as any file descriptor (isPathReferencedByLiveProcess).
 *   2. For the `pcvt-<pid>-...` naming shape specifically, the embedded PID
 *      is no longer running. This catches the gap the fd/cwd scan alone
 *      can miss: a vitest invocation whose child process hasn't yet (or
 *      ever, for a test group that touches no files) opened anything under
 *      its TMPDIR, but whose parent `run-vitest-stable.mjs` process is
 *      still synchronously blocked in `spawnSync` waiting on it.
 *
 * Both checks can only ever err toward *keeping* a directory longer, never
 * toward deleting a live one: a dead PID is unambiguous (a PID either is or
 * isn't in the process table right now), and PID reuse could only cause a
 * false "still alive", not a false "already dead".
 *
 * `liveTargets` -- see isPathReferencedByLiveProcess -- lets `run()` share
 * one /proc scan across every candidate instead of paying for it per entry.
 */
export function evaluateTmpEntry(entryPath, nowMs, config = CONFIG, liveTargets = null) {
  if (isPathReferencedByLiveProcess(entryPath, config, liveTargets)) {
    return { path: entryPath, eligible: false, reason: "live-process-reference" };
  }
  const pcvtPid = extractPcvtPid(path.basename(entryPath));
  if (pcvtPid !== null && pidIsAlive(pcvtPid, config.PROC_ROOT)) {
    return { path: entryPath, eligible: false, reason: "owning-pid-alive" };
  }
  const cutoffMs = nowMs - config.TMP_SCRATCH_MIN_AGE_HOURS * HOUR_MS;
  const eligible = !directoryHasFileNewerThan(entryPath, cutoffMs);
  return { path: entryPath, eligible, reason: eligible ? null : "too-recent" };
}

// ---------------------------------------------------------------------------
// Disk alarm
// ---------------------------------------------------------------------------

/** Parses the Use% column out of `df -kP <path>` output. */
export function parseDfUsePercent(dfOutput) {
  const lines = dfOutput.trim().split("\n");
  const dataLine = lines[lines.length - 1];
  const fields = dataLine.trim().split(/\s+/);
  const pctField = fields[fields.length - 2]; // ... Use% Mounted-on
  const match = /^(\d+)%$/.exec(pctField);
  if (!match) return null;
  return Number(match[1]);
}

export function checkDiskUsage(diskPath = CONFIG.DISK_ALARM_PATH) {
  const output = execFileSync("df", ["-kP", diskPath], { encoding: "utf8" });
  const usePercent = parseDfUsePercent(output);
  return { usePercent, raw: output.trim() };
}

/** Reads the bearer token from the operator's existing auth.json. Never
 * embeds a credential in this script or any committed file. */
export function readApiCredential(config = CONFIG) {
  if (!existsSync(config.PAPERCLIP_AUTH_JSON_PATH)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(config.PAPERCLIP_AUTH_JSON_PATH, "utf8"));
  } catch {
    return null;
  }
  const credentials = parsed?.credentials || {};
  const preferredBase = process.env.PAPERCLIP_RUNTIME_API_URL || config.PAPERCLIP_API_BASE_FALLBACK;
  if (credentials[preferredBase]) {
    return { apiBase: preferredBase, token: credentials[preferredBase].token };
  }
  const firstKey = Object.keys(credentials)[0];
  if (firstKey) return { apiBase: firstKey, token: credentials[firstKey].token };
  return null;
}

// Statuses that count as "still open" for alarm dedup -- everything except
// terminal states. Combined with the `q` text search below (title matches
// rank first per the issues search endpoint), this keeps the dedup lookup
// on the marker's own issue even once the company has many open issues,
// instead of depending on it staying on an unfiltered first page.
const ALARM_OPEN_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];

async function fileDiskAlarmIssue({ usePercent, threshold, companyId, credential }) {
  const marker = CONFIG.DISK_ALARM_ISSUE_TITLE_MARKER;
  const createUrl = `${credential.apiBase}/api/companies/${companyId}/issues`;
  const searchUrl =
    `${createUrl}?q=${encodeURIComponent(marker)}&status=${encodeURIComponent(ALARM_OPEN_STATUSES.join(","))}`;
  const headers = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };

  let existingOpen = false;
  try {
    const listResp = await fetch(searchUrl, { headers });
    if (listResp.ok) {
      const body = await listResp.json();
      const issues = Array.isArray(body) ? body : body.issues || body.data || [];
      existingOpen = issues.some(
        (issue) =>
          typeof issue.title === "string" &&
          issue.title.includes(marker) &&
          !["done", "closed", "cancelled"].includes(String(issue.status).toLowerCase()),
      );
    }
  } catch {
    // Best-effort dedup only; fall through and attempt to create.
  }

  if (existingOpen) {
    return { created: false, reason: "alarm issue already open" };
  }

  const title = `${marker} host disk usage at ${usePercent}% (threshold ${threshold}%)`;
  const description = [
    `Automated alarm from scripts/host-disk-janitor.mjs.`,
    ``,
    `\`df -kP /\` reported ${usePercent}% used, at or above the ${threshold}% threshold.`,
    ``,
    `Run the janitor's dry-run to see current reclaim candidates: node scripts/host-disk-janitor.mjs --dry-run`,
  ].join("\n");

  const resp = await fetch(createUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ title, description, priority: "high" }),
  });
  if (!resp.ok) {
    return { created: false, reason: `issue creation failed: HTTP ${resp.status}` };
  }
  const created = await resp.json();
  return { created: true, identifier: created.identifier || created.id };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  return {
    apply: argv.includes("--apply"),
    json: argv.includes("--json"),
  };
}

function bytesToHuman(bytes) {
  if (bytes === 0) return "0B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exp).toFixed(2)}${units[exp]}`;
}

function statSize(p) {
  try {
    return lstatSync(p).size;
  } catch {
    return 0;
  }
}

function dirSizeBytes(p) {
  return collectFiles(p).reduce((sum, f) => sum + f.sizeBytes, 0) + statSize(p);
}

export async function run({ apply = false, nowMs = Date.now(), config = CONFIG } = {}) {
  const summary = { mode: apply ? "apply" : "dry-run", timestamp: new Date(nowMs).toISOString(), categories: {} };

  // -- backups --
  {
    const dirExists = existsSync(config.BACKUPS_DIR);
    const entries = dirExists
      ? readdirSync(config.BACKUPS_DIR, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => ({ name: e.name, sizeBytes: statSize(path.join(config.BACKUPS_DIR, e.name)) }))
      : [];
    const { keep, prune, unrecognized } = classifyBackups(entries, config);
    if (apply) {
      for (const e of prune) {
        try {
          unlinkSync(path.join(config.BACKUPS_DIR, e.name));
        } catch {
          // already gone -- idempotent
        }
      }
    }
    summary.categories.backups = {
      totalFiles: entries.length,
      keptFiles: keep.length,
      prunedFiles: prune.length,
      unrecognizedFiles: unrecognized.length,
      reclaimedBytes: prune.reduce((sum, e) => sum + e.sizeBytes, 0),
      prunedNames: prune.map((e) => e.name),
    };
  }

  // -- run-logs --
  {
    const files = collectFiles(config.RUN_LOGS_DIR);
    const { keep, prune } = classifyRunLogFiles(files, nowMs, config.RUN_LOGS_MAX_AGE_DAYS);
    if (apply) {
      for (const f of prune) {
        try {
          unlinkSync(f.path);
        } catch {
          // already gone -- idempotent
        }
      }
      pruneEmptyDirs(config.RUN_LOGS_DIR);
    }
    summary.categories.runLogs = {
      totalFiles: files.length,
      keptFiles: keep.length,
      prunedFiles: prune.length,
      reclaimedBytes: prune.reduce((sum, f) => sum + f.sizeBytes, 0),
    };
  }

  // -- worktrees / clones --
  {
    const candidates = scanWorktreeCandidates(config);
    const evaluations = candidates.map((p) => evaluateWorktree(p, nowMs, config));
    const eligible = evaluations.filter((e) => e.eligible);
    // Size is measured before deletion in both modes -- measuring only in
    // dry-run (the previous behavior) made every --apply run report
    // reclaimedBytes: 0, the only observability this job gets.
    const eligibleSizedBytes = eligible.reduce((sum, e) => sum + dirSizeBytes(e.path), 0);
    let registrationPrune = null;
    if (apply) {
      for (const e of eligible) {
        try {
          rmSync(e.path, { recursive: true, force: true });
        } catch {
          // already gone -- idempotent
        }
      }
      registrationPrune = pruneWorktreeRegistrations(config.WORKTREE_OBJECT_STORE_DIR);
    }
    summary.categories.worktrees = {
      totalScanned: candidates.length,
      eligible: eligible.length,
      reclaimedBytes: eligibleSizedBytes,
      eligiblePaths: eligible.map((e) => e.path),
      excludedReview: evaluations.filter((e) => e.classification === "review").map((e) => e.path),
      excludedSelf: evaluations.filter((e) => e.isSelf).map((e) => e.path),
      registrationPrune,
    };
  }

  // -- /tmp scratch --
  {
    const candidates = scanTmpCandidates(config);
    // Collected once and shared across every candidate -- see
    // collectLiveProcessTargets' docstring for why re-scanning /proc per
    // candidate is not an acceptable cost here.
    const liveTargets = collectLiveProcessTargets(config);
    const evaluations = candidates.map((p) => evaluateTmpEntry(p, nowMs, config, liveTargets));
    const eligible = evaluations.filter((e) => e.eligible);
    const eligibleSizedBytes = eligible.reduce((sum, e) => sum + dirSizeBytes(e.path), 0);
    if (apply) {
      for (const e of eligible) {
        try {
          rmSync(e.path, { recursive: true, force: true });
        } catch {
          // already gone -- idempotent
        }
      }
    }
    summary.categories.tmpScratch = {
      totalScanned: candidates.length,
      eligible: eligible.length,
      reclaimedBytes: eligibleSizedBytes,
      eligiblePaths: eligible.map((e) => e.path),
      excludedLive: evaluations.filter((e) => e.reason === "live-process-reference").map((e) => e.path),
      excludedOwningPidAlive: evaluations.filter((e) => e.reason === "owning-pid-alive").map((e) => e.path),
      excludedTooRecent: evaluations.filter((e) => e.reason === "too-recent").map((e) => e.path),
    };
  }

  // -- disk alarm --
  {
    let disk;
    try {
      disk = checkDiskUsage(config.DISK_ALARM_PATH);
    } catch (err) {
      disk = { usePercent: null, raw: `df failed: ${err.message}` };
    }
    const alarmed = disk.usePercent !== null && disk.usePercent >= config.DISK_ALARM_THRESHOLD_PCT;
    let alarmResult = null;
    if (alarmed && apply) {
      const credential = readApiCredential(config);
      if (!credential) {
        alarmResult = { created: false, reason: "no API credential found in auth.json" };
      } else {
        alarmResult = await fileDiskAlarmIssue({
          usePercent: disk.usePercent,
          threshold: config.DISK_ALARM_THRESHOLD_PCT,
          companyId: config.DISK_ALARM_COMPANY_ID,
          credential,
        });
      }
    }
    summary.diskAlarm = {
      usePercent: disk.usePercent,
      threshold: config.DISK_ALARM_THRESHOLD_PCT,
      alarmed,
      wouldFileIssue: alarmed && !apply,
      action: alarmResult,
    };
  }

  return summary;
}

function printSummary(summary) {
  const c = summary.categories;
  console.log(`host-disk-janitor: mode=${summary.mode} at ${summary.timestamp}`);
  console.log("");
  console.log(
    `backups:     ${c.backups.prunedFiles}/${c.backups.totalFiles} files ${summary.mode === "apply" ? "deleted" : "would delete"}, ` +
      `${bytesToHuman(c.backups.reclaimedBytes)} ${summary.mode === "apply" ? "freed" : "reclaimable"} (kept ${c.backups.keptFiles}, unrecognized ${c.backups.unrecognizedFiles})`,
  );
  console.log(
    `run-logs:    ${c.runLogs.prunedFiles}/${c.runLogs.totalFiles} files ${summary.mode === "apply" ? "deleted" : "would delete"}, ` +
      `${bytesToHuman(c.runLogs.reclaimedBytes)} ${summary.mode === "apply" ? "freed" : "reclaimable"} (kept ${c.runLogs.keptFiles})`,
  );
  console.log(
    `worktrees:   ${c.worktrees.eligible}/${c.worktrees.totalScanned} dirs ${summary.mode === "apply" ? "deleted" : "would delete"}, ` +
      `${bytesToHuman(c.worktrees.reclaimedBytes)} ${summary.mode === "apply" ? "freed" : "reclaimable"} ` +
      `(excluded as review: ${c.worktrees.excludedReview.length}, excluded as self: ${c.worktrees.excludedSelf.length})`,
  );
  if (c.worktrees.registrationPrune) {
    const rp = c.worktrees.registrationPrune;
    console.log(`             git worktree prune: ${rp.pruned} stale registration(s) cleared (${rp.before} -> ${rp.after})`);
  }
  console.log(
    `tmp scratch: ${c.tmpScratch.eligible}/${c.tmpScratch.totalScanned} entries ${summary.mode === "apply" ? "deleted" : "would delete"}, ` +
      `${bytesToHuman(c.tmpScratch.reclaimedBytes)} ${summary.mode === "apply" ? "freed" : "reclaimable"} ` +
      `(excluded as live: ${c.tmpScratch.excludedLive.length}, excluded as owning-pid-alive: ${c.tmpScratch.excludedOwningPidAlive.length}, excluded as too-recent: ${c.tmpScratch.excludedTooRecent.length})`,
  );
  console.log("");
  const d = summary.diskAlarm;
  if (d.usePercent === null) {
    console.log(`disk alarm:  could not read disk usage`);
  } else if (d.alarmed) {
    console.log(`disk alarm:  ALARM -- ${d.usePercent}% used (threshold ${d.threshold}%)`);
    if (d.wouldFileIssue) {
      console.log(`             would file an issue titled "${CONFIG.DISK_ALARM_ISSUE_TITLE_MARKER} host disk usage at ${d.usePercent}% (threshold ${d.threshold}%)" (dry-run: no network call made)`);
    } else if (d.action) {
      console.log(`             ${d.action.created ? `filed issue ${d.action.identifier}` : `no issue filed: ${d.action.reason}`}`);
    }
  } else {
    console.log(`disk alarm:  OK -- ${d.usePercent}% used (threshold ${d.threshold}%)`);
  }
  if (summary.mode !== "apply") {
    console.log("");
    console.log("Dry-run only. Re-run with --apply to delete/act.");
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const { apply, json } = parseArgs(process.argv.slice(2));
  const summary = await run({ apply });
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printSummary(summary);
  }
  try {
    mkdirSync(CONFIG.STATE_DIR, { recursive: true });
    writeFileSync(path.join(CONFIG.STATE_DIR, "last-run.json"), JSON.stringify(summary, null, 2));
  } catch {
    // Observability is best-effort; never fail the run over a state-file write.
  }
}
