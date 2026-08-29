#!/usr/bin/env bash
#
# pg-recover.test.sh — self-test for scripts/pg-recover.sh.
#
# Drives the watchdog tick against a SCRATCH environment only: a scratch TCP
# port, scratch log/state files and a fake postgres binary. The real embedded
# cluster, its port and its state files are never touched. Alert deliveries
# are captured into a drill file (PG_RECOVER_ALERT_FILE), so the battery never
# pages anyone and never posts to the board.
#
# Covered: healthy no-op + stale-state reset (negative case), immediate
# escalation on the WAL PANIC class, exactly-one-alert + no-restart backoff,
# N-consecutive-failure escalation, recovery re-arm (healthy observation and
# clear-state), stale/alive pidfile handling, and the alert payload shape.
#
#   ./scripts/pg-recover.test.sh
#
# Co-Authored-By: Paperclip <noreply@paperclip.ing> (repo convention)

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECOVER="$HERE/pg-recover.sh"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

expect_exit() { # <want> <what> <cmd...>
  local want="$1" what="$2"; shift 2
  local got rc
  got="$("$@" 2>&1)"; rc=$?
  if [ "$rc" = "$want" ]; then
    ok "$what (exit $rc)"
  else
    bad "$what — expected exit $want, got $rc"
    printf '%s\n' "$got" | sed 's/^/      | /' | head -8
  fi
}

alert_count() { [ -f "$1" ] && wc -l < "$1" | tr -d ' ' || echo 0; }
state_get()   { jq -r --arg k "$1" '.[$k] // empty' "$2" 2>/dev/null || true; }

start_listener() { # <port> <basename>
  python3 -c "
import socket, sys
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', int(sys.argv[1]))); s.listen(8)
open(sys.argv[2], 'w').write('listening')
while True:
    try:
        c, _ = s.accept(); c.close()
    except Exception:
        break
" "$1" "$2" &
  echo $! > "$2.pid"
}

TMP="$(mktemp -d /tmp/pg-recover-test.XXXXXX)"
export TMP   # the fake postgres binary writes its listener pidfile under $TMP
trap '
  for pf in "$TMP"/listener*.pid "$TMP"/fake-listener.pid; do
    [ -f "$pf" ] && kill "$(cat "$pf")" 2>/dev/null
  done
  rm -rf "$TMP"
' EXIT

PORT=$((40000 + RANDOM % 20000))
export PG_RECOVER_PORT="$PORT"
export PG_RECOVER_DATA_DIR="$TMP/db"
export PG_RECOVER_LOG="$TMP/pg-recover.log"
export PG_RECOVER_STAMP="$TMP/pg-recover.stamp"
export PG_RECOVER_STATE="$TMP/pg-recover-alert.state"
export PG_RECOVER_START_WAIT=3
export PG_RECOVER_MAX_FAILURES=3
export PG_RECOVER_LOG_TAIL_LINES=50
export PG_RECOVER_POSTGRES_BIN="$TMP/fake-postgres"
export PG_RECOVER_ALERT_FILE="$TMP/alerts.jsonl"
export FAKE_COUNT="$TMP/fake-postgres.calls"
: > "$FAKE_COUNT"
export FAKE_MODE="fail"

mkdir -p "$PG_RECOVER_DATA_DIR"
: > "$PG_RECOVER_LOG"

cat > "$PG_RECOVER_POSTGRES_BIN" <<'FAKE'
#!/usr/bin/env bash
echo "$FAKE_MODE" >> "$FAKE_COUNT"
case "${FAKE_MODE:-fail}" in
  panic)
    echo "$(date -u +%Y-%m-%dT%H:%M:%S).000 UTC [$$] PANIC:  could not locate a valid checkpoint record at 0/100001" >> "$PG_RECOVER_LOG"
    exit 1 ;;
  fail)
    echo "$(date -u +%Y-%m-%dT%H:%M:%S).000 UTC [$$] FATAL:  fake start failure (no corruption signature)" >> "$PG_RECOVER_LOG"
    exit 1 ;;
  ok)
    python3 -c "
import socket, os, time
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', ${PG_RECOVER_PORT})); s.listen(8)
while True:
    try:
        c, _ = s.accept(); c.close()
    except Exception:
        break
" &
    echo $! > "$TMP/fake-listener.pid"
    sleep 300 ;;
esac
FAKE
chmod +x "$PG_RECOVER_POSTGRES_BIN"

echo "== case: healthy port -> no-op, clears PRE-EXISTING stale alert state (negative case) =="
printf '%s' '{"backoff":true,"alerted_page":true,"alerted_board":true,"reason":"panic","consecutive_failures":3}' > "$PG_RECOVER_STATE"
printf 'stale junk\n' > "$PG_RECOVER_ALERT_FILE"
start_listener "$PORT" "$TMP/listener"
sleep 0.4
expect_exit 0 "healthy tick exits 0" "$RECOVER" tick
[ "$(alert_count "$PG_RECOVER_ALERT_FILE")" = "1" ] \
  && ok "no new alert on healthy tick (stale drill file untouched)" \
  || bad "healthy tick wrote an alert"
[ "$(state_get backoff "$PG_RECOVER_STATE")" = "" ] && ok "stale backoff flag cleared" || bad "stale backoff flag survived"
grep -q "already-up" "$PG_RECOVER_STAMP" && ok "stamp: already-up" || bad "stamp not already-up"

