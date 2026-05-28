#!/usr/bin/env node
/**
 * upstream-sync.mjs
 *
 * Sync-tick entrypoint for the upstream-sync routine
 * (claudegoogl-sudo/paperclip ← paperclipai/paperclip). See
 * skills/upstream-sync/SKILL.md for the wider workflow.
 *
 * One tick:
 *   1. Load .paperclip/upstream-sync.json (state).
 *   2. GET https://api.github.com/repos/paperclipai/paperclip/releases/latest
 *      with If-None-Match: <state.etag>. On 304 → "no-op: still at <tag>".
 *   3. On 200: if tag_name === state.lastSyncedTag, refresh ETag and exit 0.
 *   4. Otherwise: git fetch upstream, branch sync/upstream-<tag> off
 *      origin/master, merge upstream/<tag> --no-ff. On conflicts, invoke
 *      scripts/resolve-trivial-sync-conflicts.mjs; if anything is still
 *      unresolved, emit a JSON escalation report on stdout and exit non-zero.
 *   5. On clean merge: rewrite state file, commit, push, open a draft PR
 *      against claudegoogl-sudo/paperclip:master with the body produced by
 *      scripts/format-sync-pr-body.mjs.
 *
 * Side-effects (network, branch creation, push, PR create) only run when
 * --dry-run is absent. --dry-run still hits the GitHub API (read-only) and
 * is safe to run by hand at any time.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const UPSTREAM_OWNER = "paperclipai";
const UPSTREAM_REPO = "paperclip";
const FORK_OWNER = "claudegoogl-sudo";
const FORK_REPO = "paperclip";
const FORK_BASE_BRANCH = "master";
const UPSTREAM_REMOTE = "upstream";
const FORK_REMOTE = "origin";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateFile = path.join(repoRoot, ".paperclip", "upstream-sync.json");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

function readState() {
  if (!existsSync(stateFile)) {
    throw new Error(`missing state file: ${stateFile} (bootstrap with .paperclip/upstream-sync.json)`);
  }
  return JSON.parse(readFileSync(stateFile, "utf8"));
}

function writeState(next) {
  writeFileSync(stateFile, `${JSON.stringify(next, null, 2)}\n`);
}

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", ...opts }).trim();
}

async function fetchLatestRelease(etag) {
  const headers = {
    "User-Agent": `${FORK_OWNER}-upstream-sync`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (etag) headers["If-None-Match"] = etag;
  if (process.env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch(`https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/releases/latest`, {
    headers,
  });

  if (res.status === 304) return { status: 304, etag, release: null };
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`upstream releases/latest ${res.status}: ${body.slice(0, 400)}`);
  }
  const release = await res.json();
  return { status: res.status, etag: res.headers.get("etag"), release };
}

function runConflictResolver() {
  try {
    execFileSync("node", [path.join("scripts", "resolve-trivial-sync-conflicts.mjs")], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } catch (err) {
    // resolver may legitimately exit non-zero when files remain unresolved;
    // we re-check via `git diff --name-only --diff-filter=U` below.
    if (err && typeof err.status === "number" && err.status !== 0) {
      // fall through; unresolved check is authoritative
    } else {
      throw err;
    }
  }
}

function unresolvedFiles() {
  const out = git(["diff", "--name-only", "--diff-filter=U"]);
  return out ? out.split("\n").filter(Boolean) : [];
}

function bucketFor(files) {
  // "reviewable" = small/scoped, e.g. up to 5 files and no infra/.github changes.
  if (files.length === 0) return "clean";
  const touchesInfra = files.some(
    (f) => f.startsWith(".github/") || f === "Dockerfile" || f.startsWith("docker/"),
  );
  if (touchesInfra || files.length > 5) return "escalation";
  return "reviewable";
}

async function main() {
  const state = readState();
  const { release, status, etag: newEtag } = await fetchLatestRelease(state.etag);

  if (status === 304) {
    console.log(`no-op: still at ${state.lastSyncedTag}`);
    return 0;
  }

  const tag = release.tag_name;
  if (tag === state.lastSyncedTag) {
    // ETag rotated but the release is the same — just refresh the cache key.
    if (!dryRun && newEtag && newEtag !== state.etag) {
      writeState({ ...state, etag: newEtag, lastCheckedAt: new Date().toISOString() });
    }
    console.log(`no-op: still at ${state.lastSyncedTag}`);
    return 0;
  }

  if (dryRun) {
    console.log(
      `dry-run: upstream is at ${tag}, fork last synced ${state.lastSyncedTag}; would create sync/upstream-${tag}`,
    );
    return 0;
  }

  // Real sync path. Sibling B's cron will exercise this; the scaffold PR
  // intentionally does not run it.
  git(["fetch", UPSTREAM_REMOTE, "--tags"]);
  git(["fetch", FORK_REMOTE, FORK_BASE_BRANCH]);

  const branch = `sync/upstream-${tag}`;
  git(["checkout", "-B", branch, `${FORK_REMOTE}/${FORK_BASE_BRANCH}`]);

  let mergeFailed = false;
  try {
    git(["merge", "--no-ff", "-m", `sync(upstream): ${tag}`, `${UPSTREAM_REMOTE}/${tag}`]);
  } catch {
    mergeFailed = true;
  }

  if (mergeFailed) {
    runConflictResolver();
    const remaining = unresolvedFiles();
    if (remaining.length > 0) {
      const report = { tag, unresolvedFiles: remaining, bucket: bucketFor(remaining) };
      console.log(JSON.stringify(report));
      return 2;
    }
    git(["commit", "--no-edit"]);
  }

  const headSha = git(["rev-parse", "HEAD"]);
  const nextState = {
    ...state,
    lastSyncedTag: tag,
    lastSyncedSha: headSha,
    lastSyncedAt: new Date().toISOString(),
    etag: newEtag,
    pendingPrUrl: null,
  };
  writeState(nextState);
  git(["add", path.relative(repoRoot, stateFile)]);
  git(["commit", "-m", `chore(upstream-sync): record ${tag}`]);

  git(["push", "-u", FORK_REMOTE, branch]);

  // PR body is computed by a sibling script so it can be unit-tested in
  // isolation. We pass the tag and let it shell out for diff stats.
  const body = execFileSync(
    "node",
    [path.join("scripts", "format-sync-pr-body.mjs"), "--tag", tag, "--base", FORK_BASE_BRANCH],
    { cwd: repoRoot, encoding: "utf8" },
  );

  if (process.env.GITHUB_TOKEN) {
    const prRes = await fetch(`https://api.github.com/repos/${FORK_OWNER}/${FORK_REPO}/pulls`, {
      method: "POST",
      headers: {
        "User-Agent": `${FORK_OWNER}-upstream-sync`,
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      },
      body: JSON.stringify({
        title: `sync(upstream): ${tag}`,
        head: branch,
        base: FORK_BASE_BRANCH,
        body,
        draft: true,
      }),
    });
    if (!prRes.ok) {
      const errBody = await prRes.text();
      throw new Error(`PR create ${prRes.status}: ${errBody.slice(0, 400)}`);
    }
    const pr = await prRes.json();
    writeState({ ...nextState, pendingPrUrl: pr.html_url });
    console.log(`opened draft PR: ${pr.html_url}`);
  } else {
    console.log(`branch ${branch} pushed; GITHUB_TOKEN missing, skipped PR create`);
  }
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
