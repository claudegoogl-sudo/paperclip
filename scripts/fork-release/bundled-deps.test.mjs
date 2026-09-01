/// Tests for the fork-release bundled-dependency staging + gate
/// (scripts/fork-release/stage-bundled-packages.mjs and
/// scripts/fork-release/check-bundled-tarballs.mjs).
///
/// Background: the fork build used to strip bundleDependencies and
/// pack workspace dirs, so hosts resolved PRISTINE registry copies of patched
/// bundled deps. The first victim was acpx: pristine acpx's persisted-key
/// policy rejects the SCREAMING_CASE env map adapter-utils persists as
/// acpx.session_options.env, killing every claude_local ensure_session. These
/// tests pin the staging discovery, the tarball naming, and the gate's
/// fail-closed behavior against hand-built tarball fixtures.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { bundledReleasePackages, tarballNameFor } from "./stage-bundled-packages.mjs";
import { checkBundledTarballs } from "./gate-bundled-tarballs.mjs";
import { copyPackageMetadata } from "../prepare-bundled-package.mjs";

const repoRoot = join(new URL("..", import.meta.url).pathname, "..");

test("bundled release discovery finds the patched bundled packages", () => {
  const bundled = bundledReleasePackages();
  const byName = new Map(bundled.map((entry) => [entry.name, entry]));
  assert.deepEqual(byName.get("@paperclipai/adapter-utils")?.bundledDeps, ["acpx"]);
  assert.deepEqual(byName.get("@paperclipai/db")?.bundledDeps, ["embedded-postgres"]);
});

test("tarball naming matches the npm pack convention for scoped packages", () => {
  assert.equal(tarballNameFor("@paperclipai/adapter-utils", "2026.824.1-fork.39"), "paperclipai-adapter-utils-2026.824.1-fork.39.tgz");
  assert.equal(tarballNameFor("@paperclipai/db", "2026.824.1-fork.39"), "paperclipai-db-2026.824.1-fork.39.tgz");
});

/// Build a minimal tarball that looks like a packed bundled package.
function makeFakeTarball(outDir, { name, version, deps, bundled, files }) {
  // Real npm pack archives everything under a top-level "package/" prefix.
  const pkgDir = join(outDir, "stage", name.replace(/^@/, "").replace("/", "-"), "package");
  rmSync(join(pkgDir, ".."), { recursive: true, force: true });
  mkdirSync(pkgDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const filePath = join(pkgDir, rel);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, content);
  }
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name, version, dependencies: deps, bundleDependencies: bundled }),
  );
  const tarball = join(outDir, tarballNameFor(name, version));
  const result = spawnSync("tar", ["-czf", tarball, "package"], { cwd: join(pkgDir, ".."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  rmSync(pkgDir, { recursive: true, force: true });
  return tarball;
}

function makeFakeRepo(manifestEntries, { bundledDeps = ["acpx"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fork-release-bundled-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "release-package-manifest.json"), JSON.stringify(manifestEntries));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ pnpm: { patchedDependencies: { "acpx@0.12.0": "patches/acpx@0.12.0.patch" } } }),
  );
  for (const entry of manifestEntries) {
    mkdirSync(join(root, entry.dir), { recursive: true });
    writeFileSync(
      join(root, entry.dir, "package.json"),
      JSON.stringify({ name: entry.name, bundleDependencies: bundledDeps }),
    );
  }
  return root;
}

