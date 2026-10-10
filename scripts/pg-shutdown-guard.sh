#!/usr/bin/env bash
#
# pg-shutdown-guard.sh — verify an embedded PostgreSQL cluster shut down cleanly
# before an update window touches it.
#
# Why this exists: during a host update window the service is stopped and the
# package tree is replaced immediately afterwards. If the embedded Postgres
# did not reach a clean shutdown ("Database cluster state: shut down"), the
# window can tear the WAL checkpoint and corrupt the cluster. Every install or
# rollback script MUST call pg_guard_wait_clean / pg_guard_verify between
# `systemctl stop` and any `npm install -g` / data-dir mutation, and MUST
# refuse to proceed (exit 1) when the check fails.
#
# Use it three ways:
#   1. CLI:    pg-shutdown-guard.sh verify [data-dir]
#              pg-shutdown-guard.sh wait-clean [data-dir] [timeout-seconds]
#              pg-shutdown-guard.sh state [data-dir]
#              pg-shutdown-guard.sh active-runs
#              pg-shutdown-guard.sh drain           # admission hold + bounded wait
#              pg-shutdown-guard.sh drain-release   # clear the hold (idempotent)
#   2. Source: source pg-shutdown-guard.sh   # defines the pg_guard_* helpers
#   3. Installer integration — MANDATORY in every install/rollback script between
#      `systemctl stop paperclip.service` and `npm install -g` / restart. Inline
#      this whole file into the installer verbatim (release assets must be
#      self-contained), then, right after the service stop and before any package
#      mutation, using the installer's own fail-closed `fail` handler:
#
#        # -- pg clean-shutdown gate (never install over a dirty cluster) --
#        pg_guard_active_runs \
#          || fail "heartbeat runs are queued/running — reschedule the update window"
#        pg_guard_wait_clean "$HOME/.paperclip/instances/default/db" 60 \
#          || fail "embedded PG did not shut down cleanly — see the REASON/REMEDY lines above; do NOT npm install over this cluster"
#
#      Preferred on a busy board (drain instead of refuse): replace the
#      pg_guard_active_runs line above, BEFORE the service stop, with
#
#        trap 'pg_guard_drain_release' EXIT    # clears the hold on EVERY exit
#        pg_guard_drain || fail "board did not drain in time — host untouched"   # exit 10
#        systemctl stop paperclip.service; ...; systemctl start paperclip.service
#        pg_guard_drain_release                # explicit clear once the API is back
#
#      pg_guard_drain sets the server's instance admission hold (queued runs
#      wait, running runs finish) and keeps it until pg_guard_drain_release;
#      see the drain block below.
#
#      Both helpers are read-only with respect to the cluster: they never stop,
#      start or mutate Postgres, so a refused gate leaves the cluster untouched
#      for the operator to inspect.
#
# Exit codes (CLI and functions agree):
#   0  clean / no active runs
#   1  DIRTY cluster or active runs found — refuse to proceed, take no action
#   2  setup/tooling problem (pg_controldata missing, bad arguments, no data dir)
#   3  API unreachable or unreadable (active-run check could not run)
#
# Configuration (environment):
#   PG_GUARD_DATA_DIR         data dir (default: ~/.paperclip/instances/default/db)
#   PG_GUARD_PGCONTROLDATA    path to a pg_controldata binary matching the
#                             embedded server's major version
#   PG_GUARD_PGCTL            path to a pg_ctl binary (same distribution)
#   PG_GUARD_API_BASE         board API base (default: http://127.0.0.1:3100/api)
#   PG_GUARD_TOKEN_FILE       auth.json path (default: ~/.paperclip/auth.json)
#   PG_GUARD_ALLOW_ACTIVE_RUNS  "1" proceeds despite queued/running runs; the
#                             reason MUST be given in PG_GUARD_OVERRIDE_REASON
#                             and is echoed to the output
#   PG_GUARD_ALLOW_UNREACHABLE  "1" proceeds when the runs API cannot be
#                             reached; reason rules as above
#
# This script only READS cluster state. It never starts, stops or mutates
# Postgres; it is safe to run against a live cluster.
#
# Co-Authored-By: Paperclip <noreply@paperclip.ing> (repo convention)

# shellcheck shell=bash

