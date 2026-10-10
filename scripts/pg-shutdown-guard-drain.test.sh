#!/usr/bin/env bash
#
# pg-shutdown-guard-drain.test.sh — self-test for the drain mode of
# scripts/pg-shutdown-guard.sh against a MOCK board API (python3 http.server).
# No Postgres and no real instance needed.
#
#   ./scripts/pg-shutdown-guard-drain.test.sh

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$HERE/pg-shutdown-guard.sh"
command -v python3 >/dev/null && command -v jq >/dev/null || { echo "SKIP: needs python3 + jq"; exit 0; }

PASS=0; FAIL=0
ok() { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d /tmp/pg-guard-drain-test.XXXXXX)"
MOCK_PID=""
cleanup() { [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

# Mock state in $TMP:
#   companies.json  list of companies
#   runs.json       {companyId: [runs]}
#   ctl.json        {"polls": n, "drain_after": k (-1 = never), "hold_route": bool}
#                   After k heartbeat-runs GETs, RUNNING runs report finished
#                   (queued runs stay queued, as under a real hold).
#   hold.json       the admission hold {held, holdUntil, reason}
#   calls.json      log of [method, path, auth-ok]
cat > "$TMP/mock.py" <<'PY'
import json, sys, os
from http.server import BaseHTTPRequestHandler, HTTPServer
D = sys.argv[1]
def load(n): return json.load(open(os.path.join(D, n)))
def save(n, v): json.dump(v, open(os.path.join(D, n), "w"))
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def record(self):
        calls = load("calls.json")
        calls.append([self.command, self.path, self.headers.get("Authorization") == "Bearer test-token"])
        save("calls.json", calls)
    def hold_route(self):
        return self.path.startswith("/api/instance/admission-hold")
    def do_GET(self):
        self.record(); ctl = load("ctl.json"); p = self.path.split("?")[0].split("/")
        if self.hold_route():
            if not ctl["hold_route"]: return self.send(404, {"error": "not found"})
            return self.send(200, load("hold.json"))
        if self.path == "/api/companies": return self.send(200, load("companies.json"))
        ctl["polls"] += 1; save("ctl.json", ctl)
        done = ctl["drain_after"] >= 0 and ctl["polls"] > ctl["drain_after"]
        runs = load("runs.json").get(p[3], [])
        if done: runs = [r for r in runs if r["status"] != "running"]
        return self.send(200, runs)
    def do_PUT(self):
        self.record()
        if not load("ctl.json")["hold_route"]: return self.send(404, {})
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        h = {"held": True, "holdUntil": body["holdUntil"], "reason": body["reason"]}
        save("hold.json", h); return self.send(200, h)
    def do_DELETE(self):
        self.record()
        if not load("ctl.json")["hold_route"]: return self.send(404, {})
        h = load("hold.json"); h["held"] = False; h["holdUntil"] = None
        save("hold.json", h); return self.send(200, h)
S = HTTPServer(("127.0.0.1", 0), H)
open(os.path.join(D, "port.tmp"), "w").write(str(S.server_port)); os.rename(os.path.join(D, "port.tmp"), os.path.join(D, "port"))
S.serve_forever()
PY
python3 "$TMP/mock.py" "$TMP" & MOCK_PID=$!   # binds an ephemeral port (no collisions)
for _ in $(seq 1 50); do [ -s "$TMP/port" ] && break; sleep 0.1; done
[ -s "$TMP/port" ] || { echo "FAIL: mock API did not start"; exit 1; }
PORT="$(cat "$TMP/port")"

# curl shim: logs argv so the test can prove the token never reaches argv.
mkdir -p "$TMP/bin"; REAL_CURL="$(command -v curl)"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "%s/argv.log"\nexec "%s" "$@"\n' "$TMP" "$REAL_CURL" > "$TMP/bin/curl"
chmod +x "$TMP/bin/curl"; export PATH="$TMP/bin:$PATH"

export PG_GUARD_API_BASE="http://127.0.0.1:$PORT/api" PG_GUARD_TOKEN="test-token"
export PG_GUARD_DRAIN_POLL=1 PG_GUARD_DRAIN_PROGRESS=2 PG_GUARD_RELEASE_WAIT=3
unset PG_GUARD_ALLOW_ACTIVE_RUNS

RUN='{"id":"run-11111111","status":"running","agentId":"agent-aaaa","startedAt":"2026-10-10T12:00:00Z"}'
QUEUED='{"id":"run-22222222","status":"queued","agentId":"agent-bbbb","createdAt":"2026-10-10T12:01:00Z"}'
setup() { # <drain_after> <runs: none|running|queued|both> [hold_route=true]
  echo '[{"id":"c1","name":"Alpha","status":"active"},{"id":"c2","name":"Beta","status":"paused"}]' > "$TMP/companies.json"
  case "$2" in
    none) echo '{}' ;; running) echo "{\"c1\":[$RUN]}" ;; queued) echo "{\"c1\":[$QUEUED]}" ;;
    both) echo "{\"c1\":[$RUN,$QUEUED]}" ;;
  esac > "$TMP/runs.json"
  echo "{\"polls\":0,\"drain_after\":$1,\"hold_route\":${3:-true}}" > "$TMP/ctl.json"
  echo '{"held":false,"holdUntil":null,"reason":null}' > "$TMP/hold.json"
  echo '[]' > "$TMP/calls.json"
  cp "$TMP/companies.json" "$TMP/companies.before"
}
held() { [ "$(jq -r .held "$TMP/hold.json")" = true ]; }
calls() { jq -r --arg m "$1" '[.[]|select(.[0]==$m and (.[1]|startswith("/api/instance/admission-hold")))]|length' "$TMP/calls.json"; }
no_company_writes() { cmp -s "$TMP/companies.json" "$TMP/companies.before" && [ "$(jq '[.[]|select(.[0]=="PATCH")]|length' "$TMP/calls.json")" = 0 ]; }