echo "== case: stale pidfile with dead PID is removed, start attempted =="
kill "$(cat "$TMP/listener.pid")" 2>/dev/null; sleep 0.4
echo "999999" > "$PG_RECOVER_DATA_DIR/postmaster.pid"
export FAKE_MODE="fail"
expect_exit 1 "start attempted and failed (1/3)" "$RECOVER" tick
[ ! -f "$PG_RECOVER_DATA_DIR/postmaster.pid" ] && ok "stale pidfile removed" || bad "stale pidfile survived"
[ "$(state_get consecutive_failures "$PG_RECOVER_STATE")" = "1" ] && ok "failure counter = 1" || bad "counter != 1"
[ "$(alert_count "$PG_RECOVER_ALERT_FILE")" = "1" ] && ok "no alert below threshold (1/3)" || bad "premature alert at 1/3"

echo "== case: alive pidfile -> no-op, no start attempt, no failure counted =="
sleep 300 & ALIVE_PID=$!
echo "$ALIVE_PID" > "$PG_RECOVER_DATA_DIR/postmaster.pid"
expect_exit 0 "alive-pid tick exits 0" "$RECOVER" tick
kill "$ALIVE_PID" 2>/dev/null
rm -f "$PG_RECOVER_DATA_DIR/postmaster.pid"
[ "$(cat "$FAKE_COUNT" | grep -c fail)" = "1" ] && ok "no start attempt while postmaster alive" || bad "fake postgres invoked despite alive pidfile"
[ "$(state_get consecutive_failures "$PG_RECOVER_STATE")" = "1" ] && ok "alive-pid tick did not count a failure" || bad "failure counted on alive-pid tick"

echo "== case: N consecutive failures escalate exactly once, then backoff =="
expect_exit 1 "second failure (2/3) still retries" "$RECOVER" tick
expect_exit 3 "third failure (3/3) escalates (exit 3)" "$RECOVER" tick
[ "$(state_get backoff "$PG_RECOVER_STATE")" = "true" ] && ok "backoff flag set" || bad "backoff not set"
[ "$(alert_count "$PG_RECOVER_ALERT_FILE")" = "2" ] \
  && ok "exactly one alert filed at threshold (1 stale + 1 new)" \
  || bad "alert count at threshold = $(alert_count "$PG_RECOVER_ALERT_FILE")"
BEFORE_CALLS="$(grep -c fail "$FAKE_COUNT")"
expect_exit 3 "backoff tick does not retry the start" "$RECOVER" tick
[ "$(grep -c fail "$FAKE_COUNT")" = "$BEFORE_CALLS" ] && ok "no start attempt during backoff" || bad "start attempted during backoff"
[ "$(alert_count "$PG_RECOVER_ALERT_FILE")" = "2" ] && ok "no re-alert during backoff" || bad "re-alerted during backoff"

echo "== case: healthy observation after backoff re-arms (the only automatic reset) =="
start_listener "$PORT" "$TMP/listener2"
sleep 0.4
expect_exit 0 "post-backoff healthy tick exits 0" "$RECOVER" tick
[ "$(state_get backoff "$PG_RECOVER_STATE")" = "" ] && ok "backoff cleared by healthy observation" || bad "backoff survived healthy tick"
kill "$(cat "$TMP/listener2.pid")" 2>/dev/null

echo "== case: clear-state re-arms after backoff (manual reset path) =="
export FAKE_MODE="fail"
expect_exit 1 "start re-armed after clear-state" bash -c "'$RECOVER' clear-state && '$RECOVER' tick"
[ "$(state_get consecutive_failures "$PG_RECOVER_STATE")" = "1" ] && ok "counter restarted at 1 after clear-state" || bad "counter not reset by clear-state"

echo "== case: WAL PANIC class escalates on the FIRST failure =="
printf '{}' > "$PG_RECOVER_STATE"
export FAKE_MODE="panic"
expect_exit 3 "PANIC escalates immediately (exit 3)" "$RECOVER" tick
[ "$(state_get reason "$PG_RECOVER_STATE")" = "panic" ] && ok "reason classified as panic" || bad "reason not panic"
[ "$(alert_count "$PG_RECOVER_ALERT_FILE")" = "3" ] \
  && ok "exactly one panic alert (2 prior + 1 new)" \
  || bad "panic alert count = $(alert_count "$PG_RECOVER_ALERT_FILE")"

echo "== case: successful start via the real launch path -> healthy, no alert =="
printf '{}' > "$PG_RECOVER_STATE"
export FAKE_MODE="ok"
expect_exit 0 "launch -> port up -> healthy (exit 0)" "$RECOVER" tick
grep -q "^started" "$PG_RECOVER_STAMP" && ok "stamp: started" || bad "stamp not started ($(cat "$PG_RECOVER_STAMP"))"
[ "$(alert_count "$PG_RECOVER_ALERT_FILE")" = "3" ] && ok "no alert on successful start" || bad "alert on successful start"
kill "$(cat "$TMP/fake-listener.pid")" 2>/dev/null
rm -f "$TMP/fake-listener.pid"

echo "== case: alert payload shape =="
LAST="$(tail -1 "$PG_RECOVER_ALERT_FILE")"
for kv in "severity:high" "reason:panic" "port:$PORT"; do
  key="${kv%%:*}"; want="${kv#*:}"
  [ "$(printf '%s' "$LAST" | jq -r ".$key")" = "$want" ] \
    && ok "payload $key == $want" || bad "payload $key != $want"
done
[ -n "$(printf '%s' "$LAST" | jq -r .log_tail)" ] && ok "payload carries the log tail" || bad "payload log_tail empty"
[ -n "$(printf '%s' "$LAST" | jq -r .runbook_ref)" ] && ok "payload carries the runbook pointer" || bad "payload runbook_ref empty"
printf '%s' "$LAST" | jq -e . >/dev/null 2>&1 && ok "payload is valid JSON" || bad "payload not valid JSON"

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" = "0" ]
