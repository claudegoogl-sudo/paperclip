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
 * The scan is a single non-recursive pass over those two locations: nested
 * directories (`docker/agent-runtime/`, `docker/untrusted-review/`, ...) and
 * non-`.yml` files (`docker/ecs-task-definition.json`) are out of scope. This is
 * a line-based lint, not a YAML parser, so treat a green result as "the common
 * mistakes are caught", not as a proof that no credential can exist.
 *
 * Rule 2 (URL userinfo, below) runs line-wide, independent of key parsing,
 * because a credential-bearing URL is not identifiable by key name — gating it
 * behind a parseable key would reopen the very fail-open it exists to close (a
 * hyphenated `x-database-url:` extension key with an anchored DSN would slip the
 * key parser and take the whole line with it). Known residual bypasses, accepted
 * as out of scope for a line-based lint: a DSN inside a flow-mapping list item
 * (`- {KEY: value}`, not valid Compose for `environment:`) and a lower-case
 * secret key with its value on the next line (the bare-key rule is deliberately
 * restricted to upper-case env-var names so `secrets:` and other structural keys
 * stay out).
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

  // Not `^`-anchored: a DSN embedded in a larger value (`--dsn=postgres://u:pw@h`,
  // a `command:`/`args:` wrapper) carries the same credential and must be caught.
  const match = /[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)@/.exec(masked);
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
  // A secret-named key with no inline value (`POSTGRES_PASSWORD:` alone): the
  // credential could live in a block or next-line scalar this line-based check
  // cannot see. Fail closed instead of passing silently.
  if (value === null) {
    return {
      ok: false,
      reason:
        "secret-named key has no inline value; a block or next-line scalar could carry a literal " +
        "credential this line-based check cannot see. Put the value inline as `${VAR:?reason}`, " +
        "or add an allow marker if it is genuinely not a credential.",
    };
  }
  if (SECRET_KEY_PATTERN.test(key) && !SECRET_FILE_KEY_PATTERN.test(key)) {
    const result = classifySecretValue(value);
    if (!result.ok) return result;
  }
  return classifyUrlValue(value);
}

/**
 * Split `text` on `delimiter` occurrences that sit at brace depth 0 and outside
 * quotes, so a `,` inside `${VAR:?a, b}` or a quoted scalar does not split a
 * flow-mapping entry.
 */
function splitTopLevel(text, delimiter) {
  const parts = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!inDouble && char === "'") inSingle = !inSingle;
    else if (!inSingle && char === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (char === "{") depth += 1;
      else if (char === "}") depth = Math.max(0, depth - 1);
      else if (char === delimiter && depth === 0) {
        parts.push(text.slice(start, index));
        start = index + 1;
      }
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Expand a YAML flow mapping (`{KEY: value, KEY2: value2}`) into its entries so a
 * secret nested in flow style is inspected. Returns `null` when the value is not
 * a flow mapping.
 */
export function flowMappingEntries(rawValue) {
  const inner = /^\{([\s\S]*)\}$/.exec(unquote(rawValue).trim());
  if (!inner) return null;

  const entries = [];
  for (const part of splitTopLevel(inner[1], ",")) {
    const pair = /^\s*["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*:\s*([\s\S]*?)\s*$/.exec(part);
    if (pair) entries.push({ key: pair[1], value: pair[2] });
  }
  return entries.length > 0 ? entries : null;
}

/**
 * Pull the `{ key, value }` entries out of one line: `KEY: value`, `- KEY=value`,
 * `Environment=KEY=value`, quoted variants of each, and flow mappings. A
 * secret-named key with no inline value yields `value: null` so it can be failed
 * closed. Deliberately indentation-agnostic: a secret-named key anywhere in a
 * shipped stack file is a finding regardless of which block it sits in.
 *
 * A value this parser cannot read must run *no* rule silently — that is fail-open
 * in the one place meant to catch the next contributor — so every accepted shape
 * is unquoted and re-parsed rather than skipped.
 */
export function entriesForLine(line) {
  const text = stripComment(line).trim();
  if (text === "") return [];

  const environmentDirective = /^Environment=([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(text);
  if (environmentDirective) {
    return [{ key: environmentDirective[1], value: environmentDirective[2] }];
  }

  // `- KEY=value`, including the quoted `- "KEY=value"` / `- 'KEY=value'` forms:
  // quoting a list entry is ordinary Compose style and was a silent bypass.
  const listItem = /^-\s*([\s\S]+)$/.exec(text);
  if (listItem) {
    const pair = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(unquote(listItem[1]));
    return pair ? [{ key: pair[1], value: pair[2] }] : [];
  }

  // `KEY: value`, tolerating a quoted key (`"KEY": value`). A flow-mapping value
  // is expanded so a secret nested in `{...}` is still inspected.
  const mapping = /^["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?:\s+([\s\S]+)$/.exec(text);
  if (mapping) {
    return flowMappingEntries(mapping[2]) ?? [{ key: mapping[1], value: mapping[2] }];
  }

  // Secret-named key with the value on the following line or in a block scalar.
  // Restricted to env-var-style upper-case keys so structural keys such as
  // `secrets:` are not swept in.
  const bareKey = /^["']?([A-Z][A-Z0-9_]*)["']?:\s*$/.exec(text);
  if (bareKey && SECRET_KEY_PATTERN.test(bareKey[1]) && !SECRET_FILE_KEY_PATTERN.test(bareKey[1])) {
    return [{ key: bareKey[1], value: null }];
  }

  return [];
}

/** Back-compat single-entry accessor: the first entry on the line, or `null`. */
export function extractEntry(line) {
  return entriesForLine(line)[0] ?? null;
}

export function findOffenses(text) {
  const lines = text.split("\n");
  const offenses = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const previous = index > 0 ? lines[index - 1] : "";
    const commentOf = (l) => l.slice(stripComment(l).length);
    if (commentOf(line).includes(ALLOW_MARKER) || commentOf(previous).includes(ALLOW_MARKER)) continue;

    // Rule 2 runs line-wide, before and independent of key parsing. A URL with a
    // literal userinfo password is a finding wherever it sits — a hyphenated
    // extension key (`x-database-url:`), an anchor definition, a bare list item,
    // a block-scalar continuation — none of which `entriesForLine` yields a
    // parseable entry for. Gating the URL rule behind a parseable key was the
    // fail-open that let the idiomatic `x-`/anchor DRY construct reintroduce the
    // duplicated credential this gate exists to reject.
    const urlResult = classifyUrlValue(stripComment(line));
    if (!urlResult.ok) {
      offenses.push({
        lineNumber: index + 1,
        key: null,
        reason: urlResult.reason,
        line: line.trim(),
      });
    }

    for (const entry of entriesForLine(line)) {
      const result = classifyEntry(entry.key, entry.value);
      // De-dup: when the per-entry pass reports the same URL offense the
      // line-wide pass already recorded (an ordinary `DATABASE_URL: postgres://…`
      // line), flag it once, not twice.
      if (result.ok || (!urlResult.ok && result.reason === urlResult.reason)) continue;
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

  if (scanned === 0) {
    error(
      `ERROR: no container stack files found under \`${composeDir}\`. The literal-credential gate ` +
        "cannot pass vacuously: if the shipped stacks moved, point this check at the new location.",
    );
    return 1;
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