echo "== case: quiet board -> proceeds at once, hold kept until release =="
setup -1 none
T0=$SECONDS; out="$(bash "$GUARD" drain 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "drain exit 0" || { bad "drain exit $rc"; echo "$out"; }
[ $((SECONDS - T0)) -le 2 ] && ok "returned without waiting" || bad "waited $((SECONDS - T0))s"
held && ok "admission hold kept through the window" || bad "hold not set/kept"
jq -e '.reason=="pg-shutdown-guard drain (core install)"' "$TMP/hold.json" >/dev/null && ok "hold carries the drain reason" || bad "wrong reason"
no_company_writes && ok "no company status written" || bad "company status changed"
bash "$GUARD" drain-release >/dev/null 2>&1; ! held && ok "release clears the hold" || bad "release did not clear"
bash "$GUARD" drain-release >/dev/null 2>&1; [ $? = 0 ] && [ "$(calls DELETE)" = 1 ] && ok "release is idempotent (no second DELETE)" || bad "second release not idempotent"

echo "== case: queued runs are held, not counted; nothing cancelled =="
setup -1 queued
out="$(bash "$GUARD" drain 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "queued-only board drains at once under the hold" || { bad "exit $rc"; echo "$out"; }
jq -e '.c1[0].status=="queued"' "$TMP/runs.json" >/dev/null && ok "queued run untouched" || bad "queued run changed"
bash "$GUARD" drain-release >/dev/null 2>&1

echo "== case: busy then drains -> proceeds =="
setup 3 both
out="$(bash "$GUARD" drain 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "drain exit 0 after running runs finish" || { bad "drain exit $rc"; echo "$out"; }
printf '%s' "$out" | grep -q 'waiting for 1 active run' && ok "progress line counts running only" || { bad "no/wrong progress line"; echo "$out"; }
held && ok "hold kept for stop/install/start" || bad "hold dropped"
bash "$GUARD" drain-release >/dev/null 2>&1; ! held && ok "released" || bad "not released"

echo "== case: never drains -> timeout, hold cleared, exit 3 (installer: exit 10) =="
setup -1 running
out="$(PG_GUARD_DRAIN_TIMEOUT=3 bash "$GUARD" drain 2>&1)"; rc=$?
[ "$rc" = 3 ] && ok "timeout exit 3" || { bad "timeout exit $rc"; echo "$out"; }
! held && ok "hold cleared on timeout" || bad "hold left behind on timeout"
printf '%s' "$out" | grep -q 'ACTIVE RUN company=Alpha status=running run=run-11111111 agent=agent-aaaa started=2026-10-10T12:00:00Z' \
  && ok "timeout names company/agent/run/start" || { bad "run not named"; echo "$out"; }
printf '%s' "$out" | grep -q 'test-token' && bad "token leaked to output" || ok "no token in output"

