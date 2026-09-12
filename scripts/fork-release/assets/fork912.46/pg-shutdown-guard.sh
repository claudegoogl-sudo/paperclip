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

pg_guard_main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    verify) pg_guard_verify "$@" ;;
    wait-clean) pg_guard_wait_clean "$@" ;;
    state) pg_guard_state "$@" ;;
    active-runs) pg_guard_active_runs "$@" ;;
    *)
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      return 2
      ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  pg_guard_main "$@"
fi