PG_GUARD_DATA_DIR="${PG_GUARD_DATA_DIR:-$HOME/.paperclip/instances/default/db}"
PG_GUARD_API_BASE="${PG_GUARD_API_BASE:-http://127.0.0.1:3100/api}"
PG_GUARD_TOKEN_FILE="${PG_GUARD_TOKEN_FILE:-$HOME/.paperclip/auth.json}"
PG_GUARD_STOP_BUDGET_WARN="${PG_GUARD_STOP_BUDGET_WARN:-60}"

pg_guard_info() { echo "[pg-guard] $*"; }
pg_guard_warn() { echo "[pg-guard] WARNING: $*" >&2; }
pg_guard_die() { echo "[pg-guard] ERROR: $*" >&2; return 1; }

# Locate a tool by explicit env, PATH, or glob candidates. Echoes the path or
# returns 2. Candidates must be regular files: a glob can match a directory
# (directories pass -x), and executing a directory fails confusingly later.
pg_guard_find_tool() {
  local tool="$1" env_var="$2"
  shift 2
  local candidate="${!env_var:-}"
  if [ -n "$candidate" ]; then
    if [ -f "$candidate" ] && [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
    pg_guard_warn "$env_var=$candidate is set but not an executable file"
    return 2
  fi
  candidate="$(command -v "$tool" 2>/dev/null || true)"
  if [ -n "$candidate" ]; then
    echo "$candidate"
    return 0
  fi
  local glob
  for glob in "$@"; do
    for candidate in $glob; do
      if [ -f "$candidate" ] && [ -x "$candidate" ]; then
        echo "$candidate"
        return 0
      fi
    done
  done
  return 2
}

# Append "/<tool>" to every glob line. The globs arrive as one multi-line
# string, so plain string concatenation would decorate only the LAST line and
# leave earlier globs matching bare directories.
pg_guard_tool_candidates() {
  local tool="$1" line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    printf '%s/%s\n' "${line%/}" "$tool"
  done
}

# Common search locations for the embedded-postgres tool distribution.
pg_guard_bin_globs() {
  local npm_global="/usr/lib/node_modules/paperclipai/node_modules/@embedded-postgres"
  printf '%s\n' \
    "$npm_global/*/native/bin" \
    "$npm_global/*/native/bin" \
    "/usr/local/share/paperclip-release-tools/pg-bin/*/bin" \
    "${PG_GUARD_EXTRA_BIN_GLOBS:-}"
}

pg_guard_pgcontroldata() {
  pg_guard_find_tool pg_controldata PG_GUARD_PGCONTROLDATA "$(pg_guard_bin_globs | pg_guard_tool_candidates pg_controldata)"
}

pg_guard_pgctl() {
  pg_guard_find_tool pg_ctl PG_GUARD_PGCTL "$(pg_guard_bin_globs | pg_guard_tool_candidates pg_ctl)"
}

# Print the "Database cluster state" string for a data dir.
# Prints one line, e.g. "shut down", "in production", "in crash recovery".
pg_guard_state() {
  local data_dir="${1:-$PG_GUARD_DATA_DIR}"
  local ctl state
  ctl="$(pg_guard_pgcontroldata)" || {
    pg_guard_warn "pg_controldata not found; set PG_GUARD_PGCONTROLDATA, or one-time root prep: install the SERVER package postgresql-<major> (Debian/Ubuntu: pg_controldata ships in postgresql-<major>, NOT postgresql-client-<major>; if apt has no candidate for that major — e.g. noble carries PG16 only — add the PGDG apt repo first), then stage it: sudo mkdir -p /usr/local/share/paperclip-release-tools/pg-bin/<major>/bin && sudo ln -s /usr/lib/postgresql/<major>/bin/pg_controldata /usr/lib/postgresql/<major>/bin/pg_ctl /usr/local/share/paperclip-release-tools/pg-bin/<major>/bin/"
    return 2
  }
  state="$("$ctl" "$data_dir" 2>/dev/null | sed -n 's/^Database cluster state:[[:space:]]*//p' | head -1)"
  if [ -z "$state" ]; then
    pg_guard_warn "could not read cluster state from $data_dir/global/pg_control via $ctl — treat as dirty (possible torn pg_control)"
    return 1
  fi
  echo "$state"
}

# pg_guard_verify [data-dir] — exit 0 only when the cluster is stopped cleanly.
# Prints one REASON line per problem found (to stderr), suitable for pasting
# into an incident.
pg_guard_verify() {
  local data_dir="${1:-$PG_GUARD_DATA_DIR}"
  local problems=0 state pidfile="$data_dir/postmaster.pid"

  if [ ! -d "$data_dir" ]; then
    pg_guard_warn "REASON: data dir $data_dir does not exist"
    return 2
  fi

  if [ -f "$pidfile" ]; then
    pg_guard_warn "REASON: $pidfile still present (postmaster did not exit or another postmaster owns the cluster)"
    problems=$((problems + 1))
  fi

  local pgctl
  pgctl="$(pg_guard_pgctl 2>/dev/null || true)"
  if [ -n "$pgctl" ] && "$pgctl" status -D "$data_dir" >/dev/null 2>&1; then
    pg_guard_warn "REASON: pg_ctl status reports a server is running on $data_dir"
    problems=$((problems + 1))
  fi

  local state_rc
  state="$(pg_guard_state "$data_dir")"
  state_rc=$?
  if [ "$state_rc" -eq 2 ]; then
    return 2
  fi
  case "$state" in
    shut\ down|shut\ down\ in\ recovery) : ;;
    "")
      pg_guard_warn "REASON: cluster state unreadable — treat as dirty"
      problems=$((problems + 1))
      ;;
    in\ production)
      pg_guard_warn "REASON: cluster state is 'in production' — the cluster was NOT shut down cleanly"
      problems=$((problems + 1))
      ;;
    *)
      pg_guard_warn "REASON: cluster state is '$state' — not a clean shutdown state"
      problems=$((problems + 1))
      ;;
  esac

  if [ "$problems" -gt 0 ]; then
    pg_guard_warn "REMEDY: stop the server cleanly, e.g. pg_ctl stop -m fast -D $data_dir (as the service user), then re-run this check"
    pg_guard_warn "REMEDY: if the cluster is already corrupted (PANIC / checkpoint errors on start), do NOT improvise — follow the WAL repair runbook and escalate"
    return 1
  fi
  pg_guard_info "verify OK: $data_dir is stopped cleanly (state: $state, no postmaster.pid)"
  return 0
}

