import assert from "node:assert/strict";
import test from "node:test";

import { findOpenSyncPr, pickOpenSyncPr } from "./upstream-sync.mjs";

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