for SIG in INT TERM; do
echo "== case: SIG$SIG during drain -> hold cleared =="
setup -1 running
# Background jobs of a non-interactive shell start with SIGINT ignored, and bash
# cannot trap a signal ignored on entry; re-enable default dispositions first
# so the guard sees SIGINT exactly as from an operator's Ctrl-C.
python3 -c 'import os,signal,sys; signal.signal(signal.SIGINT, signal.SIG_DFL); os.execvp("bash", ["bash", sys.argv[1], "drain"])' "$GUARD" >"$TMP/int.log" 2>&1 & G=$!
for _ in $(seq 1 20); do held && break; sleep 0.2; done
sleep 1; kill "-$SIG" "$G"; wait "$G"; rc=$?
[ "$rc" = 3 ] && ok "SIG$SIG drain exits 3" || bad "SIG$SIG drain exit $rc"
! held && ok "hold cleared on SIG$SIG" || { bad "hold left behind on SIG$SIG"; cat "$TMP/int.log"; }
done

echo "== case: installer pattern — failure AFTER drain still releases (trap EXIT) =="
setup -1 none
bash -c "source '$GUARD'; trap pg_guard_drain_release EXIT; pg_guard_drain || exit 10; false || exit 1" >/dev/null 2>&1; rc=$?
[ "$rc" = 1 ] && ! held && ok "trap EXIT cleared the hold after a post-drain failure" || bad "post-drain failure left hold (rc=$rc)"

echo "== case: release leaves a hold set by someone else =="
setup -1 none
echo '{"held":true,"holdUntil":"2999-01-01T00:00:00Z","reason":"operator maintenance"}' > "$TMP/hold.json"
bash "$GUARD" drain-release >/dev/null 2>&1; held && [ "$(calls DELETE)" = 0 ] && ok "foreign hold left as is" || bad "foreign hold cleared"

echo "== case: old host (no hold route, 404) -> gap-wait fallback =="
setup 2 running false
out="$(bash "$GUARD" drain 2>&1)"; rc=$?
[ "$(printf '%s' "$out" | grep -c 'no admission-hold route')" = 1 ] && ok "one fallback line printed" || { bad "no fallback line"; echo "$out"; }
[ "$rc" = 0 ] && [ "$(calls PUT)" = 0 ] && ok "fallback waits for the gap, sets no hold, proceeds" || { bad "fallback exit $rc"; echo "$out"; }
# Without a hold the queued run counts and never finishes here -> timeout.
setup -1 queued false
out="$(PG_GUARD_DRAIN_TIMEOUT=2 bash "$GUARD" drain 2>&1)"; rc=$?
[ "$rc" = 3 ] && ok "fallback counts queued runs and times out (exit 3)" || { bad "fallback exit $rc"; echo "$out"; }
setup -1 none false
out="$(bash "$GUARD" drain 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "fallback proceeds on a quiet board" || { bad "fallback quiet exit $rc"; echo "$out"; }
bash "$GUARD" drain-release >/dev/null 2>&1; [ $? = 0 ] && ok "release on old host is a no-op (exit 0)" || bad "release on old host failed"

echo "== case: API error at start -> exit 3, no hold =="
setup -1 none
out="$(PG_GUARD_API_BASE="http://127.0.0.1:1/api" bash "$GUARD" drain 2>&1)"; rc=$?
[ "$rc" = 3 ] && ! held && ok "unreachable API refuses (exit 3), no hold" || { bad "api-error exit $rc"; echo "$out"; }

echo "== case: auth header sent, token never in curl argv =="
jq -e 'all(.[]; .[2])' "$TMP/calls.json" >/dev/null && ok "every API call carried the bearer header" || bad "missing auth header"
grep -q 'test-token' "$TMP/argv.log" && bad "token found in curl argv" || ok "token absent from curl argv ($(wc -l < "$TMP/argv.log") curl calls checked)"

echo "== case: override unchanged =="
setup -1 running
out="$(PG_GUARD_ALLOW_ACTIVE_RUNS=1 PG_GUARD_OVERRIDE_REASON=test bash "$GUARD" drain 2>&1)"; rc=$?
[ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'override reason: test' && ok "override proceeds with reason" || { bad "override broke ($rc)"; echo "$out"; }
[ "$(calls PUT)" = 0 ] && ! held && ok "override sets no hold" || bad "override set a hold"
out="$(bash "$GUARD" active-runs 2>&1)"; [ $? = 3 ] && ok "active-runs (legacy) still refuses busy board" || bad "active-runs changed"

echo; echo "drain self-test: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
