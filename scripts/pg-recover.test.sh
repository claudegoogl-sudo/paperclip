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
# clear-state), stale/alive pidfile handling, the alert payload shape, and the
# board description build (a fake board API captures the POSTed issue; the
# multi-line log tail must render with real newlines, not backslash-n text),
# empty/optional-field rendering via `alert-desc` (empty detail must not shift
# positional fields; null first_failure_at falls back to its default), the
# pure `page-test` drill (state file untouched, transport-branch selection,
# DRILL payload shape), and the Telegram page-transport helper against a stub
# Bot API (rc contract 3/2/1/0, one sendMessage per attempt, one log line per
# attempt, message label/DRILL/3800-char cap, no token or log tail anywhere),
# plus the hardening gates: fail-closed env-file mode (0600/0400 only) and the
# bot-token format check, both rc 3 with one log line and no HTTP attempt.
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

start_listener() { # <socket_dir> <basename> -- unix-socket fake postmaster
  # The watchdog probes a UNIX socket (the control-plane postmaster binds no
  # TCP port). This listener binds <socket_dir>/.s.PGSQL.$PORT and answers an
  # SSLRequest with the single byte 'N' (what a real postmaster without SSL
  # sends), which is exactly what the python3 wire-protocol probe requires.
  mkdir -p "$1"; chmod 700 "$1"  # real server creates it 0700; the CWE-379 guard refuses anything else
  python3 -c "
import socket, sys, os
path = sys.argv[1] + '/.s.PGSQL.' + sys.argv[3]
try: os.unlink(path)
except FileNotFoundError: pass
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(path); s.listen(8)
open(sys.argv[2], 'w').write('listening')
while True:
    try:
        c, _ = s.accept()
        try:
            c.settimeout(2); c.recv(8); c.sendall(b'N')
        except Exception:
            pass
        c.close()
    except Exception:
        break
" "$1" "$2" "$PORT" &
  echo $! > "$2.pid"
}

# Independent re-derivation of the server's socket dir (dist/index.js
# embeddedPostgresSocketRuntimeRoot()/socketDirectoryPathFor()): an absolute
# $XDG_RUNTIME_DIR, else $TMPDIR/$TMP/$TEMP, else /tmp; then
# paperclip-pg-<sha256(dataDir)[:16]>. Written separately from the script's
# resolve_socket_dir() so the battery is not checking the script against itself.
expected_socket_dir() {
  python3 -c "
import hashlib, os, sys
x = os.environ.get('XDG_RUNTIME_DIR', '')
root = x if x.startswith('/') else (os.environ.get('TMPDIR') or os.environ.get('TMP') or os.environ.get('TEMP') or '/tmp')
print(root + '/paperclip-pg-' + hashlib.sha256(sys.argv[1].rstrip('/').encode()).hexdigest()[:16])
" "$PG_RECOVER_DATA_DIR"
}

TMP="$(mktemp -d /tmp/pg-recover-test.XXXXXX)"
export TMP   # the fake postgres binary writes its listener pidfile under $TMP
trap '
  for pf in "$TMP"/listener*.pid "$TMP"/fake-listener.pid; do
    [ -f "$pf" ] && kill "$(cat "$pf")" 2>/dev/null
  done
  rm -rf "$TMP"
  default_lock_leaked quiet >/dev/null 2>&1 || true
' EXIT

# Test isolation for the cutover-window lock. The watchdog reads its lock path
# from PG_RECOVER_WINDOW_LOCK; the window scripts (install/rollback) read a
# SEPARATE variable, WINDOW_LOCK, whose default resolves into the LIVE
# instance dir. Pin BOTH to the scratch dir so nothing the battery runs can
# create or probe a lock at the default path.
export WINDOW_LOCK="$TMP/pg-window.lock"

# Leak guard: no lock artifact may exist at the default path after the run. A
# file that was already there before the battery started is not ours — it is
# left untouched. A file that APPEARED during the run is a test-isolation
# failure: removed when unheld, reported-but-NOT-removed when still
# flock-held (a real cutover window may be live on this host; deleting it
# could unsuppress recovery mid-window).
DEFAULT_LOCK="/home/paperclip/.paperclip/instances/default/pg-window.lock"
DEFAULT_LOCK_PREEXISTED=0
[ -e "$DEFAULT_LOCK" ] && DEFAULT_LOCK_PREEXISTED=1
default_lock_leaked() { # [quiet] -> rc 1 and a FAIL line when a leak is found
  [ "$DEFAULT_LOCK_PREEXISTED" = "0" ] || return 0
  [ ! -e "$DEFAULT_LOCK" ] && return 0
  if flock -n "$DEFAULT_LOCK" true 2>/dev/null; then
    rm -f "$DEFAULT_LOCK"
    [ "${1:-}" = "quiet" ] || bad "LEAK: lock artifact created at the DEFAULT path during the run — removed (was unheld): $DEFAULT_LOCK"
    return 1
  fi
  [ "${1:-}" = "quiet" ] || bad "LEAK: lock artifact appeared at the DEFAULT path and is STILL HELD — left in place (a real window may be running): $DEFAULT_LOCK"
  return 1
}

