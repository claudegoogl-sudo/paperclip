#!/usr/bin/env bash
# Mirror a fork release from GitHub to a local, self-contained directory.
#
# Why: install/verify/rollback scripts of a fork release point at the
# release's GitHub asset URLs. If a release is deleted on GitHub, every one
# of those URLs dies with it, and the documented rollback path is stranded.
# The local mirror keeps the exact published bytes on this host, so install
# and rollback work with no GitHub access at all.
#
# Policy (doc/runbooks/FORK-RELEASES.md):
#   - Releases are immutable. Never delete a release. Mark a broken release
#     DO-NOT-USE in its release notes and fix forward with a new release.
#   - Every fork release is mirrored at publish time, and the mirror passes
#     the offline self-test before the host cutover.
#   - Retention keeps the newest KEEP mirrors (default 3: current + 2 back),
#     plus any tag a kept release's scripts reference. Pruning is logged to
#     prune.log; it is never silent.
#
# The mirror step is idempotent: re-running on the same tag re-verifies and
# converges. A partial mirror never carries the .mirror-ok marker, so a
# failed run can never read as success.
#
# Usage:
#   scripts/mirror-fork-release.sh <tag> [options]
#
# Options:
#   --repo OWNER/REPO   GitHub repo (default: resolved from the git remotes)
#   --mirror-dir DIR    mirror root (default: ~/backups/fork-releases)
#   --keep N            retention window for --prune (default: 3)
#   --prune             after a successful mirror, prune mirrors that fall
#                       outside the retention rule (logged)
#   --max-ref-depth N   how many rollback hops to follow when a mirrored
#                       script references another release (default: 2)
#   --no-self-test      skip the offline self-test (not recommended; the
#                       .mirror-ok marker then records self_test: false)
#   -h, --help          show this help
#
# Exit codes: 0 success; 1 on any verification failure (no .mirror-ok).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=./release-lib.sh
. "$REPO_ROOT/scripts/release-lib.sh"

MIRROR_TOOL_VERSION="1.0.0"
DEFAULT_MIRROR_DIR="$HOME/backups/fork-releases"

TAG=""
REPO=""
MIRROR_DIR="$DEFAULT_MIRROR_DIR"
KEEP=3
MAX_REF_DEPTH=2
DO_PRUNE=false
DO_SELF_TEST=true

usage() {
  cat <<'EOF'
Usage:
  scripts/mirror-fork-release.sh <tag> [--repo OWNER/REPO] [--mirror-dir DIR]
                                  [--keep N] [--prune] [--max-ref-depth N]
                                  [--no-self-test]

Mirrors every asset of a published fork release into
  <mirror-dir>/<tag>/assets/
records them in <mirror-dir>/<tag>/MANIFEST.json, generates offline twins of
the URL-referencing scripts under <mirror-dir>/<tag>/offline/, verifies that
the mirror stands alone (no GitHub), and only then writes the .mirror-ok
marker. Re-running on the same tag is safe and converges.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [ $# -ge 2 ] || release_fail "--repo requires a value."; REPO="$2"; shift ;;
    --mirror-dir) [ $# -ge 2 ] || release_fail "--mirror-dir requires a value."; MIRROR_DIR="$2"; shift ;;
    --keep) [ $# -ge 2 ] || release_fail "--keep requires a value."; KEEP="$2"; shift ;;
    --max-ref-depth) [ $# -ge 2 ] || release_fail "--max-ref-depth requires a value."; MAX_REF_DEPTH="$2"; shift ;;
    --prune) DO_PRUNE=true ;;
    --no-self-test) DO_SELF_TEST=false ;;
    -h|--help) usage; exit 0 ;;
    -*) release_fail "unknown option: $1" ;;
    *) if [ -n "$TAG" ]; then release_fail "only one tag may be provided."; fi; TAG="$1" ;;
  esac
  shift
done

if [ -z "$TAG" ]; then usage; echo "" >&2; release_fail "a release tag is required (example: v2026.707.0-fork.33)"; fi
case "$TAG" in v*) ;; *) release_fail "tag must start with 'v' (example: v2026.707.0-fork.33)" ;; esac
case "$KEEP$MAX_REF_DEPTH" in *[!0-9]*) release_fail "--keep and --max-ref-depth require whole numbers" ;; esac

