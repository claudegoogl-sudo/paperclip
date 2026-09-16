import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONFIG,
  evaluateLiveness,
  parseDiskUsage,
  readApiCredential,
} from "./host-disk-janitor-watch.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url).replace(/host-disk-janitor-watch\.test\.mjs$/, "host-disk-janitor-watch.mjs");
const HOUR_MS = 3600 * 1000;

// ---------------------------------------------------------------------------
// Unit: evaluateLiveness (pure)
// ---------------------------------------------------------------------------

test("evaluateLiveness: fresh run within threshold", () => {
  const r = evaluateLiveness({
    now: Date.now(),
    staleAfterHours: 26,
    lastRunExists: true,
    lastRunRaw: JSON.stringify({ mode: "apply", timestamp: new Date(Date.now() - 1 * HOUR_MS).toISOString() }),
    janitorDeployed: true,
  });
  assert.equal(r.stale, false);
  assert.equal(r.reason, "fresh");
  assert.equal(r.mode, "apply");
  assert.equal(r.janitorDeployed, true);
});

test("evaluateLiveness: run older than threshold is stale", () => {
  const r = evaluateLiveness({
    now: Date.now(),
    staleAfterHours: 26,
    lastRunExists: true,
    lastRunRaw: JSON.stringify({ mode: "apply", timestamp: new Date(Date.now() - 30 * HOUR_MS).toISOString() }),
    janitorDeployed: true,
  });
  assert.equal(r.stale, true);
  assert.equal(r.reason, "stale-timestamp");
  assert.equal(r.ageHours > 29.9 && r.ageHours < 30.1, true);
});

test("evaluateLiveness: exactly at threshold is NOT stale (strictly-greater)", () => {
  const r = evaluateLiveness({
    now: 1_000_000_000_000,
    staleAfterHours: 26,
    lastRunExists: true,
    lastRunRaw: JSON.stringify({ mode: "apply", timestamp: new Date(1_000_000_000_000 - 26 * HOUR_MS).toISOString() }),
    janitorDeployed: true,
  });
  assert.equal(r.stale, false);
});

test("evaluateLiveness: missing last-run.json while janitor deployed is stale", () => {
  const r = evaluateLiveness({ now: Date.now(), staleAfterHours: 26, lastRunExists: false, lastRunRaw: null, janitorDeployed: true });
  assert.equal(r.stale, true);
  assert.equal(r.reason, "missing-last-run");
});

test("evaluateLiveness: missing last-run.json AND missing janitor is stale with distinct reason", () => {
  const r = evaluateLiveness({ now: Date.now(), staleAfterHours: 26, lastRunExists: false, lastRunRaw: null, janitorDeployed: false });
  assert.equal(r.stale, true);
  assert.equal(r.reason, "missing-last-run-and-janitor");
});

test("evaluateLiveness: unparseable last-run.json is stale", () => {
  const r = evaluateLiveness({ now: Date.now(), staleAfterHours: 26, lastRunExists: true, lastRunRaw: "{oops", janitorDeployed: true });
  assert.equal(r.stale, true);
  assert.equal(r.reason, "unparseable-last-run");
});

test("evaluateLiveness: non-ISO timestamp is stale but mode is preserved", () => {
  const r = evaluateLiveness({ now: Date.now(), staleAfterHours: 26, lastRunExists: true, lastRunRaw: JSON.stringify({ mode: "dry-run", timestamp: "yesterday-ish" }), janitorDeployed: true });
  assert.equal(r.stale, true);
  assert.equal(r.reason, "invalid-timestamp");
  assert.equal(r.mode, "dry-run");
});

test("evaluateLiveness: a dry-run counts as an executed run (liveness, not apply-ness)", () => {
  const r = evaluateLiveness({
    now: Date.now(),
    staleAfterHours: 26,
    lastRunExists: true,
    lastRunRaw: JSON.stringify({ mode: "dry-run", timestamp: new Date(Date.now() - 2 * HOUR_MS).toISOString() }),
    janitorDeployed: true,
  });
  assert.equal(r.stale, false);
  assert.equal(r.mode, "dry-run");
});

// ---------------------------------------------------------------------------
// Unit: parseDiskUsage (pure)
// ---------------------------------------------------------------------------

test("parseDiskUsage: parses real df -kP output", () => {
  const out = "Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/sda1        405196772 319334268  85846120      79% /\n";
  const d = parseDiskUsage(out);
  assert.equal(d.totalKb, 405196772);
  assert.equal(d.usedKb, 319334268);
  assert.equal(d.availKb, 85846120);
  assert.equal(d.usePercent, 79);
});

test("parseDiskUsage: rejects garbage", () => {
  assert.equal(parseDiskUsage(""), null);
  assert.equal(parseDiskUsage("only a header\n"), null);
  assert.equal(parseDiskUsage("a b\n1 2 3 4 5\n"), null);
});

// ---------------------------------------------------------------------------
// Unit: readApiCredential honors the auth.json override (no real auth.json)
// ---------------------------------------------------------------------------

