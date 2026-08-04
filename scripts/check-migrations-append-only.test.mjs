import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  JOURNAL_PATH,
  MIGRATIONS_DIR,
  findReleasedMigrationViolations,
  formatFindings,
  isRunnerVisibleMigration,
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

// Git's blob OID is a content hash, so equal content => equal OID. The fake
// mirrors that: a deterministic hash of the bytes stands in for the real OID.
function oid(content) {
  return createHash("sha1").update(content).digest("hex");
}

/** Build `Map<relPath, oid>` from a `{ relPath: content }` tree (migrations dir only). */
function blobs(tree) {
  const map = new Map();
  for (const [relPath, content] of Object.entries(tree)) {
    if (relPath.startsWith(`${MIGRATIONS_DIR}/`)) map.set(relPath, oid(content));
  }
  return map;
}

/** Set of OIDs present under the migrations dir at head, from a `{ relPath: content }` tree. */
function oidSet(tree) {
  return new Set([...blobs(tree).values()]);
}

/**
 * Fake `git` over a two-ref in-memory tree. `trees` maps ref -> { relPath: content }.
 * Supports the four subcommands runCheck uses: `rev-parse`, `show`, `ls-tree`, `merge-base`.
 */
function fakeGit(trees, mergeBaseOverrides = new Map()) {
  return (_cmd, args) => {
    const sub = args[0];
    if (sub === "rev-parse") {
      // ["rev-parse", "--verify", "--quiet", "<ref>^{commit}"]
      const ref = args[args.length - 1].replace(/\^\{commit\}$/, "");
      if (!(ref in trees)) throw new Error(`fatal: Needed a single revision: ${ref}`);
      return `${oid(ref)}\n`;
    }
    if (sub === "show") {
      // ["show", "<ref>:<relPath>"]
      const spec = args[1];
      const sep = spec.indexOf(":");
      const ref = spec.slice(0, sep);
      const relPath = spec.slice(sep + 1);
      const tree = trees[ref];
      if (!tree || !(relPath in tree)) throw new Error(`fatal: path '${relPath}' does not exist in '${ref}'`);
      return tree[relPath];
    }
    if (sub === "ls-tree") {
      // ["ls-tree", "-r", "<ref>", "--", MIGRATIONS_DIR]
      const ref = args[2];
      const tree = trees[ref] || {};
      return Object.entries(tree)
        .filter(([p]) => p.startsWith(`${MIGRATIONS_DIR}/`))
        .map(([p, content]) => `100644 blob ${oid(content)}\t${p}`)
        .join("\n");
    }
    if (sub === "merge-base") {
      // ["merge-base", "<ref1>", "<ref2>"]
      const ref1 = args[1];
      const ref2 = args[2];
      // Check for explicit override first (for "behind master" test cases)
      const key = `${ref1}..${ref2}`;
      const reverseKey = `${ref2}..${ref1}`;
      if (mergeBaseOverrides.has(key)) return mergeBaseOverrides.get(key);
      if (mergeBaseOverrides.has(reverseKey)) return mergeBaseOverrides.get(reverseKey);
      // Default: return ref1 as the merge-base (simplest case for most tests)
      return ref1;
    }
    throw new Error(`unexpected git subcommand: ${sub}`);
  };
}

test("parseJournalTags: extracts tags in order, ignores malformed entries", () => {
  const text = journal(["0000_alpha", "0001_beta"]);
  assert.deepEqual(parseJournalTags(text), ["0000_alpha", "0001_beta"]);
  assert.deepEqual(parseJournalTags(JSON.stringify({ entries: [{ idx: 0 }, { tag: "" }, { tag: "x" }] })), ["x"]);
  assert.deepEqual(parseJournalTags(JSON.stringify({})), []);
});

// --- Pure core: keyed on blob-OID content survival --------------------------

