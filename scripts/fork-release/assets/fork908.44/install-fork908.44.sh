#!/usr/bin/env bash
# Paperclip host upgrade -> 2026.908.1-fork.44 (MIGRATING cutover: DB journal 0240 -> 0249).
# REV r3-20260909
#   r2: adds the Node engines preflight (host-parity gate). The 2026-09-08
#   window installed this build on a Node 22 host: npm only WARNS about
#   engines.node (engine-strict=false), so the install completed and the
#   service crash-looped at boot. r2 reads the requirement from the PINNED
#   TARBALL and refuses (exit 1, nothing touched) before any stop/snapshot.
#   r3: (a) the pg-shutdown-guard fetch lost its single point of failure:
#   3 attempts with backoff per origin, then the byte-identical release asset
#   on this same tag as a second origin (every fetch is sha256-verified
#   against the pinned literal either way). (b) any PRE-FLIGHT abort — before
#   the service is stopped or a snapshot exists — now exits 10 and says the
#   host is untouched and NO rollback is needed or possible; it NEVER prints
#   a rollback command. Only aborts after the service stop name the rollback
#   (exit 1). The 2026-09-09 05:07Z window died at preflight on a transient
#   fetch blip and the old text told the operator to run the fork.43 rollback
#   — which could have restored the 03:04 nightly snapshot over a healthy DB.
#   (c) the host-tarball download retries transient curl failures too.
#
# Shipped as a release asset on v2026.908.1-fork.44 (claudegoogl-sudo fork).
# Operator one-liner (inside the CTO-scheduled window):
#   T=$(mktemp) && curl -fsSL https://github.com/claudegoogl-sudo/paperclip/releases/download/v2026.908.1-fork.44/install-fork908.44.sh -o "$T" && sudo bash "$T"
#
# Scope: npm -g swap of the sha-pinned host tarball + service restart + gates.
# THIS RANGE APPLIES MIGRATIONS (journal moves 0240 -> 0249), so a fail-loud,
# size-verified embedded-PG snapshot is REQUIRED before install and is the
# rollback record for the paired rollback-fork907.43.sh. The window lock
# (flock + epoch line-1) makes the pg-recover watchdog stand down for the
# whole window and guards against a double/overlapping paste.
#
# Gates, in order: root check -> window lock -> pg-shutdown-guard preflight
# (sha-pinned; fetched with retry from the commit-pinned primary and the
# same-tag release-asset mirror) -> download + sha256 (retried) -> NODE
# ENGINES PREFLIGHT (refuses on old Node) -> service stop + clean-shutdown
# gate -> REQUIRED PG snapshot (state probes, gzip -t, 80% size gate) ->
# npm install -g -> version gate -> payload sentinels (deferred-wake sweep
# fix + migration 0249 + fork hardening superset + socket-only embedded PG)
# -> service start -> health -> post-start version gate.
#
# Exit codes: 0 ok; 1 abort AFTER the host was touched (service stopped /
# snapshot territory) — the failure block names the rollback; 10 PRE-FLIGHT
# abort, host UNTOUCHED (service never stopped, no snapshot exists, nothing
# installed) — fix the cause and re-paste; NEVER run a rollback for exit 10.
set -euo pipefail

TARGET="2026.908.1-fork.44"
ROLLBACK_VER="2026.907.1-fork.43"
BASEURL="https://github.com/claudegoogl-sudo/paperclip/releases/download/v2026.908.1-fork.44"
URL="${BASEURL}/paperclipai-${TARGET}.tgz"
SHA="75842fd8a286473bdfa27432932fd52d2ef0281a481eb6d36807346189d49a68"
RB_URL="${BASEURL}/rollback-fork907.43.sh"

