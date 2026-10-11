#!/usr/bin/env bash
#
# pg-recover.sh — recover the embedded Paperclip postgres after an unexpected
# death, WITH bounded retries and one-shot escalation.
#
# Why this exists: on 2026-08-29 the watchdog cron retried `postgres -D ...`
# every 2 minutes for ~85 minutes while the cluster PANIC'd on WAL corruption
# ("could not locate a valid checkpoint record"). Nobody was paged; the silent
# retry loop was the watchdog half of the outage. This version detects that
# failure class, pages once, and stops retrying until a human clears it.
#
# Behavior (one "tick"; safe to run from cron every minute or two):
#   0. Cutover-window lock held (another process — the install/rollback
#      window — holds an exclusive flock on PG_RECOVER_WINDOW_LOCK) ->
#      do NOTHING: log one deferral line, update no state, count no failure,
#      exit 0. The window intentionally stopped postgres and mid-snapshot
#      wants it to STAY down; starting it mid-window is the race that aborted
#      the 2026-08-31 fork.37 window (watchdog restarted the cluster during
#      the tar). flock — not a pidfile — so a crashed window releases the
#      lock via the kernel on fd close; no stale-lock cleanup exists.
#   1. Postgres already answering -> healthy. Clears the failure counter and
#      any active alert state. No alert, no restart. (A healthy observation
#      is the ONLY automatic reset.) The control-plane postmaster is
#      unix-socket-only (`-c listen_addresses=` empty is PERMANENT hardening
#      host-side — do NOT re-enable TCP). "healthy" is
#      decided by port_up(), which probes the unix socket the server would
#      actually dial (resolved from the live postmaster.pid, or derived the
#      same way the server derives it — see resolve_socket_dir()), preferring
#      pg_isready, then a python3 wire-protocol probe, then (degraded,
#      liveness-only) pg_ctl status. A bare TCP dial or a bare
#      socket-file-exists check is NOT sufficient — see resolve_socket_dir()
#      and port_up() below for why.
#   2. A live postmaster pidfile (PID alive, port not up yet) -> normal
#      startup in progress; do nothing, do not count a failure, never start a
#      second postmaster.
#   3. Backoff active (WAL PANIC classified, or PG_RECOVER_MAX_FAILURES
#      consecutive failed starts already seen) -> do NOT start postgres again.
#      Repair needs a human: fix the cluster, then `pg-recover.sh clear-state`.
#      Outstanding alert deliveries ARE still retried on later ticks: when the
#      embedded postgres is down the board API is usually down too, so the
#      board alert fires on the first tick where the API is reachable again.
#   4. Otherwise: clear a stale pidfile (dead PID only), launch postgres
#      detached with the SAME transport the live server uses (unix-socket
#      only, socket dir derived at runtime — see resolve_socket_dir()), wait
#      up to PG_RECOVER_START_WAIT for the socket to accept AND ANSWER a
#      query at the path the control plane actually dials.
#   5. Start failed:
#        - Log lines emitted by THIS attempt matching the corruption class
#          ("PANIC:" / "could not locate a valid checkpoint record") escalate
#          IMMEDIATELY — a corrupted WAL must not be hammered.
#        - Otherwise the consecutive-failure counter increments; reaching
#          PG_RECOVER_MAX_FAILURES escalates too.
#      Escalation fires each channel ONCE per incident (flags in the state
#      file, so re-runs never re-page):
#        a. page transport (PG_RECOVER_PAGE_CMD, or PG_RECOVER_ALERT_FILE for
#           drills) — host-local, works while the board is down;
#        b. a high-priority issue on the board via the board token, carrying
#           severity, the last ~50 log lines and the runbook pointer.
#
# Operator-delivery note: the marker-comment relay to the operator requires an
# AGENT token; the host-level watchdog only has the board token (the board
# rejects marker comments from it with 422 by design). The board issue is
# assigned to the on-call agent (PG_RECOVER_ALERT_ASSIGNEE_AGENT_ID), who
# relays the operator page. For a board-independent page, point
# PG_RECOVER_PAGE_CMD at a host-local transport.
#
# Subcommands:
#   (default) tick   one watchdog pass (the cron entry)
#   status           print state file + port summary
#   clear-state      MANUAL: clear backoff/alert state so the tick starts
#                    recovering again; run ONLY after the cluster is repaired
#   alert-desc       render the board-alert issue description from a payload
#                    JSON on stdin (drill/debug: shows the exact body the
#                    alert issue would carry; pure, no state, no I/O)
#   page-test        pure drill: build a DRILL-labeled alert payload (same
#                    shape as the escalation payload, zero counters) and feed
#                    it through deliver_page() exactly as a real escalation
#                    would; never reads or writes the state file. Prints
#                    which transport branch fired and propagates its rc.
#   help
#
# Exit codes (tick):
#   0  healthy / no-op (already up, or startup still in progress), or a
#      cutover window holds the window lock (deferred: nothing attempted)
#   1  a start was attempted and failed (counter < N; retrying next tick)
#   2  setup/config problem
#   3  escalation active (backoff; no further start attempts until clear-state)
#
# Configuration (environment):
#   PG_RECOVER_PORT                     port (default 54329)
#   PG_RECOVER_DATA_DIR                 cluster dir
#                                       (default ~/.paperclip/instances/default/db)
#   PG_RECOVER_LOG                      watchdog+server log
#                                       (default ~/.paperclip/instances/default/logs/pg-recover.log)
#   PG_RECOVER_STAMP                    one-line stamp file, kept for humans
#                                       (default ~/.paperclip/instances/default/pg-recover.state)
#   PG_RECOVER_STATE                    alert/backoff state (JSON)
#                                       (default ~/.paperclip/instances/default/pg-recover-alert.state)
#   PG_RECOVER_WINDOW_LOCK              cutover-window lock file (default
#                                       /home/paperclip/.paperclip/instances/default/pg-window.lock):
#                                       while another process holds an
#                                       exclusive flock on it, every tick
#                                       defers (behavior 0). The default is
#                                       ABSOLUTE on purpose, not $HOME-based:
#                                       the root window process and the
#                                       paperclip watchdog user must resolve
#                                       the SAME file.
#   PG_RECOVER_POSTGRES_BIN             postgres binary
#   PG_RECOVER_MAX_FAILURES             N consecutive failed starts that
#                                       escalate (default 3; a PANIC escalates
#                                       on the first occurrence)
#   PG_RECOVER_START_WAIT               seconds to wait for the port after
#                                       launch (default 30)
#   PG_RECOVER_LOG_TAIL_LINES           log lines carried in alerts (default 50)
#   PG_RECOVER_API_BASE                 board API base (default http://127.0.0.1:3100/api)
#   PG_RECOVER_TOKEN_FILE               auth.json path (default ~/.paperclip/auth.json)
#   PG_RECOVER_TOKEN                    board token directly (overrides file)
#   PG_RECOVER_COMPANY_NAME             board company resolved by name when no
#                                       explicit id (default "Platform")
#   PG_RECOVER_COMPANY_ID               explicit company id (wins over name)
#   PG_RECOVER_ALERT_ASSIGNEE_AGENT_ID  agent id the alert issue is assigned to
#                                       (the on-call agent relays the operator page)
#   PG_RECOVER_ALERT_PARENT_ISSUE_ID    optional parent issue id to attach the alert to
#   PG_RECOVER_RUNBOOK_REF              runbook pointer carried in the alert
#   PG_RECOVER_PAGE_CMD                 shell command; the alert JSON arrives
#                                       on stdin. Unset = page transport off
#                                       (board alert only).
#   PG_RECOVER_ALERT_FILE               drill hook: when set, ALL alert
#                                       deliveries append the JSON to this
#                                       file instead of paging/posting
#
# Idempotency: every tick is safe to re-run. State lives in
# PG_RECOVER_STATE; a corrupt/truncated state file is treated as empty
# (re-arming recovery) with a warning, never as a crash.
#
# Co-Authored-By: Paperclip <noreply@paperclip.ing> (repo convention)

