#!/usr/bin/env node
/**
 * TEST-ONLY: reproduce the "packed but never built" provider defect class to
 * prove the release gate blocks it.
 *
 * Rewrites one sandbox-provider plugin tarball into the historically-shipped
 * empty shape: the manifest keeps its `main`/`exports`/`paperclipPlugin`
 * targets pointing at `./dist/*`, but every `dist/` file is stripped from
 * the tarball. This is exactly what shipped when a provider was packed
 * without ever being built. Because provider plugins are not reachable from
 * the core tarball's URL pins, a closure-scoped export scan passes such a
 * set silently; the export-target scan must therefore cover EVERY tarball in
 * the release set and refuse this one.
 *
 * The release workflow refuses to publish a release whose set was corrupted
 * by this script; it exists so the gate can be validated end to end.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
    else if (arg === "--name") args.name = next();
    else if (arg === "--help") args.help = true;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!args.dir) {
    process.stderr.write("Usage: negative-test-empty-provider.mjs --dir <tarball-dir> [--name <asset>]\n");
    process.exit(2);
  }
  return args;
}

// Any provider plugin tarball reproduces the class; prefer a sandbox provider
// when one is present so the test tracks the historically-shipped packages.
function pickProviderTarball(dir, requested) {
  const names = readdirSync(dir).filter((name) => name.endsWith(".tgz")).sort();
  if (requested) {
    if (!names.includes(requested)) throw new Error(`requested tarball not found in ${dir}: ${requested}`);
    return requested;
  }
  const provider = names.find((name) => /^paperclipai-plugin-(e2b|cloudflare-sandbox|daytona|exe-dev|kubernetes|modal|novita-sandbox)-/.test(name));
  return provider ?? null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tarballName = pickProviderTarball(args.dir, args.name);
  if (!tarballName) {
    throw new Error(`no provider plugin tarball in ${args.dir} (looked for paperclipai-plugin-*)`);
  }
  const tarballPath = path.join(args.dir, tarballName);

  const work = mkdtempSync(path.join(tmpdir(), "negtest-empty-provider-"));
  try {
    const extract = spawnSync("tar", ["-xzf", tarballPath, "-C", work], { encoding: "utf8" });
    if (extract.status !== 0) throw new Error(`extract failed: ${extract.stderr}`);
    const manifestPath = path.join(work, "package", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    // Keep the manifest EXACTLY as packed: dist-pointing main/exports and
    // paperclipPlugin entrypoints are the defect. Remove the code itself.
    if (manifest.exports === undefined && manifest.main === undefined) {
      throw new Error(`${tarballName} declares no dist targets; nothing to corrupt`);
    }
    rmSync(path.join(work, "package", "dist"), { recursive: true, force: true });
    const tmpOut = `${tarballPath}.neg`;
    const repack = spawnSync("tar", ["--owner=0", "--group=0", "-czf", tmpOut, "-C", work, "package"], { encoding: "utf8" });
    if (repack.status !== 0) throw new Error(`repack failed: ${repack.stderr}`);
    spawnSync("mv", [tmpOut, tarballPath], { encoding: "utf8" });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // Refresh SHA256SUMS so the checksum step matches the corrupted set; the
  // export-target gate is what must fail.
  const sumsPath = path.join(args.dir, "SHA256SUMS.txt");
  const tgzNames = readdirSync(args.dir).filter((name) => name.endsWith(".tgz")).sort();
  const sha = spawnSync("sha256sum", tgzNames, { cwd: args.dir, encoding: "utf8" });
  if (sha.status !== 0) throw new Error(`sha256sum failed: ${sha.stderr}`);
  writeFileSync(sumsPath, sha.stdout);
  process.stdout.write(`==> negative test applied: ${tarballName} now ships dist-pointing targets with no dist/ (empty-provider class); SHA256SUMS refreshed\n`);
}

import { fileURLToPath } from "node:url";
const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`negative-test-empty-provider: ${error.message}\n`);
    process.exit(1);
  }
}
