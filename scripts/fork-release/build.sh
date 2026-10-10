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

echo "===== [1/10] pnpm install --frozen-lockfile ====="
pnpm install --frozen-lockfile 2>&1 | tail -3

echo "===== [2/10] set-version $VERSION ====="
node scripts/release-package-map.mjs set-version "$VERSION"
for P in cli/package.json server/package.json packages/db/package.json; do
  GOT="$(node -e "console.log(require('./$P').version)")"
  [ "$GOT" = "$VERSION" ] || { echo "FATAL: $P version '$GOT' != $VERSION" >&2; exit 1; }
done

echo "===== [3/10] workspace links preflight ====="
pnpm run preflight:workspace-links 2>&1 | tail -2

echo "===== [4/10] pre-build shared + plugin-sdk ====="
pnpm --filter @paperclipai/plugin-sdk ensure-build-deps >/dev/null 2>&1 || true
pnpm --filter @paperclipai/shared build 2>&1 | tail -1
pnpm --filter @paperclipai/plugin-sdk build 2>&1 | tail -1

echo "===== [5/10] full workspace build ====="
pnpm -r build 2>&1 | tail -2

echo "===== [6/10] build the sandbox-provider plugin dists ====="
# The sandbox providers are deliberately NOT pnpm-workspace members (their
# third-party SDK deps must not churn the root lockfile), so the full
# workspace build above never visits them. Packing them unbuilt ships
# tarballs whose manifests point at ./dist/* files that do not exist, and the
# core-chain export scan cannot see them because nothing on the core install
# closure depends on them. Build each provider standalone here: install its
# registry deps, link the already-built plugin-sdk in for type resolution,
# then run the package's own build script. Safe to re-run: npm install
# converges, and every build starts with `rm -rf dist`.
for D in packages/plugins/sandbox-providers/*/; do
  [ -f "$D/package.json" ] || continue
  echo "  -> $D"
  # Full deps (not --omit=dev): the tsconfig needs @types/node and the
  # devDep typescript is the compiler this package pins.
  (cd "$D" && npm install --no-audit --no-fund --no-package-lock --loglevel=error 2>&1 | tail -1)
  mkdir -p "$D/node_modules/@paperclipai"
  ln -sfn "$REPO_ROOT/packages/plugins/sdk" "$D/node_modules/@paperclipai/plugin-sdk"
  (cd "$D" && npm run build 2>&1 | tail -1)
  for ENTRY in index.js manifest.js worker.js; do
    test -f "$D/dist/$ENTRY"       || { echo "FATAL: $D/dist/$ENTRY missing after build" >&2; exit 1; }
  done
done

echo "===== [7/10] dashboard payload into the server package ====="
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
# Packages that declare bundleDependencies are NOT packed here: they are
# staged through scripts/prepare-bundled-package.mjs (npm install of the
# bundled dep + `patch -p1` re-application of the repository pnpm patch +
# patch-marker validation) and packed from the staged directory, so the
# published tarballs carry the PATCHED bundled runtime. Stripping
# bundleDependencies and packing the workspace directory instead shipped
# pristine registry copies to hosts — the fork.37 claude_local
# ensure_session outage (see scripts/fork-release/stage-bundled-packages.mjs).
BUNDLED_NAMES="$(node "$SCRIPT_DIR/stage-bundled-packages.mjs" --list-names)" || {
  echo "FATAL: could not enumerate bundled-dependency packages" >&2
  exit 1
}
BUNDLED_SKIP_ARGS=()
while IFS= read -r NAME; do
  BUNDLED_SKIP_ARGS+=(--skip "$NAME")
done <<< "$BUNDLED_NAMES"
node scripts/pack-public-packages.mjs --out "$OUT" "${BUNDLED_SKIP_ARGS[@]}" > pack-public.log 2>&1 || {
  echo "FATAL: pack-public-packages failed — last 30 lines:" >&2
  tail -30 pack-public.log >&2
  exit 1
}
grep -E '^==>|^  - ' pack-public.log | tail -5
echo "  -> staging bundled-dependency packages: $(echo "$BUNDLED_NAMES" | tr '\n' ' ')"
node "$SCRIPT_DIR/stage-bundled-packages.mjs" --out "$REPO_ROOT/$OUT" > stage-bundled.log 2>&1 || {
  echo "FATAL: bundled-dependency staging failed — last 30 lines:" >&2
  tail -30 stage-bundled.log >&2
  exit 1
}
cat stage-bundled.log

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
import path from "node:path";
import { listTarballs, scanExportTargets, scanUrlClosure } from "./scripts/fork-release/lib.mjs";
const [outDir, version] = process.argv.slice(2);
const closure = scanUrlClosure({ assetsDir: outDir, version });
if (!closure.ok) {
  for (const v of closure.violations) console.error(JSON.stringify(v));
  process.exit(1);
}
console.log(`  -> URL closure OK (${closure.references.length} internal refs)`);
// Scan EVERY tarball in the release set, not only the core install closure:
// provider plugin tarballs are not reachable from the core URL pins, so a
// closure-scoped scan silently passes a provider that ships no code.
const all = listTarballs(outDir);
const violations = [];
for (const tarballPath of all) {
  const asset = path.basename(tarballPath);
  violations.push(...scanExportTargets(tarballPath).violations.map((v) => ({ asset, ...v })));
}
if (violations.length > 0) {
  for (const v of violations) console.error(JSON.stringify(v));
  process.exit(1);
}
console.log(`  -> export targets OK on all ${all.length} release tarballs`);
NODE
# (d) bundled-dependency tarballs must ship the PATCHED bundled runtime
node "$SCRIPT_DIR/gate-bundled-tarballs.mjs" --dir "$OUT" --version "$VERSION" || {
  echo "FATAL: bundled-dependency tarball gate failed" >&2
  exit 1
}
# Plain names (no ./ prefix), matching the basename keys the verifier and the
# test-only injector use; verifyChecksums also normalizes either format.
(cd "$OUT" && sha256sum *.tgz > SHA256SUMS.txt)
echo "  -> SHA256SUMS.txt written"

if [ "$NEGATIVE_TEST" = "1" ]; then
  echo "===== TEST-ONLY: injecting the fork.34 defect (dev-exports db tarball) ====="
  node "$SCRIPT_DIR/negative-test-fork34.mjs" --dir "$OUT"
fi

echo "===== fork-release build DONE: $OUT ====="
