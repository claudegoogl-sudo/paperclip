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
# attempt, message label/DRILL/3800-char cap, no token or log tail anywhere).
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

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" = "0" ]