PORT=$((40000 + RANDOM % 20000))
export PG_RECOVER_PORT="$PORT"
export PG_RECOVER_DATA_DIR="$TMP/db"
# Pin the socket runtime root to scratch so the derived socket dir never
# lands next to the live cluster's socket.
export XDG_RUNTIME_DIR="$TMP/run"
SOCK_DIR="$(expected_socket_dir)"
export PG_RECOVER_LOG="$TMP/pg-recover.log"
export PG_RECOVER_STAMP="$TMP/pg-recover.stamp"
export PG_RECOVER_STATE="$TMP/pg-recover-alert.state"
export PG_RECOVER_START_WAIT=3
export PG_RECOVER_MAX_FAILURES=3
export PG_RECOVER_LOG_TAIL_LINES=50
export PG_RECOVER_POSTGRES_BIN="$TMP/fake-postgres"
export PG_RECOVER_ALERT_FILE="$TMP/alerts.jsonl"
export PG_RECOVER_WINDOW_LOCK="$TMP/pg-window.lock"
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
  ok|wrongsock)
    # Bind where the watchdog TOLD us to (-c unix_socket_directories=...),
    # like a real postmaster. Record the argv so the battery can assert the
    # launch flags. wrongsock: bind a DIFFERENT dir and advertise it in
    # postmaster.pid line 5 (a postmaster that answers, but not at the path
    # the control plane dials).
    printf '%s\n' "$@" > "$TMP/fake-argv"
    sockdir=""
    for a in "$@"; do
      case "$a" in unix_socket_directories=*) sockdir="${a#unix_socket_directories=}" ;; esac
    done
    if [ "$FAKE_MODE" = "wrongsock" ]; then
      sockdir="$TMP/wrong-sock"
      printf '%s\n%s\n%s\n%s\n%s\n' "$$" "$PG_RECOVER_DATA_DIR" "0" "$PG_RECOVER_PORT" "$sockdir" \
        > "$PG_RECOVER_DATA_DIR/postmaster.pid"
    fi
    mkdir -p "$sockdir"; chmod 700 "$sockdir"
    printf '%s' "$sockdir" > "$TMP/fake-bound-dir"
    python3 -c "
import socket, sys, os
path = sys.argv[1] + '/.s.PGSQL.' + sys.argv[2]
try: os.unlink(path)  # a real postmaster replaces a stale socket file too
except FileNotFoundError: pass
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(path); s.listen(8)
while True:
    try:
        c, _ = s.accept()
        try:
            c.settimeout(2); c.recv(8); c.sendall(b'N')
        except Exception:
            pass
        c.close()
    except Exception:
        break
" "$sockdir" "$PG_RECOVER_PORT" &
    echo $! > "$TMP/fake-listener.pid"
    sleep 300 ;;
esac
FAKE
chmod +x "$PG_RECOVER_POSTGRES_BIN"

echo "== case: healthy port -> no-op, clears PRE-EXISTING stale alert state (negative case) =="
printf '%s' '{"backoff":true,"alerted_page":true,"alerted_board":true,"reason":"panic","consecutive_failures":3}' > "$PG_RECOVER_STATE"
printf 'stale junk\n' > "$PG_RECOVER_ALERT_FILE"
start_listener "$SOCK_DIR" "$TMP/listener"
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
start_listener "$SOCK_DIR" "$TMP/listener2"
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
[ "$(cat "$TMP/fake-bound-dir" 2>/dev/null)" = "$SOCK_DIR" ] \
  && ok "watchdog-started postmaster bound the server's derived socket dir ($SOCK_DIR)" \
  || bad "bound socket dir '$(cat "$TMP/fake-bound-dir" 2>/dev/null)' != derived '$SOCK_DIR'"
grep -qx 'listen_addresses=' "$TMP/fake-argv" \
  && ok "launch flags: listen_addresses empty (no TCP bind)" || bad "launch did not pass empty listen_addresses"
grep -qx "unix_socket_directories=$SOCK_DIR" "$TMP/fake-argv" \
  && ok "launch flags: explicit unix_socket_directories" || bad "launch missing unix_socket_directories=$SOCK_DIR"
grep -q '127.0.0.1' "$TMP/fake-argv" && bad "launch still binds 127.0.0.1" || ok "launch flags carry no TCP address"
kill "$(cat "$TMP/fake-listener.pid")" 2>/dev/null
rm -f "$TMP/fake-listener.pid"

echo "== case: socket dir resolved from live postmaster.pid line 5 (authoritative over derivation) =="
ALT_DIR="$TMP/alt-sock"
sleep 300 & PIDF_PID=$!
printf '%s\n%s\n0\n%s\n%s\n' "$PIDF_PID" "$PG_RECOVER_DATA_DIR" "$PORT" "$ALT_DIR" > "$PG_RECOVER_DATA_DIR/postmaster.pid"
start_listener "$ALT_DIR" "$TMP/listener-alt"
sleep 0.4
: > "$PG_RECOVER_STAMP"
expect_exit 0 "postmaster answering at pidfile line-5 dir -> healthy" "$RECOVER" tick
grep -q "already-up" "$PG_RECOVER_STAMP" && ok "stamp: already-up (probe dialed the pidfile's socket dir)" || bad "pidfile line-5 dir not probed (stamp: $(cat "$PG_RECOVER_STAMP"))"
kill "$(cat "$TMP/listener-alt.pid")" "$PIDF_PID" 2>/dev/null
rm -f "$PG_RECOVER_DATA_DIR/postmaster.pid"; sleep 0.3

