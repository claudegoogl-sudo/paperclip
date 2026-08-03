#!/usr/bin/env node
/**
 * check-compose-literal-secrets.mjs
 *
 * Static check that rejects literal credentials in the shipped container stacks.
 *
 * A password baked into a file we ship is the same password on every install, so
 * it is public the moment the repo is. For the Postgres stack that is not merely
 * data access: `COPY ... FROM PROGRAM` gives command execution as the `postgres`
 * user, and the database holds agent credentials and secret material. Reach is
 * every container on the Compose network plus, because the stack publishes the
 * port, every local user on the host.
 *
 * The fix this guards is fail-closed configuration: `${VAR:?reason}`, which makes
 * Compose refuse to start with a clear error rather than boot on a weak default.
 *
 * Scope (mirrors check-compose-loopback-bind.mjs):
 *   - `docker/*.yml` — `KEY: value` and `- KEY=value` entries.
 *   - `docker/quadlet/*` — `Environment=KEY=value` entries.
 *
 * Two kinds of offense:
 *   1. A secret-named key (`*PASSWORD*`, `*SECRET*`, `*TOKEN*`, `*API_KEY*`, ...)
 *      whose value is anything other than a pure interpolation. A non-empty
 *      default such as `${POSTGRES_PASSWORD:-paperclip}` counts: the shipped
 *      default is still the credential every default install runs with.
 *   2. A URL with an inline userinfo password (`postgres://user:pw@host`) whose
 *      password segment is not fully interpolated. `DATABASE_URL` does not read
 *      as a secret by name, which is exactly how the password came to be
 *      duplicated there.
 *
 * Deliberate exceptions opt in with a `paperclip:allow-literal-secret: <reason>`
 * comment on the offending line or the line immediately above, so an exception is
 * reviewable rather than invisible.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_COMPOSE_DIR = "docker";
const DEFAULT_QUADLET_DIR = "docker/quadlet";
const COMPOSE_EXTENSIONS = new Set([".yml", ".yaml"]);

export const ALLOW_MARKER = "paperclip:allow-literal-secret";

const SECRET_KEY_PATTERN =
  /(PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)/i;

/**
 * `POSTGRES_PASSWORD_FILE: /run/secrets/pg` is the Docker secrets convention: the
 * value is a path to read the credential from, not the credential.
 */
const SECRET_FILE_KEY_PATTERN = /_FILE$/i;

/** Placeholder that stands in for a `${...}` block; contains no URL metacharacter. */
const INTERPOLATION_MASK = "\u0001";

/** Strip a trailing `#` comment that is not inside a quoted scalar. */
export function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (!inDouble && char === "'") inSingle = !inSingle;
    else if (!inSingle && char === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && char === "#") return line.slice(0, index);
  }
  return line;
}

export function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === '"' || first === "'") && trimmed[trimmed.length - 1] === first) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Replace every brace-balanced `${...}` with a single placeholder character.
 * `${VAR:?use openssl rand -hex 32}` carries `:` and other URL metacharacters
 * that would otherwise be mis-parsed as structure.
 */
export function maskInterpolations(value) {
  let out = "";
  let index = 0;
  while (index < value.length) {
    if (value[index] === "$" && value[index + 1] === "{") {
      let depth = 0;
      let cursor = index + 1;
      for (; cursor < value.length; cursor += 1) {
        if (value[cursor] === "{") depth += 1;
        else if (value[cursor] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (cursor < value.length) {
        out += INTERPOLATION_MASK;
        index = cursor + 1;
        continue;
      }
    }
    out += value[index];
    index += 1;
  }
  return out;
}

/**
 * A value is safe when it carries no literal credential material: either empty,
 * or nothing but interpolations that have no non-empty inline default.
 */
export function classifySecretValue(rawValue) {
  const value = unquote(rawValue);
  if (value === "") return { ok: true };

  if (maskInterpolations(value).replaceAll(INTERPOLATION_MASK, "") !== "") {
    return {
      ok: false,
      reason:
        "value is a literal credential; shipping it makes it the same credential on every install. " +
        "Use `${VAR:?reason}` so the stack refuses to start until an operator sets one.",
    };
  }

  // Pure interpolation — reject a non-empty inline default, which ships a
  // credential just as surely as a bare literal does.
  const defaulted = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(:-|-|:\+|\+)([\s\S]*)\}$/.exec(value.trim());
  if (defaulted && defaulted[3] !== "") {
    return {
      ok: false,
      reason:
        `\`${value}\` defaults to a shipped credential, so a default install still runs with it. ` +
        `Use \`\${${defaulted[1]}:?reason}\` to fail closed instead.`,
    };
  }

  return { ok: true };
}

/**
 * Reject `scheme://user:password@host` where the password is not fully
 * interpolated. Returns `{ ok: true }` for URLs with no userinfo password.
 */
export function classifyUrlValue(rawValue) {
  const value = unquote(rawValue);
  const masked = maskInterpolations(value);

  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)@/.exec(masked);
  if (!match) return { ok: true };

  const separator = match[1].indexOf(":");
  if (separator < 0) return { ok: true };

  const password = match[1].slice(separator + 1);
  if (password.replaceAll(INTERPOLATION_MASK, "") === "") return { ok: true };

  return {
    ok: false,
    reason:
      "URL embeds a literal password in its userinfo field. Interpolate the same variable the " +
      "credential's owning service uses, e.g. `${POSTGRES_PASSWORD:?reason}`, so the two cannot drift.",
  };
}

