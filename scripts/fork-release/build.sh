#!/usr/bin/env bash
# Fork-release build: build, pack, URL-pin, and statically gate a fork
# release tarball set.
#
# Runs entirely against the CURRENT checkout (the caller chooses the ref, in
# CI or locally) and is safe to re-run: every step either converges or fails
# loudly. Output is a directory of tarballs + SHA256SUMS.txt that passed the
# static half of the release preflight (the install/boot half runs in the
# workflow's preflight job before anything is published).
#
# Usage:
#   scripts/fork-release/build.sh <version> [--out <dir>] [--negative-test-fork34]
#
#   <version>               release version, e.g. 2026.824.1-fork.35
#   --out <dir>             output directory (default: dist-tarballs)
#   --negative-test-fork34  test-only: corrupt the packed db tarball into the
#                           historically-shipped dev-exports defect AFTER the
#                           static gates, to prove the preflight blocks it.

set -euo pipefail

VERSION=""
OUT="dist-tarballs"
NEGATIVE_TEST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --negative-test-fork34) NEGATIVE_TEST=1; shift ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//';
      exit 0 ;;
    *)
      if [ -z "$VERSION" ]; then VERSION="$1"; shift;
      else echo "unexpected argument: $1" >&2; exit 2; fi ;;
  esac
