#!/usr/bin/env node
/// Stage + pack every release package that declares `bundleDependencies`.
///
/// Why this exists: the fork build used to strip
/// `bundleDependencies` and pack those packages like any other, so the
/// published tarballs resolved their bundled deps from the npm registry at
/// install time — pristine, WITHOUT the repository's pnpm patches. The first
/// thing that depended on a patched bundled dep was acpx: upstream PR #9980
/// made adapter-utils persist per-session env into acpx's runtime record, and
/// pristine acpx's persisted-key policy rejects SCREAMING_CASE env keys, so
/// every `claude_local` ensure_session died with `Persisted key policy
/// violation` on hosts. The repo patch was always correct; the delivery was
/// not.
///
/// Upstream's own release flow stages bundled packages through
/// `scripts/prepare-bundled-package.mjs` (npm-installs the bundled dep,
/// re-applies the pnpm patch with `patch -p1`, validates patch markers, keeps
/// `bundleDependencies` in the packed manifest). This script wires exactly
/// that flow into the fork release build: for every package in
/// `scripts/release-package-manifest.json` whose manifest declares
/// `bundleDependencies`, stage it and `npm pack` the staged directory.
///
/// stdout: one packed tarball basename per line (for the caller's gates).
/// Any staging failure exits nonzero and prints the failing package.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function tarballNameFor(packageName, version) {
  return `${packageName.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

export function bundledReleasePackages({ repoRoot: root = repoRoot } = {}) {
  const manifest = readJson(join(root, "scripts", "release-package-manifest.json"));
  const bundled = [];
  for (const entry of manifest) {
    const pkgPath = join(root, entry.dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = readJson(pkgPath);
    const bundledDeps = pkg.bundleDependencies ?? pkg.bundledDependencies ?? [];
    if (bundledDeps.length > 0) bundled.push({ dir: entry.dir, name: pkg.name, bundledDeps });
  }
  return bundled;
}

function packBundledPackage({ dir, name }, outDir) {
  const sourceDir = join(repoRoot, dir);
  const stageDir = join(repoRoot, ".fork-release-stage", dir.replaceAll("/", "__"));
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(dirname(stageDir), { recursive: true });

  const prepare = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts", "prepare-bundled-package.mjs"), sourceDir, stageDir],
    { stdio: "inherit" },
  );
  if (prepare.status !== 0) {
    throw new Error(`staging failed for ${name} (prepare-bundled-package exit ${prepare.status})`);
  }

  const pack = spawnSync("npm", ["pack", "--pack-destination", outDir], {
    cwd: stageDir,
    stdio: "inherit",
  });
  if (pack.status !== 0) {
    throw new Error(`npm pack failed for ${name} (exit ${pack.status})`);
  }

  const pkg = readJson(join(sourceDir, "package.json"));
  const tarball = tarballNameFor(pkg.name, pkg.version);
  rmSync(stageDir, { recursive: true, force: true });
  return tarball;
}

function main() {
  const argv = process.argv.slice(2);
  let outDir = null;
  let listNames = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") { outDir = argv[i + 1]; i += 1; }
    else if (argv[i] === "--list-names") listNames = true;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      process.stdout.write("Usage: node scripts/fork-release/stage-bundled-packages.mjs --out <dir> [--list-names]\n");
      process.exit(0);
    } else {
      process.stderr.write(`unexpected argument: ${argv[i]}\n`);
      process.exit(2);
    }
  }
  if (listNames) {
    for (const entry of bundledReleasePackages()) process.stdout.write(`${entry.name}\n`);
    return;
  }
  if (!outDir) {
    process.stderr.write("Usage: node scripts/fork-release/stage-bundled-packages.mjs --out <dir>\n");
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });

  const bundled = bundledReleasePackages();
  if (bundled.length === 0) {
    process.stderr.write("no release package declares bundleDependencies; nothing to stage\n");
    process.exit(1);
  }

  for (const entry of bundled) {
    const tarball = packBundledPackage(entry, resolve(outDir));
    process.stdout.write(`${tarball}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
