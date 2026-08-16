import fs from "node:fs/promises";
import path from "node:path";
import { createHash, type Hash } from "node:crypto";

// Fingerprint of the host-side "/live" runtime contract (e.g. CONTRACT.md,
// macjob.py, the active MCP config) that governs how a resumed Claude session
// behaves *without* changing the agent's injected instructions. The prompt
// bundle auto-bust (prompt-cache.ts) only keys on instruction/skill content, so
// a runtime contract that flips underneath a pinned session leaves the session
// resuming against stale precedent. Folding this fingerprint into
// resume-eligibility busts the pinned session on the next trigger when any
// configured input changes, closing a stale-session recurrence where a pinned
// session kept resuming against precedent from before the contract flipped.
//
// Content hash (not mtime): mtime is bumped by no-op checkouts/rsync and would
// spuriously bust healthy sessions, whereas a content change is exactly the
// signal we want.
const FINGERPRINT_VERSION = "paperclip-claude-runtime-contract:v1\n";

async function hashRuntimePath(
  candidate: string,
  hash: Hash,
  label: string,
  seenDirectories: Set<string>,
): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(candidate);
  } catch {
    // A missing input is a stable, meaningful state: if the file later appears
    // (or disappears) the fingerprint changes and the session is busted.
    hash.update(`missing:${label}\n`);
    return;
  }

  if (stat.isSymbolicLink()) {
    hash.update(`symlink:${label}\n`);
    const resolved = await fs.realpath(candidate).catch(() => null);
    if (!resolved) {
      hash.update(`missing:${label}\n`);
      return;
    }
    await hashRuntimePath(resolved, hash, label, seenDirectories);
    return;
  }

  if (stat.isDirectory()) {
    const realDir = await fs.realpath(candidate).catch(() => candidate);
    hash.update(`dir:${label}\n`);
    if (seenDirectories.has(realDir)) {
      hash.update("loop\n");
      return;
    }
    seenDirectories.add(realDir);
    const entries = await fs.readdir(candidate, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      await hashRuntimePath(
        path.join(candidate, entry.name),
        hash,
        `${label}/${entry.name}`,
        seenDirectories,
      );
    }
    return;
  }

  if (stat.isFile()) {
    hash.update(`file:${label}\n`);
    hash.update(await fs.readFile(candidate));
    hash.update("\n");
    return;
  }

  hash.update(`other:${label}:${stat.mode}\n`);
}

/**
 * Compute a content fingerprint over the configured runtime-contract inputs.
 * Returns "" when no inputs are configured so callers can treat an unconfigured
 * fingerprint as "no opinion" and preserve existing resume behavior.
 *
 * Inputs are de-duplicated and sorted so the fingerprint is independent of the
 * order they were listed in config. Each input may be a file or a directory
 * (hashed recursively); a missing path hashes to a stable "missing" marker.
 */
export async function buildRuntimeContractFingerprint(
  paths: readonly string[],
): Promise<string> {
  const normalized = Array.from(
    new Set(
      paths
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0),
    ),
  ).sort();
  if (normalized.length === 0) {
    return "";
  }
  const hash = createHash("sha256");
  hash.update(FINGERPRINT_VERSION);
  for (const entry of normalized) {
    hash.update(`path:${entry}\n`);
    await hashRuntimePath(entry, hash, entry, new Set<string>());
  }
  return hash.digest("hex");
}