done
[ -n "$VERSION" ] || { echo "usage: build.sh <version> [--out <dir>] [--negative-test-fork34]" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
SCRIPT_DIR="$REPO_ROOT/scripts/fork-release"

echo "===== fork-release build $VERSION ====="
echo "HEAD: $(git rev-parse HEAD)"

echo "===== [1/9] pnpm install --frozen-lockfile ====="
pnpm install --frozen-lockfile 2>&1 | tail -3

echo "===== [2/9] set-version $VERSION ====="
node scripts/release-package-map.mjs set-version "$VERSION"
for P in cli/package.json server/package.json packages/db/package.json; do
  GOT="$(node -e "console.log(require('./$P').version)")"
  [ "$GOT" = "$VERSION" ] || { echo "FATAL: $P version '$GOT' != $VERSION" >&2; exit 1; }
done

echo "===== [3/9] workspace links preflight ====="
pnpm run preflight:workspace-links 2>&1 | tail -2

echo "===== [4/9] pre-build shared + plugin-sdk ====="
pnpm --filter @paperclipai/plugin-sdk ensure-build-deps >/dev/null 2>&1 || true
pnpm --filter @paperclipai/shared build 2>&1 | tail -1
pnpm --filter @paperclipai/plugin-sdk build 2>&1 | tail -1

echo "===== [5/9] full workspace build ====="
pnpm -r build 2>&1 | tail -2

echo "===== [6/9] dashboard payload into the server package ====="
PAPERCLIP_RELEASE_REUSE_UI_DIST=1 bash scripts/prepare-server-ui-dist.sh 2>&1 | tail -2
test -f server/ui-dist/index.html || { echo "FATAL: server/ui-dist/index.html missing" >&2; exit 1; }

echo "===== [7/10] ship built-in skills (server + local adapters) ====="
for pkg_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
  rm -rf "$pkg_dir/skills"
  cp -r skills "$pkg_dir/skills"
done

echo "===== [8/10] CLI bundle + pack all packages ====="
rm -rf "$OUT"
mkdir -p "$OUT"
bash scripts/build-npm.sh --skip-checks --skip-typecheck 2>&1 | tail -3
(cd cli && npm pack --pack-destination "$REPO_ROOT/$OUT" 2>&1 | tail -1)
rm -rf packages/db/dist
pnpm --filter @paperclipai/db build 2>&1 | tail -1
# pnpm pack refuses to pack manifests that declare bundleDependencies under
# the isolated node linker. The fork ships those deps as normal registry
# dependencies (no tarball carries bundles), so strip the declarations for
# the pack and restore the manifests afterwards.
BUNDLED_MANIFESTS="$(grep -rl '"bundleDependencies"' packages server ui cli --include='package.json' 2>/dev/null | grep -v node_modules || true)"
if [ -n "$BUNDLED_MANIFESTS" ]; then
  echo "  -> temporarily stripping bundleDependencies from: $(echo "$BUNDLED_MANIFESTS" | tr '\n' ' ')"
  node -e 'const fs=require("node:fs");for(const p of process.argv.slice(1)){const j=JSON.parse(fs.readFileSync(p,"utf8"));delete j.bundleDependencies;delete j.bundledDependencies;fs.writeFileSync(p,`${JSON.stringify(j,null,2)}\n`);}' $BUNDLED_MANIFESTS
fi
node scripts/pack-public-packages.mjs --out "$OUT" > pack-public.log 2>&1 || {
  echo "FATAL: pack-public-packages failed — last 30 lines:" >&2
  tail -30 pack-public.log >&2
  if [ -n "$BUNDLED_MANIFESTS" ]; then git checkout -- $BUNDLED_MANIFESTS; fi
  exit 1
}
if [ -n "$BUNDLED_MANIFESTS" ]; then git checkout -- $BUNDLED_MANIFESTS; fi
grep -E '^==>|^  - ' pack-public.log | tail -5

echo "===== [9/10] URL-pin every internal dependency to this release ====="
node "$SCRIPT_DIR/pin-internal-deps.mjs" --dir "$OUT" --version "$VERSION"

echo "===== [10/10] static release gates ====="
TARBALL_COUNT="$(ls "$OUT"/*.tgz | wc -l)"
echo "  -> $TARBALL_COUNT tarballs packed"
# (a) every tarball must be intact gzip
for T in "$OUT"/*.tgz; do gzip -t "$T" || { echo "FATAL: corrupt tarball $T" >&2; exit 1; }; done
echo "  -> gzip -t OK on all tarballs"
# (b) the server tarball must ship the dashboard payload
# grep -c reads the whole tar listing, so the pipe cannot die of SIGPIPE
# under `set -o pipefail` the way an early-exit `grep -q` can.
SERVER_LISTING="$(tar -tzf "$OUT/paperclipai-server-$VERSION.tgz" | grep -c '^package/ui-dist/index.html$' || true)"
[ "$SERVER_LISTING" -ge 1 ] \
  || { echo "FATAL: server tarball does not ship ui-dist/index.html" >&2; exit 1; }
echo "  -> server tarball ships ui-dist/index.html"
# (c) install closure + export targets + URL pins (same code the preflight runs)
node - "$OUT" "$VERSION" <<'NODE'
import { coreChainClosure, listTarballs, scanExportTargets, scanUrlClosure } from "./scripts/fork-release/lib.mjs";
const [outDir, version] = process.argv.slice(2);
const coreAsset = `paperclipai-${version}.tgz`;
const closure = scanUrlClosure({ assetsDir: outDir, version });
if (!closure.ok) {
  for (const v of closure.violations) console.error(JSON.stringify(v));
  process.exit(1);
}
console.log(`  -> URL closure OK (${closure.references.length} internal refs)`);
const chain = coreChainClosure({ assetsDir: outDir, coreTarballName: coreAsset });
const violations = [];
for (const [asset, { tarballPath }] of chain) {
  violations.push(...scanExportTargets(tarballPath).violations.map((v) => ({ asset, ...v })));
}
if (violations.length > 0) {
  for (const v of violations) console.error(JSON.stringify(v));
  process.exit(1);
}
console.log(`  -> export targets OK on the ${chain.size}-package install closure`);
NODE
# Plain names (no ./ prefix), matching the basename keys the verifier and the
# test-only injector use; verifyChecksums also normalizes either format.
(cd "$OUT" && sha256sum *.tgz > SHA256SUMS.txt)
echo "  -> SHA256SUMS.txt written"

if [ "$NEGATIVE_TEST" = "1" ]; then
  echo "===== TEST-ONLY: injecting the fork.34 defect (dev-exports db tarball) ====="
  node "$SCRIPT_DIR/negative-test-fork34.mjs" --dir "$OUT"
fi

echo "===== fork-release build DONE: $OUT ====="
