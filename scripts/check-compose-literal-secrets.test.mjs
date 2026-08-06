import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ALLOW_MARKER,
  classifySecretValue,
  classifyUrlValue,
  entriesForLine,
  extractEntry,
  findOffenses,
  flowMappingEntries,
  maskInterpolations,
  runCheck,
} from "./check-compose-literal-secrets.mjs";

const REQUIRED = '"${POSTGRES_PASSWORD:?set a strong password}"';

const composeWith = (...environmentLines) =>
  `services:\n  db:\n    image: postgres:17-alpine\n    environment:\n${environmentLines
    .map((line) => `      ${line}\n`)
    .join("")}`;

test("maskInterpolations keeps a ${} block from being read as URL structure", () => {
  assert.equal(maskInterpolations("postgres://u:${P:?a:b@c}@db:5432/x"), "postgres://u:@db:5432/x");
  assert.equal(maskInterpolations("plain"), "plain");
});

test("extractEntry reads mapping, list and quadlet forms", () => {
  assert.deepEqual(extractEntry("      POSTGRES_PASSWORD: paperclip"), {
    key: "POSTGRES_PASSWORD",
    value: "paperclip",
  });
  assert.deepEqual(extractEntry("      - POSTGRES_PASSWORD=paperclip"), {
    key: "POSTGRES_PASSWORD",
    value: "paperclip",
  });
  assert.deepEqual(extractEntry("Environment=POSTGRES_PASSWORD=paperclip"), {
    key: "POSTGRES_PASSWORD",
    value: "paperclip",
  });
  assert.equal(extractEntry("  db:"), null);
  assert.equal(extractEntry("PublishPort=127.0.0.1:3100:3100"), null);
});

test("rejects the pre-fix POSTGRES_PASSWORD: paperclip line", () => {
  const offenses = findOffenses(composeWith("POSTGRES_USER: paperclip", "POSTGRES_PASSWORD: paperclip"));
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].lineNumber, 6);
  assert.equal(offenses[0].key, "POSTGRES_PASSWORD");
  assert.match(offenses[0].reason, /literal credential/);
});

test("rejects the pre-fix DATABASE_URL with an inline password", () => {
  const offenses = findOffenses(composeWith("DATABASE_URL: postgres://paperclip:paperclip@db:5432/paperclip"));
  assert.equal(offenses.length, 1);
  assert.match(offenses[0].reason, /userinfo field/);
});

test("accepts the fixed ${VAR:?reason} forms", () => {
  assert.deepEqual(
    findOffenses(
      composeWith(
        "POSTGRES_USER: paperclip",
        `POSTGRES_PASSWORD: ${REQUIRED}`,
        'DATABASE_URL: "postgres://paperclip:${POSTGRES_PASSWORD:?set a strong password}@db:5432/paperclip"',
      ),
    ),
    [],
  );
});

test("rejects a non-empty default, which still ships a credential", () => {
  const offenses = findOffenses(composeWith('POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:-paperclip}"'));
  assert.equal(offenses.length, 1);
  assert.match(offenses[0].reason, /defaults to a shipped credential/);
});

test("accepts an empty default and a bare interpolation", () => {
  assert.deepEqual(classifySecretValue('"${ANTHROPIC_API_KEY:-}"'), { ok: true });
  assert.deepEqual(classifySecretValue('"${GITHUB_TOKEN}"'), { ok: true });
  assert.deepEqual(classifySecretValue('""'), { ok: true });
});

test("does not flag non-credential values that merely look structural", () => {
  assert.deepEqual(findOffenses("services:\n  db:\n    image: postgres:17-alpine\n"), []);
  assert.deepEqual(classifyUrlValue('"${PAPERCLIP_PUBLIC_URL:-http://localhost:3100}"'), { ok: true });
  assert.deepEqual(classifyUrlValue("postgres://paperclip@db:5432/paperclip"), { ok: true });
});

test("exempts the _FILE Docker-secrets convention", () => {
  assert.deepEqual(findOffenses(composeWith("POSTGRES_PASSWORD_FILE: /run/secrets/pg")), []);
});

