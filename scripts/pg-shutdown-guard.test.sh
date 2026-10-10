#!/usr/bin/env bash
#
# pg-shutdown-guard.test.sh — self-test for scripts/pg-shutdown-guard.sh.
#
# Runs the guard against a THROWAWAY Postgres cluster created with initdb in a
# temp dir (never a real instance) and asserts the clean/dirty verdicts, the
# wait loop, exit-code mapping, and the active-run override semantics.
#
# Requires a PostgreSQL bin dir (major version >= 14) with initdb, pg_ctl and
# pg_controldata. Point PG_GUARD_TEST_PGBIN at it; the test SKIPS (exit 0)
# when no distribution is found, so it is safe in CI without Postgres.
#
#   PG_GUARD_TEST_PGBIN=/path/to/postgresql/bin ./scripts/pg-shutdown-guard.test.sh
#
# Co-Authored-By: Paperclip <noreply@paperclip.ing> (repo convention)

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$HERE/pg-shutdown-guard.sh"

PASS=0
FAIL=0

ok() { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

expect_exit() { # <want> <what> <cmd...>
  local want="$1" what="$2"; shift 2
  local got rc
  got="$("$@" 2>&1)"; rc=$?
  if [ "$rc" = "$want" ]; then
    ok "$what (exit $rc)"
  else
    bad "$what — expected exit $want, got $rc"
    printf '%s\n' "$got" | sed 's/^/      | /'
  fi
}

find_pgbin() {
  if [ -n "${PG_GUARD_TEST_PGBIN:-}" ] && [ -x "$PG_GUARD_TEST_PGBIN/initdb" ]; then
    echo "$PG_GUARD_TEST_PGBIN"
    return 0
  fi
  local glob candidate
  for glob in \
    /usr/lib/node_modules/paperclipai/node_modules/@embedded-postgres/*/native/bin \
    /usr/local/share/paperclip-release-tools/pg-bin/*/bin; do
    for candidate in $glob; do
      if [ -x "$candidate/initdb" ]; then echo "$candidate"; return 0; fi
    done
  done
  return 1
}

PGBIN="$(find_pgbin)" || {
  echo "SKIP: no PostgreSQL bin dir with initdb found (set PG_GUARD_TEST_PGBIN)"
  exit 0
}
for t in initdb pg_ctl pg_controldata; do
  [ -x "$PGBIN/$t" ] || { echo "SKIP: $PGBIN lacks $t"; exit 0; }
done
echo "using PostgreSQL tools: $PGBIN"

TMP="$(mktemp -d /tmp/pg-guard-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
PGDATA="$TMP/db"
SOCK="$TMP/sock"
PORT="${PG_GUARD_TEST_PORT:-$((30000 + RANDOM % 20000))}"
mkdir -p "$SOCK"

export PG_GUARD_PGCONTROLDATA="$PGBIN/pg_controldata"
export PG_GUARD_PGCTL="$PGBIN/pg_ctl"

echo "== initdb scratch cluster at $PGDATA (port $PORT) =="
"$PGBIN/initdb" -D "$PGDATA" -A trust --no-locale -E UTF8 >/dev/null 2>&1 || {
  echo "FAIL: initdb failed"; exit 1;
}

echo "== case: running cluster is DIRTY =="
"$PGBIN/pg_ctl" -D "$PGDATA" -w -o "-p $PORT -k $SOCK -c listen_addresses=127.0.0.1" start >/dev/null 2>&1 || {
  echo "FAIL: scratch cluster did not start"; exit 1;
}
[ -f "$PGDATA/postmaster.pid" ] && ok "postmaster.pid present while running" || bad "postmaster.pid missing while running"
expect_exit 1 "verify: running cluster refused" "$GUARD" verify "$PGDATA"
expect_exit 0 "state: running cluster reports in production" bash -c "\"$GUARD\" state '$PGDATA' | grep -qx 'in production'"
expect_exit 1 "wait-clean(1): running cluster times out dirty" "$GUARD" wait-clean "$PGDATA" 1

echo "== case: fast-stopped cluster is CLEAN =="
"$PGBIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null 2>&1
expect_exit 0 "verify: fast-stopped cluster passes" "$GUARD" verify "$PGDATA"
expect_exit 0 "state: stopped cluster reports shut down" bash -c "\"$GUARD\" state '$PGDATA' | grep -qx 'shut down'"
T0=$SECONDS
expect_exit 0 "wait-clean: stopped cluster passes immediately" "$GUARD" wait-clean "$PGDATA" 5
[ $((SECONDS - T0)) -le 3 ] && ok "wait-clean returned without burning the budget" || bad "wait-clean waited too long"

echo "== case: wait-clean converges when the cluster stops mid-wait =="
"$PGBIN/pg_ctl" -D "$PGDATA" -w -o "-p $PORT -k $SOCK -c listen_addresses=127.0.0.1" start >/dev/null 2>&1 || {
  echo "FAIL: scratch cluster did not restart"; exit 1;
}
( sleep 2; "$PGBIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null 2>&1 ) &
BG=$!
T0=$SECONDS
expect_exit 0 "wait-clean: dirty -> clean mid-wait converges" "$GUARD" wait-clean "$PGDATA" 10
ELAPSED=$((SECONDS - T0))
if [ "$ELAPSED" -ge 1 ] && [ "$ELAPSED" -le 9 ]; then
  ok "wait-clean polled until the stop landed (${ELAPSED}s)"
else
  bad "wait-clean convergence timing unexpected (${ELAPSED}s)"
fi
wait "$BG"

echo "== case: stale postmaster.pid is DIRTY =="
echo 999999 > "$PGDATA/postmaster.pid"
expect_exit 1 "verify: stale pidfile refused" "$GUARD" verify "$PGDATA"
rm -f "$PGDATA/postmaster.pid"

echo "== case: staged bin-dir glob discovery (no env overrides) =="
# Regression: candidate globs once matched the bare bin DIRECTORY (dirs pass
# -x), so discovery returned a directory instead of the binary. A staged
# layout like /usr/local/share/paperclip-release-tools/pg-bin/<v>/bin must
# resolve to regular executable files.
STAGED="$TMP/staged/pg-bin/18.1/bin"
mkdir -p "$STAGED"
ln -s "$PGBIN/pg_controldata" "$STAGED/pg_controldata"
ln -s "$PGBIN/pg_ctl" "$STAGED/pg_ctl"
DISCOVERED="$(PG_GUARD_PGCONTROLDATA= PG_GUARD_EXTRA_BIN_GLOBS="$TMP/staged/pg-bin/*/bin" bash -c "source '$GUARD'; pg_guard_pgcontroldata")" && rc=$? || rc=$?
if [ "$rc" = 0 ] && [ -f "$DISCOVERED" ] && [ -x "$DISCOVERED" ]; then
  ok "tool discovery returns a regular executable file ($DISCOVERED)"
else
  bad "tool discovery failed or returned a non-file (rc=$rc, got: ${DISCOVERED:-<none>})"
fi
expect_exit 0 "state via staged-bin glob discovery, no env overrides" env PG_GUARD_PGCONTROLDATA= PG_GUARD_PGCTL= PG_GUARD_EXTRA_BIN_GLOBS="$TMP/staged/pg-bin/*/bin" "$GUARD" state "$PGDATA"

echo "== case: missing pg_controldata maps to tooling exit 2 =="
PG_GUARD_PGCONTROLDATA=/nonexistent/pg_controldata expect_exit 2 "verify: missing pg_controldata" env PG_GUARD_PGCONTROLDATA=/nonexistent/pg_controldata "$GUARD" verify "$PGDATA"

echo "== case: missing data dir maps to tooling exit 2 =="
expect_exit 2 "verify: missing data dir" "$GUARD" verify "$TMP/no-such-dir"

echo "== case: CLI dispatch =="
expect_exit 2 "unknown command" "$GUARD" frobnicate
expect_exit 0 "state via CLI" bash -c "\"$GUARD\" state '$PGDATA' >/dev/null"

echo "== case: active-runs gate (unreachable API) =="
export PG_GUARD_TOKEN="" PG_GUARD_TOKEN_FILE="$TMP/no-auth.json"
export PG_GUARD_API_BASE="http://127.0.0.1:1/api"
expect_exit 3 "active-runs: unreachable API refuses" "$GUARD" active-runs
PG_GUARD_ALLOW_UNREACHABLE=1 PG_GUARD_OVERRIDE_REASON="test override" \
  expect_exit 0 "active-runs: documented override proceeds" env PG_GUARD_ALLOW_UNREACHABLE=1 PG_GUARD_OVERRIDE_REASON="test override" "$GUARD" active-runs

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
