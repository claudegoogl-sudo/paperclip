#!/usr/bin/env node
/**
 * drift-check.mjs — is the running install the code we think it is?
 *
 * Answers one question: which commits are on the release repository's master
 * but ABSENT from the running install? `done` on a host-code change means
 * "merged"; nothing else checks it is also "running". This script closes that
 * gap at install/verify time.
 *
 * How it works:
 *   1. Resolve the INSTALLED commit:
 *        a. the `gitHead` stamp in the installed package.json (exact; written
 *           at build time by the release pipeline), or
 *        b. fallback: the release tag `v<version>` on the repository
 *           (indirect; a tag re-cut mid-build yields the wrong base, which is
 *           why the stamp exists).
 *   2. Fetch the TARGET head (default `master`) fresh from the repository.
 *   3. Compare base...target and print every commit on the target that the
 *      install does not contain.
 *
 * Positive control (mandatory): the resolved base must EXIST on the target's
 * history and the compare must classify as `ahead` or `identical`. Anything
 * else exits 3 (positive-control failure) and prints NO ledger — a check that
 * cannot distinguish "absent" from "looking in the wrong place" manufactures
 * confident false alarms. Scan the WHOLE release closure, not one file:
 * grepping a single bundle (e.g. the CLI entry) returns 0 for every
 * server-side symbol, including symbols that definitely shipped.
 *
 * Usage:
 *   node scripts/fork-release/drift-check.mjs [options]
 *
 * Options:
 *   --install-dir <dir>       installed tree root
 *                             (default: $INSTALL_DIR or /usr/lib/node_modules/paperclipai)
 *   --version <v>             installed version override (skips reading the install tree)
 *   --installed-commit <sha>  base-commit override; skips version/tag resolution (pin mode)
 *   --target <ref>            target ref, default master
 *   --repo <owner/name>       release repository, default claudegoogl-sudo/paperclip
 *   --ticket-regex <re>       optional JS regex source; first match per commit message is
 *                             reported as the owning internal ticket (deployment-local config)
 *   --limit <n>               max commits printed (default 50; all are always counted)
 *   --json                    machine-readable one-object output on stdout
 *
 * Exit codes:
 *   0  install is identical to target
 *   1  drift: target is ahead; ledger printed (warning, not a hard failure —
 *      the operator may knowingly run an older pin)
 *   2  usage/environment error (install tree missing, no version, no tag, gh failure)
 *   3  positive-control failure (base unresolvable or not an ancestor of target)
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

export const DEFAULT_INSTALL_DIR = "/usr/lib/node_modules/paperclipai";
export const DEFAULT_REPO = "claudegoogl-sudo/paperclip";
export const EXIT_CLEAN = 0;
export const EXIT_DRIFT = 1;
export const EXIT_ENV_ERROR = 2;
export const EXIT_CONTROL_FAILED = 3;

/** Read the installed package.json (whole manifest — version AND stamp live here). */
export function readInstalledManifest(installDir) {
  const manifestPath = join(installDir, "package.json");
  if (!existsSync(manifestPath)) {
    return { error: `no package.json at ${manifestPath} — wrong install dir?` };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { error: `unreadable ${manifestPath}: ${err.message}` };
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    return { error: `${manifestPath} carries no version field` };
  }
  return { manifest };
}

/**
 * Resolve the base commit from an installed manifest. Exact when the build
 * stamped it; null means "fall back to the release tag".
 */
export function resolveBaseCommitFromManifest(manifest) {
  for (const field of ["gitHead", "commit", "sha"]) {
    const value = manifest?.[field];
    if (typeof value === "string" && /^[0-9a-f]{40}$/.test(value.toLowerCase())) {
      return { commit: value.toLowerCase(), mode: "stamp", field };
    }
  }
  return null;
}

/** Extract the PR number from a commit subject's trailing "(#123)" marker. */
export function extractPullNumber(subject) {
  const match = /\(#(\d+)\)\s*$/.exec(subject ?? "");
  return match ? match[1] : null;
}

/** First match of the deployment-local ticket regex in a commit message, if any. */
export function extractTicket(message, ticketRegexSource) {
  if (!ticketRegexSource) return null;
  let re;
  try {
    re = new RegExp(ticketRegexSource);
  } catch {
    return null;
  }
  const match = re.exec(message ?? "");
  return match ? match[0] : null;
}

/** First line of a commit message. */
export function subjectOf(message) {
  return String(message ?? "").split("\n", 1)[0] ?? "";
}

/**
 * Classify a compare result. Anything that is not unambiguously
 * "base is an ancestor of target" is a positive-control failure.
 */
export function classifyCompare({ compareStatus }) {
  if (compareStatus === "identical") return "clean";
  if (compareStatus === "ahead") return "drift";
  return "control-failed";
}

/** Strip ANSI escape sequences (some gh builds colorize piped output). */
export function stripAnsi(text) {
  return String(text ?? "").replace(/\x1b\[[0-9;]*m/g, "");
}

/** Run `gh api <path>` and return parsed JSON. Throws on failure. */
export function ghApi(path, { repo, ghBin = process.env.GH_BIN ?? "gh" } = {}) {
  const result = spawnSync(ghBin, ["api", path], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", CLICOLOR: "0", CLICOLOR_FORCE: "0" },
  });
  if (result.status !== 0) {
    throw new Error(`gh api ${path} failed (exit ${result.status}): ${stripAnsi(result.stderr).trim().slice(0, 400)}`);
  }
  return JSON.parse(stripAnsi(result.stdout));
}

/** Resolve the commit sha a release tag points at. */
export function resolveTagCommit({ repo, version, ghApiFn = ghApi }) {
  // npm strips leading "v" from the version field; release tags carry it.
  const tagName = version.startsWith("v") ? version : `v${version}`;
  try {
    const ref = ghApiFn(`/repos/${repo}/git/refs/tags/${encodeURIComponent(tagName)}`, { repo });
    const sha = ref?.object?.sha;
    if (typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha)) return { commit: sha, tagName };
    return { error: `tag ${tagName} exists but carries no commit sha` };
  } catch (err) {
    return { error: `cannot resolve tag ${tagName} on ${repo}: ${err.message}` };
  }
}