# pg_guard_wait_clean [data-dir] [timeout-seconds] — poll until verify passes.
pg_guard_wait_clean() {
  local data_dir="${1:-$PG_GUARD_DATA_DIR}"
  local timeout="${2:-${PG_GUARD_STOP_BUDGET_WARN}}"
  local waited=0 rc=0
  while :; do
    if pg_guard_verify "$data_dir" >/dev/null 2>&1; then
      pg_guard_info "clean shutdown observed after ${waited}s"
      return 0
    fi
    if [ "$waited" -ge "$timeout" ]; then
      pg_guard_warn "cluster still not cleanly stopped after ${waited}s (budget ${timeout}s)"
      pg_guard_verify "$data_dir" || true # re-print the reasons visibly
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

# pg_guard_active_runs — fail (exit 3) when heartbeat runs are queued/running,
# unless PG_GUARD_ALLOW_ACTIVE_RUNS=1 with a stated reason.
pg_guard_active_runs() {
  local token company_id company_name payload count=0
  if [ -n "${PG_GUARD_TOKEN:-}" ]; then
    token="$PG_GUARD_TOKEN"
  else
    token="$(jq -r '.credentials["http://localhost:3100"].token // empty' "$PG_GUARD_TOKEN_FILE" 2>/dev/null || true)"
  fi
  if [ -z "$token" ]; then
    pg_guard_warn "REASON: no board token at $PG_GUARD_TOKEN_FILE — cannot check for active runs"
    if [ "${PG_GUARD_ALLOW_UNREACHABLE:-0}" = "1" ]; then
      pg_guard_info "proceeding without run check — override reason: ${PG_GUARD_OVERRIDE_REASON:-unstated}"
      return 0
    fi
    return 3
  fi

  local companies
  companies="$(curl -fsS --max-time 10 -H "Authorization: Bearer $token" "$PG_GUARD_API_BASE/companies" 2>/dev/null)" || {
    pg_guard_warn "REASON: could not list companies at $PG_GUARD_API_BASE — active-run check not possible"
    if [ "${PG_GUARD_ALLOW_UNREACHABLE:-0}" = "1" ]; then
      pg_guard_info "proceeding without run check — override reason: ${PG_GUARD_OVERRIDE_REASON:-unstated}"
      return 0
    fi
    return 3
  }

  while read -r company_id; do
    [ -n "$company_id" ] || continue
    company_name="$(printf '%s' "$companies" | jq -r --arg id "$company_id" '.[] | select(.id==$id) | (.name // .urlKey // .id)' 2>/dev/null || echo "$company_id")"
    payload="$(curl -fsS --max-time 10 -H "Authorization: Bearer $token" "$PG_GUARD_API_BASE/companies/$company_id/heartbeat-runs?limit=200" 2>/dev/null)" || payload="[]"
    while IFS=$'\t' read -r status run_id agent_id started_at; do
      [ -n "$status" ] || continue
      pg_guard_info "ACTIVE RUN company=$company_name status=$status run=${run_id:0:8} agent=${agent_id:0:8} started=${started_at:-unknown}"
      count=$((count + 1))
    done < <(printf '%s' "$payload" | jq -r '.[] | select(.status=="running" or .status=="queued") | [.status, .id, (.agentId // "-"), (.startedAt // "-")] | @tsv' 2>/dev/null)
  done < <(printf '%s' "$companies" | jq -r '.[].id' 2>/dev/null)

  if [ "$count" -gt 0 ]; then
    pg_guard_warn "REASON: $count heartbeat run(s) queued/running — stopping the service now would abort them"
    if [ "${PG_GUARD_ALLOW_ACTIVE_RUNS:-0}" = "1" ]; then
      pg_guard_info "proceeding despite active runs — override reason: ${PG_GUARD_OVERRIDE_REASON:-unstated}"
      return 0
    fi
    pg_guard_info "refusing (set PG_GUARD_ALLOW_ACTIVE_RUNS=1 with PG_GUARD_OVERRIDE_REASON to document an override)"
    return 3
  fi
  pg_guard_info "no active runs — window is quiet"
  return 0
}

# ---------------------------------------------------------------------------
# Drain mode: hold new run starts, wait for running runs to finish, bounded.
#
# Uses the server's instance admission hold (PUT/DELETE
# /api/instance/admission-hold). It is admission-only: while held, queued runs
# stay QUEUED (nothing is cancelled or dropped), wakes still queue, and running
# runs finish normally. The hold self-expires at holdUntil, so it can never be
# left behind for longer than that. Drain:
#   1. sets the hold until now + $PG_GUARD_DRAIN_TIMEOUT + $PG_GUARD_HOLD_MARGIN
#      (defaults 600 + 900 s; the server caps it at now + 60 min);
#   2. polls RUNNING runs every $PG_GUARD_DRAIN_POLL s (default 5), with a
#      progress line every $PG_GUARD_DRAIN_PROGRESS s (default 30), for at most
#      $PG_GUARD_DRAIN_TIMEOUT s (default 600). Queued runs are held, so they
#      do not count;
#   3. returns 0 when no run is running, and KEEPS the hold through
#      stop / install / start. The caller clears it with pg_guard_drain_release
#      once the API is back (and from a trap EXIT); the TTL is the backstop;
#   4. on timeout, interrupt (INT/TERM) or API error: clears the hold, names
#      the runs still running (company, agent, run, start) and returns 3 (the
#      installer maps this to exit 10, host untouched).
#
# Old host (the hold route returns 404): drain prints one line and falls back
# to a bounded wait for a quiet gap (no queued or running runs), no hold.
#
# drain-release clears the hold only when it is the hold drain set (matched by
# reason), waits up to $PG_GUARD_RELEASE_WAIT s (default 180) for the API after
# a restart, and is safe to re-run. The board token never reaches argv: curl
# reads the Authorization header from stdin (-K -).
# ---------------------------------------------------------------------------

PG_GUARD_DRAIN_TIMEOUT="${PG_GUARD_DRAIN_TIMEOUT:-600}"
PG_GUARD_DRAIN_POLL="${PG_GUARD_DRAIN_POLL:-5}"
PG_GUARD_DRAIN_PROGRESS="${PG_GUARD_DRAIN_PROGRESS:-30}"
PG_GUARD_HOLD_MARGIN="${PG_GUARD_HOLD_MARGIN:-900}"
PG_GUARD_RELEASE_WAIT="${PG_GUARD_RELEASE_WAIT:-180}"
PG_GUARD_HOLD_REASON="pg-shutdown-guard drain (core install)"

# Load the board token into PG_GUARD__TOK (never printed). Returns 3 if absent.
pg_guard__load_token() {
  if [ -n "${PG_GUARD_TOKEN:-}" ]; then
    PG_GUARD__TOK="$PG_GUARD_TOKEN"
  else
    PG_GUARD__TOK="$(jq -r '.credentials["http://localhost:3100"].token // empty' "$PG_GUARD_TOKEN_FILE" 2>/dev/null || true)"
  fi
  [ -n "$PG_GUARD__TOK" ] || { pg_guard_warn "REASON: no board token at $PG_GUARD_TOKEN_FILE"; return 3; }
}

# pg_guard__req <method> <path> [json-body] — prints "<http-code>\n<body>".
# Code 000 = no connection. The token goes to curl on stdin, not in argv.
pg_guard__req() {
  local method="$1" path="$2" body="${3:-}" out code
  local args=(-sS --max-time 10 -X "$method" -w '\n%{http_code}')
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data "$body")
  out="$(printf 'header = "Authorization: Bearer %s"\n' "$PG_GUARD__TOK" \
    | curl -K - "${args[@]}" "$PG_GUARD_API_BASE$path" 2>/dev/null)"
  code="${out##*$'\n'}"; [ -n "$code" ] || code=000
  printf '%s\n%s' "$code" "${out%$'\n'*}"
}
pg_guard__code() { printf '%s' "$1" | head -n 1; }
pg_guard__body() { printf '%s' "$1" | tail -n +2; }

