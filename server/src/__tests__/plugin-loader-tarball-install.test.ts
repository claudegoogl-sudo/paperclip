/**
 * Regression tests for PLA-103 — tarball-spec installs.
 *
 * The plugin loader's post-install path resolution previously assumed
 * `spec === packageName`, which broke for tarball / git / URL specs because
 * npm installs those under the package's declared `name` (from package.json),
 * not the spec. These tests cover the helper that resolves the actual installed
 * package name and a focused integration test that runs `npm install <.tgz>`
 * end-to-end against a fixture tarball.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  readDependencyMap,
  resolveInstalledPackageName,
} from "../services/plugin-loader.js";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-loader-"));
  tempDirs.push(dir);
  return dir;
}

describe("resolveInstalledPackageName", () => {
  it("returns the new key added by --save when installing a fresh package", () => {
    const name = resolveInstalledPackageName({
      spec: "./paperclip-plugin-foo-1.0.0.tgz",
      packageNameHint: "./paperclip-plugin-foo-1.0.0.tgz",
      beforeDeps: {},
      afterDeps: {
        "paperclip-plugin-foo": "file:paperclip-plugin-foo-1.0.0.tgz",
      },
    });
    expect(name).toBe("paperclip-plugin-foo");
  });

  it("isolates the new key when other plugins are already installed", () => {
    const name = resolveInstalledPackageName({
      spec: "./paperclip-plugin-bar-2.1.0.tgz",
      packageNameHint: "./paperclip-plugin-bar-2.1.0.tgz",
      beforeDeps: {
        "paperclip-plugin-foo": "file:paperclip-plugin-foo-1.0.0.tgz",
        "@acme/paperclip-baz": "^0.3.0",
      },
      afterDeps: {
        "paperclip-plugin-foo": "file:paperclip-plugin-foo-1.0.0.tgz",
        "@acme/paperclip-baz": "^0.3.0",
        "paperclip-plugin-bar": "file:paperclip-plugin-bar-2.1.0.tgz",
      },
    });
    expect(name).toBe("paperclip-plugin-bar");
  });

  it("preserves simple npm-name resolution on reinstall (no diff)", () => {
    const name = resolveInstalledPackageName({
      spec: "@acme/paperclip-linear@0.3.1",
      packageNameHint: "@acme/paperclip-linear",
      beforeDeps: { "@acme/paperclip-linear": "^0.3.0" },
      afterDeps: { "@acme/paperclip-linear": "^0.3.1" },
    });
    expect(name).toBe("@acme/paperclip-linear");
  });

  it("matches by recorded value when reinstalling a tarball spec", () => {
    const name = resolveInstalledPackageName({
      spec: "file:paperclip-plugin-foo-1.0.0.tgz",
      packageNameHint: "file:paperclip-plugin-foo-1.0.0.tgz",
      beforeDeps: {
        "paperclip-plugin-foo": "file:paperclip-plugin-foo-1.0.0.tgz",
      },
      afterDeps: {
        "paperclip-plugin-foo": "file:paperclip-plugin-foo-1.0.0.tgz",
      },
    });
    expect(name).toBe("paperclip-plugin-foo");
  });

  it("falls back to the version-stripped hint for unfamiliar shapes", () => {
    const name = resolveInstalledPackageName({
      spec: "paperclip-plugin-foo@^1.0.0",
      packageNameHint: "paperclip-plugin-foo@^1.0.0",
      beforeDeps: {},
      afterDeps: {},
    });
    expect(name).toBe("paperclip-plugin-foo");
  });
});

describe("readDependencyMap", () => {
  it("returns an empty record when package.json is missing", async () => {
    const dir = makeTempDir();
    expect(await readDependencyMap(dir)).toEqual({});
  });

  it("returns the dependencies map when present", async () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "host",
        dependencies: {
          "paperclip-plugin-foo": "file:foo.tgz",
          "@acme/bar": "^1.0.0",
        },
        devDependencies: { vitest: "^1.0.0" },
      }),
    );
    const deps = await readDependencyMap(dir);
    expect(deps).toEqual({
      "paperclip-plugin-foo": "file:foo.tgz",
      "@acme/bar": "^1.0.0",
    });
  });

  it("ignores non-string dependency values", async () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { foo: 42, bar: "1.0.0" } }),
    );
    expect(await readDependencyMap(dir)).toEqual({ bar: "1.0.0" });
  });
});

describe("plugin-loader: tarball install end-to-end", () => {
  // Skipping when npm is unavailable would normally make sense, but Paperclip
  // plugin install requires npm at runtime, so the test environment must have
  // it. The 60s timeout accommodates a cold npm install.
  it("installs a .tgz tarball under its declared package name", async () => {
    const sourceDir = makeTempDir();
    const installDir = makeTempDir();

    // 1. Build a fixture tarball whose npm spec basename does NOT match its
    //    package name field (this is the regression case).
    writeFileSync(
      path.join(sourceDir, "package.json"),
      JSON.stringify({
        name: "paperclip-plugin-tarball-fixture",
        version: "1.0.0",
        main: "index.js",
      }),
    );
    writeFileSync(
      path.join(sourceDir, "index.js"),
      "module.exports = {};\n",
    );
    const packResult = await execFileAsync(
      "npm",
      ["pack", "--pack-destination", sourceDir],
      { cwd: sourceDir, timeout: 60_000 },
    );
    const tarballName = packResult.stdout.trim().split("\n").pop()!;
    const tarballPath = path.join(sourceDir, tarballName);
    expect(existsSync(tarballPath)).toBe(true);

    // 2. Snapshot deps before, run the same npm install the loader does.
    const beforeDeps = await readDependencyMap(installDir);
    expect(beforeDeps).toEqual({});

    await execFileAsync(
      "npm",
      [
        "install",
        tarballPath,
        "--prefix",
        installDir,
        "--save",
        "--ignore-scripts",
      ],
      { timeout: 120_000 },
    );

    const afterDeps = await readDependencyMap(installDir);

    // 3. The loader's resolver should pick the actual package name from the
    //    tarball, not the on-disk tarball path.
    const resolvedName = resolveInstalledPackageName({
      spec: tarballPath,
      packageNameHint: tarballPath,
      beforeDeps,
      afterDeps,
    });
    expect(resolvedName).toBe("paperclip-plugin-tarball-fixture");

    // 4. The actual node_modules directory is at the canonical name.
    const packagePath = path.join(
      installDir,
      "node_modules",
      "paperclip-plugin-tarball-fixture",
    );
    expect(existsSync(packagePath)).toBe(true);
    expect(existsSync(path.join(packagePath, "package.json"))).toBe(true);
  }, 120_000);
});
