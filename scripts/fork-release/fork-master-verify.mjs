#!/usr/bin/env node
// Guard: the fork's push-to-master Release verification must stay enabled.
//
// Upstream release.yml gates verify_canary on github.repository ==
// 'paperclipai/paperclip' and delegates to scripts/cloud-source-verification.mjs.
// That form has no verdict on the fork, so every fork push-to-master Release run
// ends with all jobs skipped and the fork master HEAD is left unverified.
//
// The fork therefore keeps a local delta: verify_canary runs the reusable
// release-verify workflow for the push SHA, and the repository gate sits on
// publish_canary so the fork never publishes an npm canary. Upstream syncs have
// repeatedly reverted this delta silently (see the fork master CI watchdog).
// This script is the durable check: it fails CI whenever the delta is missing,
// so a sync PR must restore it before it can merge.
//
// Usage: node scripts/fork-release/fork-master-verify.mjs [path]

import { readFileSync } from "node:fs";

const path = process.argv[2] ?? ".github/workflows/release.yml";

function readJob(body, jobId) {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^  [a-z0-9_]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function ifLine(job) {
  return job
    .split("\n")
    .find((line) => line.trimStart().startsWith("if:"))
    ?.trim();
}

const body = readFileSync(path, "utf8");
const errors = [];

const verify = readJob(body, "verify_canary");
if (!verify) {
  errors.push("release.yml has no verify_canary job.");
} else {
  const condition = ifLine(verify) ?? "(no if:)";
  if (!condition.includes("github.event_name == 'push'")) {
    errors.push(
      `verify_canary must run on push (found: ${condition}). The fork needs a push-triggered master verification.`,
    );
  }
  if (condition.includes("github.repository == 'paperclipai/paperclip'")) {
    errors.push(
      `verify_canary must not gate on github.repository == 'paperclipai/paperclip' (found: ${condition}). That condition is always false on the fork, so no job ever runs.`,
    );
  }
  if (!verify.includes("uses: ./.github/workflows/release-verify.yml")) {
    errors.push(
      "verify_canary must call the reusable ./.github/workflows/release-verify.yml so the fork runs the real release test matrix for the push SHA.",
    );
  }
}

const publish = readJob(body, "publish_canary");
if (!publish) {
  errors.push("release.yml has no publish_canary job.");
} else {
  const condition = ifLine(publish) ?? "(no if:)";
  if (!condition.includes("github.repository == 'paperclipai/paperclip'")) {
    errors.push(
      `publish_canary must keep the github.repository == 'paperclipai/paperclip' gate so the fork never publishes an npm canary (found: ${condition}).`,
    );
  }
}

if (errors.length > 0) {
  console.error(`fork master verify guard FAILED for ${path}:`);
  for (const error of errors) console.error(`  - ${error}`);
  console.error(
    "\nSee the FORK DELTA comment above verify_canary in release.yml and skills/upstream-sync/SKILL.md.",
  );
  process.exit(1);
}

console.log(`fork master verify guard OK for ${path}`);
