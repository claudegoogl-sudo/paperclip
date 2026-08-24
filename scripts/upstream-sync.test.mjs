import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyMerge,
  findOpenSyncPr,
  isUnrelatedHistoriesError,
  mergeBaseOrEmpty,
  pickOpenSyncPr,
  runActivationSoakGate,
  unrelatedHistoriesReport,
} from "./upstream-sync.mjs";

const FORK_OWNER = "claudegoogl-sudo";
const TAG = "v2026.525.0";
const BRANCH = `sync/upstream-${TAG}`;

function openPr(ref, extra = {}) {
  return {
    state: "open",
    html_url: "https://github.com/claudegoogl-sudo/paperclip/pull/42",
    head: { ref, repo: { owner: { login: FORK_OWNER } } },
    ...extra,
  };
}

test("pickOpenSyncPr selects the open PR whose head matches the sync branch", () => {
  const pr = pickOpenSyncPr([openPr(BRANCH)], BRANCH);
  assert.ok(pr);
  assert.equal(pr.head.ref, BRANCH);
});

test("pickOpenSyncPr ignores empty results, other branches, and closed PRs", () => {
  assert.equal(pickOpenSyncPr([], BRANCH), null);
  assert.equal(pickOpenSyncPr(null, BRANCH), null);
  assert.equal(pickOpenSyncPr([openPr("sync/upstream-v2026.428.0")], BRANCH), null);
  assert.equal(pickOpenSyncPr([openPr(BRANCH, { state: "closed" })], BRANCH), null);
});

test("pickOpenSyncPr rejects a head from a different fork owner", () => {
  const foreign = openPr(BRANCH, { head: { ref: BRANCH, repo: { owner: { login: "someone-else" } } } });
  assert.equal(pickOpenSyncPr([foreign], BRANCH), null);
});

test("findOpenSyncPr returns the open PR for the tag (acceptance #1)", async () => {
  let requestedUrl = null;
  const fetchImpl = async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => [openPr(BRANCH)] };
  };
  const pr = await findOpenSyncPr(BRANCH, { token: "t", fetchImpl });
  assert.ok(pr);
  assert.equal(pr.html_url, "https://github.com/claudegoogl-sudo/paperclip/pull/42");
  assert.match(requestedUrl, /state=open/);
  assert.match(requestedUrl, /base=master/);
  assert.match(requestedUrl, /head=claudegoogl-sudo%3Async%2Fupstream-v2026\.525\.0/);
});

test("findOpenSyncPr returns null when no PR is open (acceptance #2 path → real sync proceeds)", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [] });
  assert.equal(await findOpenSyncPr(BRANCH, { token: "t", fetchImpl }), null);
});

test("findOpenSyncPr no-ops without a token and makes no network call", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true, json: async () => [] };
  };
  assert.equal(await findOpenSyncPr(BRANCH, { token: "", fetchImpl }), null);
  assert.equal(called, false);
});

test("findOpenSyncPr throws on a non-ok pulls response", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => "rate limited" });
  await assert.rejects(() => findOpenSyncPr(BRANCH, { token: "t", fetchImpl }), /pulls query 403/);
});

// --- post-merge activation-soak gate ---------------------------------------

test("runActivationSoakGate runs the soak and passes when it exits 0", () => {
  let ran = false;
  const result = runActivationSoakGate({
    env: {},
    runner: () => { ran = true; return 0; },
    log: () => {},
  });
  assert.equal(ran, true);
  assert.deepEqual(result, { ran: true, skipped: false });
});

test("runActivationSoakGate aborts the tick when the soak exits non-zero", () => {
  assert.throws(
    () => runActivationSoakGate({ env: {}, runner: () => 1, log: () => {} }),
    /soak failed \(exit 1\); refusing to advance the sync tick/,
  );
});

test("runActivationSoakGate aborts when the runner throws (execFileSync non-zero)", () => {
  assert.throws(
    () => runActivationSoakGate({
      env: {},
      runner: () => { const e = new Error("Command failed"); e.status = 2; throw e; },
      log: () => {},
    }),
    /soak failed \(exit 2\); refusing to advance the sync tick/,
  );
});

test("runActivationSoakGate skips loudly when PAPERCLIP_SYNC_SKIP_SOAK is set", () => {
  const logs = [];
  let ran = false;
  const result = runActivationSoakGate({
    env: { PAPERCLIP_SYNC_SKIP_SOAK: "1" },
    runner: () => { ran = true; return 0; },
    log: (m) => logs.push(m),
  });
  assert.equal(ran, false, "runner must NOT be invoked when skipping");
  assert.deepEqual(result, { ran: false, skipped: true });
  assert.equal(logs.some((l) => /skipped/.test(l)), true, "skip must be logged, never silent");
});

