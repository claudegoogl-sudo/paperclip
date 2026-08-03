#!/usr/bin/env node
/**
 * check-no-internal-ids.mjs
 *
 * PR-diff regression guard for CONTRIBUTING.md's "No Internal Issue
 * References" rule. Fails a PR that adds, into any tracked file, one of the
 * internal/instance-local reference forms contributors run their own
 * Paperclip instance and accidentally leak: an internal ticket id, an
 * instance UI deep link, an `agent://` link, or a localhost/private-IP deep
 * link into the instance UI.
 *
 * Scoped to ADDED lines only (unified diff `+` lines) in the PR's changed
 * files, base...head. Pre-existing history is intentionally out of scope —
 * squash-scrubbing tracked files does not rewrite git history, so older
 * commits still carry ids; this guard only stops the leak from recurring.
 *
 * This file and its test fixture are excluded from the scan: they
 * necessarily reference the very patterns being detected (the check's own
 * pattern source, and the test's positive-control fixture), and excluding a
 * self-referential guard from its own scan is the standard shape for this
 * kind of check.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = "packages/db/src/migrations";

export const EXCLUDED_PATHS = new Set([
  "scripts/check-no-internal-ids.mjs",
  "scripts/check-no-internal-ids.test.mjs",
]);

// Internal ticket ids follow this instance's own `{PREFIX}-{NUMBER}` scheme.
// Matched case-sensitively: lowercase env-var-style / fixture identifiers
// (e.g. `pla-447-extract` as an example tmp-dir name) are a different,
// intentionally out-of-scope shape.
export const FORBIDDEN_PATTERNS = [
  {
    name: "internal-ticket-id",
    pattern: /\bPLA-[0-9]{1,6}\b/,
    describe: (m) => `internal ticket id "${m}"`,
  },
  {
    name: "instance-ui-link",
    pattern: /\/PLA\/[a-zA-Z][a-zA-Z0-9_-]*\//,
    describe: (m) => `instance UI link "${m}"`,
  },
  {
    name: "agent-protocol-link",
    pattern: /\bagent:\/\/[^\s"'`)]+/,
    describe: (m) => `agent:// link "${m}"`,
  },
  {
    name: "tailnet-url",
    pattern: /\b[a-zA-Z0-9-]+\.ts\.net\b/,
    describe: (m) => `tailnet URL "${m}"`,
  },
  {
    // Bare localhost/private-IP is normal dev/CI config (webServer bind
    // addresses, health checks, etc.) and a full-tree audit found zero real
    // leaks in that broader form. Only flag it paired with an instance UI
    // path segment, the actual "points at your own instance" signal from
    // CONTRIBUTING.md.
    name: "local-instance-deep-link",
    pattern:
      /(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}):\d+\/PLA\//,
    describe: (m) => `localhost/private-IP instance deep link "${m}"`,
  },
];

/**
 * Parse `git diff --unified=0` output into added-line records:
 * `{ file, lineNumber, content }[]`. `lineNumber` is the 1-based line number
 * in the *new* file. Deleted files (`+++ /dev/null`) are skipped.
 */
export function extractAddedLines(diffText) {
  const lines = diffText.split("\n");
  const added = [];
  let currentFile = null;
  let newLineNumber = null;

  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      currentFile = raw === "/dev/null" ? null : raw.replace(/^b\//, "");
      newLineNumber = null;
      continue;
    }
    if (line.startsWith("@@")) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      newLineNumber = match ? Number(match[1]) : null;
      continue;
    }
    if (currentFile === null || newLineNumber === null) continue;
    if (line.startsWith("+")) {
      added.push({ file: currentFile, lineNumber: newLineNumber, content: line.slice(1) });
      newLineNumber += 1;
      continue;
    }
    if (line.startsWith("-")) continue; // removed line; new-file numbering unaffected
    if (line.startsWith(" ")) newLineNumber += 1; // context line (only appears with non-zero context)
  }

  return added;
}

/** Scan pre-extracted added lines for forbidden forms. Returns findings; empty = clean. */
export function scanAddedLinesForForbiddenIds(addedLines, { excludedPaths = EXCLUDED_PATHS } = {}) {
  const findings = [];
  for (const { file, lineNumber, content } of addedLines) {
    if (excludedPaths.has(file)) continue;
    for (const { name, pattern, describe } of FORBIDDEN_PATTERNS) {
      const match = pattern.exec(content);
      if (match) {
        findings.push({
          file,
          lineNumber,
          patternName: name,
          match: match[0],
          description: describe(match[0]),
          line: content.trim(),
        });
      }
    }
  }
  return findings;
}

/** Convenience: scan a raw `git diff --unified=0` text directly. */
export function scanDiffForForbiddenIds(diffText, opts) {
  return scanAddedLinesForForbiddenIds(extractAddedLines(diffText), opts);
}

export function formatFindings(findings) {
  const header =
    'ERROR: this PR diff adds an internal/instance-local reference forbidden by CONTRIBUTING.md "No Internal Issue References":\n';
  const body = findings.map((f) => `  ${f.file}:${f.lineNumber}: ${f.description}\n    ${f.line}`).join("\n");
  const footer =
    "\nRestate any useful context in plain English instead of citing the internal id/link. " +
    "See CONTRIBUTING.md#no-internal-issue-references.";
  return `${header}${body}${footer}`;
}

export function runCheck({ baseRef, headRef, execImpl = execFileSync, log = console.log, error = console.error } = {}) {
  if (!baseRef || !headRef) {
    error("check-no-internal-ids: both baseRef and headRef are required");
    return 1;
  }
  const diffText = execImpl("git", ["diff", "--unified=0", `${baseRef}...${headRef}`, "--", "."], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });

  // Exclude only migrations that are ALREADY RELEASED (present at the base
  // ref). Those are append-only, comments included, so the scrub must not want
  // to rewrite them — that would fight the append-only guard and re-apply the
  // migration on every existing database (see check-migrations-append-only.mjs;
  // the remedy for an id in a released migration is a NEW forward migration).
  //
  // A migration ADDED in this PR is NOT released yet, carries no re-apply risk,
  // and — once it merges it becomes append-only forever — is the last chance to
  // catch a leaked id, so the scan still runs on it. Keying on the base ref
  // (not a blanket path prefix) makes the excluded set exactly the protected
  // set instead of a strict superset.
  const releasedMigrations = new Set(
    execImpl("git", ["ls-tree", "-r", "--name-only", baseRef, "--", MIGRATIONS_DIR], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
    })
      .split("\n")
      .filter(Boolean),
  );

  const findings = scanDiffForForbiddenIds(diffText, {
    excludedPaths: new Set([...EXCLUDED_PATHS, ...releasedMigrations]),
  });
  if (findings.length > 0) {
    error(formatFindings(findings));
    return 1;
  }
  log("  ✓  No internal ticket ids, instance links, agent:// links, or local-instance deep links added in this diff.");
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