echo "== case: stale socket FILE with nothing answering is NOT healthy =="
mkdir -p "$SOCK_DIR"; chmod 700 "$SOCK_DIR"
python3 -c "
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.bind(sys.argv[1])
" "$SOCK_DIR/.s.PGSQL.$PORT"
[ -S "$SOCK_DIR/.s.PGSQL.$PORT" ] && ok "stale socket file present (precondition)" || bad "could not create stale socket file"
printf '{}' > "$PG_RECOVER_STATE"
export FAKE_MODE="fail"
expect_exit 1 "stale socket file -> not healthy, start attempted (exit 1)" "$RECOVER" tick
rm -f "$SOCK_DIR/.s.PGSQL.$PORT"

echo "== case: postmaster answering at the WRONG socket = failed start (no false green) =="
printf '{}' > "$PG_RECOVER_STATE"
: > "$PG_RECOVER_STAMP"
export FAKE_MODE="wrongsock"
expect_exit 1 "wrong-socket start counts as a failure (exit 1)" "$RECOVER" tick
grep -q "NOT at the server's expected socket" "$PG_RECOVER_LOG" \
  && ok "wrong-socket warning logged" || bad "no wrong-socket warning in log"
grep -q "^started" "$PG_RECOVER_STAMP" && bad "stamp says started on a wrong-socket start" || ok "stamp not 'started'"
[ "$(state_get consecutive_failures "$PG_RECOVER_STATE")" = "1" ] && ok "failure counted (1)" || bad "wrong-socket start not counted"
kill "$(cat "$TMP/fake-listener.pid")" 2>/dev/null
rm -f "$TMP/fake-listener.pid" "$PG_RECOVER_DATA_DIR/postmaster.pid"
sleep 0.3

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

echo "== case: board description build renders a multi-line log tail (fake board) =="
# The description body is built only on the real board path (the drill file
# captures the raw alert payload instead), so run one PANIC tick with the
# drill file DISABLED against a fake board API and inspect the POSTed issue:
# the fenced "Last log lines" block must contain REAL newlines -- the former
# TSV field roundtrip rendered them as literal backslash-n escapes.
unset PG_RECOVER_ALERT_FILE
export PG_RECOVER_TOKEN="drill-board-token"
export PG_RECOVER_COMPANY_ID="drill-company"
BOARD_PORT=$((40000 + RANDOM % 20000))
export PG_RECOVER_API_BASE="http://127.0.0.1:$BOARD_PORT/api"
BOARD_CAPTURE="$TMP/board-payload.json"
python3 -c "
import http.server, sys
CAP = sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        open(CAP, 'wb').write(body)
        self.send_response(201)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{\"id\": \"fake-board-issue-id\"}')
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
" "$BOARD_PORT" "$BOARD_CAPTURE" &
echo $! > "$TMP/listener-board.pid"   # matched by the trap's listener*.pid glob
sleep 0.4
printf '{}' > "$PG_RECOVER_STATE"
export FAKE_MODE="panic"
expect_exit 3 "board-alert tick escalates (exit 3)" "$RECOVER" tick
[ -s "$BOARD_CAPTURE" ] && ok "board POST captured by the fake board" || bad "no board POST captured"
[ "$(state_get alert_issue_id "$PG_RECOVER_STATE")" = "fake-board-issue-id" ] \
  && ok "board issue id recorded" || bad "alert_issue_id not recorded"
[ "$(jq -r '.title' "$BOARD_CAPTURE")" = "[auto-alert] embedded Postgres PANIC on start (WAL corruption class)" ] \
  && ok "board title assembled correctly" || bad "board title wrong: $(jq -r '.title' "$BOARD_CAPTURE" 2>/dev/null)"
jq -r '.description' "$BOARD_CAPTURE" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}.*PANIC:  could not locate a valid checkpoint record' \
  && ok "log tail renders with real newlines (PANIC line on its own line)" \
  || bad "PANIC log line not rendered on its own line"
if jq -r '.description' "$BOARD_CAPTURE" | grep -qF '\n'; then
  bad "description still contains literal backslash-n escapes"
else
  ok "no literal backslash-n escapes in the description"
fi
if grep -q '| @tsv' "$RECOVER"; then
  bad "board_alert() still routes fields through the TSV roundtrip"
else
  ok "no TSV field roundtrip in pg-recover.sh"
fi
kill "$(cat "$TMP/listener-board.pid")" 2>/dev/null