# Resolve the GitHub repo without depending on a specific remote name: this
# script also runs from release worktrees whose remote may be named 'fork'.
resolve_repo() {
  local r url
  if [ -n "${RELEASE_REMOTE:-}" ] || [ -n "${PUBLISH_REMOTE:-}" ]; then
    r="${RELEASE_REMOTE:-${PUBLISH_REMOTE:-}}"
    github_repo_from_remote "$r" 2>/dev/null && return 0
  fi
  for r in fork public-gh public origin upstream; do
    if git -C "$REPO_ROOT" remote get-url "$r" >/dev/null 2>&1; then
      github_repo_from_remote "$r" 2>/dev/null && return 0
    fi
  done
  return 1
}

if [ -z "$REPO" ]; then
  REPO="$(resolve_repo || true)"
fi
[ -n "$REPO" ] || release_fail "could not determine GitHub repository; pass --repo OWNER/REPO"

# Some environments force color even for pipes (CLICOLOR_FORCE/FORCE_COLOR),
# which corrupts the raw JSON gh api prints. Disable TTY formatting for gh.
export GH_FORCE_TTY=0

command -v gh >/dev/null 2>&1 || release_fail "gh CLI is required"
command -v curl >/dev/null 2>&1 || release_fail "curl is required"
command -v jq >/dev/null 2>&1 || release_fail "jq is required"
command -v sha256sum >/dev/null 2>&1 || release_fail "sha256sum is required"

MIRROR_DIR="$(mkdir -p "$MIRROR_DIR" && cd "$MIRROR_DIR" && pwd)"
LOG_FILE="$MIRROR_DIR/mirror.log"
PRUNE_LOG="$MIRROR_DIR/prune.log"

TAG_OR_CONTEXT="$TAG"
log() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) [$TAG_OR_CONTEXT] $*"
  echo "$line"
  echo "$line" >> "$LOG_FILE"
}

sha_of() { sha256sum "$1" | awk '{print $1}'; }

fetch_release_json() { # $1 = tag -> release JSON on stdout
  gh api "repos/$REPO/releases/tags/$1"
}

# Expected sha256 for an asset: the release's own SHA256SUMS.txt wins, then
# the API asset digest. Empty means size-only verification. SUMS_FILE and
# RELEASE_JSON are locals of mirror_release (dynamic scope makes them visible
# here; per-recursion locals keep recursive mirrors from clobbering each
# other).
asset_expected_sha() { # $1 asset name
  local name="$1" got=""
  if [ -n "$SUMS_FILE" ] && [ -f "$SUMS_FILE" ]; then
    got="$(awk -v n="$name" '$2 == n { print $1; exit }' "$SUMS_FILE")"
  fi
  if [ -z "$got" ]; then
    got="$(printf '%s' "$RELEASE_JSON" | jq -r --arg n "$name" \
      '.assets[] | select(.name == $n) | ((.digest // "") | sub("^sha256:"; ""))' 2>/dev/null || true)"
  fi
  printf '%s' "$got"
}

# ---------------------------------------------------------------------------
# Release-download URL handling (offline twins)
# ---------------------------------------------------------------------------

# Tags a script references via release-download URLs (often the PREVIOUS
# release: a rollback script for tag N re-installs tag N-1).
script_referenced_tags() { # $1 script path -> tags on stdout
  grep -oE 'https://github\.com/[^"]+/releases/download/[^/"]+' "$1" 2>/dev/null \
    | sed -E 's#.*/releases/download/##' | sort -u || true
}

TWIN_HEADER_LINES=5

make_twin() { # $1 source script $2 twin path
  local src="$1" dst="$2" name refs
  name="$(basename "$src")"
  refs="$(script_referenced_tags "$src" | tr '\n' ' ')"
  {
    echo "# OFFLINE MIRROR TWIN — generated by scripts/mirror-fork-release.sh v$MIRROR_TOOL_VERSION."
    echo "# Source of truth: assets/$name (sha256 $(sha_of "$src"))."
    echo "# Only difference: release-download base URLs resolve from this mirror."
    echo "# Release refs: ${refs:-none}. Do not edit; re-run the mirror script."
    echo "#"
    cat "$src"
  } > "$dst.tmp"
  sed -E 's#^([A-Za-z_][A-Za-z0-9_]*)(="https://github\.com/[^"]+/releases/download/)([^/"]+)"$#\1="file://'"$MIRROR_DIR"'/\3/assets"#' \
    "$dst.tmp" > "$dst"
  rm -f "$dst.tmp"
}