/**
 * List commits on `target` that are not in `base`, via the compare API.
 * Paginates the commit list; returns ALL of them (callers apply display limits).
 */
export function listMissingCommits({ repo, base, target, ghApiFn = ghApi }) {
  const commits = [];
  let compareStatus = null;
  let aheadBy = null;
  const perPage = 100;
  for (let page = 1; page <= 20; page += 1) {
    const payload = ghApiFn(
      `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(target)}?per_page=${perPage}&page=${page}`,
      { repo },
    );
    if (typeof payload?.status !== "string") {
      throw new Error(`compare ${base}...${target} returned no status`);
    }
    compareStatus = payload.status;
    aheadBy = typeof payload.ahead_by === "number" ? payload.ahead_by : aheadBy;
    const batch = Array.isArray(payload.commits) ? payload.commits : [];
    for (const entry of batch) {
      commits.push({
        sha: entry.sha,
        subject: subjectOf(entry.commit?.message),
        message: entry.commit?.message ?? "",
        htmlUrl: entry.html_url ?? null,
      });
    }
    if (batch.length < perPage) break;
    if (commits.length >= (aheadBy ?? 0)) break;
  }
  return { compareStatus, aheadBy, commits };
}

/**
 * Format the drift ledger. This is the single formatter shared with the
 * scheduled sweep, so both consumers always produce the same output.
 */
