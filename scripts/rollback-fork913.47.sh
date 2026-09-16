#!/usr/bin/env bash
# Paperclip host ROLLBACK: 2026.916.1-fork.48 -> 2026.913.1-fork.47 (binary-only).
#
# Shipped as a release asset on v2026.916.1-fork.48 (claudegoogl-sudo fork).
# Run ONLY if the fork.48 upgrade left the host broken:
#   T=$(mktemp) && curl -fsSL https://github.com/claudegoogl-sudo/paperclip/releases/download/v2026.916.1-fork.48/rollback-fork913.47.sh -o "$T" && sudo bash "$T"
#
# Migration-free both ways: the fork.47 <-> fork.48 range carries ZERO db
# migrations (journal 0249 on both sides — fork.47 installed on 0249 and
# fork.48 adds none), so a binary-only rollback is safe — the CURRENT
# data dir is kept untouched (restoring an old snapshot would only drop
# legitimate writes). The target tarball URL + sha256 below were resolved and
# byte-verified against the LIVE fork.47 release SHA256SUMS.txt at authoring
# time (2026-09-16; fork.47 is the live host version)
# so this rolls back to exactly what runs today).
# Same shape as the fork.47 rollback (rollback-fork911.45.sh): the
# pg-shutdown-guard preflight (sha-pinned, dual-origin retried fetch) runs
# BEFORE the service is stopped, and the clean-shutdown gate (with the
# orphan-postmaster stop) gates the swap.
# REV r1-20260916
set -euo pipefail

TARGET="2026.913.1-fork.47"        # what we restore
NEW_TARGET="2026.916.1-fork.48"    # what the forward window installed
BASEURL="https://github.com/claudegoogl-sudo/paperclip/releases/download/v2026.913.1-fork.47"
URL="${BASEURL}/paperclipai-${TARGET}.tgz"
SHA="75cd24d10081713ac5aaa88b89df01ab7bd6cb6c8314dd62c6279942367e3bac"
RB_REV="r1-20260916"

BIN="${BIN:-/usr/bin/paperclipai}"
INST_DIR="${INST_DIR:-/home/paperclip/.paperclip/instances/default}"
DB_DIR="${DB_DIR:-${INST_DIR}/db}"
WINDOW_LOCK="${WINDOW_LOCK:-${INST_DIR}/pg-window.lock}"
API="${API:-http://127.0.0.1:3100/api}"
PGCTL="${PGCTL:-/usr/lib/node_modules/paperclipai/node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl}"
SERVICE_USER="${SERVICE_USER:-paperclip}"

SERVICE_STOPPED=0
LOCK_HELD=0

fail() {
  echo "ROLLBACK FAILED — $1"
  if [ "${SERVICE_STOPPED:-0}" = "1" ]; then
    echo "-- abort path: restarting paperclip.service (best effort) --"
    systemctl start paperclip.service || true
    echo "   verify with: systemctl status paperclip.service (and curl -sS ${API}/health)"
  fi
  exit 1
}

# --- sha-pinned dual-origin fetch for the pg-shutdown-guard (same contract as
# --- the install script: 3 attempts per origin, sha mismatch = origin failure).
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

# --- window lock definitions MUST precede the first call under set -e ---
window_lock() {
  mkdir -p "$(dirname "$WINDOW_LOCK")" || true
  ( umask 000; printf '%s\n%s\n' "$(date +%s)" "$(date -u +%Y-%m-%dT%H:%M:%SZ) fork.47 rollback window" > "$WINDOW_LOCK" ) 2>/dev/null \
    || fail "cannot write the window lock ${WINDOW_LOCK} — nothing was stopped or restored"
  chmod 0666 "$WINDOW_LOCK" 2>/dev/null || true
  if ! { exec 9>>"$WINDOW_LOCK"; } 2>/dev/null; then
    fail "cannot open the window lock ${WINDOW_LOCK} — nothing was stopped or restored"
  fi
  if ! flock -n 9 2>/dev/null; then
    echo "ROLLBACK FAILED — another cutover window is in progress (exclusive flock held on ${WINDOW_LOCK}). No action taken." >&2
    exit 1
  fi
  LOCK_HELD=1
  echo "-- window lock taken: $WINDOW_LOCK (epoch line-1 + exclusive flock; pg-recover watchdog stands down) --"
}
window_unlock() { [ "${LOCK_HELD:-0}" = "1" ] && rm -f "$WINDOW_LOCK" || true; }

