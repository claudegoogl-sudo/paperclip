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
#   1. Port already listening -> healthy. Clears the failure counter and any
#      active alert state. No alert, no restart. (A healthy observation is the
#      ONLY automatic reset.)
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
#      detached, wait up to PG_RECOVER_START_WAIT for the port to accept
#      connections.
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
#   help
#
# Exit codes (tick):
#   0  healthy / no-op (already up, or startup still in progress)
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

port_up() { (exec 3<>"/dev/tcp/127.0.0.1/$PG_RECOVER_PORT") 2>/dev/null; }

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

board_alert() { # <json> — echoes issue id on success, rc 1 otherwise
  local json="$1" token company_id payload resp rc title desc id
  local ahost reason detail failures maxf first detected port datadir logpath logtail runbook severity

  token="$(board_token)"
  [ -n "$token" ] || { warn "no board token in $PG_RECOVER_TOKEN_FILE — cannot file board alert"; return 1; }

  if [ -n "${PG_RECOVER_COMPANY_ID:-}" ]; then
    company_id="$PG_RECOVER_COMPANY_ID"
  else
    company_id="$(curl -sS --max-time 10 -H "Authorization: Bearer $token" "$PG_RECOVER_API_BASE/companies" 2>/dev/null \
      | jq -r --arg n "$PG_RECOVER_COMPANY_NAME" 'map(select(.name == $n))[0].id // empty' 2>/dev/null || true)"
  fi
  [ -n "$company_id" ] || { warn "could not resolve board company id — cannot file board alert"; return 1; }

  # Field extraction: one `jq -r` per field. The former TSV roundtrip
  # (jq to-tabbed-value, then IFS=tab read) broke the alert body twice:
  # the tab escaping turns real newlines in the log tail into the two
  # characters backslash-n (rendered literally in the filed description),
  # and a whitespace IFS collapses EMPTY fields so every later field shifts
  # left. Separate calls keep newlines real and every field in its own slot.
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

  if [ "$reason" = "panic" ]; then
    title="[auto-alert] embedded Postgres PANIC on start (WAL corruption class)"
  else
    title="[auto-alert] embedded Postgres failed to start ${failures} times"
  fi

  desc="$(cat <<DESC
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
)"

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

# --------------------------------------------------------------- main tick

cmd_tick() {
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

  # 4. Attempt a start.
  local lines_before deadline child_pid
  mkdir -p "$(dirname "$PG_RECOVER_LOG")" 2>/dev/null || true
  lines_before="$(wc -l < "$PG_RECOVER_LOG" 2>/dev/null || echo 0)"
  log "starting embedded postgres (attempt $(( $(sget consecutive_failures || echo 0) + 1 )))"

  # Export for wrapper binaries used by drills/tests (reads $PG_RECOVER_LOG).
  export PG_RECOVER_LOG PG_RECOVER_DATA_DIR PG_RECOVER_PORT
  setsid nohup "$PG_RECOVER_POSTGRES_BIN" -D "$PG_RECOVER_DATA_DIR" -p "$PG_RECOVER_PORT" \
    -c listen_addresses=127.0.0.1 >> "$PG_RECOVER_LOG" 2>&1 < /dev/null &
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

  if port_up; then
    log "port $PG_RECOVER_PORT listening — start ok"
    printf '{}' > "$PG_RECOVER_STATE"
    stamp "started"
    exit 0
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
  help|-h)
    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "unknown subcommand: $1 (use: tick | status | clear-state | help)" >&2
    exit 2
    ;;
esac
