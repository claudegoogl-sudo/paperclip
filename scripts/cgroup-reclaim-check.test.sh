#!/bin/bash
# Control suite for cgroup-reclaim-check.sh.
#
# Controls 1 and 2 replay REAL counters recorded from the paperclip.service
# cgroup across the 2026-08-03 memory-thrash incident and the operator's
# ~06:21Z fix (testdata/cgroup-reclaim-incident-2026-08-03.tsv). Controls 3-5
# are synthetic and cover the pgscan_direct arm, the host-wide-pressure
# discriminator, and counter reset.
#
# An alert that has never been seen to fire has proven nothing, so 1 and 3 must
# fire and 2, 4 and 5 must not. Self-contained: no root, no live cgroup.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHECK=$HERE/cgroup-reclaim-check.sh
DATA=$HERE/testdata/cgroup-reclaim-incident-2026-08-03.tsv
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
FIX=$WORK/fixture; STATE=$WORK/state; LOG=$WORK/log; ALERT=$WORK/alert

pass=0; fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail+1)); }

reset_fixture() { rm -rf "$FIX" "$STATE" "$LOG" "$ALERT"; mkdir -p "$FIX"; }
write_sample() {
  printf 'pgscan_kswapd %s\npgscan_direct %s\n' "$2" "$1" > "$FIX/memory.stat"
  printf 'low 0\nhigh %s\nmax 0\noom 0\n' "$3" > "$FIX/memory.events"
  printf '%s\n' "$4" > "$FIX/memory.current"
}
run() { "$CHECK" --cgroup "$FIX" --state "$STATE" --log "$LOG" --alert-file "$ALERT" --now "$1" --quiet 2>/dev/null; }
state_of() { tail -n1 "$LOG" | grep -oE '(OK|WARN|ALERT|BOOTSTRAP|RESET)'; }

# replay <glob-pattern> <start-epoch>; sets FIRST_ALERT and REPLAY_END.
# Runs in the current shell (no command substitution) so both escape.
replay() {
  local pat=$1 t=$2
  FIRST_ALERT=""
  while read -r ts high memcur; do
    case "$ts" in \#*) continue ;; esac
    eval "case \"\$ts\" in $pat) ;; *) continue ;; esac"
    write_sample 0 0 "$high" "$memcur"
    run "$t"
    [ $? -eq 1 ] && [ -z "$FIRST_ALERT" ] && FIRST_ALERT=$ts
    t=$((t+60))
  done < "$DATA"
  REPLAY_END=$t
}

echo "== Control 1 (positive): real incident window 06:00-06:21Z, MemoryHigh=4G"
reset_fixture
replay '2026-08-03T06:0*|2026-08-03T06:1*|2026-08-03T06:2[01]*' 1000000
[ -n "$FIRST_ALERT" ] && ok "ALERT fired at $FIRST_ALERT" || bad "did not fire on real incident data"
[ -s "$ALERT" ] && ok "alert file written" || bad "alert file missing"

echo "== Control 2 (negative): real post-fix window 06:22-06:59Z, MemoryHigh=16G"
replay '2026-08-03T06:2[2-9]*|2026-08-03T06:[3-5]*' "$REPLAY_END"
[ "$(state_of)" = "OK" ] && ok "recovered to OK after the fix" || bad "stuck in $(state_of) after the fix"
[ -e "$ALERT" ] && bad "alert file not cleared on recovery" || ok "alert file cleared on recovery"

echo "== Control 3 (positive): pgscan_direct arm with cgroup pgscan_kswapd == 0"
reset_fixture; t=2000000; d=1000000
for _ in $(seq 1 14); do d=$((d+900000)); write_sample "$d" 0 5000 4000000000; run "$t"; t=$((t+60)); done
[ "$(state_of)" = "ALERT" ] && ok "ALERT on sustained direct reclaim" || bad "expected ALERT, got $(state_of)"

echo "== Control 4 (negative): host-wide pressure (pgscan_kswapd also rising)"
reset_fixture; t=3000000; d=1000000; k=500000
for _ in $(seq 1 14); do d=$((d+900000)); k=$((k+400000)); write_sample "$d" "$k" 5000 4000000000; run "$t"; t=$((t+60)); done
[ "$(state_of)" = "ALERT" ] && bad "fired on host-wide pressure (should be cgroup-local only)" \
  || ok "ignored host-wide pressure, got $(state_of)"

echo "== Control 5 (negative): counter reset from reboot/restart"
write_sample 1 0 1 4000000000; run "$((t+60))"
[ "$(state_of)" = "RESET" ] && ok "reset without alerting" || bad "expected RESET, got $(state_of)"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
