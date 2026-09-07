#!/usr/bin/env node
/**
 * drift-sweep.mjs — scheduled consumer of the drift ledger.
 *
 * Wraps the SAME ledger computation as drift-check.mjs (single code path)
 * and posts it to a tracker issue on the Paperclip board when the set of
 * commits missing from the running install CHANGES. Between changes it is
 * silent, so re-runs, retries and timer restarts converge instead of
 * spamming the tracker.
 *
 * Credentials: uses $PAPERCLIP_API_KEY when set; otherwise loads the host
 * board credential from ~/.paperclip/auth.json IN-PROCESS and uses it as a
 * bearer header. The credential value is never logged, echoed, or written
 * anywhere — only HTTP status codes and response metadata reach the log.
 * Board-key writes carry an agent-provenance banner (Platform decision-
 * provenance policy): automated ledger, never an operator decision.
 *
 * Usage:
 *   node scripts/fork-release/drift-sweep.mjs [options]
 *
 * Options / environment:
 *   --issue <key>          tracker issue key (or $DRIFT_TRACKER_ISSUE; required)
 *   --install-dir <dir>    installed tree root ($INSTALL_DIR or the npm global default)
 *   --target <ref>         target ref, default master
 *   --repo <owner/name>    release repository ($RELEASE_REPO or the fork default)
 *   --ticket-regex <re>    owning-ticket extraction ($DRIFT_TICKET_RE)
 *   --api-base <url>       board API base ($PAPERCLIP_API_URL or the loopback default)
 *   --state-file <path>    dedupe state ($DRIFT_STATE_FILE or ~/.paperclip/fork-drift-sweep-state.json)
 *   --agent-label <text>   provenance label ($DRIFT_AGENT_LABEL, default "fork-drift sweep")
 *   --force                post even when the missing set is unchanged
 *
 * Exit codes: 0 ran fine (posted or converged); 2 configuration error;
 * 1 drift-check control/environment failure or post failure (systemd marks
 * the run failed; state is untouched so the next run retries cleanly).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import {
  computeDriftLedger,
  DEFAULT_INSTALL_DIR,
  DEFAULT_REPO,
  extractPullNumber,
  extractTicket,
  ghApi,
} from "./drift-check.mjs";

const DEFAULT_API_BASE = process.env.PAPERCLIP_API_URL
  ?? "http://127.0.0.1:3100/api";

function log(message) {
  process.stdout.write(`${new Date().toISOString()} fork-drift-sweep: ${message}\n`);
}

function parseArgs(argv) {
  const args = {
    issue: process.env.DRIFT_TRACKER_ISSUE ?? null,
    installDir: process.env.INSTALL_DIR ?? DEFAULT_INSTALL_DIR,
    versionOverride: null,
    installedCommit: null,
    target: "master",
    repo: process.env.RELEASE_REPO ?? DEFAULT_REPO,
    ticketRegex: process.env.DRIFT_TICKET_RE ?? null,
    apiBase: DEFAULT_API_BASE.replace(/\/$/, ""),
    stateFile: process.env.DRIFT_STATE_FILE
      ?? join(homedir(), ".paperclip", "fork-drift-sweep-state.json"),
    agentLabel: process.env.DRIFT_AGENT_LABEL ?? "fork-drift sweep",
    force: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const needsValue = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    switch (arg) {
      case "--issue": args.issue = needsValue(); break;
      case "--install-dir": args.installDir = needsValue(); break;
      case "--version": args.versionOverride = needsValue(); break;
      case "--installed-commit": args.installedCommit = needsValue(); break;
      case "--target": args.target = needsValue(); break;
      case "--repo": args.repo = needsValue(); break;
      case "--ticket-regex": args.ticketRegex = needsValue(); break;
      case "--api-base": args.apiBase = needsValue().replace(/\/$/, ""); break;
      case "--state-file": args.stateFile = needsValue(); break;
      case "--agent-label": args.agentLabel = needsValue(); break;
      case "--force": args.force = true; break;
      case "--help": case "-h": args.help = true; break;
      default: throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return args;
}

/**
 * Resolve the board bearer token WITHOUT exposing it: env key wins; otherwise
 * read the host credential file in-process and return only the token string.
 * Never log the return value.
 */
