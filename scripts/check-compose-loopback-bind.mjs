#!/usr/bin/env node
/**
 * check-compose-loopback-bind.mjs
 *
 * Static check that rejects port publishes in the shipped container stacks that
 * do not pin a loopback host IP.
 *
 * Docker installs its own DNAT rules in `nat/PREROUTING` and filters container
 * traffic in the `DOCKER` chain hanging off `FORWARD`, so a published port never
 * traverses the `INPUT` chain that UFW's default-deny policy governs. The
 * publish bind address is therefore the effective control: a bare `"5432:5432"`
 * puts the service on every interface no matter what the host firewall says.
 *
 * Scope:
 *   - `docker/*.yml` — every entry under a `ports:` key must be a three-part
 *     `HOST_IP:HOST_PORT:CONTAINER_PORT` mapping whose host-IP component is a
 *     loopback literal or interpolates to one by default.
 *   - `docker/quadlet/*` — every `PublishPort=` must carry a loopback host IP.
 *
 * `${VAR-127.0.0.1}` is rejected even though it looks like a default: with the
 * single-dash form an empty-but-set variable (a common `.env` accident) expands
 * to the empty string, yielding `":3100:3100"` — published on all interfaces.
 * Only `${VAR:-127.0.0.1}` falls back on empty as well as unset.
 *
 * Opt-in mechanism: a line containing `paperclip:allow-public-bind` (typically
 * inside a `# paperclip:allow-public-bind: <reason>` comment on the line itself
 * or the line immediately above) suppresses the match, so a deliberate exception
 * is reviewable rather than invisible.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { failClosedOnEmptyScan } from "./policy-gate-fail-closed.mjs";

const DEFAULT_COMPOSE_DIR = "docker";
const DEFAULT_QUADLET_DIR = "docker/quadlet";
const COMPOSE_EXTENSIONS = new Set([".yml", ".yaml"]);

export const ALLOW_MARKER = "paperclip:allow-public-bind";
export const LOOPBACK_LITERALS = new Set(["127.0.0.1", "[::1]"]);

const INTERPOLATION_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(:-|-|:\?|\?|:\+|\+)?([\s\S]*)\}$/;

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === '"' || first === "'") && trimmed[trimmed.length - 1] === first) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

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

/**
 * Split on `:` at nesting depth zero. `${VAR:-127.0.0.1}` and `[::1]` both carry
 * colons that are not field separators, so a plain `split(":")` mis-parses them.
 */