# shellcheck shell=bash
set -u

PG_RECOVER_PORT="${PG_RECOVER_PORT:-54329}"
PG_RECOVER_DATA_DIR="${PG_RECOVER_DATA_DIR:-$HOME/.paperclip/instances/default/db}"
PG_RECOVER_LOG="${PG_RECOVER_LOG:-$HOME/.paperclip/instances/default/logs/pg-recover.log}"
PG_RECOVER_STAMP="${PG_RECOVER_STAMP:-$HOME/.paperclip/instances/default/pg-recover.state}"
PG_RECOVER_STATE="${PG_RECOVER_STATE:-$HOME/.paperclip/instances/default/pg-recover-alert.state}"
# Absolute default (not $HOME): root window + paperclip watchdog must agree on
# one file — see the PG_RECOVER_WINDOW_LOCK doc block above.
PG_RECOVER_WINDOW_LOCK="${PG_RECOVER_WINDOW_LOCK:-/home/paperclip/.paperclip/instances/default/pg-window.lock}"
PG_RECOVER_POSTGRES_BIN="${PG_RECOVER_POSTGRES_BIN:-/usr/lib/node_modules/paperclipai/node_modules/@embedded-postgres/linux-x64/native/bin/postgres}"
PG_RECOVER_MAX_FAILURES="${PG_RECOVER_MAX_FAILURES:-3}"
PG_RECOVER_START_WAIT="${PG_RECOVER_START_WAIT:-30}"
PG_RECOVER_LOG_TAIL_LINES="${PG_RECOVER_LOG_TAIL_LINES:-50}"
PG_RECOVER_API_BASE="${PG_RECOVER_API_BASE:-http://127.0.0.1:3100/api}"
PG_RECOVER_TOKEN_FILE="${PG_RECOVER_TOKEN_FILE:-$HOME/.paperclip/auth.json}"
PG_RECOVER_COMPANY_NAME="${PG_RECOVER_COMPANY_NAME:-Platform}"
PG_RECOVER_RUNBOOK_REF="${PG_RECOVER_RUNBOOK_REF:-WAL-corruption repair runbook (2026-08-29 incident): stop start attempts, repair on a copy (pg_resetwal) or restore the latest backup; see the incident parent issue on the internal Paperclip board.}"
readonly PG_RECOVER_CORRUPTION_RE='PANIC:|could not locate a valid checkpoint record'

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log() {
  echo "[$(now)] $*" >> "$PG_RECOVER_LOG" 2>/dev/null || true
  echo "[$(now)] $*" >&2
}

