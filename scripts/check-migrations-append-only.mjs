#!/usr/bin/env node
/**
 * check-migrations-append-only.mjs
 *
 * CI guard: released database migrations are append-only, comments included.
 *
 * The migration runner identifies a migration by the sha256 of the *whole
 * file* (comment header included) and dedupes on that hash alone — the live
 * `drizzle.__drizzle_migrations` table has only `id, hash, created_at`, no
 * `name` column, so the hash is the migration's identity in practice
 * (packages/db/src/client.ts). Editing an already-released migration file —
 * even just its comment header — therefore mints a *new* identity, and the
 * runner re-applies the migration on every existing database on the next
 * boot. A DDL migration re-running against a populated schema can silently
 * revert data or drop a control that was flipped after the original run.
 *
 * Identity is CONTENT, not path. So this guard keys on the git blob OID (which
 * is exactly a content hash): for every migration journaled at the PR's base
 * ref, it requires that migration's base blob to still exist at head as a file
 * the runner actually reads — a `.sql` file directly in the migrations dir, no
 * subdirectory (client.ts is non-recursive). It fails when the released bytes
 * have vanished from that runner-visible set. Bytes parked where the runner
 * never looks (a stray `*.sql.orig` merge artifact, or a copy under `meta/`)
 * do not keep the migration applied, so they do not satisfy the invariant.
 *
 * This closes the whole class, including the rename-bypass a path-keyed check
 * misses: pairing a comment edit with a rename (or a delete + re-add under a
 * new name) changes the file's path so a path-keyed compare finds nothing, yet
 * the runner still re-applies the DML because the content — hence the hash —
 * is new. Keying on blob OID makes the invariant path-independent.
 *
 * Base ref: the PR base commit (`base.sha`, i.e. the tip of the branch being
 * merged into — normally `master`). A migration is treated as "released" when
 * it is already journaled on that base ref; comparing against the base rather
 * than a release tag keeps the check self-contained to the PR diff and needs
 * no tag lookup.
 *
 * Allowed, by construction (the base blob still exists at head):
 *   - Adding a new migration file (its OID is simply new; existing OIDs are
 *     untouched).
 *   - Renaming a byte-identical file, i.e. renumbering identical content: the
 *     OID is unchanged, so it is still present under the new name at head. The
 *     runner tolerates such renames because the content hash is unchanged, so
 *     this guard must too.
 *
 * Rejected (the base blob is gone at head):
 *   - Editing a released migration in place.
 *   - Renaming a released migration *and* editing its bytes.
 *   - Deleting a released migration. Deletion diverges fresh databases from
 *     existing ones, and "delete + re-add under a new name" is the rename
 *     bypass in two steps, so a vanished released blob is a violation.
 *
 * If a released migration genuinely must change (e.g. it contains an internal
 * id that leaked), the correct remedy is a NEW forward migration, never an
 * edit to (or removal of) the released file.
 *
 * Fails closed: if either ref is not resolvable to a commit (history not
 * fetched, bad object), the guard errors rather than reporting a green "nothing
 * changed" it never actually verified. It needs full history (fetch-depth: 0)
 * and runs in the PR `policy` job alongside the other packages/db checks.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = "packages/db/src/migrations";
export const JOURNAL_PATH = `${MIGRATIONS_DIR}/meta/_journal.json`;

/**
 * True when `relPath` is a migration the runner will actually read: a `.sql`
 * file directly in the migrations dir, no subdirectory. Mirrors client.ts.
 */