# Print one line per run in the given statuses (jq filter on .status).
# Returns 3 when the company list cannot be read.
pg_guard__list_runs() { # <jq-status-filter>
  local filter="$1" r companies cid cname payload
  r="$(pg_guard__req GET /companies)"
  [ "$(pg_guard__code "$r")" = 200 ] || return 3
  companies="$(pg_guard__body "$r")"
  while read -r cid; do
    [ -n "$cid" ] || continue
    cname="$(printf '%s' "$companies" | jq -r --arg id "$cid" '.[] | select(.id==$id) | (.name // .urlKey // .id)')"
    r="$(pg_guard__req GET "/companies/$cid/heartbeat-runs?limit=200")"
    [ "$(pg_guard__code "$r")" = 200 ] || return 3
    payload="$(pg_guard__body "$r")"
    printf '%s' "$payload" | jq -r --arg c "$cname" ".[] | select($filter)
      | \"company=\(\$c) status=\(.status) run=\(.id) agent=\(.agentId // \"-\") started=\(.startedAt // .createdAt // \"-\")\"" 2>/dev/null
  done < <(printf '%s' "$companies" | jq -r '.[].id' 2>/dev/null)
}

# pg_guard_drain_release [wait-seconds] — clear the hold drain set. Idempotent.
pg_guard_drain_release() {
  local wait="${1:-$PG_GUARD_RELEASE_WAIT}" waited=0 r code reason held
  pg_guard__load_token || return 3
  while :; do
    r="$(pg_guard__req GET /instance/admission-hold)"; code="$(pg_guard__code "$r")"
    [ "$code" = 000 ] || break
    if [ "$waited" -ge "$wait" ]; then
      pg_guard_warn "RELEASE FAILED: API unreachable after ${waited}s; the admission hold (if set) stays until its holdUntil expiry"
      pg_guard_warn "REMEDY: once the service is up, run: pg-shutdown-guard.sh drain-release"
      return 3
    fi
    sleep "$PG_GUARD_DRAIN_POLL"; waited=$((waited + PG_GUARD_DRAIN_POLL))
  done
  case "$code" in
    404) return 0 ;;  # old host: no hold route, nothing to clear
    200) ;;
    *) pg_guard_warn "RELEASE FAILED: GET admission-hold returned HTTP $code"; return 3 ;;
  esac
  held="$(pg_guard__body "$r" | jq -r '.held // false' 2>/dev/null)"
  reason="$(pg_guard__body "$r" | jq -r '.reason // ""' 2>/dev/null)"
  if [ "$held" != true ]; then return 0; fi
  if [ "$reason" != "$PG_GUARD_HOLD_REASON" ]; then
    pg_guard_info "release: a hold set by someone else is active (reason: $reason) — left as is"
    return 0
  fi
  r="$(pg_guard__req DELETE /instance/admission-hold)"; code="$(pg_guard__code "$r")"
  if [ "$code" != 200 ]; then
    pg_guard_warn "RELEASE FAILED: DELETE admission-hold returned HTTP $code; the hold expires at its holdUntil"
    return 3
  fi
  pg_guard_info "release: admission hold cleared — queued runs start now"
  return 0
}