warn() {
  log "WARNING: $*"
  command -v logger >/dev/null 2>&1 && logger -t pg-recover "$*" 2>/dev/null || true
}

die() { # setup/config problem
  log "ERROR: $*"
  exit 2
}

# ------------------------------------------------------- unix-socket probe
#
# The control-plane postmaster is unix-socket-only (see header). port_up()
# used to be a raw TCP dial, which is permanently false against this
# postmaster and made the watchdog blind. The probe now:
#   1. Resolves the socket directory the SAME way the node server does
#      (never hardcoded): prefer the live postmaster.pid line 5 (the
#      authoritative value the running postmaster actually bound); else
#      derive it exactly like embeddedPostgresSocketRuntimeRoot()/
#      socketDirectoryPathFor() in dist/index.js — sha256(dataDir)[:16]
#      under $XDG_RUNTIME_DIR (if absolute) else $TMPDIR/$TMP/$TEMP else
#      /tmp — so a stale/missing pidfile still probes the right path.
#   2. Prefers `pg_isready` when found on PATH (a real libpq client that
#      proves query-ability). It is NOT guaranteed present (the embedded
#      postgres bin dir ships only initdb/pg_ctl/postgres); when absent we
#      fall back to a python3 probe that opens the actual unix socket file
#      and completes enough of the wire protocol (SSLRequest -> single-byte
#      reply) to prove something is actually listening and answering, not
#      just that a socket *file* exists. A bare `[ -S socket ]` check is
#      explicitly rejected here: a stale socket file survives a postmaster
#      crash and would falsely read as healthy.
#   3. If neither pg_isready nor python3 is available, degrades to a
#      pg_ctl(1) status check on the data dir (process-liveness only, not
#      query-ability) and logs a warning that the probe is degraded.

resolve_socket_dir() {
  local sd
  sd="$(readPidFileSocketDir 2>/dev/null || true)"
  if [ -n "$sd" ]; then
    printf '%s' "$sd"
    return 0
  fi
  local root
  if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ "${XDG_RUNTIME_DIR#/}" != "$XDG_RUNTIME_DIR" ]; then
    root="$XDG_RUNTIME_DIR"
  else
    root="${TMPDIR:-${TMP:-${TEMP:-/tmp}}}"
  fi
  local normalized hash
  normalized="${PG_RECOVER_DATA_DIR%/}"
  hash="$(printf '%s' "$normalized" | sha256sum | cut -c1-16)"
  printf '%s/paperclip-pg-%s' "$root" "$hash"
}

readPidFileSocketDir() { # mirrors dist/index.js readPidFileSocketDir(): line 5 of postmaster.pid
  local f="$PG_RECOVER_DATA_DIR/postmaster.pid" line
  [ -f "$f" ] || return 1
  line="$(sed -n '5p' "$f" 2>/dev/null || true)"
  line="${line%%,*}"
  # trim whitespace
  line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [ -n "$line" ] || return 1
  printf '%s' "$line"
}

pg_isready_probe() { # <socket_dir> -- returns 0/1/"unavailable" via echo+return 2
  command -v pg_isready >/dev/null 2>&1 || return 2
  pg_isready -h "$1" -p "$PG_RECOVER_PORT" >/dev/null 2>&1
}

python_socket_probe() { # <socket_dir> -- real protocol probe over the unix socket
  command -v python3 >/dev/null 2>&1 || return 2
  python3 - "$1" "$PG_RECOVER_PORT" <<'PYEOF' >/dev/null 2>&1
import socket, sys, struct
sock_dir, port = sys.argv[1], sys.argv[2]
path = f"{sock_dir}/.s.PGSQL.{port}"
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(3)
try:
    s.connect(path)
    # SSLRequest packet: length(8) + code(80877103)
    s.sendall(struct.pack("!ii", 8, 80877103))
    reply = s.recv(1)
    sys.exit(0 if len(reply) == 1 else 1)
except Exception:
    sys.exit(1)
finally:
    s.close()
PYEOF
}

