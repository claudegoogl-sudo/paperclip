#!/bin/bash
# cgroup-local direct-reclaim / MemoryHigh-throttle detector for paperclip.service.
#
# Detects the 2026-08-03 host memory-thrash failure mode: the service cgroup
# is capped below its working set, so its own allocations go into synchronous
# direct reclaim. The kernel bills those stalls to iowait, so the host looks
# CPU/IO-bound while RAM is free. Host-level reclaim never runs, which is why
# the cgroup's own pgscan_kswapd stays at exactly 0 while pgscan_direct climbs.
#
# Both counters are monotonic since boot, so every decision here is on the
# DELTA between consecutive samples. Absolute values are meaningless.
#
# Safe to re-run: state is a bounded rolling window, writes are atomic, and a
# counter going backwards (reboot / service restart) resets rather than alerts.

set -uo pipefail

CGROUP=/sys/fs/cgroup/system.slice/paperclip.service
STATE=/home/paperclip/.paperclip/instances/default/cgroup-reclaim-check.state
LOG=/home/paperclip/.paperclip/instances/default/logs/cgroup-reclaim-check.log
ALERT_FILE=/home/paperclip/.paperclip/instances/default/cgroup-reclaim-check.alert

# Rolling window: keep WINDOW samples, ALERT when >=BREACHES of them breach.
# At the default 1/min cron cadence that is "10 of the last 15 minutes".
WINDOW=15
BREACHES=10

# Thresholds are per 60s, derived from measured data (see the 2026-08-03 incident):
#   incident (MemoryHigh=4G):  events_high 750-5700/min sustained 20+ min
#   healthy  (MemoryHigh=16G): events_high 0/min for hours, with isolated
#                              150-520/min bursts when memcur nears the cap
# ALERT must clear the incident band while ignoring isolated bursts; WARN
# surfaces the bursts so a cap that is becoming binding is visible early.
HIGH_RATE_ALERT=500
DIRECT_RATE_ALERT=500000
HIGH_RATE_WARN=100
DIRECT_RATE_WARN=100000

QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --cgroup) CGROUP=$2; shift 2 ;;
    --state) STATE=$2; shift 2 ;;
    --log) LOG=$2; shift 2 ;;
    --alert-file) ALERT_FILE=$2; shift 2 ;;
    --window) WINDOW=$2; shift 2 ;;
    --breaches) BREACHES=$2; shift 2 ;;
    --high-rate-alert) HIGH_RATE_ALERT=$2; shift 2 ;;
    --direct-rate-alert) DIRECT_RATE_ALERT=$2; shift 2 ;;
    --now) NOW_OVERRIDE=$2; shift 2 ;;   # test hook: fixed epoch for replay
    --quiet) QUIET=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ ! -r "$CGROUP/memory.stat" ] || [ ! -r "$CGROUP/memory.events" ]; then
  echo "$(date -Is) ERROR cgroup unreadable: $CGROUP" >&2
  exit 2
fi

now=${NOW_OVERRIDE:-$(date +%s)}
direct=$(awk '/^pgscan_direct /{print $2}' "$CGROUP/memory.stat")
kswapd=$(awk '/^pgscan_kswapd /{print $2}' "$CGROUP/memory.stat")
high=$(awk '/^high /{print $2}' "$CGROUP/memory.events")
memcur=$(cat "$CGROUP/memory.current" 2>/dev/null || echo 0)
: "${direct:=0}" "${kswapd:=0}" "${high:=0}"

mkdir -p "$(dirname "$STATE")" "$(dirname "$LOG")"

# State: one sample per line -> "epoch direct kswapd high breach"
prev=$(tail -n 1 "$STATE" 2>/dev/null)

emit() { [ "$QUIET" = 1 ] || echo "$1"; echo "$1" >> "$LOG"; }

if [ -z "$prev" ]; then
  printf '%s %s %s %s 0\n' "$now" "$direct" "$kswapd" "$high" >> "$STATE"
  emit "$(date -Is -d @"$now") BOOTSTRAP direct=$direct kswapd=$kswapd high=$high"
  exit 0
fi

read -r p_ts p_direct p_kswapd p_high _ <<< "$prev"

# Counter went backwards => reboot or service restart. Reset, never alert.
if [ "$direct" -lt "$p_direct" ] || [ "$high" -lt "$p_high" ]; then
  printf '%s %s %s %s 0\n' "$now" "$direct" "$kswapd" "$high" > "$STATE"
  emit "$(date -Is -d @"$now") RESET counters went backwards (restart/reboot); window cleared"
  exit 0
fi

dt=$(( now - p_ts ))
[ "$dt" -le 0 ] && dt=60

d_direct=$(( direct - p_direct ))
d_kswapd=$(( kswapd - p_kswapd ))
d_high=$(( high - p_high ))

# Normalise to a per-60s rate so cron jitter / missed runs don't skew thresholds.
r_direct=$(( d_direct * 60 / dt ))
r_high=$(( d_high * 60 / dt ))

# Condition A: cgroup-local direct reclaim. The kswapd==0 clause is what makes
# this cgroup-local rather than host-wide memory pressure -- host-wide pressure
# would drive this cgroup's pgscan_kswapd up too.
breach_a=0
[ "$r_direct" -ge "$DIRECT_RATE_ALERT" ] && [ "$d_kswapd" -eq 0 ] && breach_a=1

# Condition B: the service is being actively throttled at MemoryHigh.
breach_b=0
[ "$r_high" -ge "$HIGH_RATE_ALERT" ] && breach_b=1

breach=0
[ "$breach_a" = 1 ] || [ "$breach_b" = 1 ] && breach=1

printf '%s %s %s %s %s\n' "$now" "$direct" "$kswapd" "$high" "$breach" >> "$STATE"

# Trim to the rolling window atomically.
tail -n "$WINDOW" "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"

n_breach=$(awk '{s+=$5} END{print s+0}' "$STATE")
n_samples=$(wc -l < "$STATE")

warn=0
{ [ "$r_high" -ge "$HIGH_RATE_WARN" ] || { [ "$r_direct" -ge "$DIRECT_RATE_WARN" ] && [ "$d_kswapd" -eq 0 ]; }; } && warn=1

stamp=$(date -Is -d @"$now")
detail="direct_rate=${r_direct}/min high_rate=${r_high}/min kswapd_delta=${d_kswapd} memcur=$(( memcur / 1048576 ))MiB breaches=${n_breach}/${n_samples}"

if [ "$n_breach" -ge "$BREACHES" ]; then
  msg="$stamp ALERT cgroup-local direct reclaim / MemoryHigh throttling on $CGROUP -- $detail"
  emit "$msg"
  echo "$msg" > "$ALERT_FILE"
  echo "$msg" >&2
  exit 1
fi

rm -f "$ALERT_FILE"
if [ "$warn" = 1 ]; then
  emit "$stamp WARN approaching MemoryHigh (not yet sustained) -- $detail"
  exit 0
fi

emit "$stamp OK $detail"
exit 0
