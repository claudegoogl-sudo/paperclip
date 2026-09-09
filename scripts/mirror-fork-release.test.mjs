import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Regression tests for the offline-twin helpers of scripts/mirror-fork-release.sh.
//
// The mirror is the standing rollback-path safeguard for fork releases: its
// self-test must prove, with no GitHub access, that every published script
// resolves from the mirrored bytes. These tests pin the parsing rules that
// make that proof trustworthy — in particular for published rollback scripts
// whose assignment lines carry trailing inline comments, e.g.
//
//     TARGET="2026.824.1-fork.42"        # what we restore
//
// (a real line of the published rollback-fork824.42.sh asset). The offline
// resolver previously kept everything after the first '=' as the value, so
// the comment became part of ${TARGET}, the resolved artifact filename grew
// a `"        # what we restore` fragment, and the self-test failed for the
// whole release chain even though the mirrored assets were byte-perfect.

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "mirror-fork-release.sh",
);

// Runs a bash snippet with mirror-fork-release.sh sourced as a function
// library (MIRROR_FORK_RELEASE_SOURCE_ONLY=1: definitions only — no argument
// parsing, no network, no mirror mutations) and cwd set to DIR.
function runSourced(dir, snippet) {
  const body = [
    "set -euo pipefail",
    'MIRROR_FORK_RELEASE_SOURCE_ONLY=1 source "$0"',
    snippet,
  ].join("\n");
  return execFileSync("bash", ["-c", body, SCRIPT], {
    cwd: dir,
    encoding: "utf8",
  });
}

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirror-fork-release-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Faithful line shapes of the published rollback-fork824.42.sh release asset
// (v2026.907.1-fork.43): a usage one-liner inside a plain comment whose URL
// points at the script's OWN release, assignment lines with trailing inline
// comments, and the ${BASEURL}/${TARGET} indirection the offline resolver
// must expand. NEW_TARGET carries a version that appears nowhere else on
// purpose, to prove commented assignment lines produce no phantom reference.
const ROLLBACK_FIXTURE = `#!/usr/bin/env bash
# Paperclip host ROLLBACK: 2026.907.1-fork.43 -> 2026.824.1-fork.42.
# Shipped as a release asset on v2026.907.1-fork.43 (claudegoogl-sudo fork).
# Run ONLY if the fork.43 upgrade left the host broken:
#   T=$(mktemp) && curl -fsSL https://github.com/claudegoogl-sudo/paperclip/releases/download/v2026.907.1-fork.43/rollback-fork824.42.sh -o "$T" && sudo bash "$T"
# Migration-free both ways: no DB snapshot/restore is involved.
TARGET="2026.824.1-fork.42"        # what we restore
NEW_TARGET="2026.907.1-fork.99"    # what the forward window installed
BASEURL="https://github.com/claudegoogl-sudo/paperclip/releases/download/v2026.824.1-fork.42"
URL="\${BASEURL}/paperclipai-\${TARGET}.tgz"
SHA="SHA256SUMS_PLACEHOLDER"
`;

test("sourcing hook defines the helpers and runs nothing", () => {
  withTempDir((dir) => {
    const out = runSourced(dir, [
      "type script_referenced_tags >/dev/null",
      "type assignment_value >/dev/null",
      "type make_twin >/dev/null",
      "type assert_twin_resolves >/dev/null",
      '[ -z "${TAG:-}" ] && [ -z "${REPO:-}" ]',
      "echo helpers-ok",
    ].join("\n"));
    assert.match(out, /helpers-ok/);
  });
});

test("assignment_value keeps the quoted value and drops the inline comment", () => {
  withTempDir((dir) => {
    const out = runSourced(dir, [
      'v1=$(assignment_value \'TARGET="2026.824.1-fork.42"        # what we restore\')',
      'v2=$(assignment_value \'TARGET="2026.824.1-fork.42"\')',
      'v3=$(assignment_value \'SHA="abc123"\')',
      "printf '%s\\n' \"$v1\" \"$v2\" \"$v3\"",
    ].join("\n"));
    assert.equal(out, "2026.824.1-fork.42\n2026.824.1-fork.42\nabc123\n");
  });
});