echo "== case: empty/optional fields render without positional shift (alert-desc) =="
# `alert-desc` renders the description from an ARBITRARY payload, which lets the
# battery exercise the empty/optional-field shapes the tick paths never produce:
# an empty `detail` (defect #2 of the TSV roundtrip: whitespace-IFS collapsed
# consecutive tabs and shifted every later field) and a null `first_failure_at`.
CRAFTED="$(printf '%s' "$LAST" | jq '.detail = "" | .consecutive_failed_starts = 7 | .first_failure_at = null')"
RENDERED="$("$RECOVER" alert-desc <<<"$CRAFTED")"
printf '%s\n' "$RENDERED" | grep -Eq '^- Reason: panic$' \
  && ok "empty detail leaves a clean Reason line" \
  || bad "empty detail corrupted the Reason line: $(printf '%s\n' "$RENDERED" | grep '^- Reason' | head -1)"
printf '%s\n' "$RENDERED" | grep -Fq 'Consecutive failed starts: 7 (max' \
  && ok "count field stays in its own slot with empty detail" \
  || bad "count field shifted with empty detail"
printf '%s\n' "$RENDERED" | grep -Fq "First failure: (this attempt)" \
  && ok "null first_failure_at renders the default" \
  || bad "null first_failure_at rendered empty"
printf '%s\n' "$RENDERED" | grep -Fq '**Runbook:**' \
  && ok "Runbook line still in its own slot" \
  || bad "Runbook line shifted with empty detail"
printf '%s\n' "$RENDERED" | grep -Fq "Port: $PORT" \
  && ok "Port/Data-dir line still in its own slot" \
  || bad "Port/Data-dir line shifted with empty detail"
printf '%s' "$RENDERED" | grep -Fq '\n' \
  && bad "crafted render contains a literal backslash-n escape" \
  || ok "crafted empty-detail render has no literal backslash-n escape"

echo "== case: page-test drill is pure (no state reads/writes), branch selection =="
SENTINEL='{"backoff":true,"alerted_page":"not-touched","alerted_board":true,"reason":"panic","consecutive_failures":9}'
printf '%s' "$SENTINEL" > "$PG_RECOVER_STATE"
unset PG_RECOVER_ALERT_FILE PG_RECOVER_PAGE_CMD
PAGEOUT="$("$RECOVER" page-test 2>&1)"; PAGE_RC=$?
[ "$PAGE_RC" = "3" ] && ok "page-test with no transport exits 3" || bad "page-test no-transport rc=$PAGE_RC (want 3)"
printf '%s\n' "$PAGEOUT" | grep -q 'transport branch: none' \
  && ok "page-test prints the 'none' transport branch" || bad "branch line missing: $PAGEOUT"
printf '%s\n' "$PAGEOUT" | grep -q 'rc=3' \
  && ok "page-test explains the rc meaning" || bad "rc meaning line missing"
cmp -s "$PG_RECOVER_STATE" <(printf '%s' "$SENTINEL") \
  && ok "no-transport drill left the state file byte-identical" || bad "state mutated by no-transport drill"

export PG_RECOVER_ALERT_FILE="$TMP/drill-page.jsonl"
: > "$PG_RECOVER_ALERT_FILE"
expect_exit 0 "page-test via alert file exits 0" "$RECOVER" page-test
[ "$(alert_count "$PG_RECOVER_ALERT_FILE")" = "1" ] \
  && ok "exactly one drill payload captured" || bad "drill payload count = $(alert_count "$PG_RECOVER_ALERT_FILE")"
cmp -s "$PG_RECOVER_STATE" <(printf '%s' "$SENTINEL") \
  && ok "alert-file drill left the state file byte-identical" || bad "state mutated by alert-file drill"
jq -e '(.reason == "drill")
       and (.detail | startswith("DRILL"))
       and (.consecutive_failed_starts == 0)
       and (.first_failure_at == null)
       and (.log_tail == "")
       and (.port == '"$PORT"')' "$PG_RECOVER_ALERT_FILE" >/dev/null \
  && ok "drill payload shape: drill reason, DRILL detail, zero counters, empty log tail" \
  || bad "drill payload shape wrong: $(tail -1 "$PG_RECOVER_ALERT_FILE")"
unset PG_RECOVER_ALERT_FILE

echo "== case: telegram page helper — no-transport rc 3 (missing file, empty token) =="
HELPER="$HERE/pg-recover-page-telegram.sh"
export PG_RECOVER_PAGE_CMD="$HELPER"
TG_ENV="$TMP/tg-page.env"
export PG_RECOVER_PAGE_TELEGRAM_ENV="$TG_ENV"
rm -f "$TG_ENV"
export PG_RECOVER_PAGE_TELEGRAM_API_BASE="http://127.0.0.1:1"   # nothing listens; rc 3 must fire BEFORE any HTTP attempt
LINES_BEFORE="$(wc -l < "$PG_RECOVER_LOG" | tr -d ' ')"
expect_exit 3 "missing env file -> rc 3 (no transport)" "$RECOVER" page-test
LINES_AFTER="$(wc -l < "$PG_RECOVER_LOG" | tr -d ' ')"
[ "$LINES_AFTER" = "$((LINES_BEFORE + 1))" ] \
  && ok "no-transport case appended exactly ONE log line" || bad "log lines $LINES_BEFORE -> $LINES_AFTER"
