#!/usr/bin/env bash
# Paperclip host upgrade -> 2026.916.1-fork.48 (MIGRATION-FREE cutover; DB journal stays at 0249).
# REV r1-20260916
#   Lineage: fork.47 r1 script (same migration-free shape, byte-identical gates) (Node engines preflight r2; dual-origin retried
#   pg-shutdown-guard fetch + exit-10 preflight-class aborts r3), unchanged shape
#   because the fork.47 -> fork.48 range carries ZERO db migrations (journal 0249
#   on both sides). Migration-free => binary-only rollback is safe: the paired
#   rollback-fork913.47.sh swaps the host package back and does NOT touch the
#   data dir.
#   This train ships (master 7880de9e0, fork PR #342): ONE shared object-key
#   guard for storage reads and writes — uploads whose stored filename carries a
#   dot-dot run (e.g. 'ProPrj_driver_v2_mirco_OP_edit..epro') were accepted by
#   the write path but refused by the read guard, so every content read 400'd
#   (PLA-6961/COP-471). server/src/storage/object-key.ts is now the single
#   source of truth (isObjectKeyReadable / assertObjectKeyReadable) used by
#   buildObjectKey (write) and ensureCompanyPrefix (read). The range also
#   carries PR #341 (62f0b8c0a + aeda7763c: zip/csv/tsv plugin artifacts with
#   download-only spreadsheet serving + KiCad pcb/schematic mimes), PR #339
#   (12a6ef0ea: plugin-backed mcp_remote health vs the plugin runtime), #340
#   (CI-only smoke seed fix) and #338 (cross-issue contextless-run naming).
#   LIVE host is fork.47 (v2026.913.1-fork.47, installed 2026-09-15 18:58Z); rollback rolls to it.
#   installed — this train SUPERSEDES the fork.46 install ask.
#
# Shipped as a release asset on v2026.916.1-fork.48 (claudegoogl-sudo fork).
# Operator one-liner (inside the CTO-scheduled window):
#   T=$(mktemp) && curl -fsSL https://github.com/claudegoogl-sudo/paperclip/releases/download/v2026.916.1-fork.48/install-fork916.48.sh -o "$T" && sudo bash "$T"
#
# Scope: npm -g swap of the sha-pinned host tarball + service restart + gates.
# NO migrations in this range, so NO DB snapshot is involved; the window lock
# (flock + epoch line-1) still makes the pg-recover watchdog stand down for the
# whole window and guards against a double/overlapping paste.
#
# Gates, in order: root check -> window lock -> pg-shutdown-guard preflight
# (sha-pinned; fetched with retry from the commit-pinned primary and the
# same-tag release-asset mirror) -> quiet-board + cluster-state probes ->
# download + sha256 (retried) -> NODE ENGINES PREFLIGHT (refuses on old Node)
# -> service stop + clean-shutdown gate -> npm install -g -> version gate ->
# payload sentinels (probe keyed by pluginKey + storage object-key guard + zip/csv/tsv + KiCad
# mimes + download-only spreadsheet serving + D2 plugin-health sweep +
# cross-issue contextless-run fix + liveness probe + deferred-wake sweep +
# migration 0249 dist + attachment-bind + patched acpx + bundled
# embedded-postgres + socket-only embedded PG + fork hardening superset)
# -> service start -> health -> post-start version gate.
#
# Exit codes: 0 ok; 1 abort AFTER the host was touched (service stopped) —
# the failure block names the rollback; 10 PRE-FLIGHT abort, host UNTOUCHED
# (service never stopped, nothing installed) — fix the cause and re-paste;
# NEVER run a rollback for exit 10.
set -euo pipefail

TARGET="2026.916.1-fork.48"
ROLLBACK_VER="2026.911.1-fork.45"
BASEURL="https://github.com/claudegoogl-sudo/paperclip/releases/download/v2026.916.1-fork.48"
URL="${BASEURL}/paperclipai-${TARGET}.tgz"
SHA="517095cf4ed134ac610b68057ab2a75eeb78a5f235d1c924bd3631f53ca27942"
RB_URL="${BASEURL}/rollback-fork913.47.sh"

