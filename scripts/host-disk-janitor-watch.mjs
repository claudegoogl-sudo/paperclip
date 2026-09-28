#!/usr/bin/env node
/**
 * host-disk-janitor-watch.mjs — liveness watchdog for host-disk-janitor.mjs
 *
 * Why this exists: the janitor's only alarm
 * (df >= 85% -> file issue) lives INSIDE the janitor. When the cron entry
 * died ~2026-09-12/13 (user crontab wiped), there was no prune AND no
 * alarm — a single point of failure. This watchdog is a separate, fully
 * read-only process that alarms when the janitor has not left evidence of
 * a recent run, independent of the janitor's own health.
 *
 * What it does each run (<1s CPU, no filesystem access beyond stat/read of
 * ONE json file + one `df` call):
 *   1. Reads `<STATE_DIR>/last-run.json` (written by the janitor after
 *      every run, apply or dry-run) and evaluates staleness against
 *      STALE_AFTER_HOURS (default 26 — daily cron + 2h grace).
 *   2. Reads current disk usage (`df -kP /`) so disk pressure is visible
 *      in the alert even while the janitor is dead.
 *   3. Stale (or last-run.json missing/unparseable):
 *        - dedup: search open issues for the title marker
 *        - if none open: file `[janitor-liveness-alarm] ...` assigned to
 *          the CTO agent (priority high). One alert per incident.
 *   4. Fresh: if a previous liveness alarm is still open, close it
 *      (status -> done) with a one-line recovery comment. This keeps the
 *      dedup cycle honest — a stuck-open alarm would mask the next death.
 *
 * Safety model:
 *   - Read-only + alert. This script deletes nothing, writes no files,
 *     and mutates nothing outside its own alarm issues on the board.
 *   - `--dry-run` is the default: evaluates and prints, makes NO network
 *     calls. `--apply` is required for any API access (same convention as
 *     the janitor).
 *   - The API credential is read in-process from the operator's auth.json
 *     (same reader as the janitor). It is never logged, never embedded.
 *   - Exit codes: 0 = check completed (healthy, alarm filed, deduped, or
 *     recovery closed). 1 = the check could not complete or an action
 *     failed (missing credential, API error) — the systemd unit then shows
 *     `failed`, which is itself an observability signal.
 *
 * Scheduling (cron-independent by requirement):
 *   Primary leg : systemd user timer `janitor-liveness-watch.timer`
 *                 (hourly, Persistent=true; user lingering is enabled:
 *                 `loginctl show-user paperclip -p Linger` -> Linger=yes).
 *   Second leg  : one redundant user-crontab line running this same
 *                 script (dedup makes double-firing harmless). The timer
 *                 must never be the crontab's dependent: it survives
 *                 crontab wipes, which is the exact 2026-09 failure mode.
 *
 * Install (as the paperclip user):
 *   1. Land this file on fork master, then byte-identical copy to
 *      /home/paperclip/scripts/ (same deployment rule as the janitor).
 *   2. Install the units (see the issue/PR for the exact unit files):
 *        ~/.config/systemd/user/janitor-liveness-watch.timer
 *        ~/.config/systemd/user/janitor-liveness-watch.service
 *        systemctl --user daemon-reload
 *        systemctl --user enable --now janitor-liveness-watch.timer
 *   3. (Optional second leg) append the crontab line documented in the
 *      issue — never as the ONLY leg.
 *
 * Verify:
 *   - Fresh state is a no-op:
 *       node /home/paperclip/scripts/host-disk-janitor-watch.mjs --apply --json
 *     -> { "stale": false, ... } and no new issue.
 *   - Stale-state simulation in a sandbox (never touch the live state dir):
 *       PLA_JANITOR_STATE_DIR=/tmp/watch-sandbox \
 *       PLA_JANITOR_WATCH_API_BASE=http://127.0.0.1:<mock-port> \
 *       PLA_JANITOR_AUTH_JSON=/tmp/watch-sandbox/fake-auth.json \
 *       node scripts/host-disk-janitor-watch.mjs --apply --json
 *     (host-disk-janitor-watch.test.mjs runs exactly this against a local
 *     mock API server and asserts dedup / no-op / recovery.)
 *
 * Rollback:
 *   systemctl --user disable --now janitor-liveness-watch.timer
 *   systemctl --user daemon-reload   # after removing the unit files
 *   crontab -e                        # remove the watchdog line if added
 *   rm /home/paperclip/scripts/host-disk-janitor-watch.mjs
 *   The janitor itself is untouched by this watchdog at every step.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const HOUR_MS = 3600 * 1000;

// Statuses that count as "still open" for alarm dedup — identical set to the
// janitor's own ALARM_OPEN_STATUSES so both alarms behave the same way.
const ALARM_OPEN_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];

// Same env var the janitor uses for its state dir, so one sandbox override
// redirects both the janitor and this watchdog consistently.
const STATE_DIR = process.env.PLA_JANITOR_STATE_DIR || path.join(HOME, ".paperclip/host-disk-janitor");

export const CONFIG = {
  STATE_DIR,
  // MUST derive from STATE_DIR (not the hard-coded home path) so the sandbox
  // override actually redirects the file this watchdog reads.
  LAST_RUN_FILE: process.env.PLA_JANITOR_WATCH_LAST_RUN_FILE || path.join(STATE_DIR, "last-run.json"),
  // "the file is missing while the script is deployed": the janitor is
  // considered deployed when a sibling host-disk-janitor.mjs exists next to
  // this script (true both in /home/paperclip/scripts/ and in a repo tree).
  JANITOR_SCRIPT_PATH:
    process.env.PLA_JANITOR_WATCH_JANITOR_PATH ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), "host-disk-janitor.mjs"),
  STALE_AFTER_HOURS: Number(process.env.PLA_JANITOR_WATCH_STALE_HOURS || 26),
  DISK_PATH: process.env.PLA_JANITOR_WATCH_DISK_PATH || "/",
  ALARM_ISSUE_TITLE_MARKER: "[janitor-liveness-alarm]",
  // companyId is not a secret (UUID identifying the operator company).
  COMPANY_ID: process.env.PAPERCLIP_COMPANY_ID || "d49b266c-50dc-42c5-b45e-308c7f3ffc1f",
  // Alerts route to the CTO agent. Agent UUID, not a secret.
  ASSIGNEE_AGENT_ID:
    process.env.PLA_JANITOR_WATCH_ASSIGNEE_AGENT_ID || "ca7c92dd-2c00-4811-ae20-dd3bb1782c1d",
  PAPERCLIP_AUTH_JSON_PATH: process.env.PLA_JANITOR_AUTH_JSON || path.join(HOME, ".paperclip/auth.json"),
  PAPERCLIP_API_BASE_FALLBACK: "http://localhost:3100",
  // Test-only overrides: point at a mock server / inject a fake token so the
  // integration tests never touch the real board or the real auth.json.
  API_BASE_OVERRIDE: process.env.PLA_JANITOR_WATCH_API_BASE || "",
  API_TOKEN_OVERRIDE: process.env.PLA_JANITOR_WATCH_API_TOKEN || "",
};

// ---------------------------------------------------------------------------
// Liveness evaluation (pure, filesystem-free) — unit-tested directly.
// ---------------------------------------------------------------------------

/**
 * Evaluate janitor liveness from the content of last-run.json.
 *
 * `readLastRun` is injected so tests can pass a stub; production passes a
 * real reader. Returns:
 *   {
 *     stale: boolean,
 *     reason: "fresh" | "stale-timestamp" | "missing-last-run" |
 *             "unparseable-last-run" | "invalid-timestamp",
 *     lastRunExists, janitorDeployed, mode, timestamp, timestampIso, ageHours
 *   }
 *
 * Policy notes:
 *   - Any recorded run (apply OR dry-run) counts as "the janitor executed";
 *     the liveness contract is about execution, and a dry-run
 *     still proves cron + script + node are alive. The mode is surfaced in
 *     the alert payload for diagnosis (a dry-run-only streak is suspicious
 *     but is not, by itself, a liveness failure).
 *   - A missing last-run.json is STALE regardless of janitor deployment
 *     state: "no evidence of a recent run" is the invariant. The reason
 *     string distinguishes deployed/not-deployed for the alert body.
 */
