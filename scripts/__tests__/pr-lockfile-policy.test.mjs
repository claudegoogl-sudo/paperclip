import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Guards the pr.yml lockfile-drift contract:
//   1. policy regenerates the lockfile unconditionally and decides on the
//      actual lockfile diff (catches patchedDependencies-only drift merged
//      into the base branch, which the old PR-diff path filter missed);
//   2. the regenerated artifact upload stays gated on the regen output and
//      fails if the file is missing;
//   3. every job that installs with --frozen-lockfile restores that artifact
//      via a hard-gated download step (no continue-on-error), so a missing
//      artifact fails at the named restore step instead of as a
//      LOCKFILE_CONFIG_MISMATCH in N downstream jobs.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const prWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/pr.yml"), "utf8");

function jobBlocks(workflow) {
  // Jobs sit at exactly two-space indentation; step keys are deeper.
  const lines = workflow.split("\n");
  const starts = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^  [a-z_0-9]+:\s*$/.test(line))
    .map(({ index }) => index);
  return starts.map((start, i) => lines.slice(start, starts[i + 1] ?? lines.length).join("\n"));
}

function stepBlock(job, stepName) {
  const marker = `- name: ${stepName}`;
  const start = job.indexOf(marker);
  if (start === -1) return null;
  const rest = job.slice(start);
  const nextStep = rest.slice(marker.length).search(/\n\s+- (?:name|uses|run):/);
  return nextStep === -1 ? rest : rest.slice(0, nextStep + marker.length);
}

test("policy regenerates the lockfile unconditionally and detects drift by content", () => {
  const policyJob = jobBlocks(prWorkflow).find((b) => b.startsWith("  policy:"));
  assert.ok(policyJob, "policy job exists");
  assert.match(policyJob, /lockfile_regenerated: \$\{\{ steps\.regen_lockfile\.outputs\.regenerated \}\}/);

  const regenStep = stepBlock(policyJob, "Detect lockfile drift by regenerating");
  assert.ok(regenStep, "regen step exists");
  assert.match(regenStep, /id: regen_lockfile/);
  // The regeneration must run outside the manifest-pattern conditional: the
  // old shape skipped it when the PR diff touched no lock inputs, which is
  // exactly the base-drift blind spot this step exists to close.
  assert.match(
    regenStep,
    /fi\n\s*pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile\n\s*if git diff --quiet -- pnpm-lock\.yaml; then/,
  );
  assert.doesNotMatch(
    regenStep,
    /grep -Eq "\$manifest_pattern"; then\s*\n\s*pnpm install --lockfile-only/,
    "regen must not be nested inside the PR-diff manifest conditional",
  );
});

test("policy uploads the regenerated lockfile only when drift was detected", () => {
  const policyJob = jobBlocks(prWorkflow).find((b) => b.startsWith("  policy:"));
  const uploadStep = stepBlock(policyJob, "Upload regenerated lockfile for downstream jobs");
  assert.ok(uploadStep, "upload step exists");
  assert.match(uploadStep, /if: steps\.regen_lockfile\.outputs\.regenerated == '1'/);
  assert.match(uploadStep, /name: pr-lockfile/);
  assert.match(uploadStep, /if-no-files-found: error/);
});

test("every frozen-lockfile install job hard-restores the policy lockfile artifact", () => {
  // Match the run line, not bare text: comments (e.g. policy's own) mention
  // --frozen-lockfile without installing anything.
  const installingJobs = jobBlocks(prWorkflow).filter((b) => b.includes("run: pnpm install --frozen-lockfile"));
  assert.ok(installingJobs.length >= 6, `expected the six policy consumers, found ${installingJobs.length}`);
  for (const job of installingJobs) {
    const restore = stepBlock(job, "Restore regenerated PR lockfile (if policy uploaded one)");
    assert.ok(restore, `job missing restore step:\n${job.split("\n")[0]}`);
    assert.match(restore, /uses: actions\/download-artifact@/);
    assert.match(restore, /name: pr-lockfile/);
    assert.match(
      restore,
      /if: needs\.policy\.outputs\.lockfile_regenerated == '1'/,
      "restore must be gated on the policy output so a missing artifact fails the restore step, not the install",
    );
    assert.doesNotMatch(
      restore,
      /continue-on-error: true/,
      "continue-on-error swallows a missing artifact and defers the failure to the frozen install",
    );
  }
});
