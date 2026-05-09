/**
 * PLA-376 — smoke coverage for the create-paperclip-plugin scaffold's
 * release-time manifest validation gate.
 *
 * The scaffold change in `packages/plugins/create-paperclip-plugin/src/index.ts`
 * has no per-package vitest suite (the package is a generator, not a runtime
 * library), and its surface — emitted file paths + emitted contents — is what
 * we actually need to gate at PR time. This test exercises the generator end
 * to end:
 *
 *   1. Calls `scaffoldPluginProject` into a tmp dir inside the repo so the
 *      `useWorkspaceSdk` branch is taken (avoids `pnpm pack` side effects).
 *   2. Asserts every PLA-376 gate file is emitted with the expected key
 *      contents (script + spec + workflow + package.json wiring).
 *   3. Cleans up the tmp dir.
 *
 * Wired in as a step in `.github/workflows/pr.yml` (verify job) so the
 * regression cannot reach `master` from this fork or upstream.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const SCAFFOLD_DIST = path.resolve(
  REPO_ROOT,
  "packages",
  "plugins",
  "create-paperclip-plugin",
  "dist",
  "index.js",
);

if (!fs.existsSync(SCAFFOLD_DIST)) {
  // The scaffold's `tsc` build hasn't run yet. In CI this script runs after
  // `pnpm build`; locally, tell the developer how to make it green.
  throw new Error(
    `[smoke-create-paperclip-plugin] expected ${SCAFFOLD_DIST} — run \`pnpm --filter @paperclipai/create-paperclip-plugin build\` first.`,
  );
}

const { scaffoldPluginProject } = await import(pathToFileURL(SCAFFOLD_DIST).href);

function makeTmpDir() {
  // Inside repo so isInsideDir(outputDir, repoRoot) === true and the scaffold
  // takes the workspace path (no `pnpm pack` of SDK + shared).
  const stem = path.join(REPO_ROOT, ".tmp-scaffold-smoke");
  fs.mkdirSync(stem, { recursive: true });
  return fs.mkdtempSync(path.join(stem, "plugin-"));
}

function rmTmp(stemDir) {
  // mkdtempSync places the new dir directly under .tmp-scaffold-smoke; we
  // remove the whole parent stem so repeated runs don't accumulate.
  const parent = path.dirname(stemDir);
  if (path.basename(parent) === ".tmp-scaffold-smoke") {
    fs.rmSync(parent, { recursive: true, force: true });
  } else {
    fs.rmSync(stemDir, { recursive: true, force: true });
  }
}

test("scaffold emits PLA-376 manifest validation gate files + wiring", () => {
  const stem = makeTmpDir();
  const outputDir = path.join(stem, "smoke-plugin");
  try {
    scaffoldPluginProject({
      pluginName: "@paperclipai/smoke-plugin",
      outputDir,
      template: "default",
    });

    const validateScript = path.join(outputDir, "scripts", "validate-manifest.mjs");
    const spec = path.join(outputDir, "tests", "validate-manifest.spec.ts");
    const workflow = path.join(outputDir, ".github", "workflows", "manifest-validate.yml");
    const pkgJsonPath = path.join(outputDir, "package.json");

    for (const f of [validateScript, spec, workflow, pkgJsonPath]) {
      assert.ok(fs.existsSync(f), `expected scaffolded file: ${path.relative(outputDir, f)}`);
    }

    const validateBody = fs.readFileSync(validateScript, "utf8");
    assert.match(
      validateBody,
      /pluginManifestV1Schema/,
      "validate-manifest.mjs must import pluginManifestV1Schema (host validator)",
    );
    assert.match(
      validateBody,
      /\^\[a-z0-9\]\[a-z0-9\._-\]\*\$/,
      "validate-manifest.mjs must mirror the PLA-163 tool-name regex",
    );
    assert.match(validateBody, /paperclipPlugin\.manifest/, "must resolve via package.json#paperclipPlugin.manifest");

    const specBody = fs.readFileSync(spec, "utf8");
    assert.match(specBody, /bad:name/, "spec must cover the v0.1.1 incident shape (':' in tools[].name)");

    const workflowBody = fs.readFileSync(workflow, "utf8");
    assert.match(workflowBody, /Plugin manifest validation \(release gate\)/);
    assert.match(workflowBody, /validate-manifest\.mjs/);

    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    assert.equal(
      pkg?.scripts?.["validate:manifest"],
      "node ./scripts/validate-manifest.mjs",
      "package.json must wire `validate:manifest` script",
    );
    assert.equal(
      pkg?.scripts?.prepack,
      "npm run build && npm run validate:manifest",
      "package.json must run validate:manifest in the prepack lifecycle",
    );
    const sharedDep = pkg?.devDependencies?.["@paperclipai/shared"];
    assert.ok(
      typeof sharedDep === "string" && sharedDep.length > 0,
      "package.json must always declare @paperclipai/shared as a devDependency (the gate imports from it)",
    );
  } finally {
    rmTmp(stem);
  }
});