// --- unrelated-histories escalation guardrail ------------------------------

const BASE = `origin/${"master"}`;

// A git error object as thrown by execFileSync/our `git` helper: non-zero exit
// with stderr captured (stdio defaults to pipe).
function gitError(stderr, status = 1) {
  const e = new Error("Command failed");
  e.status = status;
  e.stderr = stderr;
  return e;
}

test("isUnrelatedHistoriesError matches git's refusal message, case-insensitively", () => {
  assert.equal(isUnrelatedHistoriesError("fatal: refusing to merge unrelated histories"), true);
  assert.equal(isUnrelatedHistoriesError("Refusing to merge UNRELATED HISTORIES\n"), true);
  assert.equal(isUnrelatedHistoriesError("CONFLICT (content): Merge conflict in a.ts"), false);
  assert.equal(isUnrelatedHistoriesError(undefined), false);
  assert.equal(isUnrelatedHistoriesError(""), false);
});

test("unrelatedHistoriesReport is the escalation shape with the structural reason", () => {
  const report = unrelatedHistoriesReport(TAG);
  assert.equal(report.tag, TAG);
  assert.equal(report.bucket, "escalation");
  assert.equal(report.reason, "unrelated-histories");
  assert.match(report.unresolvedFiles, /N\/A/);
});

test("mergeBaseOrEmpty normalizes a throwing (no-common-ancestor) merge-base to ''", () => {
  const throwing = () => { throw gitError("", 1); };
  assert.equal(mergeBaseOrEmpty(BASE, "refs/tags/x", throwing), "");
  const ok = () => "abc123";
  assert.equal(mergeBaseOrEmpty(BASE, "refs/tags/x", ok), "abc123");
});

test("classifyMerge escalates (exit 2) when the merge-base is empty — no merge attempted", () => {
  const calls = [];
  const gitImpl = (a) => {
    calls.push(a[0]);
    if (a[0] === "merge-base") throw gitError("", 1); // no common ancestor
    throw new Error(`unexpected git ${a.join(" ")}`);
  };
  const res = classifyMerge({ tag: TAG, base: BASE, git: gitImpl });
  assert.equal(res.escalate, true);
  assert.equal(res.exitCode, 2);
  assert.deepEqual(res.report, unrelatedHistoriesReport(TAG));
  assert.deepEqual(calls, ["merge-base"], "must NOT run `git merge` once merge-base is empty");
});

test("classifyMerge escalates (exit 2) and aborts the merge on 'unrelated histories' stderr", () => {
  const calls = [];
  const gitImpl = (a) => {
    calls.push(a.join(" "));
    if (a[0] === "merge-base") return "deadbeef"; // merge-base non-empty...
    if (a[0] === "merge" && a[1] === "--no-ff") {
      throw gitError("fatal: refusing to merge unrelated histories\n"); // ...but merge aborts
    }
    return ""; // `merge --abort` succeeds
  };
  const res = classifyMerge({ tag: TAG, base: BASE, git: gitImpl });
  assert.equal(res.escalate, true);
  assert.equal(res.exitCode, 2);
  assert.deepEqual(res.report, unrelatedHistoriesReport(TAG));
  assert.ok(calls.includes("merge --abort"), "must abort the started merge to keep the tree clean");
});

test("classifyMerge tolerates `merge --abort` throwing (nothing to abort)", () => {
  const gitImpl = (a) => {
    if (a[0] === "merge-base") return "deadbeef";
    if (a[0] === "merge" && a[1] === "--no-ff") throw gitError("refusing to merge unrelated histories");
    if (a[0] === "merge" && a[1] === "--abort") throw gitError("fatal: There is no merge to abort", 128);
    return "";
  };
  const res = classifyMerge({ tag: TAG, base: BASE, git: gitImpl });
  assert.equal(res.escalate, true);
  assert.equal(res.exitCode, 2);
});

test("classifyMerge reports mergeFailed for an ordinary conflict (not escalation)", () => {
  const gitImpl = (a) => {
    if (a[0] === "merge-base") return "deadbeef";
    if (a[0] === "merge") throw gitError("CONFLICT (content): Merge conflict in a.ts");
    return "";
  };
  const res = classifyMerge({ tag: TAG, base: BASE, git: gitImpl });
  assert.equal(res.escalate, false);
  assert.equal(res.mergeFailed, true);
});

test("classifyMerge reports a clean merge when the merge succeeds", () => {
  const gitImpl = (a) => {
    if (a[0] === "merge-base") return "deadbeef";
    if (a[0] === "merge") return ""; // success
    return "";
  };
  const res = classifyMerge({ tag: TAG, base: BASE, git: gitImpl });
  assert.deepEqual(res, { escalate: false, mergeFailed: false });
});