export function formatLedger({
  repo,
  installVersion,
  baseCommit,
  baseMode,
  targetRef,
  targetCommit,
  missing,
  ticketRegexSource = null,
  limit = 50,
}) {
  const lines = [];
  const baseDesc = {
    stamp: "(stamped in the installed artifact)",
    tag: "(resolved via release tag — indirect; a re-cut tag would mislead)",
    pinned: "(pinned by the caller)",
  }[baseMode] ?? "";
  lines.push(`Install: ${installVersion ?? "<unknown>"}`);
  lines.push(`Base: ${baseCommit}${baseDesc ? ` ${baseDesc}` : ""}`);
  lines.push(targetRef === targetCommit ? `Target: ${targetCommit} on ${repo}` : `Target: ${targetRef} @ ${targetCommit} on ${repo}`);
  lines.push(`Positive control: base is an ancestor of target: PASS`);
  if (missing.length === 0) {
    lines.push(`Drift: NONE — install matches target.`);
    return lines.join("\n");
  }
  lines.push(`Drift: ${missing.length} commit(s) on ${targetRef} are NOT in the running install:`);
  lines.push("");
  for (const entry of missing.slice(0, limit)) {
    // The merge marker "(#N)" already ends most subjects; normalize to one
    // canonical refs prefix instead of printing the number twice.
    const bareSubject = entry.subject.replace(/\s*\(#\d+\)\s*$/, "");
    const pr = extractPullNumber(entry.subject);
    const ticket = extractTicket(entry.message, ticketRegexSource);
    const refs = [
      pr ? `PR #${pr}` : null,
      ticket ? `ticket ${ticket}` : null,
    ].filter(Boolean).join(", ");
    lines.push(`  ${entry.sha.slice(0, 12)}${refs ? `  (${refs}) ` : "  "}${bareSubject}`);
  }
  if (missing.length > limit) {
    lines.push(`  … and ${missing.length - limit} more (raise --limit to see them)`);
  }
  lines.push("");
  lines.push(`Action: map each commit to its owning work and either cut a new release train or confirm the current pin is intentional.`);
  return lines.join("\n");
}

/**
 * Shared ledger computation for both consumers (this CLI and the scheduled
 * sweep) so they can never drift apart. Returns either
 * `{ ok: true, ...ledger }` or `{ ok: false, stage: "env" | "control", error }`.
 *
 * `ghApiFn` is injectable for tests.
 */
export function computeDriftLedger({
  repo,
  installDir,
  versionOverride = null,
  pinnedCommit = null,
  target = "master",
  ticketRegexSource = null,
  ghApiFn = ghApi,
}) {
  let installVersion = versionOverride;
  let baseCommit = pinnedCommit ? pinnedCommit.toLowerCase() : null;
  let baseMode = pinnedCommit ? "pinned" : null;

  if (baseCommit === null) {
    let manifest = null;
    if (installVersion === null) {
      const read = readInstalledManifest(installDir);
      if (read.error) return { ok: false, stage: "env", error: read.error };
      manifest = read.manifest;
      installVersion = manifest.version;
    }
    const fromStamp = manifest ? resolveBaseCommitFromManifest(manifest) : null;
    if (fromStamp) {
      baseCommit = fromStamp.commit;
      baseMode = "stamp";
    } else {
      const tagInfo = resolveTagCommit({ repo, version: installVersion, ghApiFn });
      if (tagInfo.error) {
        return {
          ok: false,
          stage: "env",
          error: `${tagInfo.error} — a stamped artifact (gitHead in package.json) avoids this dependency on tags`,
        };
      }
      baseCommit = tagInfo.commit;
      baseMode = "tag";
    }
  }

  let targetCommit;
  let compare;
  try {
    const targetHead = ghApiFn(`/repos/${repo}/commits/${encodeURIComponent(target)}`, { repo });
    targetCommit = targetHead.sha;
    compare = listMissingCommits({ repo, base: baseCommit, target: targetCommit, ghApiFn });
  } catch (err) {
    return { ok: false, stage: "control", error: err.message };
  }

  const verdict = classifyCompare({ compareStatus: compare.compareStatus });
  if (verdict === "control-failed") {
    return {
      ok: false,
      stage: "control",
      error:
        `compare status "${compare.compareStatus}" means the base ${baseCommit} is not an ancestor of ` +
        `${target}. The install pin and the target have diverged (re-cut tag, force-push, or wrong repo). ` +
        `NO ledger is emitted because none can be trusted.`,
    };
  }

  const missing = verdict === "clean" ? [] : compare.commits;
  return {
    ok: true,
    installVersion,
    baseCommit,
    baseMode,
    targetRef: target,
    targetCommit,
    aheadBy: compare.aheadBy ?? missing.length,
    missing,
    ledgerText: formatLedger({
      repo,
      installVersion,
      baseCommit,
      baseMode,
      targetRef: target,
      targetCommit,
      missing,
      ticketRegexSource,
    }),
  };
}

function parseArgs(argv) {
  const args = {
    installDir: process.env.INSTALL_DIR ?? DEFAULT_INSTALL_DIR,
    version: null,
    installedCommit: null,
    target: "master",
    repo: process.env.RELEASE_REPO ?? DEFAULT_REPO,
    ticketRegex: process.env.DRIFT_TICKET_RE ?? null,
    limit: 50,
    json: false,
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
      case "--install-dir": args.installDir = needsValue(); break;
      case "--version": args.version = needsValue(); break;
      case "--installed-commit": args.installedCommit = needsValue(); break;
      case "--target": args.target = needsValue(); break;
      case "--repo": args.repo = needsValue(); break;
      case "--ticket-regex": args.ticketRegex = needsValue(); break;
      case "--limit": args.limit = Number(needsValue()); break;
      case "--json": args.json = true; break;
      case "--help": case "-h": args.help = true; break;
      default: throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (args.installedCommit !== null && !/^[0-9a-f]{40}$/.test(args.installedCommit.toLowerCase())) {
    throw new Error(`--installed-commit must be a full 40-hex sha`);
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`drift-check: ${err.message}\n`);
    process.exit(EXIT_ENV_ERROR);
  }
  if (args.help) {
    process.stdout.write(`${__doc__}`);
    process.exit(EXIT_CLEAN);
  }

  const result = computeDriftLedger({
    repo: args.repo,
    installDir: args.installDir,
    versionOverride: args.version,
    pinnedCommit: args.installedCommit,
    target: args.target,
    ticketRegexSource: args.ticketRegex,
  });

  if (!result.ok) {
    if (result.stage === "control") {
      process.stderr.write(`drift-check: positive control FAILED — ${result.error}\n`);
      process.exit(EXIT_CONTROL_FAILED);
    }
    process.stderr.write(`drift-check: ${result.error}\n`);
    process.exit(EXIT_ENV_ERROR);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      installVersion: result.installVersion,
      baseCommit: result.baseCommit,
      baseMode: result.baseMode,
      targetRef: result.targetRef,
      targetCommit: result.targetCommit,
      positiveControl: "PASS",
      aheadBy: result.aheadBy,
      missing: result.missing.map((entry) => ({
        sha: entry.sha,
        subject: entry.subject,
        pr: extractPullNumber(entry.subject),
        ticket: extractTicket(entry.message, args.ticketRegex),
        htmlUrl: entry.htmlUrl,
      })),
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.ledgerText}\n`);
  }
  process.exit(result.missing.length === 0 ? EXIT_CLEAN : EXIT_DRIFT);
}

const __doc__ = `
Usage: node scripts/fork-release/drift-check.mjs [options]
See the header comment of scripts/fork-release/drift-check.mjs for options and exit codes.
`;

const isDirect = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isDirect) {
  await main();
}
