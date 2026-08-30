#!/usr/bin/env bash
#
# pg-recover-page-telegram.sh — board-independent page transport for the
# pg-recover watchdog (PG_RECOVER_PAGE_CMD).
#
# Why a dedicated transport: when the embedded postgres is down hard, the
# Paperclip board is usually down with it, so the watchdog's board alert can
# never reach a human. This script pages the operator DIRECTLY via the
# Telegram Bot API and depends on nothing but the alert JSON on stdin and a
# 0600 credentials file on disk.
#
# Watchdog wiring (the crontab line stays a minimal assignment; a literal %
# truncates a crontab command line, and heavy quoting inside crontab is
# fragile):
#
#   PG_RECOVER_PAGE_CMD=<this script>
#
# deliver_page() runs it as:
#   printf '%s' "$json" | bash -c "$PG_RECOVER_PAGE_CMD"
# i.e. the alert JSON arrives on stdin, with no arguments.
#
# Exit codes (the deliver_page() rc contract):
#   0  delivered  — HTTP 2xx AND body ok:true AND message_id parsed
#   1  failed     — an HTTP response arrived, but non-2xx or ok:false
#   2  transport failure — curl itself failed (DNS, timeout, refused, TLS)
#   3  no transport configured — env file missing/unreadable, wrong file
#      mode (0600 required; 0400 accepted), or bot token / chat id missing,
#      empty, or malformed in it
#
# Observability: every attempt appends exactly ONE line to the watchdog log
# file ${PG_RECOVER_LOG:-~/.paperclip/instances/default/logs/pg-recover.log}:
#
#   [<ts>] [pg-recover-page-telegram] sent ok=true http=200 message_id=12345
#   [<ts>] [pg-recover-page-telegram] sent ok=false http=401
#
# The line goes to the log FILE only, never to stdout/stderr: the watchdog
# cron discards stderr (`>/dev/null 2>&1`), and on page-retry ticks the
# watchdog does NOT export PG_RECOVER_LOG to this child — hence the default
# path is repeated here.
#
# Message content: one short page — reason phrase, failed-start counter,
# host, detection time, and the payload's runbook pointer. A payload with
# reason "drill" is labeled [DRILL]. The message NEVER carries the log tail
# or any credential. Hard cap 3800 chars (Telegram allows 4096).
#
# Token exposure (accepted, flagged for the security sign-off): the Telegram
# Bot API carries the token in the request URL path. To keep it out of `ps`
# output, the URL is passed to curl via a `-K` config fed by process
# substitution, so curl's argv contains only a /dev/fd/N path — never the
# token. The token still transits the request URL toward the Bot API over
# TLS; that part is inherent to the Telegram API and not avoidable
# client-side. Because the URL is built inside that `-K` config line with
# the token embedded un-escaped, the token is validated on load against the
# BotFather shape ^[0-9]+:[A-Za-z0-9_-]+$ — a value that could carry
# curl-config metacharacters (`"`, `\`, newline) fails closed with rc 3.
#
# Configuration (environment):
#   PG_RECOVER_PAGE_TELEGRAM_ENV        credentials file (default
#                                       ~/.paperclip/secrets/pg-recover-page-telegram.env),
#                                       chmod 0600 (0400 accepted), staged by
#                                       the operator — any other mode fails
#                                       closed with rc 3:
#                                         PG_RECOVER_PAGE_TELEGRAM_BOT_TOKEN=123456:AAA...
#                                         PG_RECOVER_PAGE_TELEGRAM_CHAT_ID=5145760634
#   PG_RECOVER_PAGE_TELEGRAM_API_BASE   Bot API base (default
#                                       https://api.telegram.org); override
#                                       to a stub server for drills/tests
#   PG_RECOVER_LOG                      watchdog log file (default
#                                       ~/.paperclip/instances/default/logs/pg-recover.log)
#
# Idempotency: one invocation sends exactly ONE message and mutates nothing
# beyond appending its one log line; re-runs converge. Retry/backoff policy
# lives entirely in the watchdog (deliver_page/escalate).
#
# Co-Authored-By: Paperclip <noreply@paperclip.ing> (repo convention)

# shellcheck shell=bash
set -u

API_BASE="${PG_RECOVER_PAGE_TELEGRAM_API_BASE:-https://api.telegram.org}"
ENV_FILE="${PG_RECOVER_PAGE_TELEGRAM_ENV:-$HOME/.paperclip/secrets/pg-recover-page-telegram.env}"
LOG_FILE="${PG_RECOVER_LOG:-$HOME/.paperclip/instances/default/logs/pg-recover.log}"
readonly MAX_TEXT=3800   # hard cap below Telegram's 4096-char sendMessage limit

log_line() { # exactly one line, to the log FILE only (cron discards stderr)
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  printf '[%s] [pg-recover-page-telegram] %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE" 2>/dev/null || true
}

# ---- credentials: sourced ONLY from the staged 0600 env file -------------
if [ ! -r "$ENV_FILE" ]; then
  log_line "no transport: credentials env file missing/unreadable: $ENV_FILE"
  exit 3
