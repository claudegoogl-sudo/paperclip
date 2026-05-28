#!/usr/bin/env node
/**
 * resolve-trivial-sync-conflicts.mjs
 *
 * Best-effort conflict resolver for upstream-sync merges. Called by
 * scripts/upstream-sync.mjs after a merge that left unresolved files.
 * Anything outside the allow-list is left with conflict markers so the
 * caller can escalate.
 *
 * Allow-list:
 *   - pnpm-lock.yaml   → take theirs, then `pnpm install` to regenerate.
 *                        The fork's pr.yml lockfile-block carve-out covers
 *                        chore/refresh-lockfile only, so sync branches must
 *                        explicitly own a lockfile-only change set.
 *   - CHANGELOG*       → concatenate both sides with a divider.
 *   - docs/**.md, README*
 *                      → take theirs (upstream is canonical for docs) when
 *                        both sides only added prose. If either side has
 *                        deletions, escalate.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", ...opts });
}

function unresolvedFiles() {
  const out = git(["diff", "--name-only", "--diff-filter=U"]).trim();
  return out ? out.split("\n").filter(Boolean) : [];
}

function takeTheirs(file) {
  git(["checkout", "--theirs", "--", file]);
  git(["add", "--", file]);
}

function concatChangelog(file) {
  const abs = path.join(repoRoot, file);
  const ours = git(["show", `:2:${file}`]);
  const theirs = git(["show", `:3:${file}`]);
  const merged = [theirs, "", "<!-- merged from fork -->", "", ours].join("\n");
  writeFileSync(abs, merged);
  git(["add", "--", file]);
}

function isDocOnlyAddition(file) {
  // Both sides only added lines vs the merge-base ⇒ taking theirs is safe.
  try {
    const diff = git(["diff", "--cc", "--", file]);
    // Heuristic: if any line in the combined diff starts with " -" (a deletion
    // on either side), refuse to auto-resolve.
    return !diff.split("\n").some((line) => /^[ +]-/.test(line));
  } catch {
    return false;
  }
}

function isPnpmLock(file) {
  return file === "pnpm-lock.yaml";
}

function isChangelog(file) {
  return /(^|\/)CHANGELOG[^/]*$/.test(file);
}

function isProseDoc(file) {
  return /^docs\/.+\.md$/.test(file) || /(^|\/)README[^/]*$/.test(file);
}

async function regeneratePnpmLock() {
  // Drop the lockfile entirely and reinstall so the resulting lockfile is
  // genuinely owned by this branch, not a merge-then-edit artifact.
  execFileSync("pnpm", ["install", "--no-frozen-lockfile"], { cwd: repoRoot, stdio: "inherit" });
  git(["add", "pnpm-lock.yaml"]);
}

async function main() {
  const files = unresolvedFiles();
  let needsPnpmRegen = false;

  for (const file of files) {
    if (isPnpmLock(file)) {
      takeTheirs(file);
      needsPnpmRegen = true;
      continue;
    }
    if (isChangelog(file)) {
      concatChangelog(file);
      continue;
    }
    if (isProseDoc(file) && isDocOnlyAddition(file)) {
      takeTheirs(file);
      continue;
    }
    // Unhandled — leave for caller to escalate.
  }

  if (needsPnpmRegen) {
    await regeneratePnpmLock();
  }

  const remaining = unresolvedFiles();
  if (remaining.length > 0) {
    console.error(`unresolved after auto-pass: ${remaining.join(", ")}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