pg_ctl_status_probe() { # <data_dir> -- process-liveness only, last-resort
  local pgctl="${PG_RECOVER_POSTGRES_BIN%/*}/pg_ctl"
  [ -x "$pgctl" ] || return 2
  "$pgctl" -D "$PG_RECOVER_DATA_DIR" status >/dev/null 2>&1
}

port_up() {
  local socket_dir rc
  socket_dir="$(resolve_socket_dir)"
  [ -n "$socket_dir" ] || return 1

  pg_isready_probe "$socket_dir"; rc=$?
  if [ "$rc" -ne 2 ]; then
    [ "$rc" -eq 0 ]
    return $?
  fi

  python_socket_probe "$socket_dir"; rc=$?
  if [ "$rc" -ne 2 ]; then
    [ "$rc" -eq 0 ]
    return $?
  fi

  warn "no pg_isready and no python3 on PATH — degrading to pg_ctl status (process-liveness only, not query-ability)"
  pg_ctl_status_probe "$PG_RECOVER_DATA_DIR"
}

# ---------------------------------------------------------------- state file

state_init() {
  if [ ! -f "$PG_RECOVER_STATE" ]; then
    mkdir -p "$(dirname "$PG_RECOVER_STATE")" 2>/dev/null || true
    echo '{}' > "$PG_RECOVER_STATE" || die "cannot write state file $PG_RECOVER_STATE"
    return
  fi
  if ! jq -e . "$PG_RECOVER_STATE" >/dev/null 2>&1; then
    warn "state file $PG_RECOVER_STATE is corrupt — treating as empty (re-arming recovery)"
    echo '{}' > "$PG_RECOVER_STATE"
  fi
}

sget() { # <key> — echoes value ("" when unset)
  jq -r --arg k "$1" '.[$k] // empty' "$PG_RECOVER_STATE" 2>/dev/null || true
}

sset() { # <key> <json-value>
  jq --arg k "$1" --argjson v "$2" '.[$k] = $v' "$PG_RECOVER_STATE" > "$PG_RECOVER_STATE.tmp" \
    && mv "$PG_RECOVER_STATE.tmp" "$PG_RECOVER_STATE" \
    || warn "failed to update state key $1"
}

stamp() { echo "$1 $(now)" > "$PG_RECOVER_STAMP" 2>/dev/null || true; }

# ------------------------------------------------------------ alert plumbing

board_token() {
  if [ -n "${PG_RECOVER_TOKEN:-}" ]; then
    printf '%s' "$PG_RECOVER_TOKEN"
    return 0
  fi
  jq -r '.credentials["http://localhost:3100"].token // empty' "$PG_RECOVER_TOKEN_FILE" 2>/dev/null || true
}

alert_json() { # <reason-class> <detail>
  local log_tail=""

  if [ -f "$PG_RECOVER_LOG" ]; then
    log_tail="$(tail -n "$PG_RECOVER_LOG_TAIL_LINES" "$PG_RECOVER_LOG" 2>/dev/null || true)"
  fi

  jq -n \
    --arg ts "$(now)" \
    --arg host "$(hostname 2>/dev/null || echo unknown)" \
    --arg reason "$1" \
    --arg detail "$2" \
    --arg failures "$(sget consecutive_failures)" \
    --arg max "$PG_RECOVER_MAX_FAILURES" \
    --arg first "$(sget first_failure_at)" \
    --arg port "$PG_RECOVER_PORT" \
    --arg datadir "$PG_RECOVER_DATA_DIR" \
    --arg logpath "$PG_RECOVER_LOG" \
    --arg logtail "$log_tail" \
    --arg runbook "$PG_RECOVER_RUNBOOK_REF" \
    '{severity: "high", source: "pg-recover.sh watchdog (host cron)", host: $host,
      detected_at: $ts, reason: $reason, detail: $detail,
      consecutive_failed_starts: ($failures | if . == "" then 0 else tonumber end),
      max_consecutive_failed_starts: ($max | tonumber),
      first_failure_at: (if $first == "" then null else $first end),
      port: ($port | tonumber), data_dir: $datadir,
      log_path: $logpath, log_tail: $logtail, runbook_ref: $runbook}'
}

deliver_page() { # <json> — rc 0 delivered, 3 no transport configured, other = failed
  if [ -n "${PG_RECOVER_ALERT_FILE:-}" ]; then
    mkdir -p "$(dirname "$PG_RECOVER_ALERT_FILE")" 2>/dev/null || true
    printf '%s' "$1" | jq -c . >> "$PG_RECOVER_ALERT_FILE" || return 1
    return 0
  fi
  if [ -n "${PG_RECOVER_PAGE_CMD:-}" ]; then
    printf '%s' "$1" | bash -c "${PG_RECOVER_PAGE_CMD}"
    return $?
  fi
  return 3
}

