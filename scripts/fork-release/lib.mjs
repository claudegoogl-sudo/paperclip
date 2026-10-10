/**
 * Shared helpers for the fork-release preflight gate.
 *
 * Fork releases are GitHub-Release tarball sets (never npm publishes). The
 * core CLI tarball pins every internal `@paperclipai/*` dependency to an
 * exact `releases/download/v<version>/...tgz` URL, and `npm install` of the
 * core tarball resolves the whole graph through those URLs.
 *
 * Two release-defect classes motivated this gate:
 *
 * 1. Bare-version pins (`"@paperclipai/server": "2026.707.0-fork.17"`): the
 *    fork never publishes to npm, so install hits the registry and fails with
 *    ETARGET. Caught by the URL-closure scan below.
 * 2. Dev manifests shipped in the tarball (`exports -> ./src/index.ts` with
 *    no `src/` packed): install succeeds, the server dies at boot with
 *    ERR_MODULE_NOT_FOUND. Caught by the export-target scan below and,
 *    authoritatively, by the boot step of the preflight.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Internal package names resolve to this repo's release assets. */
export const RELEASE_URL_BASE =
  "https://github.com/claudegoogl-sudo/paperclip/releases/download";

export function isInternalDepName(name) {
  return name === "paperclipai" || name.startsWith("@paperclipai/");
}

/**
 * `@paperclipai/server` -> `paperclipai-server`; `paperclipai` stays.
 * Matches the tarball asset naming used by every fork release.
 */
export function tarballStem(packageName) {
  if (packageName === "paperclipai") return "paperclipai";
  if (packageName.startsWith("@paperclipai/")) {
    return `paperclipai-${packageName.slice("@paperclipai/".length)}`;
  }
  throw new Error(`not an internal package name: ${packageName}`);
}

/** The exact release URL a dependency on `packageName` must carry. */
export function expectedReleaseUrl(packageName, version) {
  return `${RELEASE_URL_BASE}/v${version}/${tarballStem(packageName)}-${version}.tgz`;
}

export function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

/** Read `package/package.json` out of a packed npm tarball. */
export function readPackedManifest(tarballPath) {
  const result = spawnSync("tar", ["-xOzf", tarballPath, "package/package.json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`failed to read manifest from ${path.basename(tarballPath)}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

/** List every file path inside a tarball (paths as stored, e.g. `package/dist/index.js`). */
export function listTarballEntries(tarballPath) {
  const result = spawnSync("tar", ["-tzf", tarballPath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`failed to list ${path.basename(tarballPath)}: ${result.stderr}`);
  }
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

/** Gather internal deps from all dependency sections of a manifest. */
export function internalDeps(manifest) {
  const found = [];
  for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = manifest[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, value] of Object.entries(deps)) {
      if (isInternalDepName(name)) found.push({ name, value, section });
    }
  }
  return found;
}

/**
 * Scan every tarball in `assetsDir` and verify the URL-pin closure:
 * every internal dep must be the exact release URL for this version, and
 * every referenced asset must exist in the set.
 *
 * Returns `{ ok, violations, references }` where each violation names the
 * tarball, the dependency, the offending value, and the expected value.
 */
export function scanUrlClosure({ assetsDir, version, baseUrl = RELEASE_URL_BASE }) {
  const tarballs = listTarballs(assetsDir);
  const presentAssets = new Set(tarballs.map((p) => path.basename(p)));
  const violations = [];
  const references = [];

  for (const tarballPath of tarballs) {
    const tarballName = path.basename(tarballPath);
    let manifest;
    try {
      manifest = readPackedManifest(tarballPath);
    } catch (error) {
      violations.push({ tarball: tarballName, problem: error.message });
      continue;
    }
    for (const dep of internalDeps(manifest)) {
      const expected = `${baseUrl}/v${version}/${assetNameFor(dep.name, version)}`;
      references.push({ from: tarballName, name: dep.name, url: dep.value });
      if (dep.value !== expected) {
        violations.push({
          tarball: tarballName,
          package: dep.name,
          section: dep.section,
          problem: `internal dep is not the exact release URL`,
          found: dep.value,
          expected,
        });
        continue;
      }
      const asset = path.basename(new URL(dep.value).pathname);
      if (!presentAssets.has(asset)) {
        violations.push({
          tarball: tarballName,
          package: dep.name,
          problem: `dep pins release asset that is missing from the set`,
          asset,
        });
      }
    }
  }
  return { ok: violations.length === 0, violations, references };
}

function assetNameFor(packageName, version) {
  return `${tarballStem(packageName)}-${version}.tgz`;
}

/**
 * Verify that every concrete export/main/types target declared by a packed
 * manifest exists inside the same tarball. Wildcard targets (`./dist/*.js`)
 * are checked by directory existence. `paperclipPlugin` entrypoints
 * (`manifest`/`worker`/`ui`) are checked the same way — they are the paths
 * the host's plugin loader actually imports, so a packed plugin manifest
 * that declares them without shipping them is the same defect class as a
 * dev manifest shipped. This is the static catch for that class:
 * `exports -> ./src/index.ts` with no `src/` in the tarball fails here
 * before anyone installs the release.
 */
export function scanExportTargets(tarballPath) {
  const tarballName = path.basename(tarballPath);
  const manifest = readPackedManifest(tarballPath);
  const entries = new Set(listTarballEntries(tarballPath));
  const violations = [];

  const targets = [];
  if (typeof manifest.main === "string") targets.push({ field: "main", value: manifest.main });
  if (typeof manifest.types === "string") targets.push({ field: "types", value: manifest.types });
  collectExportTargets(manifest.exports, "exports", targets);
  const pluginEntry = manifest.paperclipPlugin;
  if (pluginEntry && typeof pluginEntry === "object" && !Array.isArray(pluginEntry)) {
    for (const key of ["manifest", "worker", "ui"]) {
      const value = pluginEntry[key];
      if (typeof value === "string" && value.length > 0) {
        targets.push({ field: `paperclipPlugin.${key}`, value });
      }
    }
  }

  for (const { field, value } of targets) {
    if (value.includes("*")) {
      // Wildcard export (e.g. "./dist/*.js"): require the base directory to ship.
      const baseDir = `package/${value.replace(/^\.\//, "").split("*")[0]}`;
      const basePresent = [...entries].some((entry) => entry.startsWith(baseDir));
      if (!basePresent) {
        violations.push({ tarball: tarballName, field, target: value, problem: `wildcard export base directory missing from tarball`, expectedAtLeast: baseDir });
      }
      continue;
    }
    const resolved = `package/${value.replace(/^\.\//, "")}`;
    if (!entries.has(resolved)) {
      violations.push({
        tarball: tarballName,
        package: manifest.name,
        field,
        target: value,
        problem: `export target missing from tarball (dev manifest shipped?)`,
        missingPath: resolved,
      });
    }
  }
  return { ok: violations.length === 0, violations, manifest: { name: manifest.name, version: manifest.version } };
}

function collectExportTargets(node, fieldPath, out) {
  if (node === null || node === undefined) return;
  if (typeof node === "string") {
    if (node.startsWith("./")) out.push({ field: fieldPath, value: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectExportTargets(item, `${fieldPath}[${i}]`, out));
    return;
  }
  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "types" || key === "typings") continue; // checked separately below
      collectExportTargets(value, `${fieldPath}.${key}`, out);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "types" || key === "typings") collectExportTargets(value, `${fieldPath}.${key}`, out);
    }
  }
}