test("readApiCredential: loads token from a sandbox auth.json (in-process only)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "watch-auth-"));
  try {
    const authPath = path.join(dir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ credentials: { "http://localhost:3100": { token: "sandbox-fake-token" } } }));
    const cred = readApiCredential({ ...CONFIG, PAPERCLIP_AUTH_JSON_PATH: authPath });
    assert.ok(cred);
    assert.equal(cred.apiBase, "http://localhost:3100");
    assert.equal(typeof cred.token, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readApiCredential: missing auth.json returns null", () => {
  assert.equal(readApiCredential({ ...CONFIG, PAPERCLIP_AUTH_JSON_PATH: "/nonexistent/auth.json" }), null);
});

// ---------------------------------------------------------------------------
// Integration: CLI against a mock Paperclip API (AC7 evidence, reproducible)
// ---------------------------------------------------------------------------

/**
 * Minimal mock of the two board endpoints the watchdog uses. Records every
 * request; stores created issues so the dedup search can see them.
 */
function startMockApi() {
  const requests = [];
  const issues = []; // { id, identifier, title, description, status, assigneeAgentId, priority }
  let nextNumber = 9001;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const rec = { method: req.method, path: url.pathname, q: url.searchParams.get("q"), status: url.searchParams.get("status") };
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (body) {
        try {
          rec.body = JSON.parse(body);
        } catch {
          rec.bodyRaw = body;
        }
      }
      rec.auth = req.headers.authorization;
      requests.push(rec);
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && /^\/api\/companies\/[^/]+\/issues$/.test(url.pathname)) {
        // Emulate: returns open issues matching q (server-side q filter is
        // loose; the watchdog's title filter must do the real dedup work).
        const open = issues.filter((i) => i.status !== "done");
        res.end(JSON.stringify(open));
      } else if (req.method === "POST" && /^\/api\/companies\/[^/]+\/issues$/.test(url.pathname)) {
        const identifier = `PLA-${nextNumber++}`;
        const issue = {
          id: `00000000-0000-4000-8000-${String(nextNumber).padStart(12, "0")}`,
          identifier,
          title: rec.body.title,
          status: "todo",
        };
        issues.push(issue);
        rec.createdIdentifier = identifier;
        res.statusCode = 200;
        res.end(JSON.stringify(issue));
      } else if (req.method === "PATCH" && /^\/api\/issues\/.+$/.test(url.pathname)) {
        const id = url.pathname.split("/").pop();
        const issue = issues.find((i) => i.id === id);
        if (!issue) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        if (rec.body?.status) issue.status = rec.body.status;
        res.end(JSON.stringify(issue));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "no such route" }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, issues, port: server.address().port }));
  });
}

function makeSandbox({ ageHours }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "watch-sandbox-"));
  const stateDir = path.join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  if (ageHours !== undefined) {
    writeFileSync(
      path.join(stateDir, "last-run.json"),
      JSON.stringify({ mode: "apply", timestamp: new Date(Date.now() - ageHours * HOUR_MS).toISOString() }),
    );
  }
  writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ credentials: { "http://localhost:3100": { token: "sandbox-fake-token" } } }));
  return { dir, stateDir, authPath: path.join(dir, "auth.json") };
}

// Async on purpose: the mock API server runs in THIS process, so a
// synchronous exec* would block the event loop and deadlock the child's
// fetch against the mock.
async function runWatchdog(mock, sandbox, args) {
  const env = {
    ...process.env,
    PLA_JANITOR_STATE_DIR: sandbox.stateDir,
    PLA_JANITOR_AUTH_JSON: sandbox.authPath,
    PLA_JANITOR_WATCH_API_BASE: `http://127.0.0.1:${mock.port}`,
    PLA_JANITOR_WATCH_JANITOR_PATH: SCRIPT_PATH, // sibling "janitor" that exists
    PLA_JANITOR_WATCH_STALE_HOURS: "26",
  };
  const stdout = await new Promise((resolve, reject) => {
    execFile("node", [SCRIPT_PATH, ...args], { env, encoding: "utf8" }, (err, out) => {
      if (err) reject(err);
      else resolve(out);
    });
  });
  return JSON.parse(stdout.slice(stdout.indexOf("{")));
}

test("integration: stale state files exactly one alarm; second run dedups (AC7a)", async () => {
  const mock = await startMockApi();
  try {
    const sandbox = makeSandbox({ ageHours: 30 });
    const first = await runWatchdog(mock, sandbox, ["--apply", "--json"]);
    assert.equal(first.stale, true);
    assert.equal(first.action.kind, "alarm");
    assert.equal(first.action.filed, true);
    const created = mock.issues.filter((i) => i.title.includes("[janitor-liveness-alarm]"));
    assert.equal(created.length, 1);

    const second = await runWatchdog(mock, sandbox, ["--apply", "--json"]);
    assert.equal(second.action.kind, "alarm");
    assert.equal(second.action.filed, false);
    assert.equal(second.action.deduped, true);
    // Exactly one create across both runs:
    const creates = mock.requests.filter((r) => r.method === "POST");
    assert.equal(creates.length, 1);
    // Disk independence (AC3): payload carries df use% and the last-run timestamp.
    assert.equal(typeof first.disk?.usePercent, "number");
    assert.equal(first.liveness.timestampIso.endsWith("Z"), true);
  } finally {
    mock.server.close();
  }
});