# --- paths (env-overridable ONLY so a verification harness can sandbox the
# --- exact operator script; a normal operator paste sets none of these) ------
BIN="${BIN:-/usr/bin/paperclipai}"
ROOT="${ROOT:-/usr/lib/node_modules/paperclipai/node_modules/@paperclipai}"
INST_DIR="${INST_DIR:-/home/paperclip/.paperclip/instances/default}"
DB_DIR="${DB_DIR:-${INST_DIR}/db}"
WINDOW_LOCK="${WINDOW_LOCK:-${INST_DIR}/pg-window.lock}"
SNAP_DIR="${SNAP_DIR:-/home/paperclip}"
SNAPSHOT="${SNAPSHOT:-${SNAP_DIR}/db-snapshot-pre-fork844-$(date +%Y%m%dT%H%M%S).tar.gz}"
API="${API:-http://127.0.0.1:3100/api}"
PGCTL="${PGCTL:-/usr/lib/node_modules/paperclipai/node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl}"
SERVICE_USER="${SERVICE_USER:-paperclip}"

SERVICE_STOPPED=0
LOCK_HELD=0
HOST_TOUCHED=0

# --- pre-flight abort: the host is UNTOUCHED (service never stopped, no
# --- snapshot exists, nothing installed). Exit 10 means: do NOT roll back —
# --- there is nothing to roll back. Never prints a rollback command.
die_preflight() {
  echo ""
  echo "RESULT: FAILURE — PRE-FLIGHT ABORT (host untouched): $1"
  echo "  Nothing was changed: paperclip.service was NOT stopped, NO snapshot exists,"
  echo "  NO package was installed. NO rollback is needed and NO rollback is possible."
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
  echo "Roll back to 2026.907.1-fork.43 (host + DB snapshot — the snapshot restore is REQUIRED for this migrating cutover):"
  echo "  T=\$(mktemp) && curl -fsSL ${RB_URL} -o \"\$T\" && sudo bash \"\$T\""
  exit 1
}