grep -q 'pg-recover-page-telegram] no transport: credentials env file' "$PG_RECOVER_LOG" \
  && ok "no-transport log line names the env-file problem" || bad "no-transport log line missing"

printf 'PG_RECOVER_PAGE_TELEGRAM_BOT_TOKEN=\nPG_RECOVER_PAGE_TELEGRAM_CHAT_ID=5145760634\n' > "$TG_ENV"
chmod 600 "$TG_ENV"
expect_exit 3 "empty bot token in env file -> rc 3" "$RECOVER" page-test
grep -q 'pg-recover-page-telegram] no transport: bot token or chat id' "$PG_RECOVER_LOG" \
  && ok "empty-token log line names the variable problem" || bad "empty-token log line missing"

echo "== case: telegram page helper — hardening: env-file mode + token format =="
# API_BASE stays on the closed port here: any HTTP attempt against it ends
# rc 2, so an rc 3 below proves the gate fired BEFORE any HTTP attempt.
export PG_RECOVER_PAGE_TELEGRAM_API_BASE="http://127.0.0.1:1"
# Mode gate: a mis-staged 0644 env file fails closed BEFORE sourcing.
printf 'PG_RECOVER_PAGE_TELEGRAM_BOT_TOKEN=123456:drill-token-ABCDEF\nPG_RECOVER_PAGE_TELEGRAM_CHAT_ID=5145760634\n' > "$TG_ENV"
chmod 644 "$TG_ENV"
LINES_BEFORE="$(wc -l < "$PG_RECOVER_LOG" | tr -d ' ')"
expect_exit 3 "env file mode 0644 -> rc 3 (fail-closed before sourcing)" "$RECOVER" page-test
LINES_AFTER="$(wc -l < "$PG_RECOVER_LOG" | tr -d ' ')"
[ "$LINES_AFTER" = "$((LINES_BEFORE + 1))" ] \
  && ok "0644 env file appended exactly ONE log line" || bad "log lines $LINES_BEFORE -> $LINES_AFTER"
tail -1 "$PG_RECOVER_LOG" | grep -qF "no transport: credentials env file not 0600: $TG_ENV" \
  && ok "0644 log line names the mode problem and the path" || bad "0644 log line wrong: $(tail -1 "$PG_RECOVER_LOG")"

# Token-format gate: correctly-staged file, malformed token fails closed
# AFTER sourcing.
printf 'PG_RECOVER_PAGE_TELEGRAM_BOT_TOKEN=no-colon-here\nPG_RECOVER_PAGE_TELEGRAM_CHAT_ID=5145760634\n' > "$TG_ENV"
chmod 600 "$TG_ENV"
LINES_BEFORE="$(wc -l < "$PG_RECOVER_LOG" | tr -d ' ')"
expect_exit 3 "malformed bot token (no colon) -> rc 3" "$RECOVER" page-test
LINES_AFTER="$(wc -l < "$PG_RECOVER_LOG" | tr -d ' ')"
[ "$LINES_AFTER" = "$((LINES_BEFORE + 1))" ] \
  && ok "malformed-token case appended exactly ONE log line" || bad "log lines $LINES_BEFORE -> $LINES_AFTER"
tail -1 "$PG_RECOVER_LOG" | grep -q 'pg-recover-page-telegram] no transport: bot token format invalid' \
  && ok "malformed-token log line names the format problem" || bad "format log line wrong: $(tail -1 "$PG_RECOVER_LOG")"

# Accepted mode: 0400 (POSIX read-only equivalent) passes BOTH gates and
# proceeds to the transport, which fails rc 2 on the closed port — proving
# the mode gate does not over-block.
printf 'PG_RECOVER_PAGE_TELEGRAM_BOT_TOKEN=123456:drill-token-ABCDEF\nPG_RECOVER_PAGE_TELEGRAM_CHAT_ID=5145760634\n' > "$TG_ENV"
chmod 400 "$TG_ENV"
expect_exit 2 "env file mode 0400 passes both gates -> rc 2 (transport on closed port)" "$RECOVER" page-test
tail -1 "$PG_RECOVER_LOG" | grep -q 'pg-recover-page-telegram] sent ok=false http=none curl_rc=' \
  && ok "0400 file got past both hardening gates (transport-failure log shape)" \
  || bad "0400 log line wrong: $(tail -1 "$PG_RECOVER_LOG")"
chmod 600 "$TG_ENV"

