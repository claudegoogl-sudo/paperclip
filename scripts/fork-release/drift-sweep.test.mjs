import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireLock,
  buildSweepComment,
  loadState,
  missingSetSignature,
  provenanceBanner,
  resolveBoardToken,
  sweepOnce,
} from "./drift-sweep.mjs";
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SHA = (n) => String(n).padStart(40, "0");

/**
 * Raw API-shaped fake (what computeDriftLedger actually consumes): a head
 * lookup for /commits/<ref> and compare payloads for everything else.
 */
function fakeGh({ commitCount = 2, target = "b".repeat(40), fail = false } = {}) {
  return (p) => {
    if (fail) throw new Error("gh: Not Found (HTTP 404)");
    if (p.includes("/commits/")) return { sha: target };
    return {
      status: "ahead",
      ahead_by: commitCount,
      commits: Array.from({ length: commitCount }, (_, i) => ({
        sha: SHA(i + 1),
        commit: { message: `fix: thing ${i} (#${100 + i})\n\nAB-4${i}` },
        html_url: `https://example.invalid/${i}`,
      })),
    };
  };
}

function baseArgs(tmp) {
  return {
    issue: "TRK-1",
    installDir: path.join(tmp, "install"),
    versionOverride: "2026.907.1-fork.43",
    installedCommit: "a".repeat(40),
    target: "master",
    repo: "example/paperclip",
    ticketRegex: "[A-Z]{2,8}-[0-9]{1,6}",
    apiBase: "http://127.0.0.1:3100/api",
    stateFile: path.join(tmp, "state.json"),
    agentLabel: "test sweep",
    force: false,
  };
}