export function resolveBoardToken({ env = process.env, credentialPath = join(homedir(), ".paperclip", "auth.json"), apiBase } = {}) {
  const fromEnv = env.PAPERCLIP_API_KEY;
  if (fromEnv) return { token: fromEnv, source: "env" };
  if (!existsSync(credentialPath)) {
    return { error: `no $PAPERCLIP_API_KEY and no credential file at ${credentialPath}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(credentialPath, "utf8"));
  } catch (err) {
    return { error: `credential file unreadable: ${err.message}` };
  }
  const entries = Object.values(parsed?.credentials ?? {});
  if (entries.length === 0) {
    return { error: "credential file carries no credentials" };
  }
  const match = entries.find((entry) => {
    const base = String(entry?.apiBase ?? "").replace(/\/$/, "");
    return base !== "" && apiBase.startsWith(base);
  }) ?? entries[0];
  if (typeof match?.token !== "string" || match.token.length === 0) {
    return { error: "credential entry carries no token" };
  }
  return { token: match.token, source: "credential-file" };
}

/** Acquire a simple stale-aware lock so timer overlap converges instead of racing. */
export function acquireLock(lockPath, { staleMs = 30 * 60 * 1000 } = {}) {
  mkdirSync(join(lockPath, ".."), { recursive: true });
  if (existsSync(lockPath)) {
    let age = Infinity;
    try {
      age = Date.now() - statSync(lockPath).mtimeMs;
    } catch { /* someone removed it between exists and stat — fine */ }
    if (age < staleMs) {
      return { ok: false, error: `another sweep holds the lock (age ${Math.round(age / 1000)}s)` };
    }
    log(`removing stale lock (age ${Math.round(age / 1000)}s)`);
    rmSync(lockPath, { force: true });
  }
  writeFileSync(lockPath, String(process.pid));
  return { ok: true };
}

export function releaseLock(lockPath) {
  rmSync(lockPath, { force: true });
}

/** Load the dedupe state; a missing or corrupt file converges to empty state. */
export function loadState(stateFile) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.lastPosted?.missingShas)) {
      return parsed;
    }
  } catch { /* first run or corrupt — start clean */ }
  return { lastPosted: null };
}

export function missingSetSignature(missing) {
  return missing.map((entry) => entry.sha).sort();
}

/**
 * The provenance banner required on every board-credential write: it names
 * the automation and states that no operator decision is recorded here.
 */
export function provenanceBanner(agentLabel) {
  return (
    `> **Agent action — NOT an operator decision.** Posted automatically by the ${agentLabel} ` +
    `(Platform engineering automation) using the host board credential. This is a read-only drift ` +
    `ledger; no decision, approval, or ruling is recorded by this comment.\n`
  );
}

export function buildSweepComment({ ledgerText, missing, agentLabel, ticketRegexSource }) {
  const lines = [provenanceBanner(agentLabel), "", "## Fork-release drift ledger", ""];
  lines.push("```");
  lines.push(...ledgerText.split("\n"));
  lines.push("```");
  lines.push("");
  lines.push("Commits referenced:");
  lines.push("");
  for (const entry of missing) {
    const pr = extractPullNumber(entry.subject);
    const ticket = extractTicket(entry.message, ticketRegexSource);
    const refs = [pr ? `PR #${pr}` : null, ticket ? `ticket ${ticket}` : null].filter(Boolean).join(", ");
    lines.push(`- ${entry.sha.slice(0, 12)} — ${entry.subject}${refs ? ` (${refs})` : ""}${entry.htmlUrl ? ` — ${entry.htmlUrl}` : ""}`);
  }
  lines.push("");
  lines.push(
    "This ledger refreshes only when the missing set changes. Silence here means the drift picture is unchanged, " +
    "not that the sweep stopped running — check the service journal for per-run results.",
  );
  return lines.join("\n");
}

async function postComment({ apiBase, issue, body, token }) {
  const response = await fetch(`${apiBase}/issues/${encodeURIComponent(issue)}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`board POST ${response.status}: ${text.slice(0, 300)}`);
  }
  const payload = await response.json().catch(() => ({}));
  return payload;
}

/**
 * One sweep iteration. Injectable deps (`ghApiFn`, `fetchImpl`, `boardToken`)
 * keep the whole loop testable without network or credentials. Returns
 * `{ outcome: "posted" | "converged" | "skipped" | "check-failed" | "error", detail }`.
 */
export async function sweepOnce({
  args,
  ghApiFn,
  fetchImpl = postComment,
  boardToken,
} ) {
  const result = computeDriftLedger({
    repo: args.repo,
    installDir: args.installDir,
    versionOverride: args.versionOverride ?? null,
    pinnedCommit: args.installedCommit ?? null,
    target: args.target,
    ticketRegexSource: args.ticketRegex,
    ghApiFn,
  });

  if (!result.ok) {
    // Control failures must be loud but must NEVER become a fabricated
    // ledger on the tracker. State stays untouched, so recovery reposts.
    return { outcome: "check-failed", detail: `${result.stage}: ${result.error}` };
  }

  const signature = missingSetSignature(result.missing);
  const state = loadState(args.stateFile);
  const last = state.lastPosted;
  const unchanged =
    last !== null &&
    JSON.stringify(last.missingShas) === JSON.stringify(signature) &&
    last.targetCommit === result.targetCommit;

  if (unchanged && !args.force) {
    return {
      outcome: "converged",
      detail: `missing set unchanged since ${last.postedAt} (${signature.length} commit(s), target ${result.targetCommit.slice(0, 12)})`,
    };
  }

  if (boardToken?.error) {
    return { outcome: "error", detail: `cannot resolve board credential: ${boardToken.error}` };
  }

  const body = buildSweepComment({
    ledgerText: result.ledgerText,
    missing: result.missing,
    agentLabel: args.agentLabel,
    ticketRegexSource: args.ticketRegex,
  });

  let posted;
  try {
    posted = await fetchImpl({ apiBase: args.apiBase, issue: args.issue, body, token: boardToken.token });
  } catch (err) {
    return { outcome: "error", detail: `board post failed: ${err.message}` };
  }

  mkdirSync(join(args.stateFile, ".."), { recursive: true });
  writeFileSync(args.stateFile, `${JSON.stringify({
    lastPosted: {
      postedAt: new Date().toISOString(),
      targetCommit: result.targetCommit,
      missingShas: signature,
      installVersion: result.installVersion,
      issue: args.issue,
    },
  }, null, 2)}\n`);

  return {
    outcome: "posted",
    detail: `posted to ${args.issue} (comment ${posted?.id ?? "<no id>"}, ${signature.length} missing commit(s), target ${result.targetCommit.slice(0, 12)})`,
    missingCount: signature.length,
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`drift-sweep: ${err.message}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write("See the header comment of scripts/fork-release/drift-sweep.mjs.\n");
    process.exit(0);
  }
  if (!args.issue) {
    process.stderr.write("drift-sweep: --issue or $DRIFT_TRACKER_ISSUE is required\n");
    process.exit(2);
  }

  const lockPath = `${args.stateFile}.lock`;
  const lock = acquireLock(lockPath);
  if (!lock.ok) {
    log(`skipping: ${lock.error}`);
    process.exit(0);
  }

  // process.exit() does NOT run finally blocks — register the release as an
  // exit handler so the lock can never outlive this process.
  process.on("exit", () => releaseLock(lockPath));

  try {
    const outcome = await sweepOnce({
      args,
      ghApiFn: ghApi,
      boardToken: resolveBoardToken({ apiBase: args.apiBase }),
    });
    log(`${outcome.outcome}: ${outcome.detail}`);
    process.exit({
      posted: 0,
      converged: 0,
      skipped: 0,
      "check-failed": 1,
      error: 1,
    }[outcome.outcome] ?? 1);
  } catch (err) {
    log(`unexpected failure: ${err.message}`);
    process.exit(1);
  }
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isDirect) {
  await main();
}
