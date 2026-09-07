#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSourceCommit } from "./source-commit.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const packageDir = process.cwd();
const packageJsonPath = join(packageDir, "package.json");
const sdkPackageJsonPath = join(repoRoot, "packages", "plugins", "sdk", "package.json");

if (!existsSync(packageJsonPath)) {
  throw new Error(`No package.json found in plugin directory: ${packageDir}`);
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const sdkPackageJson = JSON.parse(readFileSync(sdkPackageJsonPath, "utf8"));
const publishConfig = packageJson.publishConfig ?? {};
const dependencies = {
  ...(packageJson.dependencies ?? {}),
  "@paperclipai/plugin-sdk": sdkPackageJson.version,
};

const publishPackageJson = {
  name: packageJson.name,
  version: packageJson.version,
  description: packageJson.description,
  license: packageJson.license,
  homepage: packageJson.homepage,
  bugs: packageJson.bugs,
  repository: packageJson.repository,
  type: packageJson.type,
  exports: publishConfig.exports ?? packageJson.exports,
  main: publishConfig.main,
  types: publishConfig.types,
  publishConfig,
  files: packageJson.files,
  paperclipPlugin: packageJson.paperclipPlugin,
  keywords: packageJson.keywords,
  dependencies,
};

// Provenance stamp: the prepack regenerates the manifest, which would
// otherwise wipe the stamp pack-public-packages.mjs wrote before pack ran.
const sourceCommit = resolveSourceCommit();
if (sourceCommit) {
  publishPackageJson.gitHead = sourceCommit.commit;
}

writeFileSync(packageJsonPath, `${JSON.stringify(publishPackageJson, null, 2)}\n`);

console.log(`  ✓ Generated publishable plugin package.json for ${packageJson.name}${sourceCommit ? ` (gitHead ${sourceCommit.commit.slice(0, 12)})` : ""}`);