const MARKERS = {
  acpx: (readEntry) => {
    const checkpoint = readEntry("dist/live-checkpoint-ClPCSdrW.js");
    if (!/MAP_OBJECT_PATHS = \/\* @__PURE__ \*\/ new Set\(\[[^\]]*"acpx\.session_options\.env"/.test(checkpoint)) {
      throw new Error("bundled acpx dist/live-checkpoint-ClPCSdrW.js is missing the acpx.session_options.env persisted-key-policy exemption (pristine registry copy?)");
    }
  },
};

test("the gate accepts a bundled tarball that ships the patched runtime", () => {
  const root = makeFakeRepo([{ dir: "packages/adapter-utils", name: "@paperclipai/adapter-utils" }]);
  const outDir = join(root, "out");
  mkdirSync(outDir, { recursive: true });
  makeFakeTarball(outDir, {
    name: "@paperclipai/adapter-utils",
    version: "9.9.9-test",
    deps: { acpx: "0.12.0", picocolors: "^1.1.1" },
    bundled: ["acpx"],
    files: {
      "node_modules/acpx/dist/live-checkpoint-ClPCSdrW.js":
        'const MAP_OBJECT_PATHS = /* @__PURE__ */ new Set(["request_token_usage", "messages.Agent.tool_results", "acpx.session_options.env"]);',
      "dist/index.js": "export {};",
      "LICENSE": "MIT License\n",
    },
  });

  const { checked, violations } = checkBundledTarballs({
    repoRoot: root,
    outDir,
    version: "9.9.9-test",
    markers: MARKERS,
  });
  assert.equal(checked, 1);
  assert.deepEqual(violations, []);
});

test("the gate rejects a bundled tarball whose bundled copy is pristine", () => {
  const root = makeFakeRepo([{ dir: "packages/adapter-utils", name: "@paperclipai/adapter-utils" }]);
  const outDir = join(root, "out");
  mkdirSync(outDir, { recursive: true });
  makeFakeTarball(outDir, {
    name: "@paperclipai/adapter-utils",
    version: "9.9.9-test",
    deps: { acpx: "0.12.0" },
    bundled: ["acpx"],
    files: {
      // Pristine acpx: the policy set without the session_options.env exemption.
      "node_modules/acpx/dist/live-checkpoint-ClPCSdrW.js":
        'const MAP_OBJECT_PATHS = /* @__PURE__ */ new Set(["request_token_usage", "messages.Agent.tool_results"]);',
      "dist/index.js": "export {};",
      "LICENSE": "MIT License\n",
    },
  });

  const { violations } = checkBundledTarballs({
    repoRoot: root,
    outDir,
    version: "9.9.9-test",
    markers: MARKERS,
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /missing the acpx\.session_options\.env persisted-key-policy exemption/);
});

test("the gate rejects a tarball that dropped the bundle or the manifest contract", () => {
  const root = makeFakeRepo([{ dir: "packages/adapter-utils", name: "@paperclipai/adapter-utils" }]);
  const outDir = join(root, "out");
  mkdirSync(outDir, { recursive: true });
  // Packed manifest without bundleDependencies and without the bundled dep:
  // the exact shape the fork shipped before the fix. The workspace manifest
  // still declares the bundle, so the gate compares contract vs reality.
  makeFakeTarball(outDir, {
    name: "@paperclipai/adapter-utils",
    version: "9.9.9-test",
    deps: { picocolors: "^1.1.1" },
    bundled: [],
    files: { "dist/index.js": "export {};", "LICENSE": "MIT License\n" },
  });

  const { violations } = checkBundledTarballs({
    repoRoot: root,
    outDir,
    version: "9.9.9-test",
    markers: MARKERS,
  });
  assert.equal(violations.length, 3);
  assert.match(violations[0], /dropped bundleDependencies entry acpx/);
  assert.match(violations[1], /no longer declares dependency acpx/);
  assert.match(violations[2], /does not bundle node_modules\/acpx/);
});

test("the gate rejects a bundled tarball that ships without a license", () => {
  const root = makeFakeRepo([{ dir: "packages/adapter-utils", name: "@paperclipai/adapter-utils" }]);
  const outDir = join(root, "out");
  mkdirSync(outDir, { recursive: true });
  makeFakeTarball(outDir, {
    name: "@paperclipai/adapter-utils",
    version: "9.9.9-test",
    deps: { acpx: "0.12.0" },
    bundled: ["acpx"],
    files: {
      // Patched runtime + intact manifest contract, but no package/LICENSE:
      // the shape fork.39's restaged bundled tarballs shipped with.
      "node_modules/acpx/dist/live-checkpoint-ClPCSdrW.js":
        'const MAP_OBJECT_PATHS = /* @__PURE__ */ new Set(["request_token_usage", "messages.Agent.tool_results", "acpx.session_options.env"]);',
      "dist/index.js": "export {};",
    },
  });

  const { violations } = checkBundledTarballs({
    repoRoot: root,
    outDir,
    version: "9.9.9-test",
    markers: MARKERS,
  });
  assert.ok(
    violations.some((v) => /does not ship package\/LICENSE/.test(v)),
    `expected a package/LICENSE violation, got: ${JSON.stringify(violations)}`,
  );
});

test("staged package metadata copies the repo-root license when the package has none", () => {
  const root = mkdtempSync(join(tmpdir(), "fork-release-license-"));
  try {
    writeFileSync(join(root, "LICENSE"), "root license\n");
    const sourceDir = join(root, "pkg");
    const destinationDir = join(root, "stage");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(destinationDir, { recursive: true });
    writeFileSync(join(sourceDir, "package.json"), JSON.stringify({ name: "@paperclipai/db" }));

    copyPackageMetadata(sourceDir, destinationDir, root);

    assert.equal(readFileSync(join(destinationDir, "LICENSE"), "utf8"), "root license\n");
    assert.equal(existsSync(join(destinationDir, "README.md")), false, "README must not fall back to the repo root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staged package metadata prefers the package's own license over the root fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "fork-release-license-"));
  try {
    writeFileSync(join(root, "LICENSE"), "root license\n");
    const sourceDir = join(root, "pkg");
    const destinationDir = join(root, "stage");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(destinationDir, { recursive: true });
    writeFileSync(join(sourceDir, "LICENSE"), "package license\n");

    copyPackageMetadata(sourceDir, destinationDir, root);

    assert.equal(readFileSync(join(destinationDir, "LICENSE"), "utf8"), "package license\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staged package metadata leaves no license behind when neither package nor root has one", () => {
  const root = mkdtempSync(join(tmpdir(), "fork-release-license-"));
  try {
    const sourceDir = join(root, "pkg");
    const destinationDir = join(root, "stage");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(destinationDir, { recursive: true });

    copyPackageMetadata(sourceDir, destinationDir, root);

    assert.equal(existsSync(join(destinationDir, "LICENSE")), false);
    assert.equal(existsSync(join(destinationDir, "LICENSE.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
