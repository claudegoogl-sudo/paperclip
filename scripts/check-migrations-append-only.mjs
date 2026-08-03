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
 * This guard compares every migration listed in `_journal.json` at the PR's
 * base ref against the same path at the PR head, and fails if the content
 * hash of any file present in both has changed. It runs in the PR `policy`
 * job (fetch-depth: 0), the same workflow as the other packages/db checks.
 *
 * Base ref: the PR base commit (`base.sha`, i.e. the tip of the branch being
 * merged into — normally `master`). A migration is treated as "released" when
 * it is already journaled on that base ref; comparing against the base rather
 * than a release tag keeps the check self-contained to the PR diff and needs
 * no tag lookup.
 *
 * Allowed, by construction:
 *   - Adding a new migration file (not journaled at base → never compared).
 *   - Renaming a byte-identical file, i.e. renumbering identical content: the
 *     old path is absent at head (skipped) and the new path is not journaled
 *     at base (never compared). The runner tolerates such renames because the
 *     content hash is unchanged, so this guard must too.
 *
 * If a released migration genuinely must change (e.g. it contains an internal
 * id that leaked), the correct remedy is a NEW forward migration, never an
 * edit to the released file.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = "packages/db/src/migrations";
export const JOURNAL_PATH = `${MIGRATIONS_DIR}/meta/_journal.json`;

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
 * Pure core: given the base-ref journal tags and two readers that return a
 * migration's content at a ref (or `null` when the path is absent at that
 * ref), return the list of released migrations whose content hash changed.
 *
 * `readBase`/`readHead` are `(relPath: string) => string | null`.
 */
export function findChangedReleasedMigrations({ baseTags, readBase, readHead }) {
  const findings = [];
  for (const tag of baseTags) {
    const relPath = `${MIGRATIONS_DIR}/${tag}.sql`;
    const baseContent = readBase(relPath);
    const headContent = readHead(relPath);
    // Present in BOTH is the only case we compare: a file that is gone at head
    // is a rename/removal, not an in-place content change, and byte-identical
    // renames must stay allowed.
    if (baseContent === null || headContent === null) continue;
    const baseHash = sha256(baseContent);
    const headHash = sha256(headContent);
    if (baseHash !== headHash) {
      findings.push({ file: relPath, baseHash, headHash });
    }
  }
  return findings;
}

export function formatFindings(findings) {
  const header =
    "ERROR: this PR changes the content of one or more already-released (journaled) database migrations.\n" +
    "Released migrations are append-only, comments included.\n\n" +
    "The migration runner identifies a migration by sha256 of the whole file (packages/db/src/client.ts)\n" +
    "and dedupes on that hash alone, so changing a released migration's bytes — even just its comment\n" +
    "header — mints a new identity and RE-APPLIES the migration on every existing database.\n\n";
  const body = findings
    .map((f) => `  ${f.file}\n    base sha256: ${f.baseHash}\n    head sha256: ${f.headHash}`)
    .join("\n");
  const footer =
    "\n\nRevert the change to the released file(s) above. If a released migration genuinely must change,\n" +
    "add a NEW forward migration instead of editing the released one.";
  return `${header}${body}${footer}`;
}

/** Read `git show <ref>:<relPath>`, returning `null` when the path does not exist at that ref. */
function gitShowOrNull(execImpl, ref, relPath) {
  try {
    return execImpl("git", ["show", `${ref}:${relPath}`], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
      // Absent paths are expected (renames/removals); swallow git's "fatal:
      // path does not exist" stderr so it doesn't clutter the CI log.
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // `git show ref:path` exits non-zero when the path is absent at that ref.
    return null;
  }
}

export function runCheck({ baseRef, headRef, execImpl = execFileSync, log = console.log, error = console.error } = {}) {
  if (!baseRef || !headRef) {
    error("check-migrations-append-only: both baseRef and headRef are required");
    return 1;
  }

  const journalText = gitShowOrNull(execImpl, baseRef, JOURNAL_PATH);
  if (journalText === null) {
    // No journal at the base ref (e.g. a brand-new tree): nothing is
    // "released" yet, so there is nothing to protect.
    log(`  ✓  No ${JOURNAL_PATH} at base ref; no released migrations to check.`);
    return 0;
  }

  const baseTags = parseJournalTags(journalText);
  const findings = findChangedReleasedMigrations({
    baseTags,
    readBase: (relPath) => gitShowOrNull(execImpl, baseRef, relPath),
    readHead: (relPath) => gitShowOrNull(execImpl, headRef, relPath),
  });

  if (findings.length > 0) {
    error(formatFindings(findings));
    return 1;
  }
  log(`  ✓  No released migration content changed (checked ${baseTags.length} journaled migrations).`);
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