# --- paths (env-overridable ONLY so a verification harness can sandbox the
# --- exact operator script; a normal operator paste sets none of these) ------
BIN="${BIN:-/usr/bin/paperclipai}"
ROOT="${ROOT:-/usr/lib/node_modules/paperclipai/node_modules/@paperclipai}"
INST_DIR="${INST_DIR:-/home/paperclip/.paperclip/instances/default}"
DB_DIR="${DB_DIR:-${INST_DIR}/db}"
WINDOW_LOCK="${WINDOW_LOCK:-${INST_DIR}/pg-window.lock}"
API="${API:-http://127.0.0.1:3100/api}"
PGCTL="${PGCTL:-/usr/lib/node_modules/paperclipai/node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl}"
SERVICE_USER="${SERVICE_USER:-paperclip}"

SERVICE_STOPPED=0
LOCK_HELD=0
HOST_TOUCHED=0
# Migration-free train: NO snapshot machinery exists. This line is the
# fork-release-gate-probe var-range terminator (runbook §7) and must remain
# the last line of the header var block.
SNAPSHOT=""

# --- pre-flight abort: the host is UNTOUCHED (service never stopped, no
# --- snapshot exists, nothing installed). Exit 10 means: do NOT roll back —
# --- there is nothing to roll back. Never prints a rollback command.
die_preflight() {
  echo ""
  echo "RESULT: FAILURE — PRE-FLIGHT ABORT (host untouched): $1"
  echo "  Nothing was changed: paperclip.service was NOT stopped, NO package was"
  echo "  installed. NO rollback is needed and NO rollback is possible."
  echo "  Do NOT run any rollback script. Fix the cause named above, then re-paste this"
  echo "  install one-liner."
  exit 10
}

# --- sha-pinned dual-origin fetch for the pg-shutdown-guard ------------------
# 3 attempts per origin with linear backoff. A sha mismatch counts as an
# origin failure (logged loudly) and the next origin is tried; only a
# byte-identical guard ever executes — the pin is absolute.
fetch_guard() {
  local dst="$1" origin rc attempt
  for origin in "$GUARD_URL" "$GUARD_URL_FALLBACK"; do
    [ -n "$origin" ] || continue
    for attempt in 1 2 3; do
      rm -f "$dst"
      if curl -fsSL --connect-timeout 10 --max-time 60 "$origin" -o "$dst"; then
        if echo "${GUARD_SHA}  ${dst}" | sha256sum -c - >/dev/null 2>&1; then
          echo "   pg-shutdown-guard fetched + sha256-verified from: ${origin} (attempt ${attempt}/3)"
          return 0
        fi
        echo "   WARNING: guard bytes from ${origin} do NOT match the pinned sha (attempt ${attempt}/3) — treating this origin as failed"
      else
        rc=$?
        echo "   guard fetch attempt ${attempt}/3 failed from ${origin} (curl exit ${rc})"
      fi
      if [ "$attempt" -lt 3 ]; then
        echo "   retrying in $((attempt * 2))s ..."
        sleep $((attempt * 2))
      fi
    done
    echo "   origin exhausted: ${origin}"
  done
  return 1
}

fail() {
  if [ "$HOST_TOUCHED" != "1" ]; then
    die_preflight "$1"
  fi
  echo ""
  echo "RESULT: FAILURE — $1"
  if [ "$SERVICE_STOPPED" = "1" ]; then
    echo "-- abort path: restarting paperclip.service (best effort) --"
    systemctl start paperclip.service || true
    echo "   verify with: systemctl status paperclip.service (and curl -sS ${API}/health)"
  fi
  echo "Roll back to ${ROLLBACK_VER} (binary-only; DB untouched — this range ships no migrations):"
  echo "  T=\$(mktemp) && curl -fsSL ${RB_URL} -o \"\$T\" && sudo bash \"\$T\""
  exit 1
}