export function listTarballs(assetsDir) {
  if (!existsSync(assetsDir)) throw new Error(`assets dir not found: ${assetsDir}`);
  return readdirSortedTarballs(assetsDir);
}

import { readdirSync, statSync } from "node:fs";
function readdirSortedTarballs(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".tgz"))
    .sort()
    .map((name) => path.join(dir, name));
}

/**
 * Verify every `*.tgz` in `assetsDir` against a SHA256SUMS file
 * (`<sha256>  <name>` lines). Returns `{ ok, violations }`.
 */
export function verifyChecksums({ assetsDir, sumsPath }) {
  const violations = [];
  const lines = readFileSync(sumsPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const expected = new Map();
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (!match) continue;
    // sha256sum keyed on a path-prefixed glob writes "./name.tgz"; normalize
    // to the plain basename so sums files in either format verify.
    expected.set(match[2].trim().replace(/^\.\//, ""), match[1]);
  }
  for (const tarballPath of listTarballs(assetsDir)) {
    const name = path.basename(tarballPath);
    const want = expected.get(name);
    if (!want) {
      violations.push({ asset: name, problem: "no SHA256SUMS entry" });
      continue;
    }
    const got = sha256File(tarballPath);
    if (got !== want) {
      violations.push({ asset: name, problem: "sha256 mismatch", expected: want, actual: got });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Walk the install closure of the core CLI tarball: the core package plus
 * every package reachable through internal release-URL dependencies. This is
 * exactly the graph `npm install <core-url>` resolves, and the set of
 * packages whose manifests the boot depends on.
 */
export function coreChainClosure({ assetsDir, coreTarballName }) {
  const byAsset = new Map();
  for (const tarballPath of listTarballs(assetsDir)) {
    byAsset.set(path.basename(tarballPath), tarballPath);
  }
  if (!byAsset.has(coreTarballName)) {
    throw new Error(`core tarball not found in assets dir: ${coreTarballName}`);
  }
  const chain = new Map();
  const queue = [coreTarballName];
  while (queue.length > 0) {
    const assetName = queue.shift();
    if (chain.has(assetName)) continue;
    const tarballPath = byAsset.get(assetName);
    if (!tarballPath) continue; // missing assets are a closure-scan violation
    const manifest = readPackedManifest(tarballPath);
    chain.set(assetName, { tarballPath, manifest });
    for (const dep of internalDeps(manifest)) {
      try {
        queue.push(path.basename(new URL(dep.value).pathname));
      } catch {
        // non-URL values are a closure-scan violation; reported there
      }
    }
  }
  return chain;
}