echo "== case: telegram page helper — delivered (rc 0) against a stub Bot API =="
TG_PORT=$((40000 + RANDOM % 20000))
export PG_RECOVER_PAGE_TELEGRAM_API_BASE="http://127.0.0.1:$TG_PORT"
TG_CAPTURE="$TMP/tg-captures.jsonl"
TG_MODE="$TMP/tg-mode"
printf 'ok' > "$TG_MODE"
python3 -c "
import http.server, sys, json
from urllib.parse import parse_qs
CAP, MODE = sys.argv[2], sys.argv[3]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        form = parse_qs(body.decode('utf-8'))
        form['_path_ok'] = [self.path.startswith('/bot') and self.path.endswith('/sendMessage')]
        with open(CAP, 'a') as f:
            f.write(json.dumps(form) + '\n')
        if open(MODE).read().strip() == 'ok':
            code, resp = 200, b'{\"ok\":true,\"result\":{\"message_id\":4242}}'
        else:
            code, resp = 401, b'{\"ok\":false,\"error_code\":401,\"description\":\"Unauthorized\"}'
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(resp)
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
" "$TG_PORT" "$TG_CAPTURE" "$TG_MODE" &
echo $! > "$TMP/listener-tg.pid"   # matched by the trap's listener*.pid glob
sleep 0.4
printf 'PG_RECOVER_PAGE_TELEGRAM_BOT_TOKEN=123456:drill-token-ABCDEF\nPG_RECOVER_PAGE_TELEGRAM_CHAT_ID=5145760634\n' > "$TG_ENV"
chmod 600 "$TG_ENV"

LINES_BEFORE="$(wc -l < "$PG_RECOVER_LOG" | tr -d ' ')"
expect_exit 0 "page-test through the telegram helper exits 0 (delivered)" "$RECOVER" page-test
[ -f "$TG_CAPTURE" ] && [ "$(wc -l < "$TG_CAPTURE" | tr -d ' ')" = "1" ] \
  && ok "exactly ONE sendMessage POST for one attempt" \
  || bad "POST count = $(wc -l < "$TG_CAPTURE" 2>/dev/null | tr -d ' ' || echo 0)"
LAST_TG="$(tail -1 "$TG_CAPTURE")"
[ "$(printf '%s' "$LAST_TG" | jq -r '.chat_id[0]')" = "5145760634" ] \
  && ok "chat_id read from the env file" || bad "chat_id wrong"
[ "$(printf '%s' "$LAST_TG" | jq -r '._path_ok[0]')" = "true" ] \
  && ok "request path is <base>/bot<token>/sendMessage" || bad "request path shape wrong"
TEXT="$(printf '%s' "$LAST_TG" | jq -r '.text[0]')"
printf '%s' "$TEXT" | grep -q '^\[pg-recover\] \[DRILL\]' \
  && ok "message starts with [pg-recover] and carries the DRILL label" \
  || bad "message prefix wrong: $(printf '%s' "$TEXT" | head -1)"
printf '%s' "$TEXT" | grep -qF "host=$(hostname)" \
  && ok "message carries the host" || bad "host missing from message"
printf '%s' "$TEXT" | grep -qF "failed_starts=0/$PG_RECOVER_MAX_FAILURES" \
  && ok "message carries the failed-start counter" || bad "counter missing from message"
printf '%s' "$TEXT" | grep -qF "Runbook: " \
  && ok "message carries the runbook pointer" || bad "runbook missing from message"
grep -qF "drill-token-ABCDEF" "$PG_RECOVER_LOG" \
  && bad "TOKEN LEAKED into the watchdog log" || ok "token absent from the log file"
LINES_AFTER="$(wc -l < "$PG_RECOVER_LOG" | tr -d ' ')"
[ "$LINES_AFTER" = "$((LINES_BEFORE + 1))" ] \
  && ok "delivered attempt appended exactly ONE log line" || bad "log lines $LINES_BEFORE -> $LINES_AFTER"
tail -1 "$PG_RECOVER_LOG" | grep -q 'pg-recover-page-telegram] sent ok=true http=200 message_id=4242' \
  && ok "ok=true log line shape (http + message_id)" || bad "ok=true log line wrong: $(tail -1 "$PG_RECOVER_LOG")"
cmp -s "$PG_RECOVER_STATE" <(printf '%s' "$SENTINEL") \
  && ok "delivered drill STILL left the state file untouched" || bad "state mutated by delivered drill"

echo "== case: telegram page helper — 3800-char cap + direct stdin contract =="
HUGE_RUNBOOK="$(python3 -c 'print("R" * 5000)')"
CRAFTED="$(jq -n --arg rb "$HUGE_RUNBOOK" '{severity: "high", host: "cap-host",
  detected_at: "2026-08-30T00:00:00Z", reason: "panic", detail: "d",
  consecutive_failed_starts: 3, max_consecutive_failed_starts: 3,
  first_failure_at: null, port: 54329, data_dir: "/d", log_path: "/l",
  log_tail: "PAGES-MUST-NOT-CARRY-LOGS", runbook_ref: $rb}')"
OUT="$(printf '%s' "$CRAFTED" | "$HELPER" 2>&1)"
HELPER_RC=$?
[ "$HELPER_RC" = "0" ] && ok "direct helper invocation (alert JSON on stdin) exits 0" || bad "direct helper rc=$HELPER_RC: $OUT"
[ -z "$OUT" ] \
  && ok "helper prints NOTHING to stdout/stderr (file-only logging)" || bad "helper wrote to stdout/stderr: $OUT"
