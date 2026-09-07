#!/usr/bin/env node
/**
 * Normalize every packed tarball manifest for release: pin every internal
 * dependency to the exact release URL for this release. `bundleDependencies`
 * declarations are PRESERVED: bundled packages (adapter-utils/acpx,
 * db/embedded-postgres) are staged through prepare-bundled-package.mjs and
 * carry the patched bundled runtime in the tarball — stripping the
 * declaration here would desync the manifest from the shipped bundle and
 * regress the persisted-key-policy fix (the fork.37 claude_local
 * ensure_session outage). The bundled-deps gate fails the build if a bundled
 * tarball ever ships without its bundle.
 *
 * Fork releases are GitHub-Release tarball sets, never npm publishes, so an
 * internal dep left as `workspace:*`, `*`, `^<version>`, or a bare version is
 * unresolvable at install time (the fork has no npm presence). This step
 * rewrites every `@paperclipai/*` (and `paperclipai`) dependency inside every
 * `package/package.json` of every tarball to
 * `https://github.com/claudegoogl-sudo/paperclip/releases/download/v<version>/<asset>.tgz`,
 * covering both source-manifest ranges and versions injected by prepack
 * hooks (the sandbox plugin packages inject `@paperclipai/plugin-sdk` at
 * pack time).
 *
 * Self-verifying: after rewriting, the URL-closure scan must pass with zero
 * violations or the script exits non-zero. Re-running converges (rewrites
 * are computed against the expected URL, never appended).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectedReleaseUrl, internalDeps, isInternalDepName, readPackedManifest, scanUrlClosure } from "./lib.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--dir") args.dir = next();
    else if (arg === "--version") args.version = next();
    else if (arg === "--help") args.help = true;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!args.dir || !args.version) {
    process.stderr.write("Usage: pin-internal-deps.mjs --dir <tarball-dir> --version <release-version>\n");
    process.exit(2);
  }
  return args;
}

function rewriteTarball(tarballPath, updatedManifest) {
  const work = mkdtempSync(path.join(tmpdir(), "pin-deps-"));
  try {
    const extract = spawnSync("tar", ["-xzf", tarballPath, "-C", work], { encoding: "utf8" });
    if (extract.status !== 0) throw new Error(`extract failed: ${extract.stderr}`);
    writeFileSync(path.join(work, "package", "package.json"), `${JSON.stringify(updatedManifest, null, 2)}\n`);
    const tmpOut = `${tarballPath}.pin`;
    const repack = spawnSync("tar", ["--owner=0", "--group=0", "-czf", tmpOut, "-C", work, "package"], { encoding: "utf8" });
    if (repack.status !== 0) throw new Error(`repack failed: ${repack.stderr}`);
    const rename = spawnSync("mv", [tmpOut, tarballPath], { encoding: "utf8" });
    if (rename.status !== 0) throw new Error(`replace failed: ${rename.stderr}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tarballs = readdirSync(args.dir).filter((name) => name.endsWith(".tgz")).sort();
  if (tarballs.length === 0) throw new Error(`no tarballs in ${args.dir}`);
  let rewritten = 0;
  for (const name of tarballs) {
    const tarballPath = path.join(args.dir, name);
    const manifest = readPackedManifest(tarballPath);
    let changed = false;
    for (const dep of internalDeps(manifest)) {
      const expected = expectedReleaseUrl(dep.name, args.version);
      if (dep.value !== expected) {
        manifest[dep.section][dep.name] = expected;
        changed = true;
      }
    }
    if (changed) {
      rewriteTarball(tarballPath, manifest);
      rewritten += 1;
      process.stdout.write(`  pinned internal deps -> v${args.version} URLs: ${name}\n`);
    }
  }
  // Self-check: the closure scan must now pass cleanly.
  const closure = scanUrlClosure({ assetsDir: args.dir, version: args.version });
  if (!closure.ok) {
    for (const violation of closure.violations) {
      process.stderr.write(`closure violation after pinning: ${JSON.stringify(violation)}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(
    `==> pinned ${rewritten} tarball(s); closure scan clean (${closure.references.length} internal refs across ${tarballs.length} tarballs)\n`,
  );
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`pin-internal-deps: ${error.message}\n`);
    process.exit(1);
  }
}
