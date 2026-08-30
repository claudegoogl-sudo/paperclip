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
  const stage = workflow.slice(
    workflow.indexOf("Stage the release set on a draft release"),
    workflow.indexOf("Download the staged assets"),
  );
  // The draft is created over REST: draft=true keeps it private until the
  // publish gate flips it, and the same call yields the numeric release id
  // every later step resolves instead of the tag.
  assert.match(stage, /repos\/\$RELEASE_REPO\/releases" /, "staging must create the draft over REST");
  assert.match(stage, /-f tag_name="\$TAG"/, "the draft must carry the run's release tag");
  assert.match(stage, /-F draft=true/, "staging must create a DRAFT release");
  assert.match(stage, /-F prerelease=true/, "staging must mark the release prerelease");
  assert.match(stage, /-f target_commitish="\$GITHUB_SHA"/, "the draft must pin the run's commit");
  assert.match(stage, /--jq '\.id'/, "the create call must capture the numeric release id");
  assert.match(stage, /DRAFT_RELEASE_ID=\$release_id" >> "\$GITHUB_ENV"/, "the id must be exported to later steps");
  assert.doesNotMatch(stage, /gh release create/, "the gh CLI create path is replaced by the REST call");
});

test("the staged-asset lookup resolves the draft release by id, never by tag", () => {
  const workflow = readWorkflow("fork-release.yml");
  const download = workflow.slice(workflow.indexOf("Download the staged assets"));
  assert.match(
    download,
    /repos\/\$RELEASE_REPO\/releases\/\$DRAFT_RELEASE_ID/,
    "the asset TSV must come from the captured draft release id",
  );
  assert.match(download, /--jq '\.assets\[\] \| \[\.id, \.name\] \| @tsv'/, "the TSV must carry numeric REST asset ids");
  assert.doesNotMatch(
    download,
    /releases\/tags\/\$TAG/,
    "the REST by-tag endpoint resolves published releases only and 404s on drafts",
  );
  // The ban spans the WHOLE preflight job, not just the download step: the
  // by-tag REST lookup 404s on drafts, which is the exact failure that ended
  // dry run 33299563388. Prose comments may still name the retired endpoint;
  // this matches the actual "$TAG" call shape only.
  const preflightJob = workflow.slice(workflow.indexOf("  preflight:"), workflow.indexOf("  publish:"));
  assert.doesNotMatch(preflightJob, /releases\/tags\/\$TAG/, "no REST by-tag lookup anywhere in the preflight job");
  assert.match(download, /case "\$\{DRAFT_RELEASE_ID:-\}" in/, "DRAFT_RELEASE_ID must be validated before use");
  assert.match(download, /''\|\*\[!0-9\]\*/, "the guard must refuse a missing or non-numeric id");
});

test("the negative-test injector produces a set the static gate refuses", async () => {
  const injector = readFileSync(path.join(repoRoot, "scripts/fork-release/negative-test-fork34.mjs"), "utf8");
  assert.match(injector, /exports.*\.\/src\/index\.ts/s, "injector must reproduce the dev-exports defect");
});