LAST_TG="$(tail -1 "$TG_CAPTURE")"
TEXT_LEN="$(printf '%s' "$LAST_TG" | jq -r '.text[0] | length')"
[ "$TEXT_LEN" -le 3800 ] \
  && ok "message capped at 3800 chars (got $TEXT_LEN)" || bad "message length $TEXT_LEN exceeds the cap"
printf '%s' "$LAST_TG" | jq -r '.text[0]' | grep -q '\[truncated\]' \
  && ok "over-long runbook pointer is truncated, not dropped" || bad "no truncation marker"
printf '%s' "$LAST_TG" | grep -qF "PAGES-MUST-NOT-CARRY-LOGS" \
  && bad "log tail leaked into the message" || ok "log tail absent from the message"
printf '%s' "$LAST_TG" | jq -r '.text[0]' | grep -q '^\[pg-recover\] WAL corruption' \
  && ok "non-drill panic message carries the reason phrase, no DRILL label" || bad "panic phrase wrong"

echo "== case: telegram page helper — HTTP 401 -> rc 1 =="
printf 'unauth' > "$TG_MODE"
LINES_BEFORE="$(wc -l < "$PG_RECOVER_LOG" | tr -d ' ')"
expect_exit 1 "HTTP 401 -> rc 1" "$RECOVER" page-test
LINES_AFTER="$(wc -l < "$PG_RECOVER_LOG" | tr -d ' ')"
[ "$LINES_AFTER" = "$((LINES_BEFORE + 1))" ] \
  && ok "failed attempt appended exactly ONE log line" || bad "log lines $LINES_BEFORE -> $LINES_AFTER"
tail -1 "$PG_RECOVER_LOG" | grep -q 'pg-recover-page-telegram] sent ok=false http=401' \
  && ok "non-2xx log line carries http=401" || bad "401 log line wrong: $(tail -1 "$PG_RECOVER_LOG")"

echo "== case: telegram page helper — curl transport failure -> rc 2 =="
export PG_RECOVER_PAGE_TELEGRAM_API_BASE="http://127.0.0.1:1"   # closed port
expect_exit 2 "connection refused -> rc 2 (transport failure)" "$RECOVER" page-test
tail -1 "$PG_RECOVER_LOG" | grep -q 'pg-recover-page-telegram] sent ok=false http=none' \
  && ok "transport-failure log line carries http=none" || bad "rc-2 log line wrong: $(tail -1 "$PG_RECOVER_LOG")"
kill "$(cat "$TMP/listener-tg.pid")" 2>/dev/null

echo "== case: window lock held -> deferral (exit 0, no start, no failure, no state change) =="
export PG_RECOVER_ALERT_FILE="$TMP/alerts.jsonl"   # re-arm after the telegram cases unset it
printf '{}' > "$PG_RECOVER_STATE"
export FAKE_MODE="fail"
: > "$PG_RECOVER_LOG"
STAMP_BEFORE="$(cat "$PG_RECOVER_STAMP" 2>/dev/null || true)"
CALLS_BEFORE="$(grep -c . "$FAKE_COUNT" 2>/dev/null || echo 0)"
ALERTS_BEFORE="$(alert_count "$PG_RECOVER_ALERT_FILE")"
# Hold the lock the way a real cutover window does: a separate process with an
# exclusive flock it keeps for its whole run (fd-close releases it).
( exec 9>>"$PG_RECOVER_WINDOW_LOCK" && flock 9 && sleep 20 ) &
WINDOW_HOLDER_PID=$!
sleep 0.4   # let the holder win the flock
expect_exit 0 "window-locked tick exits 0" "$RECOVER" tick
[ "$(grep -c "window lock held — deferring recovery tick" "$PG_RECOVER_LOG")" = "1" ] \
  && ok "exactly one deferral line in the log" || bad "deferral line count = $(grep -c "window lock held" "$PG_RECOVER_LOG" 2>/dev/null || echo 0)"
[ "$(grep -c . "$FAKE_COUNT" 2>/dev/null || echo 0)" = "$CALLS_BEFORE" ] \
  && ok "no start attempt under window lock" || bad "fake postgres invoked despite window lock"
[ "$(state_get consecutive_failures "$PG_RECOVER_STATE")" = "" ] \
  && ok "no failure counted under window lock" || bad "failure counted under window lock"
[ "$(alert_count "$PG_RECOVER_ALERT_FILE")" = "$ALERTS_BEFORE" ] \
  && ok "no alert under window lock" || bad "alerted during window lock"
[ "$(cat "$PG_RECOVER_STAMP" 2>/dev/null)" = "$STAMP_BEFORE" ] \
  && ok "stamp untouched by deferral" || bad "stamp changed on deferral ($(cat "$PG_RECOVER_STAMP" 2>/dev/null))"
kill "$WINDOW_HOLDER_PID" 2>/dev/null
wait "$WINDOW_HOLDER_PID" 2>/dev/null

echo "== case: window lock released -> normal recovery behavior restored =="
expect_exit 1 "tick after lock release attempts the start (exit 1)" "$RECOVER" tick
[ "$(state_get consecutive_failures "$PG_RECOVER_STATE")" = "1" ] \
  && ok "failure counted again after lock release" || bad "counter not incremented after lock release"

