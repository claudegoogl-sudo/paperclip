import assert from "node:assert/strict";
import test from "node:test";

import {
  EXCLUDED_PATHS,
  extractAddedLines,
  formatFindings,
  runCheck,
  scanAddedLinesForForbiddenIds,
  scanDiffForForbiddenIds,
} from "./check-no-internal-ids.mjs";

function unifiedDiff(file, { oldStart = 1, oldLines = 0, newStart = 1, newLines, body }) {
  const resolvedNewLines = newLines ?? body.split("\n").length;
  return [
    `diff --git a/${file} b/${file}`,
    "index 0000000..1111111 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${oldStart},${oldLines} +${newStart},${resolvedNewLines} @@`,
    body,
  ].join("\n");
}

test("extractAddedLines: only + lines count, numbered against the new file", () => {
  const diff = [
    "diff --git a/example.ts b/example.ts",
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -10,2 +10,3 @@",
    "+first added line",
    "-removed line",
    "+second added line",
  ].join("\n");
  const added = extractAddedLines(diff);
  assert.deepEqual(added, [
    { file: "example.ts", lineNumber: 10, content: "first added line" },
    { file: "example.ts", lineNumber: 11, content: "second added line" },
  ]);
});

test("extractAddedLines: skips deleted files (+++ /dev/null)", () => {
  const diff = ["diff --git a/gone.ts b/gone.ts", "--- a/gone.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-old content"].join(
    "\n",
  );
  assert.deepEqual(extractAddedLines(diff), []);
});

// --- Positive control: a diff line that DOES contain a forbidden form MUST be
// flagged. This is what makes "0 findings" on a real PR provably meaningful
// instead of a silently-broken check. -------------------------------------

test("POSITIVE CONTROL: flags an internal ticket id added in the diff", () => {
  const ticketId = ["PLA", "-", "999"].join("");
  const diff = unifiedDiff("server/src/example.ts", {
    oldStart: 5,
    oldLines: 0,
    newStart: 5,
    body: `+// see ${ticketId} for the threat model`,
  });
  const findings = scanDiffForForbiddenIds(diff);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "server/src/example.ts");
  assert.equal(findings[0].lineNumber, 5);
  assert.equal(findings[0].patternName, "internal-ticket-id");
  assert.equal(findings[0].match, ticketId);
});

test("POSITIVE CONTROL: flags an instance UI deep link added in the diff", () => {
  const link = ["/", "PLA", "/issues/", "PLA", "-1"].join("");
  const diff = unifiedDiff("doc/example.md", { newStart: 1, body: `+See ${link} for context.` });
  const findings = scanDiffForForbiddenIds(diff);
  const names = findings.map((f) => f.patternName);
  assert.ok(names.includes("instance-ui-link"));
});

test("POSITIVE CONTROL: flags an agent:// link added in the diff", () => {
  const link = "agent://" + "abc123-agent-id";
  const diff = unifiedDiff("doc/example.md", { newStart: 1, body: `+Assigned to ${link}` });
  const findings = scanDiffForForbiddenIds(diff);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].patternName, "agent-protocol-link");
});

test("POSITIVE CONTROL: flags a tailnet URL added in the diff", () => {
  const host = "my-instance-box" + ".ts.net";
  const diff = unifiedDiff("scripts/deploy-notes.md", { newStart: 1, body: `+Reach it at https://${host}:8443/` });
  const findings = scanDiffForForbiddenIds(diff);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].patternName, "tailnet-url");
});

test("POSITIVE CONTROL: flags a localhost instance deep link, not a bare localhost URL", () => {
  const deepLink = "http://localhost:3100" + "/PLA/issues/" + "PLA-1";
  const bare = "http://localhost:3100/api/health";
  const diffDeep = unifiedDiff("doc/example.md", { newStart: 1, body: `+${deepLink}` });
  const diffBare = unifiedDiff("doc/example.md", { newStart: 1, body: `+${bare}` });

  const deepFindings = scanDiffForForbiddenIds(diffDeep);
  const deepNames = deepFindings.map((f) => f.patternName);
  // The fixture line legitimately trips three patterns at once: the ticket
  // id, the /PLA/issues/ instance link, and the localhost+/PLA/ deep link.
  assert.ok(deepNames.includes("internal-ticket-id"));
  assert.ok(deepNames.includes("instance-ui-link"));
  assert.ok(deepNames.includes("local-instance-deep-link"));

  const bareFindings = scanDiffForForbiddenIds(diffBare);
  assert.deepEqual(bareFindings, [], "a bare dev-server localhost URL must not be flagged");
});