# --- cutover-window lock: exclusive flock for the whole run + epoch timestamp
# --- on line 1, so both watchdog generations (flock-aware and epoch-reading)
# --- stand down while the service is stopped. Removed on ANY exit via the
# --- EXIT trap (registered only after the flock is won).
window_lock() {
  mkdir -p "$(dirname "$WINDOW_LOCK")" || true
  ( umask 000; printf '%s\n%s\n' "$(date +%s)" "$(date -u +%Y-%m-%dT%H:%M:%SZ) fork.48 upgrade window (install)" > "$WINDOW_LOCK" ) 2>/dev/null \
    || die_preflight "cannot write the window lock ${WINDOW_LOCK} — nothing was stopped or installed; fix the permissions and re-paste"
  chmod 0666 "$WINDOW_LOCK" 2>/dev/null || true
  if ! { exec 9>>"$WINDOW_LOCK"; } 2>/dev/null; then
    die_preflight "cannot open the window lock ${WINDOW_LOCK} — nothing was stopped or installed"
  fi
  if ! flock -n 9 2>/dev/null; then
    HOLDER="$( exec 9>&- 2>/dev/null || true; fuser "$WINDOW_LOCK" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | grep -v "^$$\$" | sort -u | paste -sd, - || true )"
    {
      echo ""
      echo "RESULT: FAILURE — PRE-FLIGHT ABORT (host untouched): another cutover window is in progress (exclusive flock held on ${WINDOW_LOCK}${HOLDER:+ by pid(s): ${HOLDER}})"
      echo "No action was taken: the service was NOT stopped, nothing was installed. NO rollback is needed or possible."
      echo "If no window is actually running, the holder is a crashed window process — its lock releases when that process exits (kernel flock). Inspect: fuser -v ${WINDOW_LOCK} ; pgrep -af 'install-fork|rollback-fork'"
    } >&2
    exit 10
  fi
  LOCK_HELD=1
  echo "-- window lock taken: $WINDOW_LOCK (epoch line-1 + exclusive flock) --"
}
window_unlock() { [ "${LOCK_HELD:-0}" = "1" ] && rm -f "$WINDOW_LOCK" || true; }

# --- abort-class orphan: a postmaster outside paperclip.service's cgroup
# --- (watchdog-spawned, ppid=1) survives `systemctl stop`. Stop it explicitly
# --- as the service user with pg_ctl -m fast (clean shutdown) so the
# --- clean-shutdown gate can pass.
stop_orphan_postmaster() {
  local pgctl="$PGCTL"
  if [ ! -x "$pgctl" ]; then
    pgctl="$(ls /usr/local/share/paperclip-release-tools/pg-bin/*/bin/pg_ctl 2>/dev/null | sort -V | tail -1 || true)"
  fi
  if [ -z "$pgctl" ] || [ ! -x "$pgctl" ]; then
    echo "   no usable pg_ctl found (tried \$PGCTL and /usr/local/share/paperclip-release-tools/pg-bin/*/bin/pg_ctl)"
    return 1
  fi
  echo "-- stopping orphan postmaster (outside the service cgroup) via: $pgctl -D $DB_DIR stop -m fast -w (as $SERVICE_USER) --"
  su "$SERVICE_USER" -c "$pgctl -D $DB_DIR stop -m fast -w" || return 1
}

[ "$(id -u)" = "0" ] || fail "must run as root (use: sudo bash \$0)"

WORK="$(mktemp -d)"; trap 'window_unlock; rm -rf "$WORK"' EXIT
window_lock

echo "== Upgrade window: host ${TARGET} (script rev r1-20260916; MIGRATION-FREE: DB journal unchanged) =="
echo "Live now: host $(${BIN} --version 2>/dev/null || echo unknown)"

echo "-- [0/4] pre-flight: pg-shutdown-guard (sha-pinned, dual-origin retry) + quiet-board + cluster-state probes --"
GUARD_SHA="3aadaa32509b376d446b70966acc4fb8d61aef8b11d0a4261285782893fd42ae"
# Primary: the commit-pinned copy at the release commit (7880de9e0, the storage object-key fix). Mirror:
# the byte-identical pg-shutdown-guard.sh release asset on this same tag —
# it covers a raw.githubusercontent transport blip (the 2026-09-09 05:07Z
# window died on exactly that). Both overrides exist for sandbox/ops forcing
# only; a normal operator paste sets none of them.
GUARD_URL="${GUARD_URL:-https://raw.githubusercontent.com/claudegoogl-sudo/paperclip/1b844374e8644751f0fb600df28bff3d09e0eae2/scripts/pg-shutdown-guard.sh}"
GUARD_URL_FALLBACK="${GUARD_URL_FALLBACK:-${BASEURL}/pg-shutdown-guard.sh}"
export PG_GUARD_TOKEN_FILE="${PG_GUARD_TOKEN_FILE:-/home/paperclip/.paperclip/auth.json}"
fetch_guard "$WORK/pg-shutdown-guard.sh" \
  || die_preflight "could not fetch pg-shutdown-guard from ANY origin (3 attempts with backoff against the commit-pinned primary, then 3 against the same-tag release-asset mirror) — the clean-shutdown gate is mandatory. Fix outbound fetch (DNS / proxy / firewall) and re-paste."
