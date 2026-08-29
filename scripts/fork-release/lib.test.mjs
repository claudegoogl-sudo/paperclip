import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  coreChainClosure,
  expectedReleaseUrl,
  scanExportTargets,
  scanUrlClosure,
  tarballStem,
  verifyChecksums,
} from "./lib.mjs";

const VERSION = "2026.824.1-fork.99";

function packPackageDir(workDir, outPath, manifest) {
  writeFileSync(path.join(workDir, "package", "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const result = spawnSync("tar", ["--owner=0", "--group=0", "-czf", outPath, "-C", workDir, "package"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function makeAsset(base, packageName, { deps = {}, files = {}, main, exports, types } = {}) {
  const work = mkdtempSync(path.join(base, "work-"));
  const inner = path.join(work, "package");
  spawnSync("mkdir", ["-p", inner]);
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(inner, rel);
    spawnSync("mkdir", ["-p", path.dirname(target)]);
    writeFileSync(target, content);
  }
  const stem = tarballStem(packageName);
  const tarballPath = path.join(base, `${stem}-${VERSION}.tgz`);
  packPackageDir(work, tarballPath, {
    name: packageName,
    version: VERSION,
    ...(main !== undefined ? { main } : {}),
    ...(types !== undefined ? { types } : {}),
    ...(exports !== undefined ? { exports } : {}),
    ...(Object.keys(deps).length > 0 ? { dependencies: deps } : {}),
  });
  rmSync(work, { recursive: true, force: true });
  return tarballPath;
}

test("tarballStem maps scoped names to release asset stems", () => {
  assert.equal(tarballStem("paperclipai"), "paperclipai");
  assert.equal(tarballStem("@paperclipai/server"), "paperclipai-server");
  assert.equal(tarballStem("@paperclipai/plugin-sdk"), "paperclipai-plugin-sdk");
});

test("expectedReleaseUrl produces the exact release URL", () => {
  assert.equal(
    expectedReleaseUrl("@paperclipai/db", VERSION),
    `https://github.com/claudegoogl-sudo/paperclip/releases/download/v${VERSION}/paperclipai-db-${VERSION}.tgz`,
  );
});

test("scanUrlClosure accepts a fully pinned, self-contained set", () => {
  const base = mkdtempSync(path.join(tmpdir(), "closure-ok-"));
  try {
    makeAsset(base, "@paperclipai/shared");
    makeAsset(base, "@paperclipai/db", {
      deps: {
        "@paperclipai/shared": expectedReleaseUrl("@paperclipai/shared", VERSION),
      },
    });
    const closure = scanUrlClosure({ assetsDir: base, version: VERSION });
    assert.equal(closure.ok, true);
    assert.equal(closure.references.length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("scanUrlClosure rejects bare-version internal pins (no npm registry for forks)", () => {
  const base = mkdtempSync(path.join(tmpdir(), "closure-bare-"));
  try {
    makeAsset(base, "@paperclipai/shared");
    makeAsset(base, "@paperclipai/server", { deps: { "@paperclipai/shared": VERSION } });
    const closure = scanUrlClosure({ assetsDir: base, version: VERSION });
    assert.equal(closure.ok, false);
    assert.equal(closure.violations[0].package, "@paperclipai/shared");
    assert.match(closure.violations[0].found, new RegExp(`^${VERSION}$`));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("scanUrlClosure rejects a URL pin whose asset is missing from the set", () => {
  const base = mkdtempSync(path.join(tmpdir(), "closure-missing-"));
  try {
    makeAsset(base, "@paperclipai/server", {
      deps: { "@paperclipai/db": expectedReleaseUrl("@paperclipai/db", VERSION) },
    });
    const closure = scanUrlClosure({ assetsDir: base, version: VERSION });
    assert.equal(closure.ok, false);
    assert.equal(closure.violations[0].problem, "dep pins release asset that is missing from the set");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("scanExportTargets accepts a dist-shaped manifest and rejects the dev-exports shape", () => {
  const base = mkdtempSync(path.join(tmpdir(), "exports-"));
  try {
    const good = makeAsset(base, "@paperclipai/good", {
      main: "./dist/index.js",
      exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
      files: { "dist/index.js": "export {};", "dist/index.d.ts": "export {};" },
    });
    assert.equal(scanExportTargets(good).ok, true);

    const devTarballDir = mkdtempSync(path.join(base, "dev-"));
    const dev = makeAsset(devTarballDir, "@paperclipai/devshaped", {
      main: null,
      exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
    });
    const scan = scanExportTargets(dev);
    assert.equal(scan.ok, false);
    const dot = scan.violations.find((v) => v.target === "./src/index.ts");
    assert.ok(dot, "expected a violation for ./src/index.ts");
    assert.match(dot.problem, /missing from tarball/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("coreChainClosure follows internal URL deps and excludes unrelated packages", () => {
  const base = mkdtempSync(path.join(tmpdir(), "chain-"));
  try {
    makeAsset(base, "@paperclipai/shared");
    makeAsset(base, "@paperclipai/db", {
      deps: { "@paperclipai/shared": expectedReleaseUrl("@paperclipai/shared", VERSION) },
    });
    makeAsset(base, "paperclipai", {
      deps: { "@paperclipai/server": expectedReleaseUrl("@paperclipai/server", VERSION) },
    });
    makeAsset(base, "@paperclipai/server", {
      deps: { "@paperclipai/db": expectedReleaseUrl("@paperclipai/db", VERSION) },
    });
    makeAsset(base, "@paperclipai/plugin-unrelated");
    const chain = coreChainClosure({ assetsDir: base, coreTarballName: `paperclipai-${VERSION}.tgz` });
    assert.deepEqual(
      [...chain.keys()].sort(),
      [
        `paperclipai-${VERSION}.tgz`,
        `paperclipai-db-${VERSION}.tgz`,
        `paperclipai-server-${VERSION}.tgz`,
        `paperclipai-shared-${VERSION}.tgz`,
      ].sort(),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("verifyChecksums detects drift and absence", () => {
  const base = mkdtempSync(path.join(tmpdir(), "sums-"));
  try {
    const tgz = makeAsset(base, "@paperclipai/shared");
    writeFileSync(path.join(base, "SHA256SUMS.txt"), "not-a-hash  bogus.tgz\n");
    const result = verifyChecksums({ assetsDir: base, sumsPath: path.join(base, "SHA256SUMS.txt") });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.asset === path.basename(tgz) && v.problem === "no SHA256SUMS entry"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