# --- cutover-window lock: exclusive flock for the whole run + epoch timestamp
# --- on line 1, so both watchdog generations (flock-aware and epoch-reading)
# --- stand down while the service is stopped. Removed on ANY exit via the
# --- EXIT trap (registered only after the flock is won).
window_lock() {
  mkdir -p "$(dirname "$WINDOW_LOCK")" || true
  ( umask 000; printf '%s\n%s\n' "$(date +%s)" "$(date -u +%Y-%m-%dT%H:%M:%SZ) fork.44 upgrade window (install)" > "$WINDOW_LOCK" ) 2>/dev/null \
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

# --- delete INVALID (truncated/partial) old pre-fork844 snapshots; valid ones
# --- are the rollback record and are kept.
rm_partial_snapshots() {
  local s
  for s in "$SNAP_DIR"/db-snapshot-pre-fork844-*.tar.gz; do
    [ -f "$s" ] || continue
    if ! gzip -t "$s" 2>/dev/null; then
      echo "   removing invalid partial snapshot: $s"
      rm -f "$s"
    fi
  done
  return 0
}

[ "$(id -u)" = "0" ] || fail "must run as root (use: sudo bash \$0)"

WORK="$(mktemp -d)"; trap 'window_unlock; rm -rf "$WORK"' EXIT
window_lock

echo "== Upgrade window: host ${TARGET} (script rev r3-20260909; MIGRATING: DB journal 0240 -> 0249) =="
echo "Live now: host $(${BIN} --version 2>/dev/null || echo unknown)"

echo "-- [0/5] pre-flight: pg-shutdown-guard (sha-pinned, dual-origin retry) + quiet-board + cluster-state probes --"
GUARD_SHA="3aadaa32509b376d446b70966acc4fb8d61aef8b11d0a4261285782893fd42ae"
# Primary: the commit-pinned copy the release was verified against. Mirror:
# the byte-identical pg-shutdown-guard.sh release asset on this same tag —
# it covers a raw.githubusercontent transport blip (the 2026-09-09 05:07Z
# window died on exactly that). Both overrides exist for sandbox/ops forcing
# only; a normal operator paste sets none of them.
GUARD_URL="${GUARD_URL:-https://raw.githubusercontent.com/claudegoogl-sudo/paperclip/46f26c5c69fc549393b5d6f2a692fe0b636064b7/scripts/pg-shutdown-guard.sh}"
GUARD_URL_FALLBACK="${GUARD_URL_FALLBACK:-${BASEURL}/pg-shutdown-guard.sh}"
export PG_GUARD_TOKEN_FILE="${PG_GUARD_TOKEN_FILE:-/home/paperclip/.paperclip/auth.json}"
fetch_guard "$WORK/pg-shutdown-guard.sh" \
  || die_preflight "could not fetch pg-shutdown-guard from ANY origin (3 attempts with backoff against the commit-pinned primary, then 3 against the same-tag release-asset mirror) — the clean-shutdown gate is mandatory. Fix outbound fetch (DNS / proxy / firewall) and re-paste."
bash "$WORK/pg-shutdown-guard.sh" active-runs \
  || die_preflight "heartbeat runs are queued/running (or the run check could not run) — drain the board and re-paste when quiet (override: sudo PG_GUARD_ALLOW_ACTIVE_RUNS=1 PG_GUARD_OVERRIDE_REASON=<reason> bash, only with a stated reason)"
bash "$WORK/pg-shutdown-guard.sh" state "$DB_DIR" >/dev/null \
  || die_preflight "pg-shutdown-guard cannot read cluster state (pg_controldata missing for embedded PG major $(cat "$DB_DIR/PG_VERSION" 2>/dev/null || echo '?')) — one-time root prep BEFORE the window: install the matching postgresql-<major> SERVER package and stage tools under /usr/local/share/paperclip-release-tools/pg-bin/<major>/bin (or export PG_GUARD_PGCONTROLDATA), then re-paste"

TGZ="${WORK}/paperclipai-${TARGET}.tgz"
echo "-- [1/5] download + sha256 gate (transient curl failures retried) --"
curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors "$URL" -o "$TGZ" \
  || die_preflight "host tarball download failed (after retries) — check outbound internet/DNS and re-paste"
echo "${SHA}  ${TGZ}" | sha256sum -c - || die_preflight "host tarball sha256 mismatch vs pinned literal ${SHA} — refusing to install (do NOT retry blindly; investigate the release first)"

# --- [1b/5] Node engines preflight (host-parity gate, r2) ---------------------
# Read the requirement from THE PINNED TARBALL (not a hardcoded literal) and
# refuse BEFORE the service is stopped, the snapshot is taken, or any package
# is touched. npm only WARNS on an engines miss (engine-strict=false), which is
# exactly how the 2026-09-08 window put an unbootable build on a Node 22 host.
# Fail closed on any unreadable or unsupported engines range.
NODE_BIN="$(command -v node 2>/dev/null || true)"
[ -n "$NODE_BIN" ] || die_preflight "node was not found on PATH — this release needs Node.js to run; nothing was stopped, snapshotted, or installed"
REQ="$(tar -xOzf "$TGZ" package/package.json 2>/dev/null | "$NODE_BIN" -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{process.stdout.write((JSON.parse(d).engines||{}).node||"")}catch(e){process.exit(3)}})' 2>/dev/null || true)"
if [ -z "$REQ" ]; then
  REQ="$(tar -xOzf "$TGZ" package/package.json 2>/dev/null | grep -o '"node"[[:space:]]*:[[:space:]]*"[^"]*"' 2>/dev/null | head -1 | sed 's/^.*:[[:space:]]*"//; s/"$//' || true)"
fi
[ -n "$REQ" ] || die_preflight "could not read engines.node from the pinned tarball's package.json — refusing (fail-closed); nothing was stopped, snapshotted, or installed"
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
  *) die_preflight "could not determine the installed Node.js version ('${INST}') — refusing (fail-closed); nothing was stopped, snapshotted, or installed" ;;
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
    echo "  Nothing was changed: the service was NOT stopped, NO snapshot was taken, NO package was installed."
    echo "  NO rollback is needed or possible — do NOT run any rollback script."
  }
  exit 10
fi
echo "-- node engines gate: required ${REQ}, installed ${INST} — OK --"

