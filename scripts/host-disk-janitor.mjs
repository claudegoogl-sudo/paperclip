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
 *   - All four categories additionally require the directory/file to be
 *     older than its retention threshold, where "age" is the newest mtime of
 *     any file *inside* the tree (never a top-level directory mtime, which a
 *     host reboot resets for everything at once).
 *   - Deleting a worktree directory does not destroy any commit: this host's
 *     worktrees all share one object store (see WORKTREE_ROOTS below) and
 *     branches are additionally pushed to `fork` and `origin`. Only
 *     uncommitted *tracked* edits are at risk, and those are excluded above.
 *     Fully untracked (never `git add`ed) files are NOT protected by this
 *     check -- see README notes in the PR description.
 *
 *   - A directory at, inside, or containing a path registered as a live
 *     plugin install (`plugins.package_path` in the embedded Postgres) is
 *     NEVER deletion-eligible, regardless of age or git state. A plain-copy
 *     install has no .git and mtimes as old as its source tag, which otherwise
 *     classifies exactly like an abandoned worktree -- that is how a live
 *     deploy tree was reaped on 2026-09-09. If the registry
 *     lookup fails, the worktree and /tmp categories fail closed for that
 *     run (nothing deleted) and the failure is printed loudly.
 *   - A directory at, inside, or containing a path that a live scheduler or
 *     agent references is NEVER deletion-eligible (the 2026-10-03 reap of a
 *     cron-driven tool that nobody had edited in 30 days). References come
 *     from: `crontab -l`; every `~/.config/systemd/user/*.service|*.timer`
 *     (ExecStart*, WorkingDirectory, EnvironmentFile; `%h` -> $HOME);
 *     non-archived `routines` (title + description); non-terminated
 *     `agents.adapter_config` (every string). References at or above a scan
 *     root (e.g. an agent cwd of $HOME) are ignored as too broad. If ANY of
 *     these sources cannot be read, the worktree category deletes nothing
 *     that run and the failure is printed loudly.
 *   - Explicit keep-list for anything the scan cannot see:
 *       * a `.janitor-keep` file inside a directory keeps that directory;
 *       * `~/.config/host-disk-janitor/keep.txt` -- one absolute path per
 *         line (`#` comments, `~/` allowed); a listed path is treated like a
 *         live reference.
 *     Excluded dirs are logged as `excluded (referenced by <source>): <dir>`.
 *     Operator guide: docs/host-disk-janitor.md.
 * All retention values live in one place: CONFIG below. Every path is also
 * overridable via environment variable so this script can be pointed at an
 * isolated sandbox directory tree for testing without touching production
 * paths (see host-disk-janitor.test.mjs).
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  lstatSync,
  statSync,
  rmSync,
  unlinkSync,
  mkdirSync,
  writeFileSync,
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

  // -- DB-registered plugin package paths (the 2026-09-09 live-deploy reap fix) --
  // The plugins table's package_path column is the authority on "this
  // directory is a deployed plugin install". Registered roots -- and any
  // directory at, inside, or containing one -- are never deletion-eligible.
  // -- live-reference guard (the 2026-10-03 inbox-watchdog reap fix) --
  // A stable tool nobody edits ages exactly like an abandoned worktree. Any
  // directory a live scheduler/agent references is never deletion-eligible.
  // Sources: crontab, systemd user units, non-archived routines, and
  // non-terminated agents' adapter_config. Any source read failure => the
  // worktree category deletes nothing that run (fail closed).
  CRONTAB_FILE_OVERRIDE: process.env.PLA_JANITOR_CRONTAB_FILE || "", // test: read this file instead of `crontab -l`
  SYSTEMD_USER_DIR: process.env.PLA_JANITOR_SYSTEMD_USER_DIR || path.join(HOME, ".config/systemd/user"),
  DB_REFS_JSON_OVERRIDE: process.env.PLA_JANITOR_DB_REFS_JSON || "", // test: {"routines":[{title,description}],"agents":[{adapter_config}]}
  // Explicit keep-list for anything the scan cannot see: one absolute path
  // per line (`#` comments, blank lines and `~/` allowed). Missing file = empty.
  KEEP_LIST_FILE: process.env.PLA_JANITOR_KEEP_LIST_FILE || path.join(HOME, ".config/host-disk-janitor/keep.txt"),
  // A directory containing this marker file is never deletion-eligible.
  KEEP_MARKER_NAME: ".janitor-keep",
  REGISTERED_PATHS_JSON_OVERRIDE:
    process.env.PLA_JANITOR_REGISTERED_PATHS_JSON || "", // test/ops override: JSON array of paths
  PG_DATA_DIR: process.env.PLA_JANITOR_PG_DATA_DIR || "",
  PG_PORT: Number(process.env.PLA_JANITOR_PG_PORT || 54329),
  PG_USER: process.env.PLA_JANITOR_PG_USER || "paperclip",
  PG_DATABASE: process.env.PLA_JANITOR_PG_DATABASE || "paperclip",
  PG_CREDENTIAL_SUFFIX: ".pg-credential",
  // Where to find the `pg` driver, tried in order. The embedded-postgres
  // client library ships inside the paperclipai global module on this host;
  // the bare "pg" fallback only resolves when run from a tree that has it.
  PG_MODULE_PATHS: (
    process.env.PLA_JANITOR_PG_MODULE_PATHS ||
    [
      "/usr/lib/node_modules/paperclipai/node_modules/pg",
      path.join(HOME, "upstream-paperclip/node_modules/pg"),
      "pg",
    ].join(":")
  )
    .split(":")
    .filter(Boolean),

  // -- /tmp agent scratch --
  // Patterns, not bare prefixes: a bare `startsWith("pla")` also captures
  // `playwright-artifacts-*` / `playwright_chromiumdev_profile-*`, which are
  // unrelated live browser-test scratch dirs. Anchor the agent-scratch
  // pattern to `pla` followed by a digit (ticket-numbered dirs like
  // `pla2008-...`) so it cannot collide with `playwright*`.
  TMP_DIR: process.env.PLA_JANITOR_TMP_DIR || os.tmpdir(),
  TMP_SCRATCH_PATTERNS: [/^pcvt-/, /^pla\d/],
  TMP_MAX_AGE_DAYS: 30,
  // Unmatched /tmp category: any top-level entry owned by the janitor's own
  // uid (the `paperclip` agent user), any name, whose newest leaf-file mtime
  // is older than this. Agents name scratch dirs freely (`f53rb`,
  // `sync8241-staging`, ...) so the pattern rule above misses most of it.
  TMP_UNMATCHED_MAX_AGE_DAYS: Number(process.env.PLA_JANITOR_TMP_UNMATCHED_MAX_AGE_DAYS || 14),
  // Destructive-scope gate: the unmatched category is REPORT-ONLY until this
  // is enabled (CEO approval required to expand deletion scope). With the
  // gate off, --apply lists candidates but deletes nothing in this category.
  TMP_UNMATCHED_DELETE: process.env.PLA_JANITOR_TMP_UNMATCHED_DELETE === "1",
  TMP_OWNER_UID: typeof process.getuid === "function" ? process.getuid() : -1,
  // Never touched by the unmatched category, whatever the owner or age.
  TMP_UNMATCHED_EXCLUDE_PATTERNS: [/^\./, /^paperclip-pg-/, /^systemd-private-/, /^tmux-/, /^snap-private-tmp$/, /^claude-/, /^claude$/, /^prime-/, /^prime$/],
  PROC_DIR: process.env.PLA_JANITOR_PROC_DIR || "/proc",
  // Report-only: large paths outside janitor roots that need an owner call.
  OWNER_DECISION_GLOBS: [
    { dir: HOME, pattern: /^\.pap18/ },
  ],
  OWNER_DECISION_PATHS: [path.join(HOME, ".ipython/profile_default/history.sqlite")],

  // -- disk alarm --
  DISK_ALARM_PATH: process.env.PLA_JANITOR_DISK_PATH || "/",
  DISK_ALARM_THRESHOLD_PCT: 85,
  DISK_ALARM_ISSUE_TITLE_MARKER: "[host-disk-alarm]",
  // The alarm must wake a named owner: new alarm issues are assigned (todo),
  // and a deduped open alarm that is unassigned/backlog is re-assigned.
  DISK_ALARM_ASSIGNEE_AGENT_ID:
    process.env.PLA_JANITOR_ALARM_ASSIGNEE_AGENT_ID || "ca7c92dd-2c00-4811-ae20-dd3bb1782c1d",
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
 * Read the ISIZE field from a gzip archive (last 4 bytes, little-endian).
 * Returns null if the file cannot be read or is too small to be a valid gzip
 * archive. This is the same on-disk check used by backup-lib's runBackup, but
 * duplicated here so the janitor does not depend on the db package.
 */