test("sweepOnce posts the ledger and records state", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "drift-sweep-"));
  try {
    const posts = [];
    const outcome = await sweepOnce({
      args: baseArgs(tmp),
      ghApiFn: fakeGh(),
      fetchImpl: async (req) => { posts.push(req); return { id: "c-1" }; },
      boardToken: { token: "x".repeat(10), source: "test" },
    });
    assert.equal(outcome.outcome, "posted");
    assert.equal(posts.length, 1);
    assert.ok(posts[0].body.includes("NOT an operator decision"));
    assert.ok(posts[0].body.includes("Fork-release drift ledger"));
    assert.ok(posts[0].body.includes("PR #100, ticket AB-40"));
    assert.ok(posts[0].body.endsWith("check the service journal for per-run results."));

    const state = loadState(path.join(tmp, "state.json"));
    assert.equal(state.lastPosted.missingShas.length, 2);
    assert.equal(state.lastPosted.issue, "TRK-1");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("sweepOnce converges: identical missing set does not repost", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "drift-sweep-"));
  try {
    const posts = [];
    const fetchImpl = async (req) => { posts.push(req); return { id: "c" }; };
    const args = baseArgs(tmp);
    const first = await sweepOnce({ args, ghApiFn: fakeGh(), fetchImpl, boardToken: { token: "x" } });
    assert.equal(first.outcome, "posted");
    const second = await sweepOnce({ args, ghApiFn: fakeGh(), fetchImpl, boardToken: { token: "x" } });
    assert.equal(second.outcome, "converged");
    assert.equal(posts.length, 1);
    // A NEW commit on master changes the set -> reposts.
    const third = await sweepOnce({ args, ghApiFn: fakeGh({ commitCount: 3 }), fetchImpl, boardToken: { token: "x" } });
    assert.equal(third.outcome, "posted");
    assert.equal(posts.length, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("sweepOnce never posts on a positive-control failure and keeps state clean", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "drift-sweep-"));
  try {
    const posts = [];
    const outcome = await sweepOnce({
      args: baseArgs(tmp),
      ghApiFn: fakeGh({ fail: true }),
      fetchImpl: async (req) => { posts.push(req); return {}; },
      boardToken: { token: "x" },
    });
    assert.equal(outcome.outcome, "check-failed");
    assert.match(outcome.detail, /control/);
    assert.equal(posts.length, 0);
    assert.equal(existsSync(path.join(tmp, "state.json")), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("sweepOnce keeps state untouched when the board post fails, so retries converge", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "drift-sweep-"));
  try {
    const args = baseArgs(tmp);
    let failPost = true;
    const fetchImpl = async () => {
      if (failPost) throw new Error("board POST 502: bad gateway");
      return { id: "ok" };
    };
    const failed = await sweepOnce({ args, ghApiFn: fakeGh(), fetchImpl, boardToken: { token: "x" } });
    assert.equal(failed.outcome, "error");
    assert.equal(existsSync(path.join(tmp, "state.json")), false);
    failPost = false;
    const retried = await sweepOnce({ args, ghApiFn: fakeGh(), fetchImpl, boardToken: { token: "x" } });
    assert.equal(retried.outcome, "posted");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveBoardToken prefers env, falls back to the credential file, leaks nothing in errors", () => {
  const env = { PAPERCLIP_API_KEY: "env-token" };
  assert.deepEqual(resolveBoardToken({ env, credentialPath: "/no/such/file", apiBase: "http://127.0.0.1:3100/api" }),
    { token: "env-token", source: "env" });

  const dir = mkdtempSync(path.join(tmpdir(), "drift-sweep-cred-"));
  try {
    const credPath = path.join(dir, "auth.json");
    writeFileSync(credPath, JSON.stringify({
      credentials: {
        "http://localhost:3100": { apiBase: "http://localhost:3100", token: "file-token" },
      },
    }));
    const resolved = resolveBoardToken({ env: {}, credentialPath: credPath, apiBase: "http://127.0.0.1:3100/api" });
    assert.deepEqual(resolved, { token: "file-token", source: "credential-file" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireLock skips an active lock and clears a stale one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "drift-sweep-lock-"));
  try {
    const lockPath = path.join(dir, "state.json.lock");
    const first = acquireLock(lockPath);
    assert.equal(first.ok, true);
    const second = acquireLock(lockPath);
    assert.equal(second.ok, false);
    // Backdate past the staleness window -> cleared and re-acquired.
    const staleTime = Date.now() - 60 * 60 * 1000;
    utimesSync(lockPath, staleTime / 1000, staleTime / 1000);
    const third = acquireLock(lockPath, { staleMs: 30 * 60 * 1000 });
    assert.equal(third.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadState converges on missing and corrupt files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "drift-sweep-state-"));
  try {
    assert.deepEqual(loadState(path.join(dir, "missing.json")).lastPosted, null);
    const corrupt = path.join(dir, "corrupt.json");
    writeFileSync(corrupt, "{not json");
    assert.deepEqual(loadState(corrupt).lastPosted, null);
    const good = path.join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ lastPosted: { missingShas: ["a"], targetCommit: "b", postedAt: "t" } }));
    assert.equal(loadState(good).lastPosted.missingShas[0], "a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missingSetSignature is order-stable", () => {
  assert.deepEqual(
    missingSetSignature([{ sha: "b" }, { sha: "a" }]),
    missingSetSignature([{ sha: "a" }, { sha: "b" }]),
  );
});

test("provenance banner and sweep comment carry the required markers", () => {
  const banner = provenanceBanner("fork-drift sweep");
  assert.match(banner, /Agent action — NOT an operator decision/);
  assert.match(banner, /fork-drift sweep/);
  const comment = buildSweepComment({
    ledgerText: "LEDGER",
    missing: [{ sha: SHA(7), subject: "s (#1)", message: "s (#1)", html_url: "u" }],
    agentLabel: "test sweep",
    ticketRegexSource: null,
  });
  assert.match(comment, /## Fork-release drift ledger/);
  assert.match(comment, /```/);
  assert.match(comment, /LEDGER/);
  assert.match(comment, /— s \(#1\) \(PR #1\)/);
});
