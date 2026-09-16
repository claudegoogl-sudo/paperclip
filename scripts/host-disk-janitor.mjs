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

export function evaluateWorktree(dirPath, nowMs, config = CONFIG, registeredPaths = []) {
  const classification = classifyWorktree(dirPath);
  const cutoffMs = nowMs - config.WORKTREE_MAX_AGE_DAYS * DAY_MS;
  const isOldEnough = !directoryHasFileNewerThan(dirPath, cutoffMs, [".git"]);
  const isSelf = isPathAncestorOf(dirPath, config.SELF_SCRIPT_PATH);
  const registeredRoot = findRegisteredOverlap(dirPath, registeredPaths);
  const eligible =
    (classification === "not-a-repo" || classification === "safe") && isOldEnough && !isSelf && registeredRoot === null;
  return { path: dirPath, classification, isOldEnough, isSelf, registeredRoot, eligible };
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
    let rows;
    try {
      const result = await client.query("SELECT package_path FROM plugins WHERE package_path IS NOT NULL");
      rows = result.rows;
    } finally {
      try {
        await client.end();
      } catch {
        // already closed
      }
    }
    const paths = [...new Set(rows.map((r) => path.resolve(String(r.package_path))))].sort();
    return { status: "ok", paths, source: "db", socketDir, port: port || config.PG_PORT, rowCount: rows.length };
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

export async function run({
  apply = false,
  nowMs = Date.now(),
  config = CONFIG,
  loadRegistered = loadRegisteredPackagePaths,
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
    const evaluations = candidates.map((p) => evaluateWorktree(p, nowMs, config, registeredPaths));
    const ageEligible = evaluations.filter((e) => e.eligible);
    // Fail closed when the registered-path lookup did not answer: any
    // candidate could be a live install root the DB would have excluded, so
    // nothing in this category is deleted until the lookup works again.
    const eligible = registeredGuardActive ? ageEligible : [];
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
      guardFailureExcludedPaths: registeredGuardActive ? [] : ageEligible.map((e) => e.path),
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
      `excluded as DB-registered: ${(c.worktrees.excludedRegistered || []).length})`,
  );
  for (const p of c.worktrees.eligiblePaths) console.log(`  ${verb}: ${p}`);
  for (const e of c.worktrees.excludedRegistered || []) {
    console.log(`  excluded (registered package path root: ${e.registeredRoot}): ${e.path}`);
  }
  for (const p of c.worktrees.guardFailureExcludedPaths || []) {
    console.log(`  excluded (registered-path lookup failed): ${p}`);
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