function classifyEntry(key, value) {
  if (SECRET_KEY_PATTERN.test(key) && !SECRET_FILE_KEY_PATTERN.test(key)) {
    const result = classifySecretValue(value);
    if (!result.ok) return result;
  }
  return classifyUrlValue(value);
}

/**
 * Pull `KEY: value`, `- KEY=value` and `Environment=KEY=value` out of one line.
 * Deliberately indentation-agnostic: a secret-named key anywhere in a shipped
 * stack file is a finding regardless of which block it sits in.
 */
export function extractEntry(line) {
  const text = stripComment(line).trim();
  if (text === "") return null;

  const environmentDirective = /^Environment=([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(text);
  if (environmentDirective) {
    return { key: environmentDirective[1], value: environmentDirective[2] };
  }

  const listItem = /^-\s*([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(text);
  if (listItem) return { key: listItem[1], value: listItem[2] };

  const mapping = /^([A-Za-z_][A-Za-z0-9_]*):\s+([\s\S]+)$/.exec(text);
  if (mapping) return { key: mapping[1], value: mapping[2] };

  return null;
}

export function findOffenses(text) {
  const lines = text.split("\n");
  const offenses = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const previous = index > 0 ? lines[index - 1] : "";
    if (line.includes(ALLOW_MARKER) || previous.includes(ALLOW_MARKER)) continue;

    const entry = extractEntry(line);
    if (!entry) continue;

    const result = classifyEntry(entry.key, entry.value);
    if (!result.ok) {
      offenses.push({
        lineNumber: index + 1,
        key: entry.key,
        reason: result.reason,
        line: line.trim(),
      });
    }
  }

  return offenses;
}

function listFiles(absoluteDir, predicate) {
  let entries;
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => path.join(absoluteDir, entry.name))
    .sort();
}

function statSyncSafe(target) {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

export function runCheck({
  repoRoot,
  composeDir = DEFAULT_COMPOSE_DIR,
  quadletDir = DEFAULT_QUADLET_DIR,
  log = console.log,
  error = console.error,
} = {}) {
  const allOffenses = [];
  let scanned = 0;

  const scan = (absolute) => {
    scanned += 1;
    const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
    for (const offense of findOffenses(readFileSync(absolute, "utf8"))) {
      allOffenses.push({ relative, ...offense });
    }
  };

  const composeRoot = path.resolve(repoRoot, composeDir);
  for (const absolute of listFiles(composeRoot, (name) =>
    COMPOSE_EXTENSIONS.has(path.extname(name)),
  )) {
    scan(absolute);
  }

  const quadletRoot = path.resolve(repoRoot, quadletDir);
  if (statSyncSafe(quadletRoot)?.isDirectory()) {
    for (const absolute of listFiles(quadletRoot, () => true)) scan(absolute);
  }

  if (allOffenses.length > 0) {
    error("ERROR: literal credentials in shipped container stacks:\n");
    for (const offense of allOffenses) {
      error(`  ${offense.relative}:${offense.lineNumber}: ${offense.line}`);
      error(`      ${offense.reason}`);
    }
    error(
      "\nA credential we ship is a credential every install shares, and it is public with the repo.",
    );
    error(
      `If a value only looks like a credential, add a \`${ALLOW_MARKER}: <reason>\` comment on the matching line or the line immediately above to opt in.`,
    );
    return 1;
  }

  log(`  ✓  No literal credentials in ${scanned} container stack file(s).`);
  return 0;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  process.exit(runCheck({ repoRoot: process.cwd() }));
}