echo "== case: fresh epoch line-1 WITHOUT a held flock does NOT defer (flock is authoritative) =="
# The v2 window scripts write an epoch on line 1 of the lock file for the
# INTERIM (pre-flock) watchdog generation. A crashed window can leave that
# file behind with no live holder — this generation must NOT stand down on
# file content alone, or a stale lock file could brick recovery for up to the
# interim's 45-minute horizon.
printf '{}\n' > "$PG_RECOVER_STATE"
export FAKE_MODE="fail"
: > "$PG_RECOVER_LOG"
printf '%s\n%s\n' "$(date +%s)" "$(date -u +%Y-%m-%dT%H:%M:%SZ) leftover window lock (holder crashed)" > "$PG_RECOVER_WINDOW_LOCK"
expect_exit 1 "epoch-only leftover does not defer (start attempted, exit 1)" "$RECOVER" tick
[ "$(grep -c "window lock held — deferring recovery tick" "$PG_RECOVER_LOG")" = "0" ] \
  && ok "no deferral line for an unflocked epoch-only lock file" || bad "deferred on file content alone"
[ "$(state_get consecutive_failures "$PG_RECOVER_STATE")" = "1" ] \
  && ok "start attempt counted (recovery not suppressed)" || bad "recovery suppressed by epoch-only file"
rm -f "$PG_RECOVER_WINDOW_LOCK"

echo "== case: CWE-379 socket-dir guard (pre-seeded entries are refused, never adopted) =="
# A fresh dir is created 0700 under umask 077; a symlink, non-dir, or a dir
# with group/world bits is refused with exit 2 and the postmaster never runs.
export FAKE_MODE="fail"
guard_case() { # <what> <setup-cmd>
  printf '{}' > "$PG_RECOVER_STATE"; : > "$PG_RECOVER_LOG"
  rm -rf "$SOCK_DIR"; eval "$2"
  local calls_before; calls_before="$(wc -l < "$FAKE_COUNT")"
  expect_exit 2 "$1 -> refused (exit 2)" "$RECOVER" tick
  grep -q "refusing to start (CWE-379)" "$PG_RECOVER_LOG" && ok "$1: CWE-379 refusal logged" || bad "$1: no CWE-379 refusal in log"
  [ "$(wc -l < "$FAKE_COUNT")" = "$calls_before" ] && ok "$1: postgres not launched" || bad "$1: postgres launched despite refusal"
}
mkdir -p "$TMP/attacker"; chmod 700 "$TMP/attacker"
guard_case "symlink socket dir" 'ln -s "$TMP/attacker" "$SOCK_DIR"'
[ -z "$(ls -A "$TMP/attacker")" ] && ok "symlink target untouched" || bad "symlink target was written to"
rm -f "$SOCK_DIR"
guard_case "regular file at socket dir path" ': > "$SOCK_DIR"'
rm -f "$SOCK_DIR"
guard_case "world-writable socket dir" 'mkdir -p "$SOCK_DIR"; chmod 0777 "$SOCK_DIR"'
[ "$(stat -c %a "$SOCK_DIR")" = "777" ] && ok "pre-seeded dir mode not silently tightened (not adopted)" || bad "pre-seeded dir was chmod-ed"
guard_case "group-readable socket dir" 'mkdir -p "$SOCK_DIR"; chmod 0750 "$SOCK_DIR"'
rm -rf "$SOCK_DIR"
# Foreign uid: only provable as root (chown); skip otherwise, say so.
if [ "$(id -u)" = "0" ] && id nobody >/dev/null 2>&1; then
  guard_case "foreign-uid socket dir" 'mkdir -p "$SOCK_DIR"; chmod 700 "$SOCK_DIR"; chown nobody "$SOCK_DIR"'
  rm -rf "$SOCK_DIR"
else
  echo "  skip: foreign-uid case needs root (chown)"
fi
# Absent -> created 0700 owned by us, and the start proceeds.
printf '{}' > "$PG_RECOVER_STATE"; : > "$PG_RECOVER_LOG"
( umask 022; expect_exit 1 "absent socket dir -> created, start attempted (exit 1)" "$RECOVER" tick )
[ -d "$SOCK_DIR" ] && [ ! -L "$SOCK_DIR" ] && [ "$(stat -c %a "$SOCK_DIR")" = "700" ] && [ "$(stat -c %u "$SOCK_DIR")" = "$(id -u)" ] \
  && ok "absent socket dir created 0700, owned by us (even under umask 022)" || bad "created socket dir mode/owner wrong: $(stat -c '%a %u' "$SOCK_DIR" 2>/dev/null)"
# Pre-existing correct dir (0700, ours) is accepted.
printf '{}' > "$PG_RECOVER_STATE"
expect_exit 1 "existing 0700 own socket dir accepted, start attempted (exit 1)" "$RECOVER" tick

echo "== case: leak guard — no lock artifact left at the default path =="
default_lock_leaked || true   # rc 1 on a leak; bad() already counted it

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" = "0" ]
