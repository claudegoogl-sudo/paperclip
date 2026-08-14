import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { preparePublishPackage } from "./prepare-publish-package.mjs";

function makePackageDir(pkg) {
  const dir = mkdtempSync(join(tmpdir(), "hermes-prepack-"));
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  return dir;
}

function readPkg(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

test("no-op when publishConfig has already been stripped (fork-build packer path)", () => {
  // pack-public-packages.mjs applies+deletes publishConfig before `pnpm pack`
  // fires this prepack. The manifest is already published-shaped.
  const dir = makePackageDir({
    name: "@paperclipai/hermes-paperclip-adapter",
    version: "9.9.9",
    exports: { ".": { import: "./dist/index.js" } },
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
  });
  try {
    const before = readPkg(dir);
    const ran = preparePublishPackage(dir);

    assert.equal(ran, false);
    assert.equal(existsSync(join(dir, "package.dev.json")), false);
    assert.deepEqual(readPkg(dir), before, "manifest must be untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("standalone npm publish path promotes publishConfig and preserves a dev manifest", () => {
  const dir = makePackageDir({
    name: "@paperclipai/hermes-paperclip-adapter",
    version: "9.9.9",
    exports: { ".": "./src/index.ts" },
    publishConfig: {
      access: "public",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      provenance: true,
    },
  });
  try {
    const ran = preparePublishPackage(dir);
    const published = readPkg(dir);

    assert.equal(ran, true);
    assert.deepEqual(published.exports, {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    });
    assert.equal(published.main, "./dist/index.js");
    assert.equal(published.types, "./dist/index.d.ts");
    // registry-only directives that were merged into exports/main/types are
    // stripped from publishConfig, but non-manifest directives (provenance) stay.
    assert.equal(published.publishConfig.exports, undefined);
    assert.equal(published.publishConfig.main, undefined);
    assert.equal(published.publishConfig.types, undefined);
    assert.equal(published.publishConfig.provenance, true);
    assert.equal(existsSync(join(dir, "package.dev.json")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses to overwrite an existing dev manifest", () => {
  const dir = makePackageDir({
    name: "@paperclipai/hermes-paperclip-adapter",
    version: "9.9.9",
    publishConfig: { exports: { ".": { import: "./dist/index.js" } } },
  });
  writeFileSync(join(dir, "package.dev.json"), "{}\n");
  try {
    assert.throws(() => preparePublishPackage(dir), /Refusing to overwrite/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