echo "-- [2/5] stopping paperclip.service + pg clean-shutdown gate --"
systemctl stop paperclip.service || die_preflight "could not stop paperclip.service (systemctl exit $?) — inspect: systemctl status paperclip.service; the service was left as it was and nothing else was changed. Fix and re-paste."
SERVICE_STOPPED=1
HOST_TOUCHED=1   # from here on the host has been changed; aborts name the rollback

if ! bash "$WORK/pg-shutdown-guard.sh" wait-clean "$DB_DIR" 10; then
  stop_orphan_postmaster \
    || fail "cluster still up after 10s and the orphan postmaster could not be stopped via pg_ctl — inspect ${DB_DIR}/postmaster.pid; do NOT npm install over a live cluster"
  bash "$WORK/pg-shutdown-guard.sh" wait-clean "$DB_DIR" 60 \
    || fail "embedded PG did not shut down cleanly (even after the orphan stop) — see the [pg-guard] REASON/REMEDY lines above; do NOT npm install over this cluster"
fi

echo "-- [3/5] pre-install snapshot of the embedded PG data dir (REQUIRED for rollback, fail-loud) --"
rm_partial_snapshots
SRC_BYTES="$(du -sb "$DB_DIR" | cut -f1)"
SNAPLOG="${SNAPSHOT}.log"; rm -f "$SNAPLOG"

echo "   [pre-tar] cluster state (must be shut down):"
SNAP_STATE="$(bash "$WORK/pg-shutdown-guard.sh" state "$DB_DIR" 2>/dev/null)" \
  || fail "pg-shutdown-guard cannot read cluster state (tooling problem — see the [pg-guard] lines above) — one-time root prep BEFORE the window (install postgresql-<major> SERVER package + stage tools), then re-paste"
case "$SNAP_STATE" in
  "shut down"|"shut down in recovery") echo "   pre-tar state: ${SNAP_STATE} (clean)" ;;
  *) fail "cluster NOT in a clean shut-down state BEFORE the snapshot (state: '${SNAP_STATE:-unreadable}') — a snapshot taken now would be inconsistent. Service is stopped; after this window's lock releases, the pg-recover watchdog restarts postgres within ~2 min on its own; then run: systemctl start paperclip.service" ;;
esac

RC=0
tar -C "$(dirname "$DB_DIR")" -czf "$SNAPSHOT" "$(basename "$DB_DIR")" 2>"$SNAPLOG" || RC=$?
if [ "$RC" != "0" ]; then
  echo "   tar FAILED — stderr tail (full copy: ${SNAPLOG}):"
  tail -n 20 "$SNAPLOG" 2>/dev/null | sed 's/^/     | /' || true
  rm -f "$SNAPSHOT"
  RACED=""
  for _ in 1 2 3 4 5 6; do
    SNAP_STATE="$(bash "$WORK/pg-shutdown-guard.sh" state "$DB_DIR" 2>/dev/null)" || SNAP_STATE=""
    case "$SNAP_STATE" in
      "in production"|"in crash recovery") RACED="$SNAP_STATE"; break ;;
    esac
    sleep 0.5
  done
  if [ -n "$RACED" ]; then
    echo "   [post-tar] cluster state (after failed tar): ${RACED}"
    fail "cluster changed during snapshot — a recovery watchdog or second process raced the window — the snapshot is NOT trustworthy for rollback — do NOT npm install. After this window's lock releases, the pg-recover watchdog restarts postgres within ~2 min on its own; then run: systemctl start paperclip.service (and reschedule the window with CTO)"
  fi
  fail "PG snapshot failed (tar exit ${RC}) — partial snapshot removed; aborting BEFORE npm install (service stopped; after this window's lock releases, the pg-recover watchdog restarts postgres within ~2 min on its own; then run: systemctl start paperclip.service)"
fi

echo "   [post-tar] cluster state (must STILL be shut down):"
SNAP_STATE="$(bash "$WORK/pg-shutdown-guard.sh" state "$DB_DIR" 2>/dev/null)" \
  || fail "pg-shutdown-guard cannot read cluster state after the tar (tooling problem) — the snapshot itself is fine but the window cannot prove the cluster stayed down — do NOT npm install"
