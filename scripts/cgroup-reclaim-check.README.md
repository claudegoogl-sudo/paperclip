# paperclip.service memory limits + cgroup reclaim detector

Origin: 2026-08-03 host memory-thrash incident.

## 1. Who owns the systemd unit — determination

**The operator owns it. We do not ship it.** Nothing in any artifact we build
writes, templates, or patches `paperclip.service`.

Paths checked, all with zero matches for `MemoryHigh` / `MemoryMax` /
`Paperclip AI Agent Orchestration` / `paperclip.service`:

| Path | Result |
|---|---|
| `/home/paperclip/upstream-paperclip` (full repo, incl. install/release scripts) | no match |
| `/usr/lib/node_modules/paperclipai/` (the installed CLI, incl. bundled `dist/index.js`) | no match |
| `/usr/lib/node_modules/paperclipai/dist/index.js` for `systemd` / `systemctl` | no match |

The unit was authored by hand on this host. Consequence: **a reinstall or host
upgrade cannot revert the limits, because no installer writes them.** The real
regression risks are `systemctl revert paperclip.service`, a hand-edit, or a
host rebuild from the original provisioning notes.

Because we do not ship it, the deliverable is the runbook below plus a
copy-paste one-liner for the operator — per the ticket's second branch.

## 2. Required values

| Property | Base unit shipped | Live now | Required |
|---|---|---|---|
| `MemoryHigh` | `4G` | 16 GiB | `16G` |
| `MemoryMax`  | `6G` | 20 GiB | `20G` |

Host has 32 GB RAM (`MemTotal: 32865092 kB`).

The live values came from `systemctl set-property` at ~06:21Z on 2026-08-03,
which wrote `/etc/systemd/system.control/paperclip.service.d/50-Memory{High,Max}.conf`.
That *is* persistent across reboot, but it leaves two problems:

1. The base unit at `/etc/systemd/system/paperclip.service` **still says
   `MemoryHigh=4G` / `MemoryMax=6G`** (lines 23-24).
2. `MemoryMax=6G` in the base unit is now far below the service's actual
   working set (~16 GB). A `systemctl revert` would not merely re-throttle the
   service — it would put a hard 6G kill ceiling under a 16 GB process tree and
   **OOM-kill it immediately**. That is a sharper failure than the original
   incident.

The one-liner below removes both problems.

## 3. Operator one-liner (requires root; agents cannot run this)

Idempotent — safe to re-run. Writes the drop-in *before* removing anything, so
the effective limit is never lowered at any point during execution.

```bash
sudo install -d /etc/systemd/system/paperclip.service.d && printf '# incident fix: do not lower. 4G caused cgroup-local direct reclaim on 2026-08-03.\n[Service]\nMemoryHigh=16G\nMemoryMax=20G\n' | sudo tee /etc/systemd/system/paperclip.service.d/60-memory-limits.conf >/dev/null && sudo sed -i 's/^MemoryHigh=4G$/MemoryHigh=16G/;s/^MemoryMax=6G$/MemoryMax=20G/' /etc/systemd/system/paperclip.service && sudo rm -f /etc/systemd/system.control/paperclip.service.d/50-MemoryHigh.conf /etc/systemd/system.control/paperclip.service.d/50-MemoryMax.conf && sudo systemctl daemon-reload && systemctl show paperclip.service -p MemoryHigh -p MemoryMax -p MemoryCurrent
```

Expected final output:

```
MemoryHigh=17179869184
MemoryMax=21474836480
MemoryCurrent=<some value below MemoryHigh>
```

No restart is required. `daemon-reload` reapplies cgroup properties to the
running unit, and the drop-in carries the same values that are already live.

## 4. The detector

`cgroup-reclaim-check.sh` — reads `memory.stat` and `memory.events` from the
service cgroup and alerts on **deltas**. Both counters are monotonic since
boot; a large absolute `pgscan_direct` is normal and means nothing.

Two alert conditions:

- **A — cgroup-local direct reclaim**: `pgscan_direct` rate over threshold
  *while the cgroup's own `pgscan_kswapd` delta is 0*. The kswapd clause is the
  discriminator: real host-wide memory pressure drives this cgroup's
  `pgscan_kswapd` up too, so kswapd == 0 means the pressure is coming from our
  own cap, not from the host.
- **B — active MemoryHigh throttling**: `memory.events` `high` counter rising.

Firing requires **10 breaches within a rolling 15-sample window**, so isolated
bursts do not page. A separate non-paging `WARN` tier surfaces single breaches
so a cap that is starting to bind is visible before it becomes an incident.

Thresholds are grounded in measured data, not guessed:

| State | `high` delta | Source |
|---|---|---|
| Incident (`MemoryHigh=4G`) | 750-5,700/min sustained 20+ min | incident sampler |
| Healthy (`MemoryHigh=16G`) | 0/min for hours | same |
| Marginal (near cap) | 150-550/min, isolated | same + live |

`ALERT` at 500/min, `WARN` at 100/min.

Exit codes: `0` = OK or WARN, `1` = ALERT, `2` = cgroup unreadable / bad args.
On alert it writes `cgroup-reclaim-check.alert` and prints to stderr, so cron
surfaces it. The alert file is removed automatically on recovery.

### Schedule

```
* * * * * /home/paperclip/scripts/cgroup-reclaim-check.sh --quiet
```

Cost is three small `/sys` reads per minute. It never writes outside its own
state/log/alert files and never mutates the cgroup.

### Files

- state: `~/.paperclip/instances/default/cgroup-reclaim-check.state` (bounded to 15 lines)
- log: `~/.paperclip/instances/default/logs/cgroup-reclaim-check.log`
- alert: `~/.paperclip/instances/default/cgroup-reclaim-check.alert` (present only while alerting)

### Testing

`cgroup-reclaim-check.test.sh` replays the real recorded incident counters (committed
under `testdata/`) through
the checker. Controls 1 and 3 are positive (must fire), 2, 4 and 5 are negative
(must not fire / must recover).

## 5. Known open item

As of 2026-08-03T09:45Z the service is running at `memcur` ≈ 16.0 GiB against a
16 GiB `MemoryHigh`, and the `high` counter is incrementing again at
~350-550/min. The 2026-08-03 fix moved the wall; the workload has since grown
to meet it. Raising the cap again is not the answer — bounding concurrent agent
runs is, which the host-concurrency parent task covers. The detector's `WARN`
tier is currently active and is the intended early signal for exactly this.