export function splitTopLevelColons(value) {
  const parts = [];
  let current = "";
  let braces = 0;
  let brackets = 0;

  for (const char of value) {
    if (char === "{") braces += 1;
    else if (char === "}") braces = Math.max(0, braces - 1);
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets = Math.max(0, brackets - 1);
    else if (char === ":" && braces === 0 && brackets === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Split a `[a, b]` flow sequence on commas at nesting depth zero. */
export function parseFlowSequence(inline) {
  let body = inline.trim();
  if (body.startsWith("[")) body = body.slice(1);
  if (body.endsWith("]")) body = body.slice(0, -1);

  const values = [];
  let current = "";
  let braces = 0;
  let quote = null;

  for (const char of body) {
    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "{") braces += 1;
    else if (char === "}") braces = Math.max(0, braces - 1);
    else if (char === "," && braces === 0) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);

  return values.map(unquote).filter((value) => value !== "");
}

export function classifyHostIp(rawHost) {
  const host = rawHost.trim();
  if (host === "") {
    return { ok: false, reason: "empty host-IP component publishes on every interface" };
  }
  if (LOOPBACK_LITERALS.has(host)) return { ok: true };

  const match = INTERPOLATION_PATTERN.exec(host);
  if (!match) {
    return { ok: false, reason: `host-IP component \`${host}\` is not a loopback address` };
  }

  const [, name, operator, fallback] = match;
  if (operator === ":-") {
    if (LOOPBACK_LITERALS.has(fallback.trim())) return { ok: true };
    return {
      ok: false,
      reason: `\`${host}\` defaults to \`${fallback}\`, which is not a loopback address`,
    };
  }
  if (operator === "-") {
    return {
      ok: false,
      reason:
        `\`${host}\` uses the \`\${VAR-default}\` form, which only falls back when ${name} is ` +
        `unset — an empty-but-set ${name} expands to nothing and publishes on every interface. ` +
        `Use \`\${${name}:-127.0.0.1}\`.`,
    };
  }
  return {
    ok: false,
    reason: `\`${host}\` has no \`:-\` default; use \`\${${name}:-127.0.0.1}\``,
  };
}

export function checkPublishValue(rawValue) {
  const value = String(rawValue).trim();
  const parts = splitTopLevelColons(value);
  if (parts.length < 3) {
    return {
      ok: false,
      reason:
        `\`${value}\` publishes without a host-IP component, so it binds every interface. ` +
        `Use \`127.0.0.1:HOST_PORT:CONTAINER_PORT\`.`,
    };
  }
  if (parts.length > 3) {
    return {
      ok: false,
      reason:
        `\`${value}\` does not parse as HOST_IP:HOST_PORT:CONTAINER_PORT. ` +
        `IPv6 host addresses need bracket syntax, e.g. \`[::1]\`.`,
    };
  }
  return classifyHostIp(parts[0]);
}

function splitMappingLine(line) {
  const separator = line.indexOf(":");
  if (separator < 0) return null;
  return {
    key: line.slice(0, separator).trim(),
    value: line.slice(separator + 1).trim(),
  };
}

export function findComposeOffenses(text) {
  const lines = text.split("\n");
  const offenses = [];

  const record = (index, value, reason) => {
    const line = lines[index];
    const previous = index > 0 ? lines[index - 1] : "";
    if (line.includes(ALLOW_MARKER) || previous.includes(ALLOW_MARKER)) return;
    offenses.push({ lineNumber: index + 1, value, reason, line: line.trim() });
  };

  let index = 0;
  while (index < lines.length) {
    const header = /^ports:\s*(.*)$/.exec(stripComment(lines[index]).trim());
    if (!header) {
      index += 1;
      continue;
    }

    const portsIndent = indentOf(lines[index]);
    const inline = header[1].trim();
    if (inline !== "") {
      for (const value of parseFlowSequence(inline)) {
        const result = checkPublishValue(value);
        if (!result.ok) record(index, value, result.reason);
      }
      index += 1;
      continue;
    }

    index += 1;
    while (index < lines.length) {
      const entryLine = lines[index];
      const entryText = stripComment(entryLine).trim();
      if (entryText === "") {
        index += 1;
        continue;
      }
      if (indentOf(entryLine) <= portsIndent) break;
      if (!entryText.startsWith("-")) {
        index += 1;
        continue;
      }

      const entryIndent = indentOf(entryLine);
      const entryStart = index;
      const payload = entryText.slice(1).trim();
      index += 1;

      if (!/^[A-Za-z_][A-Za-z0-9_]*:/.test(payload)) {
        const value = unquote(payload);
        const result = checkPublishValue(value);
        if (!result.ok) record(entryStart, value, result.reason);
        continue;
      }

      // Long syntax: `- target: 3100` / `published: 3100` / `host_ip: 127.0.0.1`.
      const fields = new Map();
      const first = splitMappingLine(payload);
      if (first) fields.set(first.key, first.value);
      while (index < lines.length) {
        const continuation = lines[index];
        const continuationText = stripComment(continuation).trim();
        if (continuationText === "") {
          index += 1;
          continue;
        }
        if (indentOf(continuation) <= entryIndent) break;
        if (continuationText.startsWith("-")) break;
        const field = splitMappingLine(continuationText);
        if (field) fields.set(field.key, field.value);
        index += 1;
      }

      const hostIp = fields.get("host_ip");
      if (hostIp === undefined) {
        record(
          entryStart,
          "host_ip: <unset>",
          "long-syntax `ports:` entry has no `host_ip:`, so it binds every interface. Add `host_ip: 127.0.0.1`.",
        );
        continue;
      }
      const result = classifyHostIp(unquote(hostIp));
      if (!result.ok) record(entryStart, hostIp, result.reason);
    }
  }

  return offenses;
}

export function findQuadletOffenses(text) {
  const lines = text.split("\n");
  const offenses = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^\s*PublishPort\s*=\s*(.+?)\s*$/.exec(line);
    if (!match) continue;

    const previous = index > 0 ? lines[index - 1] : "";
    if (line.includes(ALLOW_MARKER) || previous.includes(ALLOW_MARKER)) continue;

    const value = match[1];
    const result = checkPublishValue(value);
    if (!result.ok) {
      offenses.push({ lineNumber: index + 1, value, reason: result.reason, line: line.trim() });
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

export function runCheck({
  repoRoot,
  composeDir = DEFAULT_COMPOSE_DIR,
  quadletDir = DEFAULT_QUADLET_DIR,
  log = console.log,
  error = console.error,
} = {}) {
  const allOffenses = [];
  let scanned = 0;

  const composeRoot = path.resolve(repoRoot, composeDir);
  for (const absolute of listFiles(composeRoot, (name) =>
    COMPOSE_EXTENSIONS.has(path.extname(name)),
  )) {
    scanned += 1;
    const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
    for (const offense of findComposeOffenses(readFileSync(absolute, "utf8"))) {
      allOffenses.push({ relative, ...offense });
    }
  }

  const quadletRoot = path.resolve(repoRoot, quadletDir);
  if (statSyncSafe(quadletRoot)?.isDirectory()) {
    for (const absolute of listFiles(quadletRoot, () => true)) {
      scanned += 1;
      const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
      for (const offense of findQuadletOffenses(readFileSync(absolute, "utf8"))) {
        allOffenses.push({ relative, ...offense });
      }
    }
  }

  if (allOffenses.length > 0) {
    error("ERROR: published container ports that do not bind to loopback:\n");
    for (const offense of allOffenses) {
      error(`  ${offense.relative}:${offense.lineNumber}: ${offense.line}`);
      error(`      ${offense.reason}`);
    }
    error(
      "\nUFW/iptables INPUT rules do not filter Docker-published ports, so the publish bind address is the effective control.",
    );
    error(
      `If a stack must publish beyond loopback, add a \`${ALLOW_MARKER}: <reason>\` comment on the matching line or the line immediately above to opt in.`,
    );
    return 1;
  }

  // Fail-closed guard: the gate's mandatory scan root is `composeDir` (the
  // `docker/` directory by default). `quadletDir` is optional — it is only
  // scanned when it exists — so an absent quadlet directory is not a policy
  // failure. If `composeDir` is missing or emptied, `scanned` stays at zero
  // and the gate must error rather than silently report green at zero
  // coverage. See `scripts/policy-gate-fail-closed.mjs` for the rationale.
  const emptyScanExit = failClosedOnEmptyScan({
    scannedCount: scanned,
    expectedRoots: [{ path: composeRoot, label: "compose directory" }],
    error,
    gateName: "check-compose-loopback-bind",
  });
  if (emptyScanExit !== null) return emptyScanExit;

  log(`  ✓  All published ports in ${scanned} container stack file(s) bind to loopback by default.`);
  return 0;
}

function statSyncSafe(target) {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  process.exit(runCheck({ repoRoot: process.cwd() }));
}
