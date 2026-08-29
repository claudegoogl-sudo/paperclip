import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readWorkflow(name) {
  return readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");
}

test("fork release publish is hard-gated on the preflight job", () => {
  const workflow = readWorkflow("fork-release.yml");
  const publishJob = workflow.slice(workflow.indexOf("  publish:"),);
  assert.match(publishJob, /needs: preflight/, "publish must need the preflight job");
  assert.match(publishJob, /!inputs\.dry_run/, "publish must refuse dry runs");
  assert.match(publishJob, /!inputs\.negative_test_fork34/, "publish must refuse the negative-test mode");
  assert.match(publishJob, /gh release edit "\$TAG".*--draft=false/, "publish flips the staged draft public");
});

test("a failed or dry-run preflight leaves zero published assets", () => {
  const workflow = readWorkflow("fork-release.yml");
  assert.match(
    workflow,
    /if: failure\(\) \|\| inputs\.dry_run \|\| inputs\.negative_test_fork34[\s\S]*gh release delete "\$TAG"[\s\S]*--cleanup-tag/,
    "the draft release must be deleted on failure, dry run, and negative-test runs",
  );
});

test("the preflight installs from the exact release URL and asserts the dashboard", () => {
  const workflow = readWorkflow("fork-release.yml");
  assert.match(workflow, /CORE_URL: https:\/\/github\.com\/claudegoogl-sudo\/paperclip\/releases\/download\/v\$\{\{ inputs\.version \}\}\/paperclipai-\$\{\{ inputs\.version \}\}\.tgz/);
  assert.match(workflow, /preflight\.mjs [\s\S]*--core-url "\$CORE_URL"/);
  assert.match(workflow, /--sha256sums "\$PWD\/staged-assets\/SHA256SUMS\.txt"/);
  // The gate script itself asserts GET / 200 with <title>Paperclip</title>.
  const preflight = readFileSync(path.join(repoRoot, "scripts/fork-release/preflight.mjs"), "utf8");
  assert.match(preflight, /<title>Paperclip<\/title>/);
  assert.match(preflight, /scratch/i, "the boot must document scratch-dir isolation");
});

test("the preflight stages assets on a draft release that is never public before the gate", () => {
  const workflow = readWorkflow("fork-release.yml");
  assert.match(workflow, /gh release create "\$TAG".*--draft --prerelease/, "staging must be a draft");
});

test("the negative-test injector produces a set the static gate refuses", async () => {
  const injector = readFileSync(path.join(repoRoot, "scripts/fork-release/negative-test-fork34.mjs"), "utf8");
  assert.match(injector, /exports.*\.\/src\/index\.ts/s, "injector must reproduce the dev-exports defect");
});