export function isRunnerVisibleMigration(relPath) {
  if (!relPath.startsWith(`${MIGRATIONS_DIR}/`) || !relPath.endsWith(".sql")) return false;
  return !relPath.slice(MIGRATIONS_DIR.length + 1).includes("/");
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** Extract the ordered list of migration tags (filenames without `.sql`) from a `_journal.json` string. */
export function parseJournalTags(journalText) {
  let parsed;
  try {
    parsed = JSON.parse(journalText);
  } catch (cause) {
    throw new Error(`could not parse ${JOURNAL_PATH}: ${cause.message}`);
  }
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  return entries.map((entry) => entry?.tag).filter((tag) => typeof tag === "string" && tag.length > 0);
}

/**
 * Pure core, keyed on CONTENT SURVIVAL rather than on path.
 *
 * A released migration is a violation when its base blob OID (git's blob OID is
 * a content hash, so OID equality *is* byte equality) no longer exists anywhere
 * under the migrations dir at head. This single invariant covers the in-place
 * edit, the rename-plus-edit bypass, and deletion, while allowing the two cases
 * the runner tolerates — a byte-identical renumber (OID preserved) and adding a
 * brand-new migration (existing OIDs untouched).
 *
 * @param {object}              args
 * @param {string[]}            args.baseTags   migration tags journaled at base
 * @param {Map<string,string>}  args.baseBlobs  relPath -> blob OID present at base under the migrations dir
 * @param {Set<string>}         args.headOids   set of blob OIDs present at head under the migrations dir
 * @returns {{ file: string, baseOid: string }[]} released migrations whose bytes are gone at head
 */
export function findReleasedMigrationViolations({ baseTags, baseBlobs, headOids }) {
  const findings = [];
  for (const tag of baseTags) {
    const relPath = `${MIGRATIONS_DIR}/${tag}.sql`;
    const oid = baseBlobs.get(relPath);
    // Journaled but not present as a file at base: nothing released to protect.
    if (oid === undefined) continue;
    if (!headOids.has(oid)) findings.push({ file: relPath, baseOid: oid });
  }
  return findings;
}

/**
 * Render enriched findings for the CI log. Each finding carries the released
 * path, its base sha256, and — when the same path still exists at head (an
 * in-place edit) — the head sha256; for a rename/delete there is no single head
 * path, so `headHash` is `null`.
 */
export function formatFindings(findings) {
  const header =
    "ERROR: this PR removes the released bytes of one or more already-released (journaled) database migrations.\n" +
    "Released migrations are append-only, comments included.\n\n" +
    "The migration runner identifies a migration by sha256 of the whole file (packages/db/src/client.ts)\n" +
    "and dedupes on that hash alone. Editing a released migration's bytes — even just its comment header,\n" +
    "and even paired with a rename — mints a new identity and RE-APPLIES the migration on every existing\n" +
    "database. Deleting one diverges fresh databases from existing ones. Identity is content, not path.\n\n";
  const body = findings
    .map((f) => {
      const headLine =
        f.headHash === null
          ? "    head: released bytes no longer present under the migrations dir (renamed with edits, or deleted)"
          : `    head sha256: ${f.headHash}`;
      return `  ${f.file}\n    base sha256: ${f.baseHash}\n${headLine}`;
    })
    .join("\n");
  const footer =
    "\n\nRestore the released file(s) above byte-for-byte (a byte-identical renumber is fine). If a released\n" +
    "migration genuinely must change, add a NEW forward migration instead of editing or removing it.";
  return `${header}${body}${footer}`;
}

/** Read `git show <ref>:<relPath>`, returning `null` when the path does not exist at that ref. */
function gitShowOrNull(execImpl, ref, relPath) {
  try {
    return execImpl("git", ["show", `${ref}:${relPath}`], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
      // Absent paths are expected (renames/removals); swallow git's "fatal:
      // path does not exist" stderr so it doesn't clutter the CI log. Safe to
      // swallow because runCheck has already proven the ref itself resolves, so
      // a failure here can only mean "path absent at this ref", not "bad ref".
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * Return `Map<relPath, blobOid>` for every blob under the migrations dir at
 * `ref`. `git ls-tree -r` lines are `<mode> SP <type> SP <oid> TAB <path>`.
 */
function gitLsTreeBlobs(execImpl, ref) {
  const out = execImpl("git", ["ls-tree", "-r", ref, "--", MIGRATIONS_DIR], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
  const blobs = new Map();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const oid = line.slice(0, tab).split(/\s+/)[2];
    const relPath = line.slice(tab + 1);
    if (oid) blobs.set(relPath, oid);
  }
  return blobs;
}

/** True when `ref` resolves to a commit object. Used to fail closed on an unfetched/bad ref. */
function refResolvesToCommit(execImpl, ref) {
  try {
    execImpl("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export function runCheck({ baseRef, headRef, execImpl = execFileSync, log = console.log, error = console.error } = {}) {
  if (!baseRef || !headRef) {
    error("check-migrations-append-only: both baseRef and headRef are required");
    return 1;
  }

  // Fail CLOSED on an unreadable ref. `git show`/`ls-tree` cannot distinguish
  // "path legitimately absent" from "ref not fetched / bad object", so verify
  // both refs resolve to commits first — otherwise a history/fetch problem
  // would sail through as a green "nothing changed" that verified nothing.
  for (const ref of [baseRef, headRef]) {
    if (!refResolvesToCommit(execImpl, ref)) {
      error(
        `check-migrations-append-only: ref "${ref}" is not resolvable to a commit — refusing to pass (fail closed). ` +
          "Ensure the workflow fetches full history (fetch-depth: 0).",
      );
      return 1;
    }
  }

  const journalText = gitShowOrNull(execImpl, baseRef, JOURNAL_PATH);
  if (journalText === null) {
    // No journal at the base ref (e.g. a brand-new tree): nothing is
    // "released" yet, so there is nothing to protect.
    log(`  ✓  No ${JOURNAL_PATH} at base ref; no released migrations to check.`);
    return 0;
  }

  const baseTags = parseJournalTags(journalText);
  if (baseTags.length === 0) {
    log(`  ✓  ${JOURNAL_PATH} at base ref lists no migrations; nothing released to check.`);
    return 0;
  }

  const baseBlobs = gitLsTreeBlobs(execImpl, baseRef);
  // Survival must be measured over the files the RUNNER actually reads: `.sql`
  // files directly in the migrations dir (client.ts readdir + isFile +
  // endsWith(".sql"), non-recursive). Bytes parked where the runner never looks
  // — a stray `*.sql.orig` merge artifact, or a copy under `meta/` — do not
  // keep the released migration applied, so they must not satisfy the invariant.
  const headOids = new Set(
    [...gitLsTreeBlobs(execImpl, headRef)].filter(([p]) => isRunnerVisibleMigration(p)).map(([, oid]) => oid),
  );

  const violations = findReleasedMigrationViolations({ baseTags, baseBlobs, headOids });

  if (violations.length > 0) {
    const enriched = violations.map((v) => {
      const baseContent = gitShowOrNull(execImpl, baseRef, v.file);
      const headContent = gitShowOrNull(execImpl, headRef, v.file);
      return {
        file: v.file,
        baseHash: baseContent === null ? "(unreadable)" : sha256(baseContent),
        // Same path still present at head => in-place edit; absent => rename/delete.
        headHash: headContent === null ? null : sha256(headContent),
      };
    });
    error(formatFindings(enriched));
    return 1;
  }
  log(`  ✓  All ${baseTags.length} released migrations' bytes are still present at head (append-only preserved).`);
  return 0;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const baseRef = process.argv[2] || process.env.PR_BASE_SHA;
  const headRef = process.argv[3] || process.env.PR_HEAD_SHA;
  process.exit(runCheck({ baseRef, headRef }));
}