bash "$WORK/pg-shutdown-guard.sh" active-runs \
  || die_preflight "heartbeat runs are queued/running (or the run check could not run) — drain the board and re-paste when quiet (override: sudo PG_GUARD_ALLOW_ACTIVE_RUNS=1 PG_GUARD_OVERRIDE_REASON=<reason> bash, only with a stated reason)"
bash "$WORK/pg-shutdown-guard.sh" state "$DB_DIR" >/dev/null \
  || die_preflight "pg-shutdown-guard cannot read cluster state (pg_controldata missing for embedded PG major $(cat "$DB_DIR/PG_VERSION" 2>/dev/null || echo '?')) — one-time root prep BEFORE the window: install the matching postgresql-<major> SERVER package and stage tools under /usr/local/share/paperclip-release-tools/pg-bin/<major>/bin (or export PG_GUARD_PGCONTROLDATA), then re-paste"

TGZ="${WORK}/paperclipai-${TARGET}.tgz"
echo "-- [1/4] download + sha256 gate (transient curl failures retried) --"
curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors "$URL" -o "$TGZ" \
  || die_preflight "host tarball download failed (after retries) — check outbound internet/DNS and re-paste"
echo "${SHA}  ${TGZ}" | sha256sum -c - || die_preflight "host tarball sha256 mismatch vs pinned literal ${SHA} — refusing to install (do NOT retry blindly; investigate the release first)"

# --- [1b/5] Node engines preflight (host-parity gate, r2) ---------------------
# Read the requirement from THE PINNED TARBALL (not a hardcoded literal) and
# refuse BEFORE the service is stopped or any package is touched. npm only WARNS on an engines miss (engine-strict=false), which is
# exactly how the 2026-09-08 window put an unbootable build on a Node 22 host.
# Fail closed on any unreadable or unsupported engines range.
NODE_BIN="$(command -v node 2>/dev/null || true)"
[ -n "$NODE_BIN" ] || die_preflight "node was not found on PATH — this release needs Node.js to run; nothing was stopped or installed"
REQ="$(tar -xOzf "$TGZ" package/package.json 2>/dev/null | "$NODE_BIN" -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{process.stdout.write((JSON.parse(d).engines||{}).node||"")}catch(e){process.exit(3)}})' 2>/dev/null || true)"
if [ -z "$REQ" ]; then
  REQ="$(tar -xOzf "$TGZ" package/package.json 2>/dev/null | grep -o '"node"[[:space:]]*:[[:space:]]*"[^"]*"' 2>/dev/null | head -1 | sed 's/^.*:[[:space:]]*"//; s/"$//' || true)"
fi
[ -n "$REQ" ] || die_preflight "could not read engines.node from the pinned tarball's package.json — refusing (fail-closed); nothing was stopped or installed"
REQ_N="$(printf '%s' "$REQ" | tr -d ' ')"
case "$REQ_N" in
  ">="*) REQ_V="${REQ_N#>=}" ;;
  *) die_preflight "tarball engines.node is '${REQ}' — this preflight only auto-checks simple '>=X.Y.Z' ranges; refusing (fail-closed) — verify the requirement manually before installing" ;;
esac
printf '%s' "$REQ_V" | grep -Eq '^[0-9]+(\.[0-9]+){0,2}$' \
  || die_preflight "tarball engines.node is '${REQ}' — not a simple '>=X.Y.Z' range; refusing (fail-closed) — verify the requirement manually before installing"
IFS='.' read -r RMAJ RMIN RPAT <<< "$REQ_V"
RMIN="${RMIN:-0}"; RPAT="${RPAT:-0}"
INST="$("$NODE_BIN" --version 2>/dev/null || true)"
case "$INST" in
  v[0-9]*) : ;;
  *) die_preflight "could not determine the installed Node.js version ('${INST}') — refusing (fail-closed); nothing was stopped or installed" ;;