# Structural check: the twin must differ from the published script ONLY in
# the generated header and in rewritten URL assignment lines.
assert_twin_structure() { # $1 source script $2 twin
  local src="$1" twin="$2" rc=0 removed added
  local body d
  body="$(mktemp)"; d="$(mktemp)"
  tail -n +"$((TWIN_HEADER_LINES + 1))" "$twin" > "$body"
  diff "$src" "$body" > "$d" || true
  removed="$(grep -E '^< ' "$d" | sed 's/^< //')"
  added="$(grep -E '^> ' "$d" | sed 's/^> //')"
  if [ -n "$removed" ] && printf '%s\n' "$removed" \
      | grep -qvE '^[A-Za-z_][A-Za-z0-9_]*="https://github\.com/[^"]+/releases/download/[^/"]+"$'; then
    echo "  STRUCTURE FAIL: twin changes more than release URLs in $(basename "$src"):" >&2
    printf '%s\n' "$removed" \
      | grep -vE '^[A-Za-z_][A-Za-z0-9_]*="https://github\.com/[^"]+/releases/download/[^/"]+"' >&2
    rc=1
  fi
  if [ -n "$added" ] && printf '%s\n' "$added" \
      | grep -qvE '^[A-Za-z_][A-Za-z0-9_]*="file://'"$MIRROR_DIR"'/[^"]+"$'; then
    echo "  STRUCTURE FAIL: twin adds unexpected lines in $(basename "$src"):" >&2
    printf '%s\n' "$added" \
      | grep -vE '^[A-Za-z_][A-Za-z0-9_]*="file://'"$MIRROR_DIR"'/[^"]+"' >&2
    rc=1
  fi
  # Line content is validated above; this only catches stray diff output
  # (binary notices, truncation, etc.). Prefix match on purpose.
  if [ -n "$(grep -vE '^([<>] |---$|\\ No newline at end of file$|[0-9]+(,[0-9]+)?[acd][0-9]+(,[0-9]+)?)' "$d")" ]; then
    echo "  STRUCTURE FAIL: unexpected diff content for $(basename "$src")" >&2
    rc=1
  fi
  rm -f "$body" "$d"
  return "$rc"
}

# Offline simulation of the script's fetch-and-pin path: expand the script's
# assignments, fetch every mirror URL exactly as the script would (curl),
# and check the sha pins. Runs no host-mutating step.
assert_twin_resolves() { # $1 twin path
  local twin="$1" tmp bad=0 line k v url sha rb
  tmp="$(mktemp -d)"
  awk -F= '/^[A-Za-z_][A-Za-z0-9_]*="/ { print }' "$twin" > "$tmp/assigns"
  local URL="" SHA="" RB_URL="" BASEURL="" TARGET=""
  while IFS= read -r line; do
    k="${line%%=*}"; v="${line#*=}"; v="${v%\"}"; v="${v#\"}"
    case "$k" in
      URL|SHA|RB_URL|BASEURL|TARGET) printf -v "$k" '%s' "$v" ;;
    esac
  done < "$tmp/assigns"
  for _ in 1 2 3; do
    URL="${URL//\$\{BASEURL\}/${BASEURL}}"
    URL="${URL//\$\{TARGET\}/${TARGET}}"
    RB_URL="${RB_URL//\$\{BASEURL\}/${BASEURL}}"
  done
  if [ -n "$(printf '%s\n' "$URL" "$RB_URL" | grep 'releases/download' || true)" ]; then
    echo "  RESOLVE FAIL: GitHub release URL still present after rewrite in $(basename "$twin")" >&2
    bad=1
  fi
  if [ -n "$URL" ]; then
    if curl -fsSL "$URL" -o "$tmp/artifact" 2>/dev/null; then
      if [ -n "$SHA" ] && [ "$(sha_of "$tmp/artifact")" != "$SHA" ]; then
        echo "  RESOLVE FAIL: $URL sha256 mismatch (script pin $SHA)" >&2
        bad=1
      fi
    else
      echo "  RESOLVE FAIL: cannot fetch $URL from the mirror" >&2
      bad=1
    fi
  fi
  if [ -n "$RB_URL" ]; then
    if curl -fsSL "$RB_URL" -o "$tmp/rb.sh" 2>/dev/null; then
      bash -n "$tmp/rb.sh" || { echo "  RESOLVE FAIL: rollback twin $rb does not parse" >&2; bad=1; }
    else
      echo "  RESOLVE FAIL: cannot fetch rollback twin $RB_URL" >&2
      bad=1
    fi
  fi
  rm -rf "$tmp"
  return "$bad"
}