test("honours the allow marker on the line and the line above", () => {
  const sameLine = `POSTGRES_PASSWORD: fixture-only # ${ALLOW_MARKER}: throwaway test fixture`;
  assert.deepEqual(findOffenses(composeWith(sameLine)), []);
  assert.deepEqual(
    findOffenses(composeWith(`# ${ALLOW_MARKER}: throwaway test fixture`, "POSTGRES_PASSWORD: fixture-only")),
    [],
  );
});

test("runCheck walks docker/*.yml and docker/quadlet/* and reports offenses", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "literal-secrets-"));
  try {
    mkdirSync(path.join(root, "docker", "quadlet"), { recursive: true });
    writeFileSync(
      path.join(root, "docker", "docker-compose.yml"),
      composeWith("POSTGRES_PASSWORD: paperclip"),
    );
    writeFileSync(
      path.join(root, "docker", "quadlet", "paperclip.container"),
      "[Container]\nEnvironment=POSTGRES_PASSWORD=paperclip\n",
    );

    const errors = [];
    assert.equal(runCheck({ repoRoot: root, log: () => {}, error: (line) => errors.push(line) }), 1);
    const report = errors.join("\n");
    assert.match(report, /docker\/docker-compose\.yml:5/);
    assert.match(report, /docker\/quadlet\/paperclip\.container:2/);

    writeFileSync(
      path.join(root, "docker", "docker-compose.yml"),
      composeWith(`POSTGRES_PASSWORD: ${REQUIRED}`),
    );
    writeFileSync(
      path.join(root, "docker", "quadlet", "paperclip.container"),
      "[Container]\nEnvironment=POSTGRES_PASSWORD=${POSTGRES_PASSWORD}\n",
    );
    assert.equal(runCheck({ repoRoot: root, log: () => {}, error: () => {} }), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B1: rejects a quoted list-form env entry in both quote styles", () => {
  for (const line of ['- "POSTGRES_PASSWORD=paperclip"', "- 'POSTGRES_PASSWORD=paperclip'"]) {
    const offenses = findOffenses(composeWith(line));
    assert.equal(offenses.length, 1, line);
    assert.equal(offenses[0].key, "POSTGRES_PASSWORD");
    assert.match(offenses[0].reason, /literal credential/);
  }
});

test("B1: extractEntry unquotes the list-form key=value", () => {
  assert.deepEqual(extractEntry('      - "POSTGRES_PASSWORD=paperclip"'), {
    key: "POSTGRES_PASSWORD",
    value: "paperclip",
  });
  assert.deepEqual(extractEntry("      - 'POSTGRES_PASSWORD=paperclip'"), {
    key: "POSTGRES_PASSWORD",
    value: "paperclip",
  });
  // A quoted interpolation stays accepted.
  assert.deepEqual(findOffenses(composeWith('- "POSTGRES_PASSWORD=${POSTGRES_PASSWORD:?x}"')), []);
});

test("R1: rejects a quoted mapping key", () => {
  const offenses = findOffenses(composeWith('"POSTGRES_PASSWORD": paperclip'));
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].key, "POSTGRES_PASSWORD");
  assert.match(offenses[0].reason, /literal credential/);
});

test("R2: inspects a secret nested in a flow mapping", () => {
  const flagged = findOffenses(
    "services:\n  db:\n    environment: {POSTGRES_USER: paperclip, POSTGRES_PASSWORD: paperclip}\n",
  );
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].key, "POSTGRES_PASSWORD");

  assert.deepEqual(
    findOffenses('services:\n  db:\n    environment: {POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?x}"}\n'),
    [],
  );
  assert.equal(flowMappingEntries("plain-scalar"), null);
});

test("R3: fails closed on a secret key with no inline value", () => {
  const offenses = findOffenses("services:\n  db:\n    environment:\n      POSTGRES_PASSWORD:\n");
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].key, "POSTGRES_PASSWORD");
  assert.match(offenses[0].reason, /no inline value/);
});