esac
IFS='.' read -r IMAJ IMIN IPAT <<< "${INST#v}"
if [ "$IMAJ" -lt "$RMAJ" ] \
   || { [ "$IMAJ" -eq "$RMAJ" ] && [ "${IMIN:-0}" -lt "$RMIN" ]; } \
   || { [ "$IMAJ" -eq "$RMAJ" ] && [ "${IMIN:-0}" -eq "$RMIN" ] && [ "${IPAT:-0}" -lt "$RPAT" ]; }; then
  {
    echo ""
    echo "RESULT: FAILURE — Node.js too old for ${TARGET}"
    echo "  required : Node.js ${REQ}  (read from the pinned tarball's package.json engines)"
    echo "  installed: Node.js ${INST}  (${NODE_BIN})"
    echo "  This release needs Node >= ${REQ_V}. npm only WARNS about this mismatch, so the install"
    echo "  would complete and the service would crash-loop at boot (as on 2026-09-08)."
    echo "  Upgrade Node first (e.g. Node 24 LTS via the NodeSource deb setup), verify with"
    echo "  'node --version', then re-paste this install one-liner."
    echo "  Nothing was changed: the service was NOT stopped, NO package was installed."
    echo "  NO rollback is needed or possible — do NOT run any rollback script."
  }
  exit 10
fi
echo "-- node engines gate: required ${REQ}, installed ${INST} — OK --"

echo "-- [2/4] stopping paperclip.service + pg clean-shutdown gate --"
systemctl stop paperclip.service || die_preflight "could not stop paperclip.service (systemctl exit $?) — inspect: systemctl status paperclip.service; the service was left as it was and nothing else was changed. Fix and re-paste."
SERVICE_STOPPED=1
HOST_TOUCHED=1   # from here on the host has been changed; aborts name the rollback

if ! bash "$WORK/pg-shutdown-guard.sh" wait-clean "$DB_DIR" 10; then
  stop_orphan_postmaster \
    || fail "cluster still up after 10s and the orphan postmaster could not be stopped via pg_ctl — inspect ${DB_DIR}/postmaster.pid; do NOT npm install over a live cluster"
  bash "$WORK/pg-shutdown-guard.sh" wait-clean "$DB_DIR" 60 \
    || fail "embedded PG did not shut down cleanly (even after the orphan stop) — see the [pg-guard] REASON/REMEDY lines above; do NOT npm install over this cluster"
fi

echo "-- [3/4] npm install -g + version + payload gates --"
npm install -g "$TGZ" || fail "npm install -g failed"

GOT="$(${BIN} --version 2>/dev/null || true)"
[ "$GOT" = "$TARGET" ] || fail "installed version is '${GOT}', expected '${TARGET}'"

echo "-- payload gate: storage object-key guard + zip/csv/tsv + KiCad mimes + spreadsheet download-only + cross-issue contextless-run fix + liveness probe + deferred-wake sweep + migration 0249 dist + attachment-bind + patched acpx + bundled embedded-postgres + socket hardening + fork hardening superset --"
ISS="${ROOT}/server/dist/services/issues.js"
[ -f "$ISS" ] || fail "installed server missing dist/services/issues.js — wrong build"
grep -q 'issue_attachments_asset_uq' "$ISS" || fail "server missing the upload-first attachment-bind fix (conflict-aware bind) — wrong build"
grep -q 'issueCommentId IS NULL' "$ISS" || fail "server missing the unbound-attachment bind path — wrong build"

HB="${ROOT}/server/dist/services/heartbeat.js"
[ -f "$HB" ] || fail "installed server missing dist/services/heartbeat.js — wrong build"
grep -q 'sweepStrandedDeferredWakes' "$HB" || fail "server missing the stranded deferred-wake sweep (the deferred-wake fix this train ships) — wrong build"

MIG="${ROOT}/db/dist/migrations/0249_board_api_key_auth_events.sql"
[ -f "$MIG" ] || fail "db dist missing migration 0249_board_api_key_auth_events.sql — the journal will NOT reach 0249 on this cutover; refusing"

ACPX_DIR="${ROOT}/adapter-acpx-local/node_modules/acpx"
[ -d "$ACPX_DIR" ] || fail "adapter-acpx-local ships WITHOUT bundled acpx — pristine-registry regression (persisted-key crash class); do not start on this build"
ACPX_OK=0
for f in "$ACPX_DIR"/dist/live-checkpoint-*.js; do
  [ -f "$f" ] || continue
  if grep -qF 'acpx.session_options.env' "$f" 2>/dev/null; then ACPX_OK=1; break; fi
