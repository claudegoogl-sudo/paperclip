#!/usr/bin/env node
/**
 * source-commit.mjs
 *
 * Resolve the source commit a release artifact is built from, so packed
 * tarballs carry a resolvable provenance stamp.
 *
 * Resolution order:
 *   1. `RELEASE_SOURCE_COMMIT` env var (full 40-hex sha) — explicit override
 *      for pinned/staged builds where HEAD is not the released source.
 *   2. `git rev-parse HEAD` in the repository root — the normal build path
 *      (releases run from a git checkout of the released ref).
 *
 * Returns `null` when neither is available (e.g. building from a source
 * tarball with no git metadata). Callers MUST treat `null` as "omit the
 * stamp", and the fork-release build gate fails a train whose tarballs are
 * missing the stamp, so an accidental null can never ship silently.
 *
 * Field name on packed manifests: `gitHead` — the field npm itself uses for
 * provenance, and the field consumers (drift-check) read first.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Resolve the source commit for this build.
 *
 * @param {{ repoRoot?: string, env?: Record<string, string | undefined>, execFileSync?: typeof execFileSync }} [options]
 * @returns {{ commit: string, source: "env" | "git" } | null}
 */
export function resolveSourceCommit(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const env = options.env ?? process.env;
  const run = options.execFileSync ?? execFileSync;

  const fromEnv = (env.RELEASE_SOURCE_COMMIT ?? "").trim().toLowerCase();
  if (fromEnv !== "") {
    if (!FULL_SHA.test(fromEnv)) {
      throw new Error(
        `RELEASE_SOURCE_COMMIT must be a full 40-hex commit sha, got: ${JSON.stringify(fromEnv)}`,
      );
    }
    return { commit: fromEnv, source: "env" };
  }

  if (!existsSync(resolve(root, ".git"))) {
    return null;
  }

  try {
    const head = run("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim().toLowerCase();
    if (!FULL_SHA.test(head)) return null;
    return { commit: head, source: "git" };
  } catch {
    // No git binary, or a broken repository: omit the stamp rather than
    // guess. The fork-release gate catches a missing stamp before publish.
    return null;
  }
}