test("integration: fresh state files nothing and exits clean (AC7b)", async () => {
  const mock = await startMockApi();
  try {
    const sandbox = makeSandbox({ ageHours: 1 });
    const out = await runWatchdog(mock, sandbox, ["--apply", "--json"]);
    assert.equal(out.stale, false);
    assert.equal(out.action.kind, "no-op");
    assert.equal(mock.requests.filter((r) => r.method === "POST").length, 0);
  } finally {
    mock.server.close();
  }
});

test("integration: recovery closes the open alarm, then a new death can alarm again (AC7c)", async () => {
  const mock = await startMockApi();
  try {
    // 1. Stale -> alarm filed.
    let sandbox = makeSandbox({ ageHours: 30 });
    const alarm = await runWatchdog(mock, sandbox, ["--apply", "--json"]);
    assert.equal(alarm.action.filed, true);
    const alarmId = alarm.action.identifier;

    // 2. Janitor recovers: fresh state -> watchdog closes the open alarm with a comment.
    sandbox = makeSandbox({ ageHours: 0.5 });
    const recovery = await runWatchdog(mock, sandbox, ["--apply", "--json"]);
    assert.equal(recovery.action.kind, "recovery");
    assert.deepEqual(recovery.action.closed, [alarmId]);
    const patch = mock.requests.find((r) => r.method === "PATCH");
    assert.equal(patch.body.status, "done");
    assert.match(patch.body.comment, /Recovered: host-disk-janitor ran/);
    assert.equal(mock.issues.find((i) => i.identifier === alarmId).status, "done");

    // 3. Janitor dies again -> a NEW alarm is filed (dedup did not stick).
    sandbox = makeSandbox({ ageHours: 30 });
    const again = await runWatchdog(mock, sandbox, ["--apply", "--json"]);
    assert.equal(again.action.filed, true);
    assert.notEqual(again.action.identifier, alarmId);
    assert.equal(mock.requests.filter((r) => r.method === "POST").length, 2);
  } finally {
    mock.server.close();
  }
});

test("integration: issues that merely MENTION the marker (title lacks it) do not dedup", async () => {
  const mock = await startMockApi();
  try {
    mock.issues.push({ id: "00000000-0000-4000-8000-00000000000a", identifier: "MOCK-8888", title: "Some unrelated ticket", status: "todo" });
    const sandbox = makeSandbox({ ageHours: 30 });
    const out = await runWatchdog(mock, sandbox, ["--apply", "--json"]);
    assert.equal(out.action.filed, true, "must file despite a mention-only open issue");
  } finally {
    mock.server.close();
  }
});

test("integration: dry-run makes no network calls at all", async () => {
  const mock = await startMockApi();
  try {
    const sandbox = makeSandbox({ ageHours: 30 });
    const out = await runWatchdog(mock, sandbox, ["--json"]);
    assert.equal(out.stale, true);
    assert.equal(out.action.wouldFileIssue, true);
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.server.close();
  }
});

test("integration: API unreachable while stale exits nonzero (failure is visible)", async () => {
  const sandbox = makeSandbox({ ageHours: 30 });
  const env = {
    ...process.env,
    PLA_JANITOR_STATE_DIR: sandbox.stateDir,
    PLA_JANITOR_AUTH_JSON: sandbox.authPath,
    PLA_JANITOR_WATCH_API_BASE: "http://127.0.0.1:1", // nothing listens here
    PLA_JANITOR_WATCH_JANITOR_PATH: SCRIPT_PATH,
  };
  const run = (args) =>
    new Promise((resolve) => {
      execFile("node", [SCRIPT_PATH, ...args], { env, encoding: "utf8" }, (err, out) =>
        resolve({ err, out }),
      );
    });
  // Both runs exit 1: the alarm could not be delivered, so the failure is
  // visible in the exit code (and therefore in the systemd unit state).
  const jsonRun = await run(["--apply", "--json"]);
  assert.notEqual(jsonRun.err, null);
  assert.equal(Number(jsonRun.err.code), 1);
  const out = JSON.parse(jsonRun.out.slice(jsonRun.out.indexOf("{")));
  assert.equal(out.action.kind, "error");
  const plainRun = await run(["--apply"]);
  assert.notEqual(plainRun.err, null);
  assert.equal(Number(plainRun.err.code), 1);
});

test("integration: alert payload carries df use% and last-run timestamp (AC3)", async () => {
  const mock = await startMockApi();
  try {
    const sandbox = makeSandbox({ ageHours: 27.5 });
    await runWatchdog(mock, sandbox, ["--apply", "--json"]);
    const create = mock.requests.find((r) => r.method === "POST");
    assert.match(create.body.title, /\[janitor-liveness-alarm\]/);
    assert.match(create.body.description, /% used/);
    assert.match(create.body.description, /last run .*mode=apply/);
    assert.equal(create.body.priority, "high");
    assert.equal(create.body.assigneeAgentId, CONFIG.ASSIGNEE_AGENT_ID);
  } finally {
    mock.server.close();
  }
});
