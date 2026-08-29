#!/usr/bin/env node
/**
 * TEST-ONLY: reproduce the fork.34 defect class to prove the release gate
 * blocks it.
 *
 * Rewrites the packed `@paperclipai/db` tarball's manifest back to the dev
 * exports shape (`exports -> ./src/index.ts`, no `main`, `src/` not packed).
 * A release in this state installs cleanly and dies at server boot with
 * `Cannot find module '@paperclipai/db/src/index.ts'` — the historically
 * shipped defect. The preflight must fail it (statically via the export
 * target scan, and it would also fail dynamically at the boot step).
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
    else if (arg === "--help") args.help = true;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!args.dir) {
    process.stderr.write("Usage: negative-test-fork34.mjs --dir <tarball-dir>\n");
    process.exit(2);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbTarball = readdirSync(args.dir)
    .filter((name) => /^paperclipai-db-.*\.tgz$/.test(name))
    .sort()
    .at(-1);
  if (!dbTarball) throw new Error(`no @paperclipai/db tarball in ${args.dir}`);
  const tarballPath = path.join(args.dir, dbTarball);

  const work = mkdtempSync(path.join(tmpdir(), "negtest-fork34-"));
  try {
    const extract = spawnSync("tar", ["-xzf", tarballPath, "-C", work], { encoding: "utf8" });
    if (extract.status !== 0) throw new Error(`extract failed: ${extract.stderr}`);
    const manifestPath = path.join(work, "package", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.main = null;
    manifest.exports = { ".": "./src/index.ts", "./*": "./src/*.ts" };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const tmpOut = `${tarballPath}.neg`;
    const repack = spawnSync("tar", ["--owner=0", "--group=0", "-czf", tmpOut, "-C", work, "package"], { encoding: "utf8" });
    if (repack.status !== 0) throw new Error(`repack failed: ${repack.stderr}`);
    spawnSync("mv", [tmpOut, tarballPath], { encoding: "utf8" });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // Refresh SHA256SUMS so the checksum step matches the corrupted set; the
  // export/closure/boot gates are what must fail.
  const sumsPath = path.join(args.dir, "SHA256SUMS.txt");
  const tgzNames = readdirSync(args.dir).filter((name) => name.endsWith(".tgz")).sort();
  const sha = spawnSync("sha256sum", tgzNames, { cwd: args.dir, encoding: "utf8" });
  if (sha.status !== 0) throw new Error(`sha256sum failed: ${sha.stderr}`);
  writeFileSync(sumsPath, sha.stdout);
  process.stdout.write(`==> negative test applied: ${dbTarball} now ships dev exports (fork.34 class); SHA256SUMS refreshed\n`);
}

import { fileURLToPath } from "node:url";
const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`negative-test-fork34: ${error.message}\n`);
    process.exit(1);
  }
}