export function readGzipIsize(archivePath) {
  try {
    const stat = lstatSync(archivePath);
    if (stat.size < 8) return null;
    const buffer = Buffer.alloc(4);
    const fd = openSync(archivePath, "r");
    try {
      readSync(fd, buffer, 0, 4, stat.size - 4);
      return buffer.readUInt32LE(0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Check if a gzip archive passes verification (has non-zero ISIZE).
 */
export function isArchiveVerified(archivePath) {
  const isize = readGzipIsize(archivePath);
  return isize !== null && isize > 0;
}

/**
 * Classify backup dump files into keep/prune/unrecognized sets.
 *
 * `entries` is `[{ name, sizeBytes, verified? }]`. Pure function -- no
 * filesystem or wall-clock access -- so it is fully unit-testable. Callers
 * that have access to the filesystem should populate `verified` from
 * `isArchiveVerified()`; entries with `verified === false` are excluded from
 * keep slots (AC7) and surfaced in `unverified` instead. Entries with
 * `verified === undefined` default to "verified" so synthetic test fixtures
 * and callers that do not care about content checks keep working.
 */
export function classifyBackups(entries, config = CONFIG) {
  const parsed = [];
  const unrecognized = [];
  const unverified = [];

  for (const entry of entries) {
    // Exclude .partial files and .sql files (only .sql.gz are complete backups)
    if (!entry.name.endsWith(".sql.gz") || entry.name.endsWith(".partial")) {
      unrecognized.push(entry);
      continue;
    }

    const ts = parseBackupTimestamp(entry.name, config.BACKUPS_FILENAME_PATTERN);
    if (!ts) {
      unrecognized.push(entry);
      continue;
    }

    // AC7: an archive that fails content verification cannot occupy a keep
    // slot. `verified === undefined` is treated as verified so the function
    // remains pure and unit-testable without touching the filesystem.
    if (entry.verified === false) {
      unverified.push(entry);
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
    unverified,
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

export function worktreeScanRoots(config = CONFIG) {
  return [...config.WORKTREE_SCAN_DIRS, config.WORKTREE_HOME_GLOB_ROOT];
}

export function evaluateWorktree(dirPath, nowMs, config = CONFIG, registeredPaths = [], referencedPaths = []) {
  const classification = classifyWorktree(dirPath);
  const cutoffMs = nowMs - config.WORKTREE_MAX_AGE_DAYS * DAY_MS;
  const isOldEnough = !directoryHasFileNewerThan(dirPath, cutoffMs, [".git"]);
  const isSelf = isPathAncestorOf(dirPath, config.SELF_SCRIPT_PATH);
  const registeredRoot = findRegisteredOverlap(dirPath, registeredPaths);
  const reference = findReferenceOverlap(dirPath, referencedPaths, worktreeScanRoots(config));
  const keepMarker = hasKeepMarker(dirPath, config);
  const eligible =
    (classification === "not-a-repo" || classification === "safe") &&
    isOldEnough &&
    !isSelf &&
    registeredRoot === null &&
    reference === null &&
    !keepMarker;
  return { path: dirPath, classification, isOldEnough, isSelf, registeredRoot, reference, keepMarker, eligible };
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
// DB-registered plugin package paths (the 2026-09-09 live-deploy reap fix)
// ---------------------------------------------------------------------------

/**
 * Extract the embedded-Postgres data directory from a `ps ax -o command`
 * snapshot. Unlike the messenger drift-check (which takes the first
 * `postgres -D` line and can be fooled by an unrelated staging cluster),
 * this prefers the data dir under the Paperclip instance directory and only
 * falls back to the first match when no instance dir is present.
 */
export function parseEmbeddedPostgresDataDir(psText) {
  const matches = [];
  for (const line of String(psText).split("\n")) {
    const m = line.match(/(?:^|\/)postgres\b.*?\s-D\s+(\S+)/);
    if (m) matches.push(m[1]);
  }
  if (matches.length === 0) return null;
  return (
    matches.find((d) => d.includes(`${path.sep}.paperclip${path.sep}instances${path.sep}default${path.sep}db`)) ||
    matches[0]
  );
}

/**
 * Parse `-p <port>` and `unix_socket_directories=<dir>` out of a
 * postmaster.opts file. The file quotes each argument (`"-p" "54329"`), so
 * both patterns tolerate quote characters in either position. The live
 * cluster on this host is UNIX-socket-only (listen_addresses is empty), so
 * the socket dir -- not a TCP host -- is the connection path.
 */
export function parsePostmasterOpts(optsText) {
  const port = optsText.match(/-p"?\s*"?(\d+)/);
  const sock = optsText.match(/unix_socket_directories="?([^"\s]+)/);
  return {
    port: port ? Number(port[1]) : null,
    socketDir: sock ? sock[1] : null,
  };
}

/**
 * Resolve the embedded-Postgres password without ever logging it:
 *   (a) PGPASSWORD from the environment, when set and non-empty;
 *   (b) the host credential file `<dataDir>.pg-credential`, read only when it
 *       is mode 0600 (any looser mode is refused, not silently trusted -- same
 *       policy as the messenger drift check).
 * The value must never appear in logs, output, or error messages.
 */
export function resolveDbCredential({ env = {}, dataDir, io } = {}) {
  const _io = io ?? {
    exists: (p) => existsSync(p),
    mode: (p) => statSync(p).mode & 0o777,
    read: (p) => readFileSync(p, "utf8"),
  };
  if (env.PGPASSWORD) return { password: env.PGPASSWORD, source: "env" };
  if (!dataDir) throw new Error("no embedded-postgres data dir; cannot locate credential file");
  const credPath = `${dataDir}${CONFIG.PG_CREDENTIAL_SUFFIX}`;
  if (!_io.exists(credPath)) throw new Error(`credential file ${credPath} not found`);
  const mode = _io.mode(credPath);
  if (mode !== 0o600) {
    throw new Error(`credential file ${credPath} has mode ${mode.toString(8)}, expected 600 -- refusing`);
  }
  const password = _io.read(credPath).trim();
  if (!password) throw new Error(`credential file ${credPath} is empty`);
  return { password, source: "credfile" };
}

function importPgModule(config) {
  // `pg` is a CommonJS package; ES-module import() cannot resolve a package
  // by directory path, so load it through createRequire, which can.
  const errors = [];
  const require = createRequire(import.meta.url);
  for (const candidate of config.PG_MODULE_PATHS) {
    try {
      const mod = require(candidate);
      return { mod: mod.default ?? mod, via: candidate };
    } catch (err) {
      errors.push(`${candidate}: ${err.message.split("\n")[0]}`);
    }
  }
  throw new Error(
    `no usable pg module (tried ${config.PG_MODULE_PATHS.length} location(s)): ${errors.join("; ")}`,
  );
}

/**
 * Open a short-lived client to the embedded Postgres over its UNIX socket,
 * run `fn(client)`, close. Throws on any failure -- callers fail closed.
 * The credential is read in-process and never logged.
 */
async function withDbClient(config, fn) {
  let psText = "";
  try {
    psText = execFileSync("ps", ["ax", "-o", "command"], { encoding: "utf8" });
  } catch (err) {
    throw new Error(`ps failed: ${err.message}`);
  }
  const dataDir = config.PG_DATA_DIR || parseEmbeddedPostgresDataDir(psText);
  if (!dataDir) throw new Error("no embedded-postgres `postgres -D <dataDir>` process found");
  let optsText = "";
  try {
    optsText = readFileSync(path.join(dataDir, "postmaster.opts"), "utf8");
  } catch {
    // postmaster.opts missing: socket/port must come from somewhere else
  }
  const { port, socketDir } = parsePostmasterOpts(optsText);
  if (!socketDir) throw new Error(`could not read unix_socket_directories from ${path.join(dataDir, "postmaster.opts")}`);
  const { password, source: credSource } = resolveDbCredential({ env: process.env, dataDir });
  const { mod: pg, via: pgVia } = importPgModule(config);
  const client = new pg.Client({
    host: socketDir,
    port: port || config.PG_PORT,
    user: config.PG_USER,
    password,
    database: config.PG_DATABASE,
  });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `connect to embedded Postgres over socket ${socketDir} port ${port || config.PG_PORT} ` +
        `(credential from ${credSource}, pg from ${pgVia}) failed: ${err.message}`,
    );
  }
  try {
    const rows = await fn(client);
    return { rows, meta: { socketDir, port: port || config.PG_PORT } };
  } finally {
    try {
      await client.end();
    } catch {
      // already closed
    }
  }
}

/**
 * Load the set of registered plugin install roots (`plugins.package_path`)
 * from the embedded Postgres over its UNIX socket. Never throws: any failure
 * returns { status: "unavailable", error } and every caller must fail CLOSED
 * (treat every scanned directory as potentially registered -- delete nothing
 * in the directory categories) until the lookup works again. Under-deleting
 * is recoverable; deleting a live install is not.
 */
export async function loadRegisteredPackagePaths({ config = CONFIG } = {}) {
  if (config.REGISTERED_PATHS_JSON_OVERRIDE) {
    try {
      const parsed = JSON.parse(config.REGISTERED_PATHS_JSON_OVERRIDE);
      if (!Array.isArray(parsed)) throw new Error("override is not a JSON array");
      return {
        status: "ok",
        paths: [...new Set(parsed.map((p) => path.resolve(String(p))))].sort(),
        source: "json-override",
      };
    } catch (err) {
      return {
        status: "unavailable",
        paths: [],
        source: "json-override",
        error: `bad PLA_JANITOR_REGISTERED_PATHS_JSON: ${err.message}`,
      };
    }
  }
  try {
    const { rows, meta } = await withDbClient(config, async (client) =>
      (await client.query("SELECT package_path FROM plugins WHERE package_path IS NOT NULL")).rows,
    );
    const paths = [...new Set(rows.map((r) => path.resolve(String(r.package_path))))].sort();
    return { status: "ok", paths, source: "db", socketDir: meta.socketDir, port: meta.port, rowCount: rows.length };
  } catch (err) {
    return { status: "unavailable", paths: [], source: "db", error: err.message };
  }
}

/**
 * Return the registered path that overlaps `dirPath`, or null. Overlap means
 * either side is equal to or an ancestor of the other: a candidate AT or
 * INSIDE a registered root must never be deleted, and a candidate that
 * CONTAINS a registered root must never be deleted either (deleting the
 * parent would destroy the registered install inside it).
 */
export function findRegisteredOverlap(dirPath, registeredPaths) {
  if (!registeredPaths || registeredPaths.length === 0) return null;
  const resolved = path.resolve(dirPath);
  for (const registered of registeredPaths) {
    const regResolved = path.resolve(registered);
    if (regResolved === resolved) return regResolved;
    if (isPathAncestorOf(regResolved, resolved)) return regResolved; // candidate inside registered root
    if (isPathAncestorOf(resolved, regResolved)) return regResolved; // registered root inside candidate
  }
  return null;
}

// ---------------------------------------------------------------------------
// Live-reference guard (the 2026-10-03 inbox-watchdog reap fix)
// ---------------------------------------------------------------------------

const ABS_PATH_RE = /(?:%h|\$\{HOME\}|\$HOME|~)?\/[A-Za-z0-9._\-+@%/]+/g;

/**
 * Extract absolute paths from free text (a cron line, a unit directive, a
 * routine description, an adapter_config string). `~`, `$HOME`, `${HOME}`
 * and systemd `%h` are expanded to `home`. Pure.
 */
export function extractPathsFromText(text, home = HOME) {
  if (typeof text !== "string" || !text) return [];
  const out = new Set();
  for (const m of text.matchAll(ABS_PATH_RE)) {
    let p = m[0];
    // a bare "/x" fragment inside a URL or word (e.g. "http://h/x", "a/b") is not a path
    const before = m.index > 0 ? text[m.index - 1] : "";
    if (!/^(%h|\$|~)/.test(p) && before && !/[\s"'=:(`,;|&<>\[{]/.test(before)) continue;
    if (/^[^/]*\/\//.test(p) || p.startsWith("//")) continue;
    p = p.replace(/^(%h|\$\{HOME\}|\$HOME|~)(?=\/)/, home);
    p = p.replace(/[.,:;]+$/, "");
    if (p.length < 2) continue;
    out.add(path.resolve(p));
  }
  return [...out];
}

/** Parse a systemd unit: paths from ExecStart*, WorkingDirectory, EnvironmentFile. Pure. */
export function extractPathsFromUnit(unitText, home = HOME) {
  const out = new Set();
  for (const raw of String(unitText).split("\n")) {
    const m = raw.match(/^\s*(ExecStart\w*|ExecStop\w*|WorkingDirectory|EnvironmentFile)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2].replace(/^[-@:+!]+/, "");
    for (const p of extractPathsFromText(value, home)) out.add(p);
  }
  return [...out];
}

function collectJsonStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectJsonStrings(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectJsonStrings(v, out);
    }
  }
  return out;
}

/** Paths referenced anywhere in an agent adapter_config (command, cwd, args, env values...). Pure. */
export function extractPathsFromAdapterConfig(adapterConfig, home = HOME) {
  let cfg = adapterConfig;
  if (typeof cfg === "string") {
    try {
      cfg = JSON.parse(cfg);
    } catch {
      return extractPathsFromText(cfg, home);
    }
  }
  const out = new Set();
  for (const s of collectJsonStrings(cfg)) for (const p of extractPathsFromText(s, home)) out.add(p);
  return [...out];
}

/** Parse keep.txt: one absolute (or ~/) path per line; `#` comments. Pure. */
export function parseKeepList(text, home = HOME) {
  const out = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const expanded = line.replace(/^(~|\$HOME|%h)(?=\/|$)/, home);
    if (!path.isAbsolute(expanded)) continue;
    out.push(path.resolve(expanded));
  }
  return out;
}

async function loadDbReferenceRows(config) {
  if (config.DB_REFS_JSON_OVERRIDE) {
    const parsed = JSON.parse(config.DB_REFS_JSON_OVERRIDE);
    if (parsed && parsed.fail) throw new Error(String(parsed.fail));
    return { routines: parsed.routines || [], agents: parsed.agents || [] };
  }
  const { rows } = await withDbClient(config, async (client) => {
    const routines = (
      await client.query("SELECT id, title, description FROM routines WHERE status <> 'archived'")
    ).rows;
    const agents = (
      await client.query("SELECT id, name, adapter_config FROM agents WHERE status <> 'terminated'")
    ).rows;
    return { routines, agents };
  });
  return rows;
}

/**
 * Build the set of live-referenced paths. Never throws. Returns
 * { status: "ok"|"unavailable", refs: [{ path, source }], errors: [...] }.
 * status is "unavailable" if ANY source failed; the caller must then delete
 * nothing in the worktree category (fail closed). `refs` still carries what
 * the readable sources found, so the report stays informative.
 */
export async function loadReferencedPaths({ config = CONFIG, home = HOME } = {}) {
  const refs = [];
  const errors = [];
  const add = (paths, source) => {
    for (const p of paths) refs.push({ path: p, source });
  };

  // (a) crontab
  try {
    let text;
    if (config.CRONTAB_FILE_OVERRIDE) {
      text = readFileSync(config.CRONTAB_FILE_OVERRIDE, "utf8");
    } else {
      try {
        text = execFileSync("crontab", ["-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
      } catch (err) {
        const stderr = String(err.stderr || "");
        if (/no crontab for/i.test(stderr)) text = "";
        else throw new Error(`crontab -l failed: ${stderr.trim() || err.message}`);
      }
    }
    for (const line of text.split("\n")) {
      if (/^\s*#/.test(line)) continue;
      add(extractPathsFromText(line, home), "crontab");
    }
  } catch (err) {
    errors.push(`crontab: ${err.message}`);
  }

  // (b) systemd user units
  try {
    const dir = config.SYSTEMD_USER_DIR;
    if (existsSync(dir)) {
      for (const name of readdirSync(dir).sort()) {
        if (!/\.(service|timer)$/.test(name)) continue;
        const full = path.join(dir, name);
        let st;
        try {
          st = statSync(full); // follows symlinks into *.wants/
        } catch {
          continue; // dangling symlink: unit cannot run
        }
        if (!st.isFile()) continue;
        add(extractPathsFromUnit(readFileSync(full, "utf8"), home), `systemd ${name}`);
      }
    }
  } catch (err) {
    errors.push(`systemd user units: ${err.message}`);
  }

  // (c) routines + (d) agents
  try {
    const { routines, agents } = await loadDbReferenceRows(config);
    for (const r of routines) {
      const label = `routine ${r.id ?? r.title ?? "?"}`;
      add(extractPathsFromText(`${r.title ?? ""}\n${r.description ?? ""}`, home), label);
    }
    for (const a of agents) {
      add(extractPathsFromAdapterConfig(a.adapter_config, home), `agent ${a.name ?? a.id ?? "?"}`);
    }
  } catch (err) {
    errors.push(`db routines/agents: ${err.message}`);
  }

  // explicit keep-list file
  try {
    if (existsSync(config.KEEP_LIST_FILE)) {
      add(parseKeepList(readFileSync(config.KEEP_LIST_FILE, "utf8"), home), `keep-list ${config.KEEP_LIST_FILE}`);
    }
  } catch (err) {
    errors.push(`keep-list: ${err.message}`);
  }

  return { status: errors.length ? "unavailable" : "ok", refs, errors };
}

/**
 * First reference overlapping `dirPath` (at, inside, or containing), or null.
 * References at or above a scan root (e.g. an agent cwd of `$HOME`, or a cron
 * line naming `~/work`) are ignored: they would shield every candidate and
 * say nothing about which subdirectory is live.
 */
export function findReferenceOverlap(dirPath, refs, scanRoots = []) {
  const resolved = path.resolve(dirPath);
  const roots = scanRoots.map((r) => path.resolve(r));
  for (const ref of refs || []) {
    const p = path.resolve(ref.path);
    if (roots.some((root) => p === root || isPathAncestorOf(p, root))) continue;
    if (p === resolved || isPathAncestorOf(resolved, p) || isPathAncestorOf(p, resolved)) return ref;
  }
  return null;
}

export function hasKeepMarker(dirPath, config = CONFIG) {
  return existsSync(path.join(dirPath, config.KEEP_MARKER_NAME));
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

export function evaluateTmpEntry(entryPath, nowMs, config = CONFIG, registeredPaths = []) {
  const cutoffMs = nowMs - config.TMP_MAX_AGE_DAYS * DAY_MS;
  const registeredRoot = findRegisteredOverlap(entryPath, registeredPaths);
  const eligible = !directoryHasFileNewerThan(entryPath, cutoffMs) && registeredRoot === null;
  return { path: entryPath, eligible, registeredRoot };
}

// ---------------------------------------------------------------------------
// /tmp unmatched agent scratch (any name, owned by the agent uid)
// ---------------------------------------------------------------------------

/**
 * Pure structural filter for one top-level /tmp entry. Returns the exclusion
 * reason, or null when the entry may be age-checked. `entry` is
 * `{ name, uid, kind }` with kind one of dir|file|symlink|socket|fifo|other.
 * Anything that is not a plain dir/file is excluded (sockets/FIFOs are live
 * IPC endpoints; symlinks are not ours to judge).
 */
export function tmpUnmatchedExclusionReason(entry, config = CONFIG) {
  if (config.TMP_SCRATCH_PATTERNS.some((p) => p.test(entry.name))) return "pattern-category";
  if (config.TMP_UNMATCHED_EXCLUDE_PATTERNS.some((p) => p.test(entry.name))) return "protected-name";
  if (entry.kind !== "dir" && entry.kind !== "file") return `special-file:${entry.kind}`;
  if (entry.uid !== config.TMP_OWNER_UID) return "foreign-owner";
  return null;
}

function statKind(st) {
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  if (st.isSymbolicLink()) return "symlink";
  if (st.isSocket()) return "socket";
  if (st.isFIFO()) return "fifo";
  return "other";
}

/**
 * Collect every path that is the cwd, root, or an open fd target of a live
 * process. Returns { ok: false } when /proc cannot be read at all, and also
 * when not a single cwd link was readable (a hardened /proc would otherwise
 * look like "no live users" -- the unsafe answer). Per-process races
 * (process exits mid-scan) are skipped.
 */
export function collectLiveProcessPaths(procDir = CONFIG.PROC_DIR) {
  let pids;
  try {
    pids = readdirSync(procDir).filter((n) => /^\d+$/.test(n));
  } catch (err) {
    return { ok: false, error: `cannot read ${procDir}: ${err.message}`, paths: new Set() };
  }
  const paths = new Set();
  let cwdReads = 0;
  for (const pid of pids) {
    const base = path.join(procDir, pid);
    for (const link of ["cwd", "root"]) {
      try {
        paths.add(readlinkSync(path.join(base, link)).replace(/ \(deleted\)$/, ""));
        if (link === "cwd") cwdReads += 1;
      } catch {
        // exited or not ours
      }
    }
    // mmap'd files (shared libs, node addons, sqlite -shm) of a live process.
    try {
      for (const line of readFileSync(path.join(base, "maps"), "utf8").split("\n")) {
        const i = line.indexOf("/");
        if (i >= 0) paths.add(line.slice(i).replace(/ \(deleted\)$/, ""));
      }
    } catch {
      // exited or not ours
    }
    let fds = [];
    try {
      fds = readdirSync(path.join(base, "fd"));
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = readlinkSync(path.join(base, "fd", fd));
        if (target.startsWith("/")) paths.add(target.replace(/ \(deleted\)$/, ""));
      } catch {
        // fd closed mid-scan
      }
    }
  }
  if (cwdReads === 0) {
    return { ok: false, error: `no readable /proc/*/cwd among ${pids.length} pid(s)`, paths };
  }
  return { ok: true, paths };
}

/**
 * Host paths bind-mounted into running containers. Root-owned container
 * processes are invisible to the /proc scan (we run as the agent uid), so
 * every running container's mount Sources count as live. Any docker failure
 * => { ok: false } (caller fails the category closed). `exec` is injectable.
 */
export function collectDockerMountSources(exec = (bin, args) => execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60000 })) {
  try {
    const ids = exec("docker", ["ps", "-q"]).split(/\s+/).filter(Boolean);
    const paths = new Set();
    if (ids.length === 0) return { ok: true, paths };
    const info = JSON.parse(exec("docker", ["inspect", ...ids]));
    for (const c of info) for (const m of c.Mounts || []) if (m.Source) paths.add(m.Source);
    return { ok: true, paths };
  } catch (err) {
    return { ok: false, error: `docker mount scan failed: ${err.message}`, paths: new Set() };
  }
}

/** /proc scan + docker mount sources, fail closed if either fails. */
export function collectLivePaths(config = CONFIG) {
  const proc = collectLiveProcessPaths(config.PROC_DIR);
  if (!proc.ok) return proc;
  const docker = (config.DOCKER_MOUNTS || collectDockerMountSources)();
  if (!docker.ok) return { ok: false, error: docker.error, paths: proc.paths };
  return { ok: true, paths: new Set([...proc.paths, ...docker.paths]), dockerMounts: docker.paths.size };
}

/** True when any live-process path is the entry itself or inside it. */
export function isEntryInUse(entryPath, livePaths) {
  const resolved = path.resolve(entryPath);
  for (const p of livePaths) {
    if (p === resolved || isPathAncestorOf(resolved, p)) return true;
  }
  return false;
}

/**
 * Scan and classify the unmatched category. Pure given its inputs except for
 * filesystem reads under config.TMP_DIR. `live` is the result of
 * collectLiveProcessPaths(); when !live.ok, nothing is eligible (fail closed).
 */
export function evaluateTmpUnmatched(nowMs, config = CONFIG, { live, registeredPaths = [] } = {}) {
  const out = { candidates: [], excluded: [] };
  if (!existsSync(config.TMP_DIR)) return out;
  const cutoffMs = nowMs - config.TMP_UNMATCHED_MAX_AGE_DAYS * DAY_MS;
  for (const name of readdirSync(config.TMP_DIR)) {
    const p = path.join(config.TMP_DIR, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    const reason = tmpUnmatchedExclusionReason({ name, uid: st.uid, kind: statKind(st) }, config);
    if (reason === "pattern-category") continue; // handled by the pattern rule
    if (reason) {
      out.excluded.push({ path: p, reason });
      continue;
    }
    const registeredRoot = findRegisteredOverlap(p, registeredPaths);
    if (registeredRoot) {
      out.excluded.push({ path: p, reason: "registered-package-path" });
      continue;
    }
    const age = strictNewestLeafMtime(p, config.TMP_AGE_LSTAT || lstatSync);
    if (!age.ok) {
      out.excluded.push({ path: p, reason: "age-walk-error" });
      continue;
    }
    if (age.newestMtimeMs > cutoffMs) continue; // fresh -- not a candidate
    if (!live || !live.ok) {
      out.excluded.push({ path: p, reason: "live-process-scan-failed" });
      continue;
    }
    if (isEntryInUse(p, live.paths)) {
      out.excluded.push({ path: p, reason: "in-use-by-live-process" });
      continue;
    }
    out.candidates.push({ path: p, newestMtimeMs: age.newestMtimeMs });
  }
  return out;
}

/**
 * Fail-closed age signal for the unmatched /tmp category. newest = max of
 * every leaf mtime, every directory mtime (root included), and the top-level
 * entry's own ctime. Directory mtimes and the top-level ctime cannot be
 * carried over by `cp -a` / `tar x` / `npm pack` extracts (those preserve
 * leaf mtimes only), so a tree copied in yesterday reads as fresh. Inner
 * ctimes are deliberately NOT used: hardlink-count changes (store prune,
 * sibling deletes) bump them and would make every tree look fresh.
 * ANY readdir/lstat error => { ok: false } (caller keeps the entry).
 * `lstat` is injectable for tests (ctime cannot be set with utimes).
 */
export function strictNewestLeafMtime(rootPath, lstat = lstatSync) {
  let rootStat;
  try {
    rootStat = lstat(rootPath);
  } catch {
    return { ok: false };
  }
  let newest = Math.max(rootStat.mtimeMs, rootStat.ctimeMs);
  if (!rootStat.isDirectory()) return { ok: true, newestMtimeMs: newest };
  const stack = [rootPath];
  while (stack.length) {
    const dir = stack.pop();
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return { ok: false };
    }
    for (const c of children) {
      const cp = path.join(dir, c.name);
      let st;
      try {
        st = lstat(cp);
      } catch {
        return { ok: false };
      }
      newest = Math.max(newest, st.mtimeMs);
      if (st.isDirectory()) stack.push(cp);
    }
  }
  return { ok: true, newestMtimeMs: newest };
}

/** Newest leaf mtime under a path (for reporting age only). */
export function newestLeafMtimeMs(rootPath) {
  let newest = 0;
  let rootStat;
  try {
    rootStat = lstatSync(rootPath);
  } catch {
    return 0;
  }
  if (!rootStat.isDirectory()) return rootStat.mtimeMs;
  const stack = [rootPath];
  while (stack.length) {
    const dir = stack.pop();
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const c of children) {
      const cp = path.join(dir, c.name);
      if (c.isDirectory()) stack.push(cp);
      else {
        try {
          newest = Math.max(newest, lstatSync(cp).mtimeMs);
        } catch {
          // gone
        }
      }
    }
  }
  return newest || rootStat.ctimeMs;
}

/** Report-only list of big paths outside janitor roots. Never deletes. */
export function scanOwnerDecisionPaths(config = CONFIG) {
  const paths = [...config.OWNER_DECISION_PATHS];
  for (const g of config.OWNER_DECISION_GLOBS) {
    try {
      for (const n of readdirSync(g.dir)) if (g.pattern.test(n)) paths.push(path.join(g.dir, n));
    } catch {
      // dir missing
    }
  }
  return paths
    .filter((p) => existsSync(p))
    .sort()
    .map((p) => ({ path: p, sizeBytes: duBytes(p), newestMtimeMs: newestLeafMtimeMs(p) }));
}

function duBytes(p) {
  try {
    return Number(execFileSync("du", ["-sk", p], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\s/)[0]) * 1024;
  } catch (err) {
    // du exits 1 on unreadable subdirs but still prints the total
    const m = String(err.stdout || "").match(/^(\d+)/);
    return m ? Number(m[1]) * 1024 : dirSizeBytes(p);
  }
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

export function dailyBumpMarker(nowMs) {
  return `<!-- host-disk-janitor:daily-bump ${new Date(nowMs).toISOString().slice(0, 10)} -->`;
}

/**
 * File or bump the disk alarm so a named owner always wakes:
 *   - no open alarm  -> create it assigned to DISK_ALARM_ASSIGNEE_AGENT_ID, status todo.
 *   - open alarm     -> if unassigned or backlog, assign + todo; then post at
 *                       most ONE comment per UTC day (idempotent via a dated
 *                       marker in the comment body, so re-runs converge).
 * `fetchImpl` is injectable for tests. The token is only ever placed in the
 * Authorization header -- never logged or returned.
 */
export async function fileDiskAlarmIssue({
  usePercent,
  threshold,
  companyId,
  credential,
  nowMs = Date.now(),
  config = CONFIG,
  fetchImpl = fetch,
}) {
  const marker = config.DISK_ALARM_ISSUE_TITLE_MARKER;
  const assignee = config.DISK_ALARM_ASSIGNEE_AGENT_ID;
  const createUrl = `${credential.apiBase}/api/companies/${companyId}/issues`;
  const searchUrl =
    `${createUrl}?q=${encodeURIComponent(marker)}&status=${encodeURIComponent(ALARM_OPEN_STATUSES.join(","))}`;
  const headers = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };

  let existing = null;
  try {
    const listResp = await fetchImpl(searchUrl, { headers });
    if (listResp.ok) {
      const body = await listResp.json();
      const issues = Array.isArray(body) ? body : body.issues || body.data || [];
      existing =
        issues.find(
          (issue) =>
            typeof issue.title === "string" &&
            issue.title.includes(marker) &&
            !["done", "closed", "cancelled"].includes(String(issue.status).toLowerCase()),
        ) || null;
    }
  } catch {
    // Best-effort dedup only; fall through and attempt to create.
  }

  if (existing) {
    const ref = existing.identifier || existing.id;
    const result = { created: false, reason: "alarm issue already open", identifier: ref, reassigned: false, commented: false };
    const issueUrl = `${credential.apiBase}/api/issues/${existing.id}`;
    if (!existing.assigneeAgentId || String(existing.status).toLowerCase() === "backlog") {
      const patch = await fetchImpl(issueUrl, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ assigneeAgentId: existing.assigneeAgentId || assignee, status: "todo" }),
      });
      result.reassigned = patch.ok;
      if (!patch.ok) result.reassignError = `HTTP ${patch.status}`;
    }
    const dayMarker = dailyBumpMarker(nowMs);
    let alreadyToday = null;
    try {
      const cResp = await fetchImpl(`${issueUrl}/comments`, { headers });
      if (cResp.ok) {
        const cBody = await cResp.json();
        const comments = Array.isArray(cBody) ? cBody : cBody.comments || cBody.data || [];
        alreadyToday = comments.some((c) => typeof c.body === "string" && c.body.includes(dayMarker));
      }
    } catch {
      // unknown -> do not comment (never spam on a flaky read)
    }
    if (alreadyToday === false) {
      const body = [
        `host-disk-janitor: root disk still at **${usePercent}%** (threshold ${threshold}%).`,
        ``,
        `See the janitor log and \`node scripts/host-disk-janitor.mjs --dry-run\` for reclaim candidates.`,
        dayMarker,
      ].join("\n");
      const post = await fetchImpl(`${issueUrl}/comments`, { method: "POST", headers, body: JSON.stringify({ body }) });
      result.commented = post.ok;
      if (!post.ok) result.commentError = `HTTP ${post.status}`;
    } else if (alreadyToday === null) {
      result.commentError = "could not read comments; skipped daily bump";
    }
    return result;
  }

  const title = `${marker} host disk usage at ${usePercent}% (threshold ${threshold}%)`;
  const description = [
    `Automated alarm from scripts/host-disk-janitor.mjs.`,
    ``,
    `\`df -kP /\` reported ${usePercent}% used, at or above the ${threshold}% threshold.`,
    ``,
    `Run the janitor's dry-run to see current reclaim candidates: node scripts/host-disk-janitor.mjs --dry-run`,
  ].join("\n");

  const resp = await fetchImpl(createUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ title, description, priority: "high", status: "todo", assigneeAgentId: assignee }),
  });
  if (!resp.ok) {
    return { created: false, reason: `issue creation failed: HTTP ${resp.status}` };
  }
  const created = await resp.json();
  return { created: true, identifier: created.identifier || created.id, assigneeAgentId: assignee };
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