case "$SNAP_STATE" in
  "shut down"|"shut down in recovery") echo "   post-tar state: ${SNAP_STATE} (clean)" ;;
  "in production"|"in crash recovery")
    fail "cluster changed during snapshot — a recovery watchdog or second process raced the window — the snapshot is NOT trustworthy for rollback — do NOT npm install. After this window's lock releases, the pg-recover watchdog restarts postgres within ~2 min on its own; then run: systemctl start paperclip.service (and reschedule the window with CTO)" ;;
  *)
    fail "cluster state AFTER the snapshot is '${SNAP_STATE:-unreadable}' — not a clean shut-down state — the snapshot is NOT trustworthy for rollback — do NOT npm install. After this window's lock releases, the pg-recover watchdog restarts postgres within ~2 min on its own; then run: systemctl start paperclip.service (and reschedule the window with CTO)" ;;
esac

if ! gzip -t "$SNAPSHOT" 2>>"$SNAPLOG"; then
  echo "   gzip integrity check FAILED — stderr tail (full copy: ${SNAPLOG}):"
  tail -n 20 "$SNAPLOG" 2>/dev/null | sed 's/^/     | /' || true
  rm -f "$SNAPSHOT"
  fail "PG snapshot failed the gzip -t integrity check — partial snapshot removed; aborting BEFORE npm install (service stopped; after this window's lock releases, the pg-recover watchdog restarts postgres within ~2 min on its own; then run: systemctl start paperclip.service)"
fi
UNC_BYTES="$(gzip -l "$SNAPSHOT" | awk 'NR==2{print $2}')"
MIN_BYTES=$(( SRC_BYTES * 80 / 100 ))
if [ "${UNC_BYTES:-0}" -lt "$MIN_BYTES" ]; then
  rm -f "$SNAPSHOT"
  fail "PG snapshot size gate failed: archive holds ${UNC_BYTES:-?}B uncompressed vs ${SRC_BYTES}B source (< 80%) — partial snapshot removed; aborting BEFORE npm install"
fi
echo "   snapshot OK: ${SNAPSHOT}"
echo "   size: $(du -h "$SNAPSHOT" | cut -f1) compressed  entries: $(tar tzf "$SNAPSHOT" | wc -l)  sha256: $(sha256sum "$SNAPSHOT" | cut -d' ' -f1)"
echo "   uncompressed ${UNC_BYTES}B vs ${SRC_BYTES}B source — >= 80%"

echo "-- [4/5] npm install -g + version + payload gates --"
npm install -g "$TGZ" || fail "npm install -g failed"

GOT="$(${BIN} --version 2>/dev/null || true)"
[ "$GOT" = "$TARGET" ] || fail "installed version is '${GOT}', expected '${TARGET}'"

echo "-- payload gate: deferred-wake sweep + migration 0249 + attachment-bind + patched acpx + bundled embedded-postgres + socket hardening + fork hardening superset --"
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
echo "   deferred-wake sweep + migration 0249 + attachment-bind + patched acpx + bundled embedded-postgres + socket hardening + fork hardening superset confirmed"

echo "-- starting service + health (final gates) --"
systemctl start paperclip.service || fail "service start failed — run the rollback one-liner above"
SERVICE_STOPPED=0
sleep 6
curl -fsS "${API}/health" >/dev/null 2>&1 || fail "health check failed after start (service may still be booting; re-run: curl -sS ${API}/health, and if unhealthy use the rollback one-liner above)"

GOT="$(${BIN} --version 2>/dev/null || true)"
[ "$GOT" = "$TARGET" ] || fail "post-start version is '${GOT}', expected '${TARGET}'"

echo ""
echo "RESULT: OK — host ${TARGET} installed and healthy (DB journal migrated 0240 -> 0249; snapshot: ${SNAPSHOT})."
echo "Rollback (ONLY if something is broken afterwards) — restores host AND the pre-fork844 DB snapshot:"
echo "  T=\$(mktemp) && curl -fsSL ${RB_URL} -o \"\$T\" && sudo bash \"\$T\""