test("case sensitivity: lowercase fixture-style ids are not flagged (documented false-positive exclusion)", () => {
  const diff = unifiedDiff("scripts/example.mjs", {
    newStart: 1,
    body: "+const tmp = \"/tmp/pla-447-extract/package\";",
  });
  assert.deepEqual(scanDiffForForbiddenIds(diff), []);
});

test("removed lines are never flagged, even if they contain a forbidden form", () => {
  const ticketId = ["PLA", "-", "620"].join("");
  const diff = [
    "diff --git a/scripts/upstream-sync.mjs b/scripts/upstream-sync.mjs",
    "--- a/scripts/upstream-sync.mjs",
    "+++ b/scripts/upstream-sync.mjs",
    "@@ -14,1 +14,1 @@",
    `-  // Idempotency (${ticketId}): before any branch/push/PR work`,
    "+  // Idempotency: before any branch/push/PR work",
  ].join("\n");
  assert.deepEqual(scanDiffForForbiddenIds(diff), []);
});

// --- Negative control: this checker's own source/test files are excluded so
// they don't trip on their own pattern definitions and fixtures. -----------

test("self-exclusion: the checker script and its test file are excluded from scanning", () => {
  assert.ok(EXCLUDED_PATHS.has("scripts/check-no-internal-ids.mjs"));
  assert.ok(EXCLUDED_PATHS.has("scripts/check-no-internal-ids.test.mjs"));
  const ticketId = ["PLA", "-", "1"].join("");
  const diff = unifiedDiff("scripts/check-no-internal-ids.mjs", {
    newStart: 1,
    body: `+// ${ticketId}`,
  });
  assert.deepEqual(scanDiffForForbiddenIds(diff), []);
});

test("scanAddedLinesForForbiddenIds: custom excludedPaths override is respected", () => {
  const ticketId = ["PLA", "-", "2"].join("");
  const added = [{ file: "notes.md", lineNumber: 3, content: `see ${ticketId}` }];
  assert.deepEqual(scanAddedLinesForForbiddenIds(added, { excludedPaths: new Set(["notes.md"]) }), []);
  assert.equal(scanAddedLinesForForbiddenIds(added).length, 1);
});

test("formatFindings: readable, includes file:line and the offending snippet", () => {
  const ticketId = ["PLA", "-", "42"].join("");
  const findings = [
    {
      file: "server/src/example.ts",
      lineNumber: 7,
      patternName: "internal-ticket-id",
      match: ticketId,
      description: `internal ticket id "${ticketId}"`,
      line: `// see ${ticketId}`,
    },
  ];
  const message = formatFindings(findings);
  assert.match(message, /server\/src\/example\.ts:7/);
  assert.match(message, /No Internal Issue References/);
});

// --- runCheck: end-to-end wiring over an injected git implementation -------

test("runCheck: exits 1 and prints findings when the diff adds a forbidden form", () => {
  const ticketId = ["PLA", "-", "7"].join("");
  const diff = unifiedDiff("server/src/example.ts", { newStart: 1, body: `+// ${ticketId}` });
  const logs = [];
  const errors = [];
  const code = runCheck({
    baseRef: "base-sha",
    headRef: "head-sha",
    execImpl: () => diff,
    log: (msg) => logs.push(msg),
    error: (msg) => errors.push(msg),
  });
  assert.equal(code, 1);
  assert.equal(logs.length, 0);
  assert.ok(errors.some((line) => line.includes("server/src/example.ts:1")));
});

test("runCheck: exits 0 on a clean diff", () => {
  const diff = unifiedDiff("server/src/example.ts", { newStart: 1, body: "+// nothing forbidden here" });
  const code = runCheck({
    baseRef: "base-sha",
    headRef: "head-sha",
    execImpl: () => diff,
    log: () => {},
    error: () => {},
  });
  assert.equal(code, 0);
});

test("runCheck: exits 1 with a usage error when refs are missing", () => {
  const errors = [];
  const code = runCheck({ baseRef: "", headRef: "head-sha", execImpl: () => "", error: (m) => errors.push(m) });
  assert.equal(code, 1);
  assert.ok(errors[0].includes("baseRef and headRef are required"));
});