export async function run({
  apply = false,
  nowMs = Date.now(),
  config = CONFIG,
  loadRegistered = loadRegisteredPackagePaths,
  loadReferences = loadReferencedPaths,
} = {}) {
  const summary = { mode: apply ? "apply" : "dry-run", timestamp: new Date(nowMs).toISOString(), categories: {} };

  // -- DB-registered plugin install roots (the 2026-09-09 live-deploy reap fix) --
  // Loaded once, up front: the worktree AND /tmp categories both consult it.
  // On lookup failure both categories fail closed for the whole run.
  const registeredLookup = await loadRegistered({ config });
  const registeredPaths = registeredLookup.status === "ok" ? registeredLookup.paths : [];
  const registeredGuardActive = registeredLookup.status === "ok";
  summary.registeredPackagePaths = {
    status: registeredLookup.status,
    source: registeredLookup.source || "unknown",
    count: registeredPaths.length,
    paths: registeredPaths,
  };
  if (registeredLookup.error) summary.registeredPackagePaths.error = registeredLookup.error;

  // -- live references: crontab, systemd user units, routines, agents, keep.txt --
  // (the 2026-10-03 inbox-watchdog reap fix). Any source failure => the
  // worktree category fails closed for the whole run.
  const refLookup = await loadReferences({ config });
  const referenceGuardActive = refLookup.status === "ok";
  summary.referencedPaths = {
    status: refLookup.status,
    count: refLookup.refs.length,
    errors: refLookup.errors,
  };

  // -- backups --
  {
    const dirExists = existsSync(config.BACKUPS_DIR);
    const rawEntries = dirExists
      ? readdirSync(config.BACKUPS_DIR, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => {
            const fullPath = path.join(config.BACKUPS_DIR, e.name);
            return { name: e.name, sizeBytes: statSize(fullPath), fullPath };
          })
      : [];
    // Populate `verified` from disk so classifyBackups stays pure. .sql.gz is
    // the only shape we treat as a backup candidate; only those need an ISIZE
    // probe (cheap: 4 bytes per file).
    const entries = rawEntries.map((e) =>
      e.name.endsWith(".sql.gz") && !e.name.endsWith(".partial")
        ? { ...e, verified: isArchiveVerified(e.fullPath) }
        : e,
    );
    const { keep, prune, unrecognized, unverified } = classifyBackups(entries, config);
    if (apply) {
      // Delete unverified and pruned files
      for (const e of [...unverified, ...prune]) {
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
      unverifiedFiles: unverified.length,
      reclaimedBytes: [...unverified, ...prune].reduce((sum, e) => sum + e.sizeBytes, 0),
      prunedNames: prune.map((e) => e.name),
      unverifiedNames: unverified.map((e) => e.name),
      // Full paths, so the log alone attributes every deletion (so the log alone attributes every deletion).
      prunedPaths: [...unverified, ...prune].map((e) => e.fullPath || path.join(config.BACKUPS_DIR, e.name)),
      unverifiedPaths: unverified.map((e) => e.fullPath || path.join(config.BACKUPS_DIR, e.name)),
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
      prunedPaths: prune.map((f) => f.path),
    };
  }

  // -- worktrees / clones --
  {
    const candidates = scanWorktreeCandidates(config);
    const evaluations = candidates.map((p) =>
      evaluateWorktree(p, nowMs, config, registeredPaths, refLookup.refs),
    );
    const ageEligible = evaluations.filter((e) => e.eligible);
    // Fail closed when the registered-path lookup OR any live-reference
    // source did not answer: any candidate could be a live install root or a
    // tool a scheduler runs, so nothing in this category is deleted until
    // every lookup works again.
    const worktreeGuardsActive = registeredGuardActive && referenceGuardActive;
    const eligible = worktreeGuardsActive ? ageEligible : [];
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
      eligibleBeforeRegisteredGuard: ageEligible.length,
      reclaimedBytes: eligibleSizedBytes,
      eligiblePaths: eligible.map((e) => e.path),
      excludedReview: evaluations.filter((e) => e.classification === "review").map((e) => e.path),
      excludedSelf: evaluations.filter((e) => e.isSelf).map((e) => e.path),
      excludedRegistered: evaluations
        .filter((e) => e.registeredRoot)
        .map((e) => ({ path: e.path, registeredRoot: e.registeredRoot })),
      excludedReferenced: evaluations
        .filter((e) => e.reference)
        .map((e) => ({ path: e.path, source: e.reference.source, referencedPath: e.reference.path })),
      excludedKeepMarker: evaluations.filter((e) => e.keepMarker).map((e) => e.path),
      guardFailureExcludedPaths: registeredGuardActive ? [] : ageEligible.map((e) => e.path),
      referenceGuardFailureExcludedPaths: referenceGuardActive ? [] : ageEligible.map((e) => e.path),
      registrationPrune,
    };
  }

  // -- /tmp scratch --
  {
    const candidates = scanTmpCandidates(config);
    const evaluations = candidates.map((p) => evaluateTmpEntry(p, nowMs, config, registeredPaths));
    const ageEligible = evaluations.filter((e) => e.eligible);
    // Same fail-closed rule as the worktree category above.
    const eligible = registeredGuardActive ? ageEligible : [];
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
      eligibleBeforeRegisteredGuard: ageEligible.length,
      reclaimedBytes: eligibleSizedBytes,
      eligiblePaths: eligible.map((e) => e.path),
      excludedRegistered: evaluations
        .filter((e) => e.registeredRoot)
        .map((e) => ({ path: e.path, registeredRoot: e.registeredRoot })),
      guardFailureExcludedPaths: registeredGuardActive ? [] : ageEligible.map((e) => e.path),
    };
  }

  // -- /tmp unmatched agent scratch (any name, agent uid, >= N days idle) --
  {
    const live = collectLivePaths(config);
    const { candidates, excluded } = evaluateTmpUnmatched(nowMs, config, { live, registeredPaths });
    // Fail closed on registered-path lookup failure too (same rule as above).
    const eligible = registeredGuardActive ? candidates : [];
    const sized = eligible.map((c) => ({ ...c, sizeBytes: duBytes(c.path) }));
    const deleteEnabled = apply && config.TMP_UNMATCHED_DELETE;
    if (deleteEnabled && sized.length) {
      // Sizing takes minutes; re-scan live users right before deleting and
      // re-check age + in-use per entry immediately before rmSync.
      const liveNow = collectLivePaths(config);
      const cutoffMs = nowMs - config.TMP_UNMATCHED_MAX_AGE_DAYS * DAY_MS;
      for (const c of sized) {
        if (!liveNow.ok) {
          c.result = "skipped-at-delete (live-scan-failed)";
          continue;
        }
        const age = strictNewestLeafMtime(c.path, config.TMP_AGE_LSTAT || lstatSync);
        if (!age.ok || age.newestMtimeMs > cutoffMs) {
          c.result = `skipped-at-delete (${age.ok ? "fresh" : "age-walk-error"})`;
          continue;
        }
        if (isEntryInUse(c.path, liveNow.paths)) {
          c.result = "skipped-at-delete (in-use)";
          continue;
        }
        try {
          (config.TMP_RM || rmSync)(c.path, { recursive: true });
          c.result = "deleted";
        } catch (err) {
          c.result = `failed:${err.code || "ERR"}`;
        }
      }
    }
    summary.categories.tmpUnmatched = {
      maxAgeDays: config.TMP_UNMATCHED_MAX_AGE_DAYS,
      deleteEnabled: config.TMP_UNMATCHED_DELETE,
      deleted: deleteEnabled,
      liveProcessScan: live.ok ? { ok: true, paths: live.paths.size } : { ok: false, error: live.error },
      eligible: sized.length,
      deletedCount: sized.filter((c) => c.result === "deleted").length,
      reclaimedBytes: deleteEnabled
        ? sized.filter((c) => c.result === "deleted").reduce((s, c) => s + c.sizeBytes, 0)
        : sized.reduce((s, c) => s + c.sizeBytes, 0),
      candidates: sized.map((c) => ({
        path: c.path,
        sizeBytes: c.sizeBytes,
        result: c.result || null,
        ageDays: Math.max(0, Math.floor((nowMs - c.newestMtimeMs) / DAY_MS)),
      })),
      excluded,
      guardFailureExcludedPaths: registeredGuardActive ? [] : candidates.map((c) => c.path),
    };
  }

  // -- report-only: owner decision needed (never deleted) --
  summary.ownerDecision = scanOwnerDecisionPaths(config).map((e) => ({
    path: e.path,
    sizeBytes: e.sizeBytes,
    ageDays: Math.max(0, Math.floor((nowMs - e.newestMtimeMs) / DAY_MS)),
  }));

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
          nowMs,
          config,
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
  const reg = summary.registeredPackagePaths || { status: "unknown", paths: [], count: 0 };
  const verb = summary.mode === "apply" ? "deleted" : "would delete";
  console.log(`host-disk-janitor: mode=${summary.mode} at ${summary.timestamp}`);
  console.log("");
  // Registered install roots first: they are the reason this run's exclusions
  // look the way they do, and the 2026-09-09 reap was invisible without them.
  if (reg.status === "ok") {
    console.log(`registered plugin package paths (DB): ${reg.count} -- never deletion-eligible`);
    for (const p of reg.paths) console.log(`  registered: ${p}`);
  } else if (reg.status === "unavailable") {
    console.log(`registered plugin package paths: LOOKUP FAILED -- worktree + /tmp pruning DISABLED this run (fail-closed)`);
    if (reg.error) console.log(`  reason: ${reg.error}`);
  } else {
    console.log(`registered plugin package paths: no data (status ${reg.status}) -- worktree + /tmp pruning DISABLED this run (fail-closed)`);
  }
  const refs = summary.referencedPaths;
  if (refs && refs.status === "ok") {
    console.log(`live references (crontab, systemd user units, routines, agents, keep-list): ${refs.count} path(s) -- never deletion-eligible`);
  } else if (refs) {
    console.log(`live references: LOOKUP FAILED -- worktree pruning DISABLED this run (fail-closed)`);
    for (const e of refs.errors || []) console.log(`  reason: ${e}`);
  }
  console.log("");
  console.log(
    `backups:     ${c.backups.prunedFiles}/${c.backups.totalFiles} files ${summary.mode === "apply" ? "deleted" : "would delete"}, ` +
      `${bytesToHuman(c.backups.reclaimedBytes)} ${summary.mode === "apply" ? "freed" : "reclaimable"} (kept ${c.backups.keptFiles}, unrecognized ${c.backups.unrecognizedFiles}, unverified ${c.backups.unverifiedFiles})`,
  );
  for (const p of c.backups.prunedPaths || []) console.log(`  ${verb}: ${p}`);
  for (const p of c.backups.unverifiedPaths || []) console.log(`  ${verb} (failed content verification): ${p}`);
  console.log(
    `run-logs:    ${c.runLogs.prunedFiles}/${c.runLogs.totalFiles} files ${summary.mode === "apply" ? "deleted" : "would delete"}, ` +
      `${bytesToHuman(c.runLogs.reclaimedBytes)} ${summary.mode === "apply" ? "freed" : "reclaimable"} (kept ${c.runLogs.keptFiles})`,
  );
  for (const p of c.runLogs.prunedPaths || []) console.log(`  ${verb}: ${p}`);
  console.log(
    `worktrees:   ${c.worktrees.eligible}/${c.worktrees.totalScanned} dirs ${summary.mode === "apply" ? "deleted" : "would delete"}, ` +
      `${bytesToHuman(c.worktrees.reclaimedBytes)} ${summary.mode === "apply" ? "freed" : "reclaimable"} ` +
      `(excluded as review: ${c.worktrees.excludedReview.length}, excluded as self: ${c.worktrees.excludedSelf.length}, ` +
      `excluded as DB-registered: ${(c.worktrees.excludedRegistered || []).length}, ` +
      `excluded as referenced: ${(c.worktrees.excludedReferenced || []).length}, ` +
      `excluded by keep marker: ${(c.worktrees.excludedKeepMarker || []).length})`,
  );
  for (const p of c.worktrees.eligiblePaths) console.log(`  ${verb}: ${p}`);
  for (const e of c.worktrees.excludedRegistered || []) {
    console.log(`  excluded (registered package path root: ${e.registeredRoot}): ${e.path}`);
  }
  for (const e of c.worktrees.excludedReferenced || []) {
    console.log(`  excluded (referenced by ${e.source}): ${e.path}`);
  }
  for (const p of c.worktrees.excludedKeepMarker || []) {
    console.log(`  excluded (keep marker ${CONFIG.KEEP_MARKER_NAME}): ${p}`);
  }
  for (const p of c.worktrees.guardFailureExcludedPaths || []) {
    console.log(`  excluded (registered-path lookup failed): ${p}`);
  }
  for (const p of c.worktrees.referenceGuardFailureExcludedPaths || []) {
    console.log(`  excluded (live-reference lookup failed): ${p}`);
  }
  if (c.worktrees.registrationPrune) {
    const rp = c.worktrees.registrationPrune;
    console.log(`             git worktree prune: ${rp.pruned} stale registration(s) cleared (${rp.before} -> ${rp.after})`);
  }
  console.log(
    `tmp scratch: ${c.tmpScratch.eligible}/${c.tmpScratch.totalScanned} entries ${summary.mode === "apply" ? "deleted" : "would delete"}, ` +
      `${bytesToHuman(c.tmpScratch.reclaimedBytes)} ${summary.mode === "apply" ? "freed" : "reclaimable"}`,
  );
  for (const p of c.tmpScratch.eligiblePaths) console.log(`  ${verb}: ${p}`);
  for (const e of c.tmpScratch.excludedRegistered || []) {
    console.log(`  excluded (registered package path root: ${e.registeredRoot}): ${e.path}`);
  }
  for (const p of c.tmpScratch.guardFailureExcludedPaths || []) {
    console.log(`  excluded (registered-path lookup failed): ${p}`);
  }
  {
    const u = c.tmpUnmatched;
    const act = u.deleted ? "deleted" : "candidates";
    const verbU = u.deleted ? "deleted" : "would delete";
    console.log(
      `tmp unmatched (>=${u.maxAgeDays}d idle, agent uid): ${u.deleted ? `${u.deletedCount}/${u.eligible}` : u.eligible} ${act}, ${bytesToHuman(u.reclaimedBytes)} ` +
        `${u.deleted ? "freed" : "reclaimable"}` +
        (u.deleteEnabled ? "" : " [REPORT-ONLY: deletion gate PLA_JANITOR_TMP_UNMATCHED_DELETE=1 is off]"),
    );
    if (!u.liveProcessScan.ok) console.log(`  live-process scan FAILED -- category fail-closed: ${u.liveProcessScan.error}`);
    for (const e of u.candidates) {
      console.log(`  ${u.deleted ? e.result : u.deleteEnabled ? verbU : "candidate"}: ${e.path}  ${bytesToHuman(e.sizeBytes)}  ${e.ageDays}d`);
    }
    const counts = {};
    for (const e of u.excluded) counts[e.reason] = (counts[e.reason] || 0) + 1;
    console.log(`  excluded: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
    for (const e of u.excluded) {
      console.log(`  excluded (${e.reason}): ${e.path}`);
    }
  }
  if (summary.ownerDecision && summary.ownerDecision.length) {
    console.log(`owner decision needed (report-only, never deleted):`);
    for (const e of summary.ownerDecision) console.log(`  ${e.path}  ${bytesToHuman(e.sizeBytes)}  ${e.ageDays}d`);
  }
  console.log("");
  const d = summary.diskAlarm;
  if (d.usePercent === null) {
    console.log(`disk alarm:  could not read disk usage`);
  } else if (d.alarmed) {
    console.log(`disk alarm:  ALARM -- ${d.usePercent}% used (threshold ${d.threshold}%)`);
    if (d.wouldFileIssue) {
      console.log(`             would file an issue titled "${CONFIG.DISK_ALARM_ISSUE_TITLE_MARKER} host disk usage at ${d.usePercent}% (threshold ${d.threshold}%)" (dry-run: no network call made)`);
    } else if (d.action) {
      const a = d.action;
      if (a.created) console.log(`             filed issue ${a.identifier} (assigned ${a.assigneeAgentId}, todo)`);
      else if (a.identifier) {
        console.log(
          `             open alarm ${a.identifier}: reassigned=${a.reassigned} daily-comment=${a.commented}` +
            (a.reassignError ? ` reassignError=${a.reassignError}` : "") +
            (a.commentError ? ` commentError=${a.commentError}` : ""),
        );
      } else console.log(`             no issue filed: ${a.reason}`);
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