test("published rollback line resolves to the real asset filename, not a comment fragment", () => {
  withTempDir((dir) => {
    const out = runSourced(dir, [
      'target=$(assignment_value \'TARGET="2026.824.1-fork.42"        # what we restore\')',
      'baseurl="file:///mirrors/v2026.824.1-fork.42/assets"',
      'url="${baseurl}/paperclipai-${target}.tgz"',
      'case "$url" in',
      '  *\'"\'*|*\'#\'*|*\' restore\'*) echo "GARBAGE: $url"; exit 1 ;;',
      "esac",
      '[ "$url" = "file:///mirrors/v2026.824.1-fork.42/assets/paperclipai-2026.824.1-fork.42.tgz" ]',
      'echo "clean: $url"',
    ].join("\n"));
    assert.match(
      out,
      /^clean: file:\/\/\/mirrors\/v2026\.824\.1-fork\.42\/assets\/paperclipai-2026\.824\.1-fork\.42\.tgz$/m,
    );
  });
});

// Reference discovery is intentionally an over-approximation: every
// release-download URL in the file counts as a reference, INCLUDING a URL
// inside a plain comment (the usage one-liner above points at the script's
// own release). Over-approximating is safe — the mirror skips self-references
// and an extra mirrored tag is harmless — while MISSING a real dependency
// would silently withhold the offline twin. The inline-comment parsing fix
// must not move this rule in either direction.
test("script_referenced_tags: comment URLs count; commented assignments yield no phantom tag", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "rollback-fixture.sh"),
      ROLLBACK_FIXTURE.replace("SHA256SUMS_PLACEHOLDER", "0".repeat(64)),
    );
    const out = runSourced(
      dir,
      "script_referenced_tags ./rollback-fixture.sh",
    );
    assert.equal(
      out,
      "v2026.824.1-fork.42\nv2026.907.1-fork.43\n",
      "expected exactly the BASEURL tag plus the comment-URL self-reference; no NEW_TARGET phantom",
    );
  });
});

// The end-to-end regression: twin the fixture against a staged mirror and
// prove the offline self-test path passes — twin structure intact, comment
// lines preserved byte-identical, and every ${BASEURL}/${TARGET} expansion
// resolving to a real, sha-verified file with no GitHub access.
test("offline twin of a comment-bearing rollback script resolves from the mirror alone", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "rollback-fixture.sh"),
      ROLLBACK_FIXTURE.replace("SHA256SUMS_PLACEHOLDER", "WAITING_FOR_SHA"),
    );
    const out = runSourced(
      dir,
      [
        "mkdir -p mirror/v2026.824.1-fork.42/assets",
        "printf 'fixture-asset-bytes\\n' > mirror/v2026.824.1-fork.42/assets/paperclipai-2026.824.1-fork.42.tgz",
        "sha=$(sha256sum mirror/v2026.824.1-fork.42/assets/paperclipai-2026.824.1-fork.42.tgz | awk '{print $1}')",
        "sed -i \"s/WAITING_FOR_SHA/$sha/\" rollback-fixture.sh",
        // Plain assignment (not a prefix env): assert_twin_structure reads
        // $MIRROR_DIR again below and must see the same staged mirror root.
        'MIRROR_DIR="$PWD/mirror"',
        "make_twin rollback-fixture.sh twin.sh",
        "assert_twin_structure rollback-fixture.sh twin.sh",
        'grep -q \'^TARGET="2026.824.1-fork.42"        # what we restore$\' twin.sh',
        "assert_twin_resolves twin.sh",
        'echo "twin-ok"',
      ].join("\n"),
    );
    assert.match(out, /twin-ok/);
  });
});