test("FAILS when a released migration is edited in place (same path, new bytes)", () => {
  const relPath = `${MIGRATIONS_DIR}/0000_alpha.sql`;
  const base = { [relPath]: "-- old header (ticket ABC-1)\nALTER TABLE t ADD COLUMN c int;\n" };
  const head = { [relPath]: "-- new header, id scrubbed\nALTER TABLE t ADD COLUMN c int;\n" };
  const violations = findReleasedMigrationViolations({
    baseTags: ["0000_alpha"],
    baseBlobs: blobs(base),
    headOids: oidSet(head),
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, relPath);
});

test("REGRESSION (F1): FAILS on rename + content edit — the path-keyed bypass", () => {
  // Base: 0138 is journaled with an id in its header + a live DML line.
  // Head: git mv to 0139 AND the header edited. A path-keyed guard compares
  // nothing (old path gone, new path not journaled at base) and passes; the
  // runner still re-applies the edited body because its content hash is new.
  const base = {
    [`${MIGRATIONS_DIR}/0138_egress.sql`]:
      "-- egress rollout (ticket ABC-138)\nUPDATE secret_bindings SET egress_allowlist_enforced = false;\n",
  };
  const head = {
    [`${MIGRATIONS_DIR}/0139_egress.sql`]:
      "-- egress rollout\nUPDATE secret_bindings SET egress_allowlist_enforced = false;\n",
  };
  const violations = findReleasedMigrationViolations({
    baseTags: ["0138_egress"],
    baseBlobs: blobs(base),
    headOids: oidSet(head),
  });
  assert.equal(violations.length, 1, "rename + content edit must be flagged");
  assert.equal(violations[0].file, `${MIGRATIONS_DIR}/0138_egress.sql`);
});

test("PASSES a byte-identical rename (renumbering identical content keeps the OID)", () => {
  const content = "ALTER TABLE t ADD COLUMN c int;\n";
  const base = { [`${MIGRATIONS_DIR}/0000_alpha.sql`]: content };
  const head = { [`${MIGRATIONS_DIR}/0000_renamed.sql`]: content }; // same bytes, new name
  const violations = findReleasedMigrationViolations({
    baseTags: ["0000_alpha"],
    baseBlobs: blobs(base),
    headOids: oidSet(head),
  });
  assert.deepEqual(violations, []);
});

test("PASSES when a brand-new migration is added (existing OIDs untouched)", () => {
  const base = { [`${MIGRATIONS_DIR}/0000_alpha.sql`]: "ALTER TABLE t ADD COLUMN c int;\n" };
  const head = {
    [`${MIGRATIONS_DIR}/0000_alpha.sql`]: "ALTER TABLE t ADD COLUMN c int;\n", // unchanged
    [`${MIGRATIONS_DIR}/0001_new.sql`]: "CREATE TABLE u (id int);\n", // new
  };
  const violations = findReleasedMigrationViolations({
    baseTags: ["0000_alpha"],
    baseBlobs: blobs(base),
    headOids: oidSet(head),
  });
  assert.deepEqual(violations, []);
});

test("FAILS when a released migration is deleted at head (vanished bytes; delete + re-add is the two-step bypass)", () => {
  const base = { [`${MIGRATIONS_DIR}/0000_alpha.sql`]: "ALTER TABLE t ADD COLUMN c int;\n" };
  const head = {}; // gone
  const violations = findReleasedMigrationViolations({
    baseTags: ["0000_alpha"],
    baseBlobs: blobs(base),
    headOids: oidSet(head),
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, `${MIGRATIONS_DIR}/0000_alpha.sql`);
});

test("ignores a tag journaled at base with no file at base (nothing released to protect)", () => {
  const violations = findReleasedMigrationViolations({
    baseTags: ["0000_ghost"],
    baseBlobs: new Map(), // journaled but not present as a file
    headOids: new Set(),
  });
  assert.deepEqual(violations, []);
});

test("flags only the changed file among several released migrations", () => {
  const unchanged = "CREATE TABLE a (id int);\n";
  const base = {
    [`${MIGRATIONS_DIR}/0000_a.sql`]: unchanged,
    [`${MIGRATIONS_DIR}/0001_b.sql`]: "CREATE TABLE b (id int);\n",
  };
  const head = {
    [`${MIGRATIONS_DIR}/0000_a.sql`]: unchanged,
    [`${MIGRATIONS_DIR}/0001_b.sql`]: "CREATE TABLE b (id int); -- edited\n",
  };
  const violations = findReleasedMigrationViolations({
    baseTags: ["0000_a", "0001_b"],
    baseBlobs: blobs(base),
    headOids: oidSet(head),
  });
  assert.equal(violations.length, 1);
  assert.ok(violations[0].file.endsWith("0001_b.sql"));
});

test("formatFindings: explains WHY, prints the file + base hash, and both edit/rename head forms", () => {
  const inPlace = formatFindings([{ file: `${MIGRATIONS_DIR}/0000_a.sql`, baseHash: "aaa", headHash: "bbb" }]);
  assert.match(inPlace, /append-only/i);
  assert.match(inPlace, /RE-APPLIES the migration/);
  assert.match(inPlace, /0000_a\.sql/);
  assert.match(inPlace, /base sha256: aaa/);
  assert.match(inPlace, /head sha256: bbb/);
  assert.match(inPlace, /NEW forward migration/);

  const vanished = formatFindings([{ file: `${MIGRATIONS_DIR}/0000_a.sql`, baseHash: "aaa", headHash: null }]);
  assert.match(vanished, /no longer present/i);
});

// --- runCheck: end-to-end over a faked git ----------------------------------

test("runCheck: exits 1 when a released migration's bytes change in place", () => {
  const relPath = `${MIGRATIONS_DIR}/0000_alpha.sql`;
  const trees = {
    base: { [JOURNAL_PATH]: journal(["0000_alpha"]), [relPath]: "-- v1\nSELECT 1;\n" },
    head: { [JOURNAL_PATH]: journal(["0000_alpha"]), [relPath]: "-- v2\nSELECT 1;\n" },
  };
  const errors = [];
  const code = runCheck({ baseRef: "base", headRef: "head", execImpl: fakeGit(trees), log: () => {}, error: (m) => errors.push(m) });
  assert.equal(code, 1);
  assert.ok(errors.some((m) => m.includes("0000_alpha.sql")));
  assert.ok(errors.some((m) => /head sha256:/.test(m)), "in-place edit reports a head hash");
});

test("runCheck REGRESSION (F1): exits 1 on a released migration renamed AND content-changed", () => {
  const trees = {
    base: {
      [JOURNAL_PATH]: journal(["0138_egress"]),
      [`${MIGRATIONS_DIR}/0138_egress.sql`]: "-- egress (ticket ABC-138)\nUPDATE t SET egress_allowlist_enforced = false;\n",
    },
    head: {
      [JOURNAL_PATH]: journal(["0139_egress"]),
      [`${MIGRATIONS_DIR}/0139_egress.sql`]: "-- egress\nUPDATE t SET egress_allowlist_enforced = false;\n",
    },
  };
  const errors = [];
  const code = runCheck({ baseRef: "base", headRef: "head", execImpl: fakeGit(trees), log: () => {}, error: (m) => errors.push(m) });
  assert.equal(code, 1);
  assert.ok(errors.some((m) => m.includes("0138_egress.sql")));
  assert.ok(errors.some((m) => /no longer present/i.test(m)), "rename reports vanished bytes, not a head hash");
});

test("runCheck: exits 0 on a byte-identical renumber", () => {
  const content = "SELECT 1;\n";
  const trees = {
    base: { [JOURNAL_PATH]: journal(["0000_alpha"]), [`${MIGRATIONS_DIR}/0000_alpha.sql`]: content },
    head: { [JOURNAL_PATH]: journal(["0000_renamed"]), [`${MIGRATIONS_DIR}/0000_renamed.sql`]: content },
  };
  const logs = [];
  const code = runCheck({ baseRef: "base", headRef: "head", execImpl: fakeGit(trees), log: (m) => logs.push(m), error: () => {} });
  assert.equal(code, 0);
  assert.ok(logs.some((m) => m.includes("still present at head")));
});

test("runCheck: exits 0 when released migrations are untouched and a new one is added", () => {
  const a = `${MIGRATIONS_DIR}/0000_alpha.sql`;
  const b = `${MIGRATIONS_DIR}/0001_new.sql`;
  const trees = {
    base: { [JOURNAL_PATH]: journal(["0000_alpha"]), [a]: "SELECT 1;\n" },
    head: { [JOURNAL_PATH]: journal(["0000_alpha", "0001_new"]), [a]: "SELECT 1;\n", [b]: "SELECT 2;\n" },
  };
  const logs = [];
  const code = runCheck({ baseRef: "base", headRef: "head", execImpl: fakeGit(trees), log: (m) => logs.push(m), error: () => {} });
  assert.equal(code, 0);
  assert.ok(logs.some((m) => m.includes("still present at head")));
});

test("runCheck: exits 1 when a released migration is deleted at head", () => {
  const trees = {
    base: { [JOURNAL_PATH]: journal(["0000_alpha"]), [`${MIGRATIONS_DIR}/0000_alpha.sql`]: "SELECT 1;\n" },
    head: { [JOURNAL_PATH]: journal([]) },
  };
  const errors = [];
  const code = runCheck({ baseRef: "base", headRef: "head", execImpl: fakeGit(trees), log: () => {}, error: (m) => errors.push(m) });
  assert.equal(code, 1);
  assert.ok(errors.some((m) => m.includes("0000_alpha.sql")));
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

test("runCheck: exits 0 when the base journal lists no migrations", () => {
  const trees = { base: { [JOURNAL_PATH]: journal([]) }, head: { [JOURNAL_PATH]: journal([]) } };
  const logs = [];
  const code = runCheck({ baseRef: "base", headRef: "head", execImpl: fakeGit(trees), log: (m) => logs.push(m), error: () => {} });
  assert.equal(code, 0);
  assert.ok(logs.some((m) => m.includes("nothing released to check")));
});

test("runCheck (F3): fails closed when a ref is not resolvable to a commit", () => {
  // `head` is absent from the tree, so rev-parse throws for it.
  const trees = { base: { [JOURNAL_PATH]: journal(["0000_alpha"]) } };
  const errors = [];
  const code = runCheck({ baseRef: "base", headRef: "head", execImpl: fakeGit(trees), log: () => {}, error: (m) => errors.push(m) });
  assert.equal(code, 1);
  assert.ok(errors.some((m) => /not resolvable to a commit/.test(m)));
});

test("runCheck: exits 1 with a usage error when refs are missing", () => {
  const errors = [];
  const code = runCheck({ baseRef: "", headRef: "head", execImpl: () => "", error: (m) => errors.push(m) });
  assert.equal(code, 1);
  assert.ok(errors[0].includes("baseRef and headRef are required"));
});

// --- F5: survival must be measured over runner-visible files only -----------

test("isRunnerVisibleMigration: only `.sql` directly under the migrations dir", () => {
  assert.equal(isRunnerVisibleMigration(`${MIGRATIONS_DIR}/0138_egress.sql`), true);
  assert.equal(isRunnerVisibleMigration(`${MIGRATIONS_DIR}/0138_egress.sql.orig`), false);
  assert.equal(isRunnerVisibleMigration(`${MIGRATIONS_DIR}/meta/0138_egress.sql`), false);
  assert.equal(isRunnerVisibleMigration(`${MIGRATIONS_DIR}/meta/_journal.json`), false);
  assert.equal(isRunnerVisibleMigration(`other/dir/0138_egress.sql`), false);
});

test("runCheck REGRESSION (F5): exits 1 when a released migration is edited in place but its base bytes survive at a sibling `.sql.orig`", () => {
  // The runner reads only `.sql` files directly in the dir, so a `*.sql.orig`
  // copy does NOT keep the released migration applied — yet a survival check
  // over every blob would see the old bytes and wrongly pass.
  const relPath = `${MIGRATIONS_DIR}/0138_egress.sql`;
  const released = "-- egress (ticket ABC-138)\nUPDATE t SET egress_allowlist_enforced = false;\n";
  const trees = {
    base: { [JOURNAL_PATH]: journal(["0138_egress"]), [relPath]: released },
    head: {
      [JOURNAL_PATH]: journal(["0138_egress"]),
      [relPath]: "-- egress\nUPDATE t SET egress_allowlist_enforced = false;\n", // header scrubbed => new identity
      [`${relPath}.orig`]: released, // old bytes parked where the runner never reads
    },
  };
  const errors = [];
  const code = runCheck({ baseRef: "base", headRef: "head", execImpl: fakeGit(trees), log: () => {}, error: (m) => errors.push(m) });
  assert.equal(code, 1);
  assert.ok(errors.some((m) => m.includes("0138_egress.sql")));
});

test("runCheck REGRESSION (F5): exits 1 when the surviving base bytes are only a copy under `meta/`", () => {
  const relPath = `${MIGRATIONS_DIR}/0138_egress.sql`;
  const released = "-- egress (ticket ABC-138)\nUPDATE t SET egress_allowlist_enforced = false;\n";
  const trees = {
    base: { [JOURNAL_PATH]: journal(["0138_egress"]), [relPath]: released },
    head: {
      [JOURNAL_PATH]: journal(["0138_egress"]),
      [relPath]: "-- egress\nUPDATE t SET egress_allowlist_enforced = false;\n",
      [`${MIGRATIONS_DIR}/meta/0138_egress.sql`]: released, // real `.sql` but in a subdirectory
    },
  };
  const errors = [];
  const code = runCheck({ baseRef: "base", headRef: "head", execImpl: fakeGit(trees), log: () => {}, error: (m) => errors.push(m) });
  assert.equal(code, 1);
  assert.ok(errors.some((m) => m.includes("0138_egress.sql")));
});

// --- F6: merge-base prevents false positives for PRs behind master -----------

test("runCheck: exits 0 when head is behind base (merge-base has no new migrations)", () => {
  // Scenario: base (master tip) has migrations 0138-0144, head (PR branch) was cut
  // before 0138 landed, so head only has up to 0137. The merge-base is head's
  // tip (where the branch diverged), which only journals 0000-0137. Guard passes.
  const m0138 = `${MIGRATIONS_DIR}/0138_new.sql`;
  const m0139 = `${MIGRATIONS_DIR}/0139_even_newer.sql`;
  const trees = {
    base: {
      [JOURNAL_PATH]: journal(["0000_alpha", "0138_new", "0139_even_newer"]),
      [`${MIGRATIONS_DIR}/0000_alpha.sql`]: "SELECT 1;\n",
      [m0138]: "CREATE TABLE foo (id int);\n",
      [m0139]: "CREATE TABLE bar (id int);\n",
    },
    head: {
      [JOURNAL_PATH]: journal(["0000_alpha"]),
      [`${MIGRATIONS_DIR}/0000_alpha.sql`]: "SELECT 1;\n",
    },
  };
  // merge-base returns "head" because head is where the branch diverged
  const mergeBaseOverrides = new Map([["base..head", "head"]]);
  const logs = [];
  const code = runCheck({
    baseRef: "base",
    headRef: "head",
    execImpl: fakeGit(trees, mergeBaseOverrides),
    log: (m) => logs.push(m),
    error: () => {},
  });
  assert.equal(code, 0, "head behind base must pass");
  assert.ok(logs.some((m) => m.includes("still present at head")));
});

test("runCheck: exits 1 when head is behind base AND edits a released migration", () => {
  // Same scenario as above, but head edits 0000_alpha (which IS in the merge-base).
  // Guard must fail because the merge-base contains the original bytes.
  const m0138 = `${MIGRATIONS_DIR}/0138_new.sql`;
  const alphaPath = `${MIGRATIONS_DIR}/0000_alpha.sql`;
  const original = "SELECT 1;\n";
  const edited = "SELECT 1; -- edited\n";
  const trees = {
    base: {
      [JOURNAL_PATH]: journal(["0000_alpha", "0138_new"]),
      [alphaPath]: original,
      [m0138]: "CREATE TABLE foo (id int);\n",
    },
    mergeBase: {
      // The commit where the branch diverged (has original 0000_alpha, not 0138)
      [JOURNAL_PATH]: journal(["0000_alpha"]),
      [alphaPath]: original,
    },
    head: {
      // Current PR state (edits 0000_alpha)
      [JOURNAL_PATH]: journal(["0000_alpha"]),
      [alphaPath]: edited,
    },
  };
  const mergeBaseOverrides = new Map([["base..head", "mergeBase"]]);
  const errors = [];
  const code = runCheck({
    baseRef: "base",
    headRef: "head",
    execImpl: fakeGit(trees, mergeBaseOverrides),
    log: () => {},
    error: (m) => errors.push(m),
  });
  assert.equal(code, 1, "edit in merge-base must fail");
  assert.ok(errors.some((m) => m.includes("0000_alpha.sql")));
  assert.ok(errors.some((m) => /head sha256:/.test(m)), "in-place edit reports a head hash");
});

test("runCheck: fails closed when merge-base cannot be computed (unrelated histories)", () => {
  const trees = {
    base: { [JOURNAL_PATH]: journal(["0000_alpha"]) },
    head: { [JOURNAL_PATH]: journal(["0000_alpha"]) },
  };
  // merge-base returns null (simulated by throwing)
  const throwingGit = (_cmd, args) => {
    if (args[0] === "merge-base") throw new Error("fatal: not a valid commit name");
    return fakeGit(trees)(_cmd, args);
  };
  const errors = [];
  const code = runCheck({
    baseRef: "base",
    headRef: "head",
    execImpl: throwingGit,
    log: () => {},
    error: (m) => errors.push(m),
  });
  assert.equal(code, 1);
  assert.ok(errors.some((m) => /failed to compute merge-base/.test(m)));
});