# pg_guard_drain — see the block comment above. 0 = no running runs (hold kept),
# 3 = timeout / interrupted / API problem (hold cleared).
pg_guard_drain() {
  if [ "${PG_GUARD_ALLOW_ACTIVE_RUNS:-0}" = "1" ]; then
    pg_guard_active_runs; return $?   # override path is unchanged
  fi
  pg_guard__load_token || return 3
  local r code mode filter
  r="$(pg_guard__req GET /instance/admission-hold)"; code="$(pg_guard__code "$r")"
  case "$code" in
    200) mode=hold; filter='.status=="running"' ;;
    404)
      mode=gap; filter='.status=="running" or .status=="queued"'
      pg_guard_info "drain: this host has no admission-hold route (older release) — waiting for a quiet gap without a hold"
      ;;
    *)
      pg_guard_warn "REASON: admission-hold check at $PG_GUARD_API_BASE returned HTTP $code — drain not possible"
      return 3
      ;;
  esac

  local interrupted=0 saved_traps
  saved_traps="$(trap -p INT TERM)"
  trap 'interrupted=1' INT TERM
  if [ "$mode" = hold ]; then
    local until_iso body
    until_iso="$(date -u -d "+$((PG_GUARD_DRAIN_TIMEOUT + PG_GUARD_HOLD_MARGIN)) seconds" +%Y-%m-%dT%H:%M:%SZ)"
    body="$(jq -cn --arg u "$until_iso" --arg r "$PG_GUARD_HOLD_REASON" '{holdUntil:$u, reason:$r}')"
    r="$(pg_guard__req PUT /instance/admission-hold "$body")"; code="$(pg_guard__code "$r")"
    if [ "$code" != 200 ]; then
      trap - INT TERM; [ -n "$saved_traps" ] && eval "$saved_traps"
      pg_guard_warn "REASON: could not set the admission hold (HTTP $code) — host untouched"
      pg_guard_drain_release 0 >/dev/null 2>&1 || true
      return 3
    fi
    pg_guard_info "drain: admission hold set until $until_iso (queued runs wait, running runs finish)"
  fi

  local start=$SECONDS last=-999 active n rc=3
  while :; do
    [ "$interrupted" = 1 ] && { pg_guard_warn "drain interrupted"; break; }
    if ! active="$(pg_guard__list_runs "$filter")"; then
      pg_guard_warn "REASON: runs API unreadable during drain"; break
    fi
    n="$(printf '%s' "$active" | grep -c .)"
    if [ "$n" -eq 0 ]; then
      pg_guard_info "drain: no running runs after $((SECONDS - start))s — window is quiet"
      rc=0; break
    fi
    if [ $((SECONDS - start)) -ge "$PG_GUARD_DRAIN_TIMEOUT" ]; then
      pg_guard_warn "REASON: drain timed out after $((SECONDS - start))s; $n run(s) still active:"
      printf '%s\n' "$active" | sed 's/^/[pg-guard]   ACTIVE RUN /' >&2
      break
    fi
    if [ $((SECONDS - last)) -ge "$PG_GUARD_DRAIN_PROGRESS" ]; then
      pg_guard_info "drain: waiting for $n active run(s) ($((SECONDS - start))s / ${PG_GUARD_DRAIN_TIMEOUT}s)"
      last=$SECONDS
    fi
    sleep "$PG_GUARD_DRAIN_POLL" & wait $! 2>/dev/null
  done
  trap - INT TERM
  [ -n "$saved_traps" ] && eval "$saved_traps"
  if [ "$rc" -ne 0 ]; then
    [ "$mode" = hold ] && { pg_guard_drain_release 15 || true; }
    pg_guard_info "refusing — host untouched (override: PG_GUARD_ALLOW_ACTIVE_RUNS=1 with PG_GUARD_OVERRIDE_REASON)"
  fi
  return "$rc"
}

pg_guard_main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    verify) pg_guard_verify "$@" ;;
    wait-clean) pg_guard_wait_clean "$@" ;;
    state) pg_guard_state "$@" ;;
    active-runs) pg_guard_active_runs "$@" ;;
    drain) pg_guard_drain "$@" ;;
    drain-release) pg_guard_drain_release "$@" ;;
    *)
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      return 2
      ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  pg_guard_main "$@"
fi
