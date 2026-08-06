import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findOffenses, parseEnvEntry, runCheck, stripEnvComment } from "./check-env-example-connection-string.mjs";

test("stripEnvComment drops a trailing comment and leaves non-comment lines alone", () => {
  assert.equal(stripEnvComment("KEY=value # note"), "KEY=value ");
  assert.equal(stripEnvComment("# full line comment"), "");
  assert.equal(stripEnvComment("KEY=value"), "KEY=value");
});

test("parseEnvEntry reads KEY=value and ignores comments / blanks / non-assignments", () => {
  assert.deepEqual(parseEnvEntry("DATABASE_URL=postgres://u:pw@h/db"), {
    key: "DATABASE_URL",
    value: "postgres://u:pw@h/db",
  });
  assert.deepEqual(parseEnvEntry("DATABASE_URL=postgres://u:pw@h/db # shape only"), {
    key: "DATABASE_URL",
    value: "postgres://u:pw@h/db",
  });
  assert.equal(parseEnvEntry("# DATABASE_URL=postgres://u:pw@h/db"), null);
  assert.equal(parseEnvEntry(""), null);
  assert.equal(parseEnvEntry("not-an-assignment"), null);
});

test("POSITIVE CONTROL: rejects the pre-fix paperclip:paperclip literal", () => {
  // This is the exact line that shipped in `.env.example` before this change.
  // If the check ever stops flagging it, the gate is dead — keep this test.
  const offenses = findOffenses(
    "DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip\n",
  );
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].lineNumber, 1);
  assert.equal(offenses[0].key, "DATABASE_URL");
  assert.match(offenses[0].reason, /userinfo field/);
});

test("rejects any scheme://user:password@host value, not just postgres", () => {
  const offenses = findOffenses("DATABASE_URL=mongodb://admin:hunter2@host:27017/db\n");
  assert.equal(offenses.length, 1);
  assert.match(offenses[0].reason, /userinfo field/);
});

test("accepts the post-fix `.env.example` shape: empty value plus commented placeholder", () => {
  const after = [
    "# Shape: postgres://USER:PASSWORD@HOST:PORT/DB",
    "# DATABASE_URL=postgres://paperclip:YOUR_PASSWORD@localhost:5432/paperclip",
    "DATABASE_URL=",
    "PORT=3100",
    "",
  ].join("\n");
  assert.deepEqual(findOffenses(after), []);
});

test("accepts a fully-interpolated connection string", () => {
  // Compose-style interpolation is the pattern used by docker/docker-compose.yml;
  // .env.example itself does not interpolate, but the gate must not flag a
  // value that has no literal password to leak.
  assert.deepEqual(findOffenses("DATABASE_URL=postgres://paperclip:${POSTGRES_PASSWORD}@db:5432/paperclip\n"), []);
});

test("accepts a URL with no userinfo password", () => {
  assert.deepEqual(findOffenses("DATABASE_URL=postgres://localhost:5432/paperclip\n"), []);
  assert.deepEqual(findOffenses("DATABASE_URL=postgres://paperclip@localhost:5432/paperclip\n"), []);
});

test("does not flag unrelated weak-secret-looking lines (scope is connection strings only)", () => {
  // BETTER_AUTH_SECRET is a separate ticket; the gate must not couple to it.
  // The line below is deliberately a weak placeholder so a future generalisation
  // of this rule would surface as a test failure here.
  assert.deepEqual(findOffenses("BETTER_AUTH_SECRET=dev-only-not-real\n"), []);
});

test("DOES NOT flag `chown -R paperclip:paperclip` — the canonical false positive", () => {
  // docker/Dockerfile.onboard-smoke:32 contains this line. Even if the file
  // were ever accidentally scanned, it has no scheme, no `://`, and no `@`,
  // so it must not register as a connection string. Asserted explicitly
  // because the issue calls this shape out by name.
  assert.deepEqual(findOffenses("RUN chown -R paperclip:paperclip /paperclip /home/paperclip\n"), []);
  assert.equal(parseEnvEntry("  && chown -R paperclip:paperclip /paperclip /home/paperclip \\"), null);
});

test("runCheck walks `.env.example` by default and reports the offense", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "env-example-connstr-"));
  try {
    writeFileSync(
      path.join(root, ".env.example"),
      "DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip\nPORT=3100\n",
    );
    const errors = [];
    assert.equal(runCheck({ repoRoot: root, log: () => {}, error: (l) => errors.push(l) }), 1);
    const report = errors.join("\n");
    assert.match(report, /\.env\.example:1/);
    assert.match(report, /userinfo field/);

    writeFileSync(path.join(root, ".env.example"), "# DATABASE_URL=postgres://paperclip:YOUR_PASSWORD@localhost:5432/paperclip\nDATABASE_URL=\nPORT=3100\n");
    assert.equal(runCheck({ repoRoot: root, log: () => {}, error: () => {} }), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCheck returns 1 when `.env.example` is missing — the gate cannot pass vacuously", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "env-example-connstr-"));
  try {
    const errors = [];
    assert.equal(runCheck({ repoRoot: root, log: () => {}, error: (l) => errors.push(l) }), 1);
    const report = errors.join("\n");
    assert.match(report, /`\.env\.example` not found/);
    assert.match(report, /cannot pass vacuously/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repository's own shipped `.env.example` passes", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  assert.equal(runCheck({ repoRoot, log: () => {}, error: console.error }), 0);
});