fi
# Fail closed on a mis-staged mode. On this single-uid host a mode bit adds
# no actor boundary (every agent shares the uid); the check converts a silent
# misconfiguration into a loud rc 3 and is defense-in-depth for any future
# multi-uid deployment. 0400 is the POSIX read-only equivalent and accepted.
env_mode="$(stat -c %a "$ENV_FILE" 2>/dev/null || true)"
if [ "$env_mode" != "600" ] && [ "$env_mode" != "400" ]; then
  log_line "no transport: credentials env file not 0600: $ENV_FILE"
  exit 3
fi
# shellcheck disable=SC1090
. "$ENV_FILE"
if [ -z "${PG_RECOVER_PAGE_TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${PG_RECOVER_PAGE_TELEGRAM_CHAT_ID:-}" ]; then
  log_line "no transport: bot token or chat id missing/empty in $ENV_FILE"
  exit 3
fi
# BotFather tokens match ^[0-9]+:[A-Za-z0-9_-]+$; the sendMessage URL is
# built inside a `-K` config line with the token embedded un-escaped, so the
# shape is validated BEFORE the token reaches that config. Anyone able to
# write the 0600 file already has code-exec here, so this is hardening, not
# an actor boundary — but it also fails closed on a mis-staged/wrong file.
# The explicit newline check closes the ERE `$`-matches-before-final-newline
# edge (a trailing newline inside the -K quoted value would corrupt the URL).
if ! [[ "$PG_RECOVER_PAGE_TELEGRAM_BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] \
   || [[ "$PG_RECOVER_PAGE_TELEGRAM_BOT_TOKEN" == *$'\n'* ]]; then
  log_line "no transport: bot token format invalid"
  exit 3
fi
BOT_TOKEN="$PG_RECOVER_PAGE_TELEGRAM_BOT_TOKEN"
CHAT_ID="$PG_RECOVER_PAGE_TELEGRAM_CHAT_ID"

# ---- build the page text from the alert JSON -----------------------------
json="$(cat)"

if ! printf '%s' "$json" | jq -e . >/dev/null 2>&1; then
  log_line "sent ok=false http=none error=unreadable-payload"
  exit 1
fi

jf() { printf '%s' "$json" | jq -r "$1"; }   # one jq -r per field (newline-safe, like alert_description())
reason="$(jf '.reason // ""')"
host="$(jf '.host // ""')"
detected="$(jf '.detected_at // ""')"
failures="$(jf '(.consecutive_failed_starts // 0) | tostring')"
maxf="$(jf '(.max_consecutive_failed_starts // 0) | tostring')"
runbook="$(jf '.runbook_ref // ""')"

case "$reason" in
  panic)                phrase="WAL corruption (PANIC) — embedded Postgres recovery stopped" ;;
  consecutive-failures) phrase="embedded Postgres repeatedly failed to start" ;;
  drill)                phrase="planned page-path drill (no outage)" ;;
  *)                    phrase="$reason" ;;
esac
label=""
[ "$reason" = "drill" ] && label="[DRILL] "

text="[pg-recover] ${label}${phrase}
host=${host:-unknown} failed_starts=${failures}/${maxf} detected=${detected:-unknown}
Runbook: ${runbook:-none}"

# Codepoint-safe hard cap (jq counts codepoints; bash substrings count bytes
# in a C locale and could split a multibyte character).
text="$(jq -rn --arg t "$text" --arg m " …[truncated]" --argjson cap "$MAX_TEXT" \
  'if ($t | length) > $cap then $t[0:($cap - ($m | length))] + $m else $t end')"

# ---- exactly ONE sendMessage ---------------------------------------------
resp_file="$(mktemp /tmp/pg-recover-page-tg.XXXXXX)"
trap 'rm -f "$resp_file" 2>/dev/null' EXIT

# Token stays out of argv: -K reads the URL from the /dev/fd/N config (see
# the header note on token exposure).
http_code="$(curl -sS --max-time 15 -o "$resp_file" -w '%{http_code}' \
  -K <(printf 'url = "%s/bot%s/sendMessage"\n' "$API_BASE" "$BOT_TOKEN") \
  --data-urlencode "chat_id=$CHAT_ID" \
  --data-urlencode "text=$text" 2>/dev/null)"
curl_rc=$?

if [ "$curl_rc" -ne 0 ]; then
  log_line "sent ok=false http=none curl_rc=$curl_rc"
  exit 2
fi

ok_flag="$(jq -r '.ok // false' "$resp_file" 2>/dev/null || true)"
message_id="$(jq -r '.result.message_id // empty' "$resp_file" 2>/dev/null || true)"

case "$http_code" in
  2*) if [ "$ok_flag" = "true" ] && [ -n "$message_id" ]; then
        log_line "sent ok=true http=$http_code message_id=$message_id"
        exit 0
      fi ;;
esac

log_line "sent ok=false http=$http_code"
exit 1