export function evaluateLiveness({
  now = Date.now(),
  staleAfterHours = 26,
  lastRunExists,
  lastRunRaw,
  janitorDeployed,
}) {
  const base = {
    lastRunExists: Boolean(lastRunExists),
    janitorDeployed: Boolean(janitorDeployed),
    mode: null,
    timestamp: null,
    timestampIso: null,
    ageHours: null,
  };
  if (!lastRunExists) {
    return {
      ...base,
      stale: true,
      reason: janitorDeployed ? "missing-last-run" : "missing-last-run-and-janitor",
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(lastRunRaw);
  } catch {
    return { ...base, stale: true, reason: "unparseable-last-run" };
  }
  const ts = typeof parsed?.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
  if (!Number.isFinite(ts)) {
    return { ...base, mode: parsed?.mode ?? null, stale: true, reason: "invalid-timestamp" };
  }
  const ageHours = (now - ts) / HOUR_MS;
  const stale = ageHours > staleAfterHours;
  return {
    ...base,
    mode: typeof parsed?.mode === "string" ? parsed.mode : null,
    timestamp: ts,
    timestampIso: parsed.timestamp,
    ageHours: Math.round(ageHours * 10) / 10,
    stale,
    reason: stale ? "stale-timestamp" : "fresh",
  };
}

/** Parse `df -kP <path>` output into { totalKb, usedKb, availKb, usePercent }. */
export function parseDiskUsage(dfOutput) {
  const lines = String(dfOutput ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  const fields = lines[1].split(/\s+/);
  if (fields.length < 6) return null;
  const [totalKb, usedKb, availKb] = [Number(fields[1]), Number(fields[2]), Number(fields[3])];
  const pct = parseInt(fields[4], 10);
  if (![totalKb, usedKb, availKb].every(Number.isFinite) || !Number.isFinite(pct)) return null;
  return { totalKb, usedKb, availKb, usePercent: pct };
}

/** Run `df -kP` on CONFIG.DISK_PATH. Returns null when unavailable. */
function readDiskUsage(diskPath = CONFIG.DISK_PATH) {
  try {
    return parseDiskUsage(execFileSync("df", ["-kP", diskPath], { encoding: "utf8", timeout: 5000 }));
  } catch {
    return null;
  }
}

function kbToHuman(kb) {
  const units = ["KB", "MB", "GB", "TB"];
  let v = kb;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(1)}${units[u]}`;
}

// ---------------------------------------------------------------------------
// Credential + board API (mirrors the janitor's reader; token never logged)
// ---------------------------------------------------------------------------

/** Read the API credential in-process from auth.json. Never prints it. */
export function readApiCredential(config = CONFIG) {
  if (config.API_TOKEN_OVERRIDE && config.API_BASE_OVERRIDE) {
    return { apiBase: config.API_BASE_OVERRIDE, token: config.API_TOKEN_OVERRIDE };
  }
  if (!existsSync(config.PAPERCLIP_AUTH_JSON_PATH)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(config.PAPERCLIP_AUTH_JSON_PATH, "utf8"));
  } catch {
    return null;
  }
  const credentials = parsed?.credentials || {};
  let apiBase = process.env.PAPERCLIP_RUNTIME_API_URL || config.PAPERCLIP_API_BASE_FALLBACK;
  let entry = credentials[apiBase];
  if (!entry) {
    const firstKey = Object.keys(credentials)[0];
    if (!firstKey) return null;
    apiBase = firstKey;
    entry = credentials[firstKey];
  }
  if (!entry?.token) return null;
  if (config.API_BASE_OVERRIDE) apiBase = config.API_BASE_OVERRIDE;
  return { apiBase, token: config.API_TOKEN_OVERRIDE || entry.token };
}

function apiHeaders(credential) {
  return { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };
}

/** Find OPEN issues whose TITLE contains the marker (q also matches bodies;
 *  the title filter keeps dedup immune to mentions in other issues). */
export async function findOpenAlarmIssues({ marker, companyId, credential }) {
  const createUrl = `${credential.apiBase}/api/companies/${companyId}/issues`;
  const searchUrl =
    `${createUrl}?q=${encodeURIComponent(marker)}&status=${encodeURIComponent(ALARM_OPEN_STATUSES.join(","))}`;
  const resp = await fetch(searchUrl, { headers: apiHeaders(credential) });
  if (!resp.ok) throw new Error(`alarm search failed: HTTP ${resp.status}`);
  const body = await resp.json();
  const issues = Array.isArray(body) ? body : body.issues || body.data || [];
  return issues.filter(
    (issue) =>
      typeof issue.title === "string" &&
      issue.title.includes(marker) &&
      !["done", "closed", "cancelled"].includes(String(issue.status).toLowerCase()),
  );
}

function describeLastRun(liveness) {
  if (!liveness.lastRunExists) return "last-run.json MISSING";
  if (liveness.reason === "unparseable-last-run") return "last-run.json UNPARSEABLE";
  if (liveness.reason === "invalid-timestamp") return `last-run.json timestamp INVALID (mode=${liveness.mode ?? "unknown"})`;
  return `last run ${liveness.timestampIso} (mode=${liveness.mode ?? "unknown"}, ${liveness.ageHours}h ago)`;
}

function alarmTitle(liveness, staleAfterHours) {
  return `${CONFIG.ALARM_ISSUE_TITLE_MARKER} host-disk-janitor stale: no run in ${liveness.ageHours ?? "?"}h (threshold ${staleAfterHours}h) — ${describeLastRun(liveness)}`;
}

function alarmDescription({ liveness, staleAfterHours, disk, nowIso }) {
  const diskLine = disk
    ? `\`df -kP /\`: **${disk.usePercent}% used** — ${kbToHuman(disk.usedKb)} used, ${kbToHuman(disk.availKb)} available of ${kbToHuman(disk.totalKb)}`
    : "`df -kP /` could not be read (disk pressure UNKNOWN — check manually)";
  return [
    "Automated liveness alert from `scripts/host-disk-janitor-watch.mjs` (systemd user timer `janitor-liveness-watch` + redundant crontab leg). This is a watchdog alert, not an operator decision.",
    "",
    `**The daily host-disk-janitor has not left evidence of a run within ${staleAfterHours}h.**`,
    "",
    `- ${describeLastRun(liveness)}`,
    `- Janitor script deployed at expected path: ${liveness.janitorDeployed ? "yes" : "NO (deployment itself is broken)"}`,
    `- Checked at ${nowIso}`,
    `- ${diskLine}`,
    "",
    "Disk pressure above is current even though the janitor is dead — the janitor's own 85% alarm cannot fire in this state (that is the blindspot this watchdog covers).",
    "",
    "Likely causes, in observed order:",
    "1. User crontab wiped / janitor line dropped (happened 2026-09-12/13) — `crontab -l | grep host-disk-janitor`",
    "2. Janitor script errored before writing state — `tail -50 ~/.paperclip/instances/default/host-disk-janitor.log`",
    "3. Cron daemon or node unavailable — `systemctl status cron; /usr/bin/node --version`",
    "",
    "Recovery runbook:",
    "1. Inspect: `node /home/paperclip/scripts/host-disk-janitor.mjs --dry-run`",
    "2. Prune: `node /home/paperclip/scripts/host-disk-janitor.mjs --apply`",
    "3. Restore the scheduling leg that died (crontab line and/or janitor timer).",
    "",
    "**Auto-resolve contract:** this issue is closed automatically (status → done, one-line recovery comment) by the watchdog as soon as a fresh janitor run (< threshold) is observed. If woken by the recovery comment, no action is needed.",
  ].join("\n");
}

export async function fileAlarmIssue({ liveness, staleAfterHours, disk, companyId, assigneeAgentId, credential, nowIso }) {
  const resp = await fetch(`${credential.apiBase}/api/companies/${companyId}/issues`, {
    method: "POST",
    headers: apiHeaders(credential),
    body: JSON.stringify({
      title: alarmTitle(liveness, staleAfterHours),
      description: alarmDescription({ liveness, staleAfterHours, disk, nowIso }),
      priority: "high",
      assigneeAgentId,
      // status intentionally omitted: an assigned issue defaults to `todo`,
      // which wakes the assignee (CTO).
    }),
  });
  if (!resp.ok) throw new Error(`alarm issue creation failed: HTTP ${resp.status}`);
  const created = await resp.json();
  return created.identifier || created.id;
}

export async function resolveAlarmIssue({ issue, credential, liveness, nowIso }) {
  const comment =
    `Recovered: host-disk-janitor ran ${liveness.timestampIso} (mode=${liveness.mode ?? "unknown"}, ` +
    `${liveness.ageHours}h ago) — within the staleness threshold. Auto-closing; no action needed. ` +
    `(watchdog check at ${nowIso})`;
  const resp = await fetch(`${credential.apiBase}/api/issues/${issue.id}`, {
    method: "PATCH",
    headers: apiHeaders(credential),
    body: JSON.stringify({ status: "done", comment }),
  });
  if (!resp.ok) throw new Error(`alarm recovery close failed: HTTP ${resp.status}`);
  return true;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runWatch({ apply = false, now = Date.now() } = {}) {
  const nowIso = new Date(now).toISOString();
  const lastRunExists = existsSync(CONFIG.LAST_RUN_FILE);
  const lastRunRaw = lastRunExists ? readFileSync(CONFIG.LAST_RUN_FILE, "utf8") : null;
  const janitorDeployed = existsSync(CONFIG.JANITOR_SCRIPT_PATH);
  const liveness = evaluateLiveness({
    now,
    staleAfterHours: CONFIG.STALE_AFTER_HOURS,
    lastRunExists,
    lastRunRaw,
    janitorDeployed,
  });
  const disk = readDiskUsage();

  const summary = {
    watchdog: "host-disk-janitor-watch",
    mode: apply ? "apply" : "dry-run",
    checkedAt: nowIso,
    staleAfterHours: CONFIG.STALE_AFTER_HOURS,
    liveness,
    disk,
    stale: liveness.stale,
  };

  if (!apply) {
    summary.action = liveness.stale
      ? { kind: "alarm", filed: false, wouldFileIssue: true }
      : { kind: "no-op", wouldFileIssue: false };
    return { summary, exitCode: 0 };
  }

  const credential = readApiCredential();
  if (!credential) {
    summary.action = { kind: "error", error: "no API credential found in auth.json" };
    return { summary, exitCode: 1 };
  }

  try {
    if (liveness.stale) {
      const open = await findOpenAlarmIssues({
        marker: CONFIG.ALARM_ISSUE_TITLE_MARKER,
        companyId: CONFIG.COMPANY_ID,
        credential,
      });
      if (open.length > 0) {
        summary.action = { kind: "alarm", filed: false, deduped: true, dedupedAgainst: open.map((i) => i.identifier) };
      } else {
        const identifier = await fileAlarmIssue({
          liveness,
          staleAfterHours: CONFIG.STALE_AFTER_HOURS,
          disk,
          companyId: CONFIG.COMPANY_ID,
          assigneeAgentId: CONFIG.ASSIGNEE_AGENT_ID,
          credential,
          nowIso,
        });
        summary.action = { kind: "alarm", filed: true, identifier };
      }
    } else {
      const open = await findOpenAlarmIssues({
        marker: CONFIG.ALARM_ISSUE_TITLE_MARKER,
        companyId: CONFIG.COMPANY_ID,
        credential,
      });
      if (open.length > 0) {
        const closed = [];
        for (const issue of open) {
          await resolveAlarmIssue({ issue, credential, liveness, nowIso });
          closed.push(issue.identifier);
        }
        summary.action = { kind: "recovery", closed, recoveredAt: liveness.timestampIso };
      } else {
        summary.action = { kind: "no-op" };
      }
    }
  } catch (err) {
    summary.action = { kind: "error", error: String(err?.message || err) };
    return { summary, exitCode: 1 };
  }
  return { summary, exitCode: 0 };
}

function printSummary(summary) {
  const l = summary.liveness;
  const d = summary.disk;
  console.log(`host-disk-janitor-watch: mode=${summary.mode} at ${summary.checkedAt}`);
  console.log(
    `liveness:    ${l.stale ? "STALE" : "OK"} -- ${describeLastRun(l)} (threshold ${summary.staleAfterHours}h, reason=${l.reason})`,
  );
  console.log(`disk:        ${d ? `${d.usePercent}% used (${kbToHuman(d.availKb)} free of ${kbToHuman(d.totalKb)})` : "unavailable"}`);
  const a = summary.action || {};
  if (a.kind === "alarm") {
    if (a.filed) console.log(`action:      filed alarm issue ${a.identifier} (assigned to CTO, priority high)`);
    else if (a.deduped) console.log(`action:      alarm already open (${(a.dedupedAgainst || []).join(", ")}) — deduped`);
    else console.log(`action:      would file alarm issue (dry-run: no network call made)`);
  } else if (a.kind === "recovery") {
    console.log(`action:      recovered — closed alarm issue(s) ${(a.closed || []).join(", ")}`);
  } else if (a.kind === "no-op") {
    console.log(`action:      none (fresh state${summary.mode === "apply" ? ", no open alarm" : ""})`);
  } else if (a.kind === "error") {
    console.log(`action:      ERROR — ${a.error}`);
  }
}

function parseArgs(argv) {
  return { apply: argv.includes("--apply"), json: argv.includes("--json") };
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const { apply, json } = parseArgs(process.argv.slice(2));
  const { summary, exitCode } = await runWatch({ apply });
  if (json) console.log(JSON.stringify(summary, null, 2));
  else printSummary(summary);
  process.exit(exitCode);
}