test("R3: does not sweep in structural or _FILE keys", () => {
  const text =
    "secrets:\n  db_password:\n    file: ./db_password.txt\n" +
    "services:\n  db:\n    environment:\n      POSTGRES_PASSWORD_FILE:\n";
  assert.deepEqual(findOffenses(text), []);
  assert.deepEqual(entriesForLine("  secrets:"), []);
});

test("R4: rejects a DSN embedded in a wrapper value", () => {
  const offenses = findOffenses(
    composeWith("DATABASE_URL: --dsn=postgres://paperclip:paperclip@db:5432/x"),
  );
  assert.equal(offenses.length, 1);
  assert.match(offenses[0].reason, /userinfo field/);
});

test("B2/P1: rejects a hyphenated x- extension key carrying a literal DSN (anchor idiom)", () => {
  const offenses = findOffenses(
    "x-database-url: &db-url postgres://paperclip:paperclip@db:5432/paperclip\n" +
      "services:\n  server:\n    environment:\n      DATABASE_URL: *db-url\n",
  );
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].lineNumber, 1);
  assert.equal(offenses[0].key, null);
  assert.match(offenses[0].reason, /userinfo field/);
});

test("B2/P4: rejects a bare DSN list item that is not a KEY=value entry", () => {
  const offenses = findOffenses(composeWith("- postgres://paperclip:paperclip@db:5432/x"));
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].key, null);
  assert.match(offenses[0].reason, /userinfo field/);
});

test("B2/P5: rejects a DSN carried on a block-scalar continuation line", () => {
  const offenses = findOffenses(
    "services:\n  db:\n    command: |\n      psql postgres://paperclip:paperclip@db:5432/x\n",
  );
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].lineNumber, 4);
  assert.match(offenses[0].reason, /userinfo field/);
});

test("B2: an ordinary DATABASE_URL offense is flagged exactly once, not twice", () => {
  const offenses = findOffenses(composeWith("DATABASE_URL: postgres://paperclip:paperclip@db:5432/paperclip"));
  assert.equal(offenses.length, 1);
  assert.match(offenses[0].reason, /userinfo field/);
});

test("the repository's own shipped stacks pass", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  assert.equal(runCheck({ repoRoot, log: () => {}, error: console.error }), 0);
});

// ===== Fail-open fixes (Fix A & B) =====

test("Fix A: runCheck returns 1 when no docker/ dir exists", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "literal-secrets-"));
  try {
    const errors = [];
    assert.equal(runCheck({ repoRoot: root, log: () => {}, error: (line) => errors.push(line) }), 1);
    const report = errors.join("\n");
    assert.match(report, /no container stack files found/);
    assert.match(report, /cannot pass vacuously/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Fix A: runCheck returns 1 when docker/ dir exists but contains no stack files", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "literal-secrets-"));
  try {
    mkdirSync(path.join(root, "docker"), { recursive: true });
    // docker/ exists but is empty
    const errors = [];
    assert.equal(runCheck({ repoRoot: root, log: () => {}, error: (line) => errors.push(line) }), 1);
    const report = errors.join("\n");
    assert.match(report, /no container stack files found/);
    assert.match(report, /cannot pass vacuously/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Fix B: marker in a VALUE does not exempt; only comment portion counts", () => {
  // A secret value containing the marker text should still be flagged
  // because the marker is only honored in the comment portion
  const secretWithMarkerValue = `POSTGRES_PASSWORD: "paperclip:allow-literal-secret: attacker-payload"`;
  const offenses = findOffenses(composeWith(secretWithMarkerValue));
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].key, "POSTGRES_PASSWORD");
  assert.match(offenses[0].reason, /literal credential/);
});

test("Fix B regression: standalone marker comment line still exempts the line below", () => {
  const markerAbove = `# ${ALLOW_MARKER}: throwaway test fixture`;
  const secretLine = "POSTGRES_PASSWORD: fixture-only";
  assert.deepEqual(findOffenses(composeWith(markerAbove, secretLine)), []);
});

test("Fix B regression: trailing comment with marker still exempts its own line", () => {
  const sameLine = `POSTGRES_PASSWORD: fixture-only # ${ALLOW_MARKER}: throwaway test fixture`;
  assert.deepEqual(findOffenses(composeWith(sameLine)), []);
});
