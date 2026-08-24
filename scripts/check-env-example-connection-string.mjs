#!/usr/bin/env node
/**
 * check-env-example-connection-string.mjs
 *
 * Regression guard for `.env.example`. Rejects a connection string that
 * embeds a literal password in URL userinfo (`scheme://user:password@host`)
 * in the active (non-comment) portion of the file.
 *
 * A credential we ship is the same credential on every install, and it is
 * public with the repo the moment it lands. PR #168 made the Docker Compose
 * stack refuse to start on a shipped `POSTGRES_PASSWORD` default; this check
 * stops the same shape of credential from creeping back in via the example
 * env file, where the URL form does not look like a secret by name.
 *
 * Scope is deliberately narrow on both axes:
 *
 *   - File: `.env.example` only. Not a general weak-secret sweep — that would
 *     couple this gate to `BETTER_AUTH_SECRET`, which is a separate ticket,
 *     and to any future low-entropy example value someone files for.
 *   - Pattern: a URL with an embedded `user:password@` authority. A bare
 *     `KEY=VALUE` line with no `://...@` structure does not match. This is
 *     what keeps the rule from turning into a false-positive generator:
 *     `chown -R paperclip:paperclip` in `docker/Dockerfile.onboard-smoke`
 *     has no scheme, no `://`, and no `@`, so even if that file were ever
 *     scanned the line would not be a finding.
 *
 * A documented placeholder inside a `#` comment is fine — the rule strips
 * comments before matching, so the example shape can stay in the file as
 * guidance without being treated as an active value.
 *
 * The URL-userinfo classifier itself is shared with the compose stack gate
 * (`check-compose-literal-secrets.mjs`), so the two gates cannot drift on
 * what counts as an embedded password.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { classifyUrlValue } from "./check-compose-literal-secrets.mjs";

const DEFAULT_TARGET = ".env.example";

/**
 * Strip a `#` comment from an env line. Unlike YAML, env files do not have
 * quote contexts to track: a `#` not preceded by a backslash starts a comment.
 * No production value in `.env.example` needs a literal `#`, so the unescaped
 * form is the only one parsed here.
 */
export function stripEnvComment(line) {
  const hash = line.indexOf("#");
  return hash >= 0 ? line.slice(0, hash) : line;
}

/**
 * Parse one env line into `{ key, value }`, or `null` for blank, comment-only,
 * or non-assignment lines. The value is the raw text after `=`, before the
 * `#` comment, with surrounding whitespace trimmed.
 */
export function parseEnvEntry(line) {
  const active = stripEnvComment(line);
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(active);
  if (!match) return null;
  return { key: match[1], value: match[2].trim() };
}

export function findOffenses(text) {
  const lines = text.split("\n");
  const offenses = [];

  for (let index = 0; index < lines.length; index += 1) {
    const entry = parseEnvEntry(lines[index]);
    if (!entry) continue;

    const result = classifyUrlValue(entry.value);
    if (!result.ok) {
      offenses.push({
        lineNumber: index + 1,
        key: entry.key,
        reason: result.reason,
        line: lines[index].trim(),
      });
    }
  }

  return offenses;
}

export function runCheck({
  repoRoot = process.cwd(),
  target = DEFAULT_TARGET,
  log = console.log,
  error = console.error,
} = {}) {
  const absolute = path.resolve(repoRoot, target);
  let text;
  try {
    text = readFileSync(absolute, "utf8");
  } catch {
    error(
      `ERROR: \`${target}\` not found. The connection-string gate cannot pass vacuously: ` +
        "if the example env moved, point this check at the new path.",
    );
    return 1;
  }

  const offenses = findOffenses(text);
  if (offenses.length > 0) {
    error(`ERROR: literal connection-string credentials in \`${target}\`:\n`);
    for (const offense of offenses) {
      error(`  ${target}:${offense.lineNumber}: ${offense.line}`);
      error(`      ${offense.reason}`);
    }
    error(
      "\nA credential we ship is a credential every install shares, and it is public with the repo.",
    );
    error(
      "Set the value empty and document the shape in a `#` comment, or interpolate the variable the stack already requires.",
    );
    return 1;
  }

  log(`  ✓  No literal connection-string credentials in \`${target}\`.`);
  return 0;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  process.exit(runCheck());
}
