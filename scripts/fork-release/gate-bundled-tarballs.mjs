#!/usr/bin/env node
/// Release gate: every bundled-dependency tarball must actually ship the
/// PATCHED bundled runtime, and its manifest must keep the
/// `bundleDependencies` contract (the fork.37 claude_local ensure_session outage).
///
/// Fails closed:
///  - a bundled package's tarball is missing from the release set;
///  - the manifest dropped `bundleDependencies` or the bundled dep itself;
///  - the bundled copy is absent from the tarball;
///  - a bundled dep that root `pnpm.patchedDependencies` patches ships without
///    its registered patch marker (pristine registry copy made it through);
///  - the tarball does not ship `package/LICENSE` (every published tarball
///    must carry the license; staging falls back to the repo-root LICENSE).
///
/// Patch markers are registered per dependency name in PATCH_MARKERS. A newly
/// patched bundled dep without a marker here is a HARD FAILURE — extend the
/// map when you add one, so a packaging regression cannot ship silently.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");

// One distinctive, added-by-the-patch literal per patched bundled dependency.
// `test(tarballEntryReader)` receives the bundled dep's directory inside the
// extracted package and must throw if the patch content is missing.
const PATCH_MARKERS = {
  acpx: (readEntry) => {
    // The persisted-key-policy exemption that fixes the fork.37
    // claude_local ensure_session outage (sessionOptions.env).
    const checkpoint = readEntry("dist/live-checkpoint-ClPCSdrW.js");
    if (!/MAP_OBJECT_PATHS = \/\* @__PURE__ \*\/ new Set\(\[[^\]]*"acpx\.session_options\.env"/.test(checkpoint)) {
      throw new Error("bundled acpx dist/live-checkpoint-ClPCSdrW.js is missing the acpx.session_options.env persisted-key-policy exemption (pristine registry copy?)");
    }
  },
  "embedded-postgres": (readEntry) => {
    const index = readEntry("dist/index.js");
    if (!index.includes("LC_MESSAGES_LOCALE = 'C'")) {
      throw new Error("bundled embedded-postgres dist/index.js is missing the LC_MESSAGES_LOCALE patch marker (pristine registry copy?)");
    }
  },
};

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function tarEntries(tarballPath) {
  const list = spawnSync("tar", ["-tzf", tarballPath], { encoding: "utf8" });
  if (list.status !== 0) throw new Error(`tar -tzf failed for ${tarballPath}: ${list.stderr}`);
  return list.stdout.split("\n").filter((line) => line.length > 0);
}

function readTarballEntry(tarballPath, entry) {
  const show = spawnSync("tar", ["-xzOf", tarballPath, entry], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (show.status !== 0) throw new Error(`tar -xzOf ${entry} failed for ${tarballPath}: ${show.stderr}`);
  return show.stdout;
}

export function checkBundledTarballs({ outDir, version, manifestPath, repoRoot: root = repoRoot, markers = PATCH_MARKERS } = {}) {
  const resolvedOut = resolve(outDir ?? join(root, "dist-tarballs"));
  const manifest = readJson(manifestPath ?? join(root, "scripts", "release-package-manifest.json"));
  const patchedDependencies = readJson(join(root, "package.json"))?.pnpm?.patchedDependencies ?? {};
  const violations = [];
  let checked = 0;

  for (const entry of manifest) {
    const pkgPath = join(root, entry.dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = readJson(pkgPath);
    const bundledDeps = pkg.bundleDependencies ?? pkg.bundledDependencies ?? [];
    if (bundledDeps.length === 0) continue;
    checked += 1;

    const releaseVersion = version ?? pkg.version;
    const tarballPath = join(
      resolvedOut,
      `${pkg.name.replace(/^@/, "").replace("/", "-")}-${releaseVersion}.tgz`,
    );
    if (!existsSync(tarballPath)) {
      violations.push(`${pkg.name}: expected bundled tarball ${tarballPath} is missing`);
      continue;
    }

    const manifestEntry = "package/package.json";
    let packed;
    try {
      packed = JSON.parse(readTarballEntry(tarballPath, manifestEntry));
    } catch (error) {
      violations.push(`${pkg.name}: cannot read packed manifest: ${error.message}`);
      continue;
    }
    const packedBundled = packed.bundleDependencies ?? packed.bundledDependencies ?? [];
    for (const dep of bundledDeps) {
      if (!packedBundled.includes(dep)) {
        violations.push(`${pkg.name}: packed manifest dropped bundleDependencies entry ${dep}`);
      }
      if (!packed.dependencies?.[dep]) {
        violations.push(`${pkg.name}: packed manifest no longer declares dependency ${dep}`);
      }
    }

    const entries = tarEntries(tarballPath);
    if (!entries.includes("package/LICENSE")) {
      violations.push(`${pkg.name}: tarball does not ship package/LICENSE (every published tarball must carry the license)`);
    }
    for (const dep of bundledDeps) {
      const prefix = `package/node_modules/${dep}/`;
      const bundledEntries = entries.filter((name) => name.startsWith(prefix));
      if (bundledEntries.length === 0) {
        violations.push(`${pkg.name}: tarball does not bundle node_modules/${dep} (registry-resolved copy would be pristine on hosts)`);
        continue;
      }
      const patchKey = Object.keys(patchedDependencies).find(
        (key) => key === dep || key.startsWith(`${dep}@`),
      );
      const patchPath = patchKey === undefined ? undefined : patchedDependencies[patchKey];
      if (!patchPath) continue; // unpatched bundled dep: presence + manifest contract is enough
      const marker = markers[dep];
      if (!marker) {
        violations.push(`${pkg.name}: bundled dep ${dep} is patched via ${patchPath} but has no registered patch marker in gate-bundled-tarballs.mjs`);
        continue;
      }
      try {
        marker((relative) => {
          const full = `${prefix}${relative}`;
          if (!entries.includes(full)) throw new Error(`bundled ${dep} is missing ${relative}`);
          return readTarballEntry(tarballPath, full);
        });
      } catch (error) {
        violations.push(`${pkg.name}: ${error.message}`);
      }
    }
  }

  return { checked, violations };
}

function main() {
  const argv = process.argv.slice(2);
  let outDir = null;
  let version;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dir") { outDir = argv[i + 1]; i += 1; }
    else if (argv[i] === "--version") { version = argv[i + 1]; i += 1; }
    else if (argv[i] === "--help" || argv[i] === "-h") {
      process.stdout.write("Usage: node scripts/fork-release/gate-bundled-tarballs.mjs --dir <tarball-dir> [--version <version>]\n");
      process.exit(0);
    } else {
      process.stderr.write(`unexpected argument: ${argv[i]}\n`);
      process.exit(2);
    }
  }
  const { checked, violations } = checkBundledTarballs({ outDir, version });
  if (violations.length > 0) {
    for (const v of violations) process.stderr.write(`BUNDLED-DEPS GATE: ${v}\n`);
    process.exit(1);
  }
  process.stdout.write(`bundled-deps gate OK (${checked} bundled package${checked === 1 ? "" : "s"})\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