[ "$(id -u)" = "0" ] || fail "must run as root (sudo bash \$0)"

WORK="$(mktemp -d)"; trap 'window_unlock; rm -rf "$WORK"' EXIT

echo "-- rollback script rev ${RB_REV} --"
echo "-- pre-flight: pg-shutdown-guard (sha-pinned, dual-origin retry; fetched BEFORE anything is touched) --"
GUARD_SHA="3aadaa32509b376d446b70966acc4fb8d61aef8b11d0a4261285782893fd42ae"
GUARD_URL="${GUARD_URL:-https://raw.githubusercontent.com/claudegoogl-sudo/paperclip/1b844374e8644751f0fb600df28bff3d09e0eae2/scripts/pg-shutdown-guard.sh}"
GUARD_URL_FALLBACK="${GUARD_URL_FALLBACK:-https://github.com/claudegoogl-sudo/paperclip/releases/download/v2026.913.1-fork.47/pg-shutdown-guard.sh}"
export PG_GUARD_TOKEN_FILE="${PG_GUARD_TOKEN_FILE:-/home/paperclip/.paperclip/auth.json}"
fetch_guard "$WORK/pg-shutdown-guard.sh" \
  || fail "could not fetch pg-shutdown-guard from ANY origin (3 attempts with backoff per origin) — the clean-shutdown gate is mandatory; NOTHING was touched. Fix outbound fetch and re-paste."

window_lock

HOST_NOW="$(${BIN} --version 2>/dev/null || echo unknown)"
if [ "$HOST_NOW" = "$TARGET" ]; then
  echo "ROLLBACK NOT NEEDED — host already reports ${TARGET}. Nothing was changed; the service was NOT stopped."
  exit 0
fi
echo "== Rollback window: ${HOST_NOW} -> ${TARGET} (migration-free; binary-only; DB untouched) =="

TGZ="${WORK}/paperclipai-${TARGET}.tgz"
echo "-- download + sha256 gate (transient curl failures retried) --"
curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors "$URL" -o "$TGZ" \
  || fail "${TARGET} tarball download failed (after retries) — NOTHING was touched (service still running, DB untouched)"
echo "${SHA}  ${TGZ}" | sha256sum -c - || fail "${TARGET} sha mismatch vs pinned literal ${SHA} — refusing (NOTHING was touched)"

echo "-- stopping paperclip.service + pg clean-shutdown gate --"
systemctl stop paperclip.service || true
SERVICE_STOPPED=1

if ! bash "$WORK/pg-shutdown-guard.sh" wait-clean "$DB_DIR" 10; then
  stop_orphan_postmaster \
    || fail "cluster still up after 10s and the orphan postmaster could not be stopped via pg_ctl — inspect ${DB_DIR}/postmaster.pid; do NOT proceed manually"
  bash "$WORK/pg-shutdown-guard.sh" wait-clean "$DB_DIR" 60 \
    || fail "embedded PG did not shut down cleanly (even after the orphan stop) — see the [pg-guard] REASON/REMEDY lines above; NOTHING was swapped"
fi

echo "-- npm install -g (host ${TARGET}; the embedded-PG data dir is NOT touched) --"
npm install -g "$TGZ" || fail "npm install -g failed (previous host package may have been replaced — re-run this script to converge, or reinstall ${NEW_TARGET} from its asset)"

echo "-- starting service --"
systemctl start paperclip.service || {
  echo "If this failed with 'start request repeated too quickly': run  systemctl reset-failed paperclip  , then  systemctl start paperclip.service"
  fail "service start failed"
}
SERVICE_STOPPED=0
sleep 6

GOT="$(${BIN} --version 2>/dev/null || true)"
echo "host version now: ${GOT}"
[ "$GOT" = "$TARGET" ] || fail "host version is '${GOT}', expected ${TARGET}"
curl -fsS "${API}/health" >/dev/null 2>&1 || fail "health check failed after rollback start"

echo "ROLLBACK OK -> host ${TARGET} (migration-free; DB untouched, journal stays at 0249). Verify board health before resuming work."
echo "Re-attempt the ${NEW_TARGET} window only after the root cause is understood."