done
[ "$ACPX_OK" = "1" ] || fail "bundled acpx missing the acpx.session_options.env persisted-key-policy exemption (pristine registry copy?)"

EP_DIR="${ROOT}/db/node_modules/embedded-postgres"
[ -d "$EP_DIR" ] || fail "db ships WITHOUT bundled embedded-postgres — bundle contract dropped"
grep -qF 'LC_MESSAGES_LOCALE' "${EP_DIR}/dist/index.js" 2>/dev/null || fail "bundled embedded-postgres missing the LC_MESSAGES_LOCALE patch marker (pristine registry copy?)"

EPA="${ROOT}/db/dist/embedded-postgres-auth.js"
[ -f "$EPA" ] || fail "installed db missing dist/embedded-postgres-auth.js — wrong build"
grep -qF 'paperclip-pg-' "$EPA" || fail "db dist missing paperclip-pg- socket-dir prefix — socket-only hardening not in this build"
grep -qF 'unix_socket_permissions=0700' "$EPA" || fail "db dist missing unix_socket_permissions=0700 — socket-only hardening not in this build"

grep -q 'adapterConfigReferencesSecrets' "${ROOT}/server/dist/services/agent-secret-bindings.js" 2>/dev/null || fail "missing adapterConfigReferencesSecrets (fork hardening superset)"
grep -q 'TRANSIENT_RETRY_NOT_BEFORE_MAX_DELAY_MS' "$HB" 2>/dev/null || fail "missing TRANSIENT_RETRY_NOT_BEFORE_MAX_DELAY_MS (reset-time retry cap)"
grep -q 'KNOWN_CONTEXT_INJECTION_KEYS' "${ROOT}/server/dist/routes/agents.js" 2>/dev/null || fail "missing KNOWN_CONTEXT_INJECTION_KEYS (context-injection guard)"
grep -q 'requireBoardActorSource' "${ROOT}/server/dist/services/actor-source.js" 2>/dev/null || fail "missing requireBoardActorSource (actor-source)"
# --- fork.45 regression guards (previous-train fixes must not regress) -------
CIL="${ROOT}/server/dist/services/cross-issue-influence-limit.js"
[ -f "$CIL" ] || fail "installed server missing dist/services/cross-issue-influence-limit.js — wrong build"
grep -q 'contextlessRun' "$CIL" || fail "server missing the contextless-run exemption (the cross-issue influence fix this train ships, master 093f5c3d1) — wrong build"
grep -q 'livenessProbe' "${ROOT}/server/dist/routes/agents.js" 2>/dev/null || fail "missing liveness-probe marker (reaper-safe run GET probe, master 29fe40513) — wrong build"
# --- fork.46 train sentinels (this train's reason to exist: D2, master 12a6ef0ea) ---
TA="${ROOT}/server/dist/services/tool-access.js"
[ -f "$TA" ] || fail "installed server missing dist/services/tool-access.js — wrong build"
grep -q 'pluginToolRuntimeProbe' "$TA" || fail "server missing the plugin-backed connection runtime probe (the D2 health fix this train ships, PR #339) — wrong build"
grep -q 'mcp_remote_plugin_unconfigured' "$TA" || fail "server missing the truthful mcp_remote_plugin_unconfigured health code (PR #339) — wrong build"
grep -q 'pluginToolDispatcher' "${ROOT}/server/dist/app.js" 2>/dev/null || fail "missing pluginToolDispatcher wiring (createApp exposes the plugin runtime for health probes, PR #339) — wrong build"