alert_description() { # <json> — echoes the board-alert issue description (pure: no I/O, no state)
  local json="$1"
  local ahost reason detail failures maxf first detected port datadir logpath logtail runbook severity

  # Field extraction: one `jq -r` per field. The former TSV roundtrip
  # (jq to-tabbed-value, then IFS=tab read) broke the alert body twice:
  # the tab escaping turns real newlines in the log tail into the two
  # characters backslash-n (rendered literally in the filed description),
  # and a whitespace IFS collapses EMPTY fields so every later field shifts
  # left. Separate calls keep newlines real and every field in its own slot.
  # `alert-desc` exposes this builder for drills, so the battery can render
  # payload shapes the tick paths never produce (empty detail, null fields).
  jfield() { printf '%s' "$json" | jq -r "$1"; }
  ahost="$(jfield '.host // ""')"
  reason="$(jfield '.reason // ""')"
  detail="$(jfield '.detail // ""')"
  failures="$(jfield '(.consecutive_failed_starts // 0) | tostring')"
  maxf="$(jfield '(.max_consecutive_failed_starts // 0) | tostring')"
  first="$(jfield '.first_failure_at // "(this attempt)"')"
  detected="$(jfield '.detected_at // ""')"
  port="$(jfield '(.port // 0) | tostring')"
  datadir="$(jfield '.data_dir // ""')"
  logpath="$(jfield '.log_path // ""')"
  logtail="$(jfield '.log_tail // ""')"
  runbook="$(jfield '.runbook_ref // ""')"
  severity="$(jfield '.severity // "high"')"

  cat <<DESC
[agent-provenance] Automated post by scripts/pg-recover.sh (host ${ahost}, host cron — no execution run id) on behalf of the Coder agent, Platform, company urlKey "PLA" — agent action — NOT an operator decision.

**Automated alert: embedded Postgres is down and watchdog recovery is stopped**

- Severity: ${severity}
- Reason: ${reason}${detail:+ — ${detail}}
- Consecutive failed starts: ${failures} (max ${maxf})
- First failure: ${first}   Detected: ${detected}
- Port: ${port}   Data dir: ${datadir}
- Watchdog: further start attempts are STOPPED until a human runs \`pg-recover.sh clear-state\` AFTER the cluster is repaired.

**Last log lines** (${logpath}):

\`\`\`
${logtail}
\`\`\`

**Runbook:** ${runbook}

(One alert per incident: the watchdog state file prevents re-alerting every tick; a NEW incident after clear-state files a new issue.)
DESC
}

board_alert() { # <json> — echoes issue id on success, rc 1 otherwise
  local json="$1" token company_id payload resp rc title desc id reason failures severity

  token="$(board_token)"
  [ -n "$token" ] || { warn "no board token in $PG_RECOVER_TOKEN_FILE — cannot file board alert"; return 1; }

  if [ -n "${PG_RECOVER_COMPANY_ID:-}" ]; then
    company_id="$PG_RECOVER_COMPANY_ID"
  else
    company_id="$(curl -sS --max-time 10 -H "Authorization: Bearer $token" "$PG_RECOVER_API_BASE/companies" 2>/dev/null \
      | jq -r --arg n "$PG_RECOVER_COMPANY_NAME" 'map(select(.name == $n))[0].id // empty' 2>/dev/null || true)"
  fi
  [ -n "$company_id" ] || { warn "could not resolve board company id — cannot file board alert"; return 1; }

  reason="$(printf '%s' "$json" | jq -r '.reason // ""')"
  failures="$(printf '%s' "$json" | jq -r '(.consecutive_failed_starts // 0) | tostring')"
  severity="$(printf '%s' "$json" | jq -r '.severity // "high"')"

  if [ "$reason" = "panic" ]; then
    title="[auto-alert] embedded Postgres PANIC on start (WAL corruption class)"
  else
    title="[auto-alert] embedded Postgres failed to start ${failures} times"
  fi

  desc="$(alert_description "$json")"

  payload="$(jq -n \
    --arg title "$title" --arg desc "$desc" --arg severity "$severity" \
    --arg assignee "${PG_RECOVER_ALERT_ASSIGNEE_AGENT_ID:-}" \
    --arg parent "${PG_RECOVER_ALERT_PARENT_ISSUE_ID:-}" \
    '{title: $title, description: $desc, status: "todo", priority: $severity}
     + (if $assignee != "" then {assigneeAgentId: $assignee} else {} end)
     + (if $parent != "" then {parentId: $parent} else {} end)')" || {
    warn "failed to build alert payload — will retry next tick"; return 1
  }

  local resp_file
  resp_file="$(mktemp /tmp/pg-recover-board-alert.XXXXXX)"
  resp="$(curl -sS --max-time 15 -o "$resp_file" -w '%{http_code}' \
    -X POST "$PG_RECOVER_API_BASE/companies/$company_id/issues" \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null)" && rc=0 || rc=1
  if [ "$rc" = "0" ] && { [ "$resp" = "200" ] || [ "$resp" = "201" ]; }; then
    id="$(jq -r '.id // empty' "$resp_file" 2>/dev/null || true)"
    rm -f "$resp_file"
    if [ -n "$id" ]; then
      printf '%s' "$id"
      return 0
    fi
  fi
  rm -f "$resp_file"
  warn "board alert POST failed (HTTP ${resp:-unreachable}) — will retry on the next tick (no re-page: flag only set on success)"
  return 1
}

escalate() { # <reason-class> <detail> — fires each channel once per incident
  local json id rc
  json="$(alert_json "$1" "$2")"

  if [ "$(sget alerted_page)" != "true" ]; then
    deliver_page "$json"; rc=$?
    if [ "$rc" = "0" ]; then
      sset alerted_page true
      log "ESCALATION: page delivered (reason=$1)"
    elif [ "$rc" = "3" ]; then
      log "ESCALATION: no page transport configured (PG_RECOVER_PAGE_CMD unset) — board alert only"
    else
      warn "page transport failed — will retry next tick"
    fi
  fi

  if [ "$(sget alerted_board)" != "true" ]; then
    if [ -n "${PG_RECOVER_ALERT_FILE:-}" ]; then
      log "drill mode (PG_RECOVER_ALERT_FILE set) — board alert suppressed (payload captured in the drill file)"
    elif id="$(board_alert "$json")"; then
      sset alerted_board true
      sset alert_issue_id "\"$id\""
      log "ESCALATION: board alert issue filed (id=$id, reason=$1)"
    fi
  fi
}

backoff_active() {
  [ "$(sget backoff)" = "true" ]
}

# ------------------------------------------------------------- window lock

# True when ANOTHER process holds an exclusive flock on PG_RECOVER_WINDOW_LOCK
# (the cutover window). Self-competing ticks never take the lock: a tick that
# wins the probe flock releases it immediately and proceeds normally.
#
# Cross-user open mode: the window runs as root, this watchdog as the
# paperclip user, and both must open the SAME file. Whoever creates it first
# does so 0666 (umask-defeated below; the window script does the same). The
# probe only needs a readable fd — flock(2) accepts LOCK_EX on O_RDONLY
# descriptors on Linux — so a restrictive-mode leftover owned by root still
# probes correctly via the read-only fallback.
#
# Cross-generation interop: the v2 window scripts ALSO write the epoch
# timestamp on line 1 of the lock file while they hold the flock. That line is
# what the INTERIM watchdog generation deployed 2026-08-31 (pre-flock) reads
# and stands down on; THIS generation defers on the flock itself and treats
# the file content as opaque. A leftover file with a fresh epoch but NO flock
# (crashed window) therefore does NOT defer a tick here — recovery stays
# prompt, and the interim generation self-heals once the epoch goes stale.
#
# Fail-open by design: if the lock path cannot be opened at all we warn and
# PROCEED. The watchdog's primary job is recovering a genuinely dead cluster;
# an unprobeable lock file must not be able to suppress recovery forever. A
# HELD lock, by contrast, always defers (the normal, expected case), and every
# deferral logs a line, so a permanently-held lock is visible in the log.
window_lock_held() {
  local lock="$PG_RECOVER_WINDOW_LOCK"
  # Open READ-ONLY first: probing must not CREATE protocol state. A write-mode
  # open would materialize an empty lock file at the default path whenever a
  # tick runs without a window (the interim watchdog generation then reads an
  # empty line 1). flock(2) takes LOCK_EX on O_RDONLY descriptors on Linux, so
  # the probe still detects a held lock; the write-mode fallback with the
  # 0666 create only runs when a restrictive-mode file owned by root blocks
  # even the read open.
  if ! { exec 9<"$lock"; } 2>/dev/null; then
    if [ ! -e "$lock" ]; then
      return 1   # no lock file -> no window can hold one
    fi
    ( umask 000; : >>"$lock" ) 2>/dev/null || true
    chmod 0666 "$lock" 2>/dev/null || true
    if ! { exec 9<"$lock"; } 2>/dev/null; then
      warn "window lock ${lock} not openable — cannot probe; proceeding (fail-open)"
      return 1
    fi
  fi
  if flock -n 9 2>/dev/null; then
    flock -u 9 2>/dev/null || true
    { exec 9>&-; } 2>/dev/null || true
    return 1   # nobody holds it — window not in progress
  fi
  { exec 9>&-; } 2>/dev/null || true
  return 0    # held by another process — defer
}

# ------------------------------------------------------------- subcommands

cmd_status() {
  echo "port $PG_RECOVER_PORT: $(port_up && echo LISTENING || echo down)"
  echo "state file: $PG_RECOVER_STATE"
  [ -f "$PG_RECOVER_STATE" ] && jq . "$PG_RECOVER_STATE" 2>/dev/null || echo "{}"
  echo "stamp: $(cat "$PG_RECOVER_STAMP" 2>/dev/null || echo none)"
}

cmd_clear_state() {
  state_init
  printf '{}' > "$PG_RECOVER_STATE"
  log "manual clear-state: backoff/alert state reset — recovery attempts re-armed"
  stamp "cleared"
  echo "state cleared" >&2
}

cmd_page_test() { # pure drill: DRILL payload through deliver_page(); NO state I/O
  local json rc branch
  # Same field shape as alert_json(), but no sget()/state reads: a drill must
  # neither depend on nor disturb the incident state (fixed zero counters).
  json="$(jq -n \
    --arg ts "$(now)" \
    --arg host "$(hostname 2>/dev/null || echo unknown)" \
    --arg detail "DRILL — planned page-path verification, no outage" \
    --arg runbook "$PG_RECOVER_RUNBOOK_REF" \
    --arg port "$PG_RECOVER_PORT" \
    --arg max "$PG_RECOVER_MAX_FAILURES" \
    --arg datadir "$PG_RECOVER_DATA_DIR" \
    --arg logpath "$PG_RECOVER_LOG" \
    '{severity: "high", source: "pg-recover.sh page-test (manual drill)",
      host: $host, detected_at: $ts, reason: "drill", detail: $detail,
      consecutive_failed_starts: 0, max_consecutive_failed_starts: ($max | tonumber),
      first_failure_at: null, port: ($port | tonumber), data_dir: $datadir,
      log_path: $logpath, log_tail: "", runbook_ref: $runbook}')"

  # Mirror deliver_page()'s precedence so the operator sees which branch fires.
  if [ -n "${PG_RECOVER_ALERT_FILE:-}" ]; then
    branch="alert file (PG_RECOVER_ALERT_FILE=$PG_RECOVER_ALERT_FILE)"
  elif [ -n "${PG_RECOVER_PAGE_CMD:-}" ]; then
    branch="page transport (PG_RECOVER_PAGE_CMD)"
  else
    branch="none (no PG_RECOVER_ALERT_FILE and no PG_RECOVER_PAGE_CMD)"
  fi
  echo "page-test: transport branch: $branch"

  deliver_page "$json"
  rc=$?
  case "$rc" in
    0) echo "page-test: rc=0 — page delivered" ;;
    3) echo "page-test: rc=3 — no page transport configured (set PG_RECOVER_PAGE_CMD)" ;;
    *) echo "page-test: rc=$rc — page transport failed (a real incident would retry on later ticks)" ;;
  esac
  return "$rc"
}

# --------------------------------------------------------------- main tick

cmd_tick() {
  # 0. Cutover window holding the lock? Checked before anything else —
  #    including state_init: a deferral must update nothing at all.
  if window_lock_held; then
    log "window lock held — deferring recovery tick"
    exit 0
  fi

  state_init

  # 1. Healthy? (the only automatic reset)
  if port_up; then
    if [ -n "$(sget backoff)" ] || [ -n "$(sget consecutive_failures)" ]; then
      log "recovered: port $PG_RECOVER_PORT listening — clearing failure/alert state"
    fi
    printf '{}' > "$PG_RECOVER_STATE"
    stamp "already-up"
    exit 0
  fi

  # 2. Live postmaster with port not up yet: startup in progress, no-op.
  if [ -f "$PG_RECOVER_DATA_DIR/postmaster.pid" ]; then
    local pid
    pid="$(head -1 "$PG_RECOVER_DATA_DIR/postmaster.pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      log "pidfile PID $pid ALIVE; startup in progress — refusing to start (avoid double postmaster)"
      stamp "alive-pid-$pid"
      exit 0
    fi
    log "removing stale pidfile (dead PID $pid)"
    rm -f "$PG_RECOVER_DATA_DIR/postmaster.pid"
  fi

  [ -x "$PG_RECOVER_POSTGRES_BIN" ] || die "postgres binary not found/executable: $PG_RECOVER_POSTGRES_BIN"
  [ -d "$PG_RECOVER_DATA_DIR" ] || die "data dir not found: $PG_RECOVER_DATA_DIR"

  # 3. Backoff: no start attempts; retry outstanding alert deliveries only.
  if backoff_active; then
    log "backoff active ($(sget reason), $(sget consecutive_failures) failed starts) — NOT starting postgres; clear with: $(basename "$0") clear-state"
    escalate "$(sget reason)" "repeated tick while backoff active"
    stamp "backoff"
    exit 3
  fi

  # 4. Attempt a start. Flags MUST match how the live server launches
  #    postgres: unix-socket-only, socket dir derived the
  #    SAME way the server derives it (never hardcoded — see resolve_socket_dir),
  #    so a watchdog-started postmaster is reachable at the path the control
  #    plane actually connects to, and so it binds NO tcp port (a bind that
  #    would make the old TCP-based port_up() false-green while the real
  #    client path stays broken).
  local lines_before deadline child_pid expected_socket_dir expected_socket_file
  mkdir -p "$(dirname "$PG_RECOVER_LOG")" 2>/dev/null || true
  lines_before="$(wc -l < "$PG_RECOVER_LOG" 2>/dev/null || echo 0)"
  log "starting embedded postgres (attempt $(( $(sget consecutive_failures || echo 0) + 1 )))"

  expected_socket_dir="$(resolve_socket_dir)"
  if [ -z "$expected_socket_dir" ]; then
    die "could not derive expected unix socket directory for $PG_RECOVER_DATA_DIR"
  fi
  mkdir -p "$expected_socket_dir" 2>/dev/null || true
  chmod 0700 "$expected_socket_dir" 2>/dev/null || true
  expected_socket_file="$expected_socket_dir/.s.PGSQL.$PG_RECOVER_PORT"

  # Export for wrapper binaries used by drills/tests (reads $PG_RECOVER_LOG).
  export PG_RECOVER_LOG PG_RECOVER_DATA_DIR PG_RECOVER_PORT
  setsid nohup "$PG_RECOVER_POSTGRES_BIN" -D "$PG_RECOVER_DATA_DIR" -p "$PG_RECOVER_PORT" \
    -c listen_addresses= \
    -c "unix_socket_directories=$expected_socket_dir" \
    -c unix_socket_permissions=0700 >> "$PG_RECOVER_LOG" 2>&1 < /dev/null &
  child_pid=$!
  disown 2>/dev/null || true

  deadline=$(( $(date +%s) + PG_RECOVER_START_WAIT ))
  while ! port_up; do
    if ! kill -0 "$child_pid" 2>/dev/null; then
      break  # postmaster already dead — no point waiting out the window
    fi
    [ "$(date +%s)" -ge "$deadline" ] && break
    sleep 1
  done

  # 4b. No false green (AC5): port_up() alone proves SOME postgres answers
  # a query; also require the socket at the path the server would actually
  # dial exists, so a start that comes up on an unexpected path still counts
  # as a failure rather than a silent "start ok".
  if port_up && [ -S "$expected_socket_file" ]; then
    log "socket $expected_socket_file answering queries — start ok"
    printf '{}' > "$PG_RECOVER_STATE"
    stamp "started"
    exit 0
  elif port_up; then
    warn "postgres is answering but NOT at the server's expected socket $expected_socket_file — treating as a failed start (would not be reachable by the control plane)"
  fi

  # 5. Classify the failure from THIS attempt's new log lines.
  local new_lines reason failures
  new_lines="$(tail -n +"$((lines_before + 1))" "$PG_RECOVER_LOG" 2>/dev/null || true)"
  failures=$(( $(sget consecutive_failures) + 1 ))
  [ -n "$failures" ] || failures=1

  if printf '%s' "$new_lines" | grep -Eq "$PG_RECOVER_CORRUPTION_RE"; then
    reason="panic"
    warn "WAL corruption class detected in this start attempt's log — escalating immediately"
    failures="$PG_RECOVER_MAX_FAILURES"
  else
    reason="consecutive-failures"
    log "start failed ($failures/$PG_RECOVER_MAX_FAILURES)"
  fi

  if [ -z "$(sget first_failure_at)" ]; then
    sset first_failure_at "\"$(now)\""
  fi
  sset consecutive_failures "$failures"
  sset reason "\"$reason\""
  sset last_failure_at "\"$(now)\""

  if [ "$failures" -ge "$PG_RECOVER_MAX_FAILURES" ]; then
    sset backoff true
    warn "ESCALATION threshold reached (reason=$reason, failures=$failures) — stopping recovery attempts"
    escalate "$reason" "threshold reached"
    stamp "backoff"
    exit 3
  fi

  stamp "failed-start"
  exit 1
}

case "${1:-tick}" in
  tick|"")      cmd_tick ;;
  status)       cmd_status ;;
  clear-state)  cmd_clear_state ;;
  alert-desc)   alert_description "$(cat)" ;;
  page-test)    cmd_page_test ;;
  help|-h)
    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "unknown subcommand: $1 (use: tick | status | clear-state | alert-desc | page-test | help)" >&2
    exit 2
    ;;
esac
