import assert from "node:assert/strict";
import test from "node:test";

import {
  JOURNAL_PATH,
  MIGRATIONS_DIR,
  findChangedReleasedMigrations,
  formatFindings,
  parseJournalTags,
  runCheck,
} from "./check-migrations-append-only.mjs";

function journal(tags) {
  return JSON.stringify({
    version: "7",
    dialect: "postgresql",
    entries: tags.map((tag, idx) => ({ idx, version: "7", when: 1000 + idx, tag, breakpoints: true })),
  });
}

/**
 * Build a fake `git show <ref>:<path>` over an in-memory two-ref file tree.
 * `trees` maps ref -> { relPath: content }. Missing paths throw, matching how
 * real `git show` exits non-zero for an absent path.
 */
function fakeGit(trees) {
  return (_cmd, args) => {
    // args === ["show", "<ref>:<relPath>"]
    const spec = args[1];
    const sep = spec.indexOf(":");
    const ref = spec.slice(0, sep);
    const relPath = spec.slice(sep + 1);
    const tree = trees[ref];
    if (!tree || !(relPath in tree)) {
      throw new Error(`fatal: path '${relPath}' does not exist in '${ref}'`);
    }
    return tree[relPath];
  };
}

test("parseJournalTags: extracts tags in order, ignores malformed entries", () => {
  const text = journal(["0000_alpha", "0001_beta"]);
  assert.deepEqual(parseJournalTags(text), ["0000_alpha", "0001_beta"]);
  assert.deepEqual(parseJournalTags(JSON.stringify({ entries: [{ idx: 0 }, { tag: "" }, { tag: "x" }] })), ["x"]);
  assert.deepEqual(parseJournalTags(JSON.stringify({})), []);
});

// --- The three required scope cases -----------------------------------------

test("FAILS when a released migration's comment-only content changes", () => {
  const relPath = `${MIGRATIONS_DIR}/0000_alpha.sql`;
  const findings = findChangedReleasedMigrations({
    baseTags: ["0000_alpha"],
    readBase: () => "-- old header (ticket ABC-1)\nALTER TABLE t ADD COLUMN c int;\n",
    readHead: () => "-- new header, id scrubbed\nALTER TABLE t ADD COLUMN c int;\n",
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, relPath);
  assert.notEqual(findings[0].baseHash, findings[0].headHash);
});

test("PASSES a byte-identical rename (renumbering identical content)", () => {
  // 0000_alpha (base, journaled) is renamed to 0000_renamed with identical
  // bytes at head. The old path is gone at head; the new path is not journaled
  // at base. Neither is a present-in-both content change.
  const content = "ALTER TABLE t ADD COLUMN c int;\n";
  const findings = findChangedReleasedMigrations({
    baseTags: ["0000_alpha"],
    readBase: (p) => (p.endsWith("0000_alpha.sql") ? content : null),
    readHead: (p) => (p.endsWith("0000_renamed.sql") ? content : null),
  });
  assert.deepEqual(findings, []);
});

test("PASSES when a brand-new migration is added", () => {
  const base = "ALTER TABLE t ADD COLUMN c int;\n";
  const findings = findChangedReleasedMigrations({
    baseTags: ["0000_alpha"], // only the pre-existing one is journaled at base
    readBase: (p) => (p.endsWith("0000_alpha.sql") ? base : null),
    readHead: (p) => {
      if (p.endsWith("0000_alpha.sql")) return base; // unchanged
      if (p.endsWith("0001_new.sql")) return "CREATE TABLE u (id int);\n"; // new
      return null;
    },
  });
  assert.deepEqual(findings, []);
});

test("does not flag a released migration deleted at head (rename/removal, not in-place edit)", () => {
  const findings = findChangedReleasedMigrations({
    baseTags: ["0000_alpha"],
    readBase: () => "ALTER TABLE t ADD COLUMN c int;\n",
    readHead: () => null,
  });
  assert.deepEqual(findings, []);
});

test("flags only the changed file among several released migrations", () => {
  const unchanged = "CREATE TABLE a (id int);\n";
  const findings = findChangedReleasedMigrations({
    baseTags: ["0000_a", "0001_b"],
    readBase: (p) => (p.endsWith("0000_a.sql") ? unchanged : "CREATE TABLE b (id int);\n"),
    readHead: (p) => (p.endsWith("0000_a.sql") ? unchanged : "CREATE TABLE b (id int); -- edited\n"),
  });
  assert.equal(findings.length, 1);
  assert.ok(findings[0].file.endsWith("0001_b.sql"));
});

test("formatFindings: explains WHY and prints both hashes + the file", () => {
  const msg = formatFindings([{ file: `${MIGRATIONS_DIR}/0000_a.sql`, baseHash: "aaa", headHash: "bbb" }]);
  assert.match(msg, /append-only/i);
  assert.match(msg, /RE-APPLIES the migration/);
  assert.match(msg, /0000_a\.sql/);
  assert.match(msg, /base sha256: aaa/);
  assert.match(msg, /head sha256: bbb/);
  assert.match(msg, /NEW forward migration/);
});

// --- runCheck: end-to-end over a faked git ----------------------------------

test("runCheck: exits 1 when a released migration's bytes change base->head", () => {
  const relPath = `${MIGRATIONS_DIR}/0000_alpha.sql`;
  const trees = {
    base: { [JOURNAL_PATH]: journal(["0000_alpha"]), [relPath]: "-- v1\nSELECT 1;\n" },
    head: { [JOURNAL_PATH]: journal(["0000_alpha"]), [relPath]: "-- v2\nSELECT 1;\n" },
  };
  const errors = [];
  const code = runCheck({
    baseRef: "base",
    headRef: "head",
    execImpl: fakeGit(trees),
    log: () => {},
    error: (m) => errors.push(m),
  });
  assert.equal(code, 1);
  assert.ok(errors.some((m) => m.includes("0000_alpha.sql")));
});

test("runCheck: exits 0 when released migrations are untouched and a new one is added", () => {
  const a = `${MIGRATIONS_DIR}/0000_alpha.sql`;
  const b = `${MIGRATIONS_DIR}/0001_new.sql`;
  const trees = {
    base: { [JOURNAL_PATH]: journal(["0000_alpha"]), [a]: "SELECT 1;\n" },
    head: { [JOURNAL_PATH]: journal(["0000_alpha", "0001_new"]), [a]: "SELECT 1;\n", [b]: "SELECT 2;\n" },
  };
  const logs = [];
  const code = runCheck({
    baseRef: "base",
    headRef: "head",
    execImpl: fakeGit(trees),
    log: (m) => logs.push(m),
    error: () => {},
  });
  assert.equal(code, 0);
  assert.ok(logs.some((m) => m.includes("No released migration content changed")));
});

test("runCheck: exits 0 when there is no journal at base (nothing released yet)", () => {
  const code = runCheck({
    baseRef: "base",
    headRef: "head",
    execImpl: fakeGit({ base: {}, head: {} }),
    log: () => {},
    error: () => {},
  });
  assert.equal(code, 0);
});

test("runCheck: exits 1 with a usage error when refs are missing", () => {
  const errors = [];
  const code = runCheck({ baseRef: "", headRef: "head", execImpl: () => "", error: (m) => errors.push(m) });
  assert.equal(code, 1);
  assert.ok(errors[0].includes("baseRef and headRef are required"));
});