# --- fork.47 train sentinels (this train's reason to exist) ------------------
# PR #342 (master 7880de9e0): one shared object-key guard for storage reads+writes.
OKM="${ROOT}/server/dist/storage/object-key.js"
[ -f "$OKM" ] || fail "installed server missing dist/storage/object-key.js (the shared object-key guard module, PR #342) — wrong build"
grep -q 'assertObjectKeyReadable' "$OKM" || fail "server missing assertObjectKeyReadable in the shared object-key guard (PR #342, master 7880de9e0) — wrong build"
grep -q 'isObjectKeyReadable' "$OKM" || fail "server missing isObjectKeyReadable in the shared object-key guard (PR #342, master 7880de9e0) — wrong build"
SVS="${ROOT}/server/dist/storage/service.js"
[ -f "$SVS" ] || fail "installed server missing dist/storage/service.js — wrong build"
grep -q 'assertObjectKeyReadable' "$SVS" || fail "storage service missing the shared object-key guard call (read+write paths, PR #342) — wrong build"
grep -q 'ensureCompanyPrefix' "$SVS" || fail "storage service missing ensureCompanyPrefix (the PR #342 guard call site) — wrong build"
# PR #341 (master 62f0b8c0a + aeda7763c): zip/csv/tsv plugin artifacts + KiCad mimes
# + download-only spreadsheet serving. tsv/kicad/bait-gate are NEW literals (fork.46
# dist provably lacks them); zip/csv were already listed upstream — kept as AC sentinels.
ATY="${ROOT}/server/dist/attachment-types.js"
[ -f "$ATY" ] || fail "installed server missing dist/attachment-types.js — wrong build"
grep -q 'text/tab-separated-values' "$ATY" || fail "attachment types missing the admitted .tsv mime text/tab-separated-values (PR #341, master 62f0b8c0a) — wrong build"
grep -q 'application/zip' "$ATY" || fail "attachment types missing the admitted application/zip plugin-artifact mime (PR #341) — wrong build"
grep -q 'text/csv' "$ATY" || fail "attachment types missing text/csv (PR #341) — wrong build"
grep -q 'application/x-kicad-pcb' "$ATY" || fail "attachment types missing application/x-kicad-pcb (PR #341, master aeda7763c) — wrong build"
grep -q 'application/x-kicad-schematic' "$ATY" || fail "attachment types missing application/x-kicad-schematic (PR #341, master aeda7763c) — wrong build"
grep -q 'isSpreadsheetBaitPluginArtifact' "$ATY" || fail "attachment types missing the spreadsheet-bait gate helper (PR #341) — wrong build"
ASR="${ROOT}/server/dist/routes/assets.js"
[ -f "$ASR" ] || fail "installed server missing dist/routes/assets.js — wrong build"
grep -q 'isSpreadsheetBaitPluginArtifact' "$ASR" || fail "assets route missing the download-only spreadsheet serving gate (PR #341) — wrong build"

# --- fork.48 train sentinels (this train's reason to exist) ------------------
# PR #343 (master 1b844374e): key the plugin tool-runtime health probe by
# pluginKey, not DB uuid. The registry's byPlugin map is keyed by pluginKey, so
# the uuid-keyed probe ALWAYS missed -> toolCount 0 -> fail-closed 502
# mcp_remote_plugin_unavailable for EVERY plugin (0/14 configured healthy).
# Red-side proven on the live fork.47 dist: uuid shape present, this literal absent.
grep -q 'pluginKey: plugin.pluginKey' "$TA" || fail "server missing the pluginKey-keyed probe call site (PR #343, master 1b844374e) - wrong build"

echo "   pluginKey-keyed health probe + object-key guard (read+write) + zip/csv/tsv + KiCad mimes + download-only spreadsheet serving + D2 plugin-health sweep + cross-issue fix + liveness probe + deferred-wake sweep + migration 0249 + attachment-bind + patched acpx + bundled embedded-postgres + socket hardening + fork hardening superset confirmed"

echo "-- starting service + health (final gates) --"
systemctl start paperclip.service || fail "service start failed — run the rollback one-liner above"
SERVICE_STOPPED=0
sleep 6
curl -fsS "${API}/health" >/dev/null 2>&1 || fail "health check failed after start (service may still be booting; re-run: curl -sS ${API}/health, and if unhealthy use the rollback one-liner above)"

GOT="$(${BIN} --version 2>/dev/null || true)"
[ "$GOT" = "$TARGET" ] || fail "post-start version is '${GOT}', expected '${TARGET}'"

echo ""
echo "RESULT: OK — host ${TARGET} installed and healthy (migration-free; DB journal unchanged at 0249)."
echo "Rollback (ONLY if something is broken afterwards) — binary-only host swap, DB untouched:"
echo "  T=\$(mktemp) && curl -fsSL ${RB_URL} -o \"\$T\" && sudo bash \"\$T\""