# ---------------------------------------------------------------------------
# Mirror one release (recursively mirrors referenced releases first)
# ---------------------------------------------------------------------------

MIRRORED_TAGS=" "
IN_PROGRESS=" "

mirror_release() { # $1 tag $2 depth
  local tag="$1" depth="$2"
  case "$MIRRORED_TAGS" in *" $tag "*) return 0 ;; esac
  case "$IN_PROGRESS" in *" $tag "*) return 0 ;; esac
  IN_PROGRESS="$IN_PROGRESS$tag "

  local final="$MIRROR_DIR/$tag"
  if [ -f "$final/.mirror-ok" ]; then
    log "$tag already mirrored — re-verifying in place"
  else
    log "mirroring $tag"
  fi

  local json
  json="$(fetch_release_json "$tag")" || release_fail "release $tag not found in $REPO (gh api failed)"
  [ -n "$json" ] || release_fail "release $tag not found in $REPO"
  if [ "$(printf '%s' "$json" | jq -r '.draft')" = "true" ]; then
    release_fail "release $tag is a DRAFT — this tool mirrors published releases only"
  fi

  local asset_count asset_bytes
  asset_count="$(printf '%s' "$json" | jq -r '.assets | length')"
  asset_bytes="$(printf '%s' "$json" | jq -r '[.assets[].size] | add // 0')"
  [ "$asset_count" -gt 0 ] || release_fail "release $tag has zero assets — refusing to mirror an empty release"
  log "$tag: $asset_count assets, $((asset_bytes / 1048576)) MiB, from $REPO"

  local staged="$MIRROR_DIR/.staging-$tag-$$"
  rm -rf "$staged"
  mkdir -p "$staged/assets" "$staged/offline"

  local SUMS_FILE="" RELEASE_JSON=""

  # One authenticated download of all assets, then verify every file.
  gh release download "$tag" -R "$REPO" -D "$staged/assets" --clobber \
    || release_fail "asset download failed for $tag"

  RELEASE_JSON="$json"
  if [ -f "$staged/assets/SHA256SUMS.txt" ]; then
    SUMS_FILE="$staged/assets/SHA256SUMS.txt"
  else
    log "WARNING: $tag has no SHA256SUMS.txt asset; hashes come from the API digest field only"
  fi

  # Asset set must match the release exactly: none missing, none extra.
  local expected_assets actual_assets missing extra name size expected got f
  expected_assets="$(printf '%s' "$json" | jq -r '.assets[].name' | sort)"
  actual_assets="$(cd "$staged/assets" && ls -A | sort)"
  missing="$(comm -23 <(printf '%s\n' "$expected_assets") <(printf '%s\n' "$actual_assets"))"
  extra="$(comm -13 <(printf '%s\n' "$expected_assets") <(printf '%s\n' "$actual_assets"))"
  [ -z "$missing" ] || release_fail "mirror of $tag is missing assets: $(echo "$missing" | tr '\n' ' ')"
  [ -z "$extra" ] || release_fail "mirror of $tag has unexpected extra files: $(echo "$extra" | tr '\n' ' ')"

  # Verify size + checksum for every asset (download-time assertion).
  while IFS=$'\t' read -r name size; do
    [ -n "$name" ] || continue
    f="$staged/assets/$name"
    [ "$(wc -c < "$f")" = "$size" ] || release_fail "size mismatch: $tag asset $name (want $size bytes)"
    expected="$(asset_expected_sha "$name")"
    if [ -n "$expected" ]; then
      got="$(sha_of "$f")"
      [ "$got" = "$expected" ] || release_fail "sha256 mismatch: $tag asset $name (want $expected, got $got)"
    else
      log "WARNING: no checksum source for $tag asset $name — verified by size only"
    fi
  done < <(printf '%s' "$json" | jq -r '.assets[] | [.name, (.size | tostring)] | @tsv')

  # Offline twins for scripts that reference release-download URLs. A script
  # may reference ANOTHER tag; mirror that tag first when it is within the
  # configured rollback depth. A script with an unmirrored reference gets NO
  # twin (an offline twin that cannot resolve would be a lie); it is
  # recorded as withheld in MANIFEST.json instead.
  local reftag twins_generated=0 withheld_json="[]" withheld_list=" "
  for f in "$staged"/assets/*.sh; do
    [ -f "$f" ] || continue
    while IFS= read -r reftag; do
      [ -n "$reftag" ] || continue
      case "$reftag" in "$tag") continue ;; esac # self-reference: same dir
      mirrored_or_pending=false
      [ -d "$MIRROR_DIR/$reftag" ] && mirrored_or_pending=true
      case "$IN_PROGRESS" in *" $reftag "*) mirrored_or_pending=true ;; esac
      if [ "$mirrored_or_pending" = "true" ]; then
        continue
      fi
      if [ "$depth" -lt "$MAX_REF_DEPTH" ]; then
        TAG_OR_CONTEXT="$reftag"
        log "$tag script references $reftag — mirroring it first"
        mirror_release "$reftag" "$((depth + 1))"
        TAG_OR_CONTEXT="$tag"
      else
        case "$withheld_list" in *" $(basename "$f"):$reftag "*) ;; *)
          withheld_list="$withheld_list$(basename "$f"):$reftag "
          withheld_json="$(printf '%s' "$withheld_json" | jq --arg s "$(basename "$f")" --arg r "$reftag" '. + [{script: $s, ref: $r, reason: "ref beyond --max-ref-depth"}]')"
          log "NOTE: $reftag is beyond --max-ref-depth=$MAX_REF_DEPTH — no offline twin for $(basename "$f") (recorded in MANIFEST.json)"
        ;;
        esac
      fi
    done < <(script_referenced_tags "$f")
  done
  for f in "$staged"/assets/*.sh; do
    [ -f "$f" ] || continue
    script_referenced_tags "$f" | grep -q . || continue
    if [[ "$withheld_list" == *" $(basename "$f"):"* ]]; then
      continue # unresolvable reference — no twin, recorded as withheld
    fi
    make_twin "$f" "$staged/offline/$(basename "$f")"
    twins_generated=$((twins_generated + 1))
  done
  log "$tag: $twins_generated offline twin(s) generated"

  # ROLLBACK.md — the 3 a.m. entry point: how to roll back with no GitHub.
  {
    echo "# Offline rollback — $tag"
    echo ""
    echo "This directory is a local mirror of release $tag from $REPO."
    echo "Files under assets/ are byte-identical to the published release"
    echo "assets (checksums verified). Files under offline/ are generated"
    echo "twins of the published scripts: byte-identical except that"
    echo "release-download URLs resolve from this mirror (file://), so they"
    echo "work with no GitHub access at all."
    echo ""
    echo "## Offline scripts in this mirror (no GitHub needed)"
    echo ""
    echo "Rollback scripts (undo an installed release):"
    echo ""
    for f in "$staged"/offline/rollback-*.sh; do
      [ -f "$f" ] || continue
      echo "$MIRROR_DIR/$tag/offline/$(basename "$f")"
    done | sed 's#^#    sudo bash #'
    echo ""
    echo "Install scripts (install THIS tag; NOT a rollback):"
    echo ""
    for f in "$staged"/offline/install-*.sh; do
      [ -f "$f" ] || continue
      echo "$MIRROR_DIR/$tag/offline/$(basename "$f")"
    done | sed 's#^#    sudo bash #'
    echo ""
    echo "Run a rollback script only when the release it undoes is the one"
    echo "installed and it must be undone. Each script stops services,"
    echo "reinstalls, and restores data snapshots exactly as published."
    echo ""
    echo "## Verify the mirror (idempotent re-run)"
    echo ""
    echo "    scripts/mirror-fork-release.sh $tag --repo $REPO --mirror-dir $MIRROR_DIR"
  } > "$staged/ROLLBACK.md"

  # MANIFEST.json — machine-readable record of the mirror.
  local manifest="$staged/MANIFEST.json" assets_json sums_json tag_commit
  printf '%s' "$json" | jq '{tag: .tag_name, repo: $repo, title: .name, prerelease: .prerelease, draft: .draft, created_at: .created_at, published_at: .published_at, target_commitish: .target_commitish}' \
    --arg repo "$REPO" > "$manifest"
  assets_json="$(printf '%s' "$json" | jq '[.assets[] | {name: .name, size: .size, sha256: ((.digest // "") | sub("^sha256:"; "") | select(. != "")) , digest_source: (if (.digest // "") == "" then null else "api" end)}]')"
  if [ -n "$SUMS_FILE" ]; then
    sums_json="$(jq -Rn '[inputs | sub("\r$";"") | select(length > 0) | split("  ") | {name: .[1], hash: .[0]}]' < "$SUMS_FILE")"
    assets_json="$(jq -n --argjson assets "$assets_json" --argjson sums "$sums_json" \
      '$assets | map(. as $a | ($sums | map(select(.name == $a.name)) | .[0].hash // null) as $h | if $h == null then . else (.sha256 = $h | .digest_source = "SHA256SUMS.txt") end)')"
  fi
  tag_commit="$(git ls-remote "https://github.com/$REPO" "refs/tags/$tag" "refs/tags/$tag^{}" 2>/dev/null | awk '{print $1}' | tail -1 || true)"
  jq --argjson assets "$assets_json" --argjson withheld "$withheld_json" \
     --arg twins_generated "$twins_generated" \
     --arg tool "mirror-fork-release.sh" --arg tool_version "$MIRROR_TOOL_VERSION" \
     --arg mirrored_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     --arg host "$(hostname 2>/dev/null || echo unknown)" \
     --arg tag_commit "$tag_commit" \
     '. + {
        tag_commit: (if $tag_commit == "" then null else $tag_commit end),
        assets: $assets,
        offline: {twins_generated: ($twins_generated | tonumber), withheld: $withheld},
        mirror: {tool: $tool, tool_version: $tool_version, mirrored_at: $mirrored_at, host: $host}
      }' "$manifest" > "$manifest.new"
  mv "$manifest.new" "$manifest"

  # Swap into place atomically (same filesystem): a previous failed attempt
  # (no .mirror-ok) is replaced; a verified one is replaced by an equal one.
  if [ -d "$final" ]; then
    mv "$final" "$final.old.$$"
  fi
  mv "$staged" "$final"
  if [ -d "$final.old.$$" ]; then
    rm -rf "$final.old.$$"
  fi
  MIRRORED_TAGS="$MIRRORED_TAGS$tag "
  log "$tag mirrored and checksummed at $final"

  # The marker is written only after the self-test proves this tag's mirror
  # stands alone; a failed run leaves no marker (no partial mirror can read
  # as success). Dependency tags mirrored above are verified the same way.
  if [ "$DO_SELF_TEST" = "true" ]; then
    if ! self_test "$tag"; then
      log "FAILED: offline self-test for $tag — no .mirror-ok written"
      release_fail "offline self-test failed for $tag"
    fi
    write_mirror_ok "$tag" true
  else
    log "WARNING: self-test skipped for $tag — marker records self_test: false"
    write_mirror_ok "$tag" false
  fi
}

# ---------------------------------------------------------------------------
# Self-test: prove the mirror stands alone (no GitHub)
# ---------------------------------------------------------------------------

self_test() { # $1 tag
  local tag="$1" dir="$MIRROR_DIR/$tag" bad=0 f name twin
  echo "== offline self-test: $tag =="
  for f in "$dir"/assets/*.sh; do
    [ -f "$f" ] || continue
    script_referenced_tags "$f" | grep -q . || continue
    name="$(basename "$f")"
    twin="$dir/offline/$name"
    if [ ! -f "$twin" ]; then
      if jq -e --arg s "$name" \
          '.offline.withheld | map(select(.script == $s)) | length > 0' "$dir/MANIFEST.json" >/dev/null 2>&1; then
        echo "  NOTE: $name twin withheld (ref outside depth) — recorded in MANIFEST"
        continue
      fi
      echo "  FAIL: missing offline twin for $name" >&2
      bad=1
      continue
    fi
    local script_bad=0
    bash -n "$twin" || { echo "  FAIL: twin does not parse: $name" >&2; script_bad=1; }
    assert_twin_structure "$f" "$twin" || script_bad=1
    assert_twin_resolves "$twin" || script_bad=1
    if [ "$script_bad" = "0" ]; then
      echo "  OK: $name resolves from the mirror"
      bad=$((bad + 0))
    else
      bad=$((bad + 1))
    fi
  done
  # Published bytes must remain the GitHub originals — no mirror paths inside.
  for f in "$dir"/assets/*.sh; do
    [ -f "$f" ] || continue
    if grep -q "file://$MIRROR_DIR" "$f"; then
      echo "  FAIL: published script $(basename "$f") contains mirror paths — mirror corrupted it" >&2
      bad=1
    fi
  done
  if [ "$bad" = "0" ]; then
    echo "  self-test PASS: every artifact reference resolves from the mirror alone"
  else
    echo "  self-test FAIL for $tag" >&2
  fi
  return "$bad"
}

write_mirror_ok() { # $1 tag  ($2 = "true" when the self-test ran and passed)
  local tag="$1" self_test_passed="${2:-false}" dir="$MIRROR_DIR/$1"
  printf '{"tag": "%s", "self_test": %s, "verified_at": "%s", "tool": "mirror-fork-release.sh v%s", "manifest_sha256": "%s"}\n' \
    "$tag" "$self_test_passed" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MIRROR_TOOL_VERSION" "$(sha_of "$dir/MANIFEST.json")" \
    > "$dir/.mirror-ok"
  [ -s "$dir/.mirror-ok" ] || release_fail "failed to write .mirror-ok for $tag"
}

# ---------------------------------------------------------------------------
# Retention: keep the newest KEEP fork releases (+ referenced tags); log all
# ---------------------------------------------------------------------------

fork_release_tags_in_mirror() {
  local d
  for d in "$MIRROR_DIR"/v*-fork.*; do
    [ -d "$d" ] || continue
    [ -f "$d/.mirror-ok" ] || continue
    basename "$d"
  done | sort -u
}

prune_mirrors() { # $1 keep
  local keep="$1" tags t pub ordered kept n f ref
  tags="$(fork_release_tags_in_mirror)"
  if [ -z "$tags" ]; then
    log "prune: no verified fork-release mirrors found"
    return 0
  fi
  ordered="$(for t in $tags; do
    pub="$(jq -r '.published_at // .created_at // empty' "$MIRROR_DIR/$t/MANIFEST.json" 2>/dev/null || echo "")"
    printf '%s\t%s\n' "${pub:-0000}" "$t"
  done | sort -r | cut -f2)"
  kept=" "
  n=0
  for t in $ordered; do
    n=$((n + 1))
    if [ "$n" -le "$keep" ]; then
      kept="$kept$t "
    fi
  done
  # Safety net: never prune a tag a kept release's scripts reference.
  # Chains are short; iterate to a fixed point.
  local pass changed
  for pass in 1 2 3 4 5; do
    changed=""
    for t in $kept; do
      [ -n "$t" ] || continue
      for f in "$MIRROR_DIR/$t"/assets/*.sh; do
        [ -f "$f" ] || continue
        for ref in $(script_referenced_tags "$f"); do
          case "$kept" in *" $ref "*) ;; *) kept="$kept$ref "; changed="$changed$ref " ;; esac
        done
      done
    done
    [ -z "$changed" ] && break
  done
  for t in $ordered; do
    case "$kept" in *" $t "*) continue ;; esac
    log "prune: removing $t (retention keep=$keep)"
    printf '%s pruned tag=%s manifest_sha256=%s rule="keep newest %s fork releases + referenced tags"\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$t" "$(sha_of "$MIRROR_DIR/$t/MANIFEST.json" 2>/dev/null || echo unknown)" "$keep" >> "$PRUNE_LOG"
    rm -rf "$MIRROR_DIR/$t"
  done
  log "prune: kept $(echo $kept | tr ' ' '\n' | sed '/^$/d' | tr '\n' ' ')"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo "== mirror-fork-release: $TAG from $REPO -> $MIRROR_DIR =="
# Clean staging leftovers from crashed runs older than a day.
find "$MIRROR_DIR" -maxdepth 1 -name '.staging-*' -mtime +0 -exec rm -rf {} + 2>/dev/null || true

mirror_release "$TAG" 0

if [ "$DO_PRUNE" = "true" ]; then
  prune_mirrors "$KEEP"
fi

log "done: $TAG verified (self_test=$DO_SELF_TEST); mirror at $MIRROR_DIR/$TAG"
echo "== OK: $TAG mirrored, verified, offline-resolvable =="
echo "   mirror dir : $MIRROR_DIR/$TAG"
echo "   marker     : $MIRROR_DIR/$TAG/.mirror-ok"
echo "   offline rollback (no GitHub): see $MIRROR_DIR/$TAG/ROLLBACK.md"
