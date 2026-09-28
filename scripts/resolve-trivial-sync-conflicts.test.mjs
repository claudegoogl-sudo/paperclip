#!/usr/bin/env node
/**
 * resolve-trivial-sync-conflicts.test.mjs
 *
 * Integration tests for scripts/resolve-trivial-sync-conflicts.mjs.
 *
 * The resolver is a script (it runs main() at import), so these tests build a
 * throwaway git repository with a real conflicted merge state, copy the
 * resolver into it (the resolver derives its repo root from its own location),
 * and run it as a subprocess.
 *
 * `pnpm install` is replaced with a PATH shim that mirrors the one behavior
 * the resolver depends on: pnpm parses manifests (package.json,
 * pnpm-workspace.yaml) at install time, and conflict markers inside one abort
 * the install with ERR_PNPM_JSON_PARSE. That is the exact crash observed on
 * recent sync ticks, so the shim keeps these tests deterministic and offline
 * while reproducing the production failure mode.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RESOLVER = fileURLToPath(new URL("./resolve-trivial-sync-conflicts.mjs", import.meta.url));

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message]);
}

// Both sides change the same lines so `git merge` leaves real conflict
// markers (index stages 1/2/3) in exactly the files named in `conflicts`.
function buildConflictedFixture(conflicts) {
  const dir = mkdtempSync(path.join(tmpdir(), "resolver-fixture-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "sync-test@example.com"]);
  git(dir, ["config", "user.name", "Sync Test"]);

  write(dir, "package.json", JSON.stringify({ name: "fixture-root", version: "1.0.0", private: true }, null, 2) + "\n");
  write(dir, "pnpm-workspace.yaml", "packages:\n  - ui\n");
  write(dir, "ui/package.json", JSON.stringify({ name: "@fixture/ui", version: "1.0.0" }, null, 2) + "\n");
  write(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n");
  write(dir, "CHANGELOG.md", "# Changelog\n\n## base\n");
  write(dir, "docs/notes.md", "base prose.\n");
  commitAll(dir, "base");

  git(dir, ["checkout", "-b", "theirs"]);
  if (conflicts.has("pnpm-lock.yaml")) write(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n# theirs lock line\n");
  if (conflicts.has("ui/package.json")) write(dir, "ui/package.json", JSON.stringify({ name: "@fixture/ui", version: "3.0.0" }, null, 2) + "\n");
  if (conflicts.has("CHANGELOG.md")) write(dir, "CHANGELOG.md", "# Changelog\n\n## base\n- theirs entry\n");
  if (conflicts.has("docs/notes.md")) write(dir, "docs/notes.md", "base prose.\ntheirs prose.\n");
  commitAll(dir, "theirs");

  git(dir, ["checkout", "main"]);
  if (conflicts.has("pnpm-lock.yaml")) write(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n# ours lock line\n");
  if (conflicts.has("ui/package.json")) write(dir, "ui/package.json", JSON.stringify({ name: "@fixture/ui", version: "2.0.0" }, null, 2) + "\n");
  if (conflicts.has("CHANGELOG.md")) write(dir, "CHANGELOG.md", "# Changelog\n\n## base\n- ours entry\n");
  if (conflicts.has("docs/notes.md")) write(dir, "docs/notes.md", "base prose.\nours prose.\n");
  commitAll(dir, "ours");

  const merge = spawnSync("git", ["merge", "--no-ff", "theirs"], { cwd: dir, encoding: "utf8" });
  const unresolved = git(dir, ["diff", "--name-only", "--diff-filter=U"]).trim().split("\n").filter(Boolean).sort();
  assert.deepEqual(
    unresolved,
    [...conflicts].sort(),
    `fixture must leave exactly the requested files conflicted (merge status ${merge.status})`,
  );

  // The resolver derives its repo root from its own path, so a copy inside
  // the fixture makes it operate on the fixture repository.
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  copyFileSync(RESOLVER, path.join(dir, "scripts", "resolve-trivial-sync-conflicts.mjs"));
  return dir;
}

// A `pnpm` double on PATH. It logs every invocation, then reproduces pnpm's
// install-time manifest parsing: conflict markers in any manifest (or a
// package.json that fails JSON.parse) abort with ERR_PNPM_JSON_PARSE, exit 1.
// The shim lives outside the fixture repo so it never shows up as a repo file.
function writePnpmShim() {
  const dir = mkdtempSync(path.join(tmpdir(), "resolver-pnpm-shim-"));
  const logFile = path.join(dir, "pnpm.log");
  writeFileSync(logFile, "");
  const impl = path.join(dir, "pnpm-impl.mjs");
  writeFileSync(
    impl,
    [
      'import { appendFileSync, readdirSync, readFileSync } from "node:fs";',
      'import path from "node:path";',
      'import process from "node:process";',
      "",
      `const LOG = ${JSON.stringify(logFile)};`,
      'appendFileSync(LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");',
      "",
      "function walk(dir, out) {",
      "  for (const entry of readdirSync(dir, { withFileTypes: true })) {",
      '    if (entry.name === ".git" || entry.name === "node_modules") continue;',
      "    const abs = path.join(dir, entry.name);",
      "    if (entry.isDirectory()) walk(abs, out);",
      '    else if (entry.name === "package.json" || entry.name === "pnpm-workspace.yaml") out.push(abs);',
      "  }",
      "}",
      "",
      "const manifests = [];",
      "walk(process.cwd(), manifests);",
      "for (const file of manifests) {",
      '  const text = readFileSync(file, "utf8");',
      '  if (/^<{7}|^>{7}/m.test(text)) {',
      "    console.error(`ERR_PNPM_JSON_PARSE  conflict markers while parsing ${file}`);",
      "    process.exit(1);",
      "  }",
      '  if (file.endsWith(".json")) {',
      "    try {",
      "      JSON.parse(text);",
      "    } catch (err) {",
      "      console.error(`ERR_PNPM_JSON_PARSE  ${err.message} while parsing ${file}`);",
      "      process.exit(1);",
      "    }",
      "  }",
      "}",
    ].join("\n") + "\n",
  );
  const shim = path.join(dir, "pnpm");
  writeFileSync(shim, `#!/bin/sh\nexec node "${impl}" "$@"\n`);
  chmodSync(shim, 0o755);
  return { dir, logFile };
}

function runResolver(fixtureDir, shimDir) {
  return spawnSync("node", ["scripts/resolve-trivial-sync-conflicts.mjs"], {
    cwd: fixtureDir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH}`,
    },
  });
}

function shimInvocations(logFile) {
  return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("lockfile regen is skipped with a structured reason when a package.json is still conflicted (exit 2)", (t) => {
  const fixture = buildConflictedFixture(new Set(["pnpm-lock.yaml", "ui/package.json"]));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const shim = writePnpmShim();
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));

  const res = runResolver(fixture, shim.dir);

  // Before the fix this crashed: `pnpm install` parsed the conflicted
  // ui/package.json, threw ERR_PNPM_JSON_PARSE, and the resolver exited 1
  // with a stack trace instead of a structured escalation.
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /LOCKFILE-REGEN-SKIPPED/);
  assert.match(res.stderr, /ui\/package\.json/);
  assert.match(res.stderr, /unresolved after auto-pass:.*ui\/package\.json/);
  assert.equal(shimInvocations(shim.logFile).length, 0, "pnpm install must NOT run while a manifest is conflicted");
});

test("lockfile regen still runs when only allow-listed files are conflicted", (t) => {
  const fixture = buildConflictedFixture(new Set(["pnpm-lock.yaml", "CHANGELOG.md", "docs/notes.md"]));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const shim = writePnpmShim();
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));

  const res = runResolver(fixture, shim.dir);

  assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstderr:\n${res.stderr}`);
  const invocations = shimInvocations(shim.logFile);
  assert.equal(invocations.length, 1, "pnpm install must run exactly once");
  assert.deepEqual(invocations[0].args, ["install", "--no-frozen-lockfile"]);
});
