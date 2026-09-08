# Manual Run-Row Reap Runbook

Operational runbook for manually reaping a stuck `heartbeat_runs` row (marking a `running` run `interrupted`/`failed` by hand). Written after the 2026-09-07 b67c6c10 incident, where a live run in a ~2h model-provider stall was reaped as `interrupted` and then completed with `Exit code: 0` two minutes later.

**Prime rule: a silent log tail is not death evidence.** A dead spawn produces an explicit error; a provider stall produces silence. Never reap on silence alone.

## Step 0 — Probe the liveness API FIRST

Before touching the row, get an authoritative liveness answer in one call:

```
GET /api/heartbeat-runs/:runId
```

For a `running` row the response carries a machine-readable `livenessProbe`:

```json
{
  "livenessProbe": {
    "hasInMemoryHandle": true,
    "processPidAlive": null,
    "processGroupAlive": null,
    "occupiesHostSlot": true
  }
}
```

Field semantics:

- `hasInMemoryHandle` — the host process still holds this run in its in-memory execution registry. **True means live.** This covers adapters whose child pid is not recorded on the row (e.g. `prime_local` before the onSpawn-forwarding fix): a provider stall keeps the handle, so the probe reads live.
- `processPidAlive` / `processGroupAlive` — OS-level process / process-group liveness for adapters that track a local child (`claude_local`, `codex_local`, `pi_local`, ...). `null` means "not tracked for this adapter", **never dead**.
- `occupiesHostSlot` — the same verdict the host-slot accounting and the reaper use. If it is `true`, the reaper will not reap the row, and neither should you.

**Decision:** any `true` field, or the row not `running` → do not reap; the run is live or already terminal. All fields false/null **and** `occupiesHostSlot: false` → the row is orphaned; proceed to Step 1 for death evidence.

## Step 1 — Log-tail discriminator

Read the run's ndjson log tail. Classification:

| Observation | Meaning |
| --- | --- |
| Explicit `error` / `adapter_failed` / process-exit event | Death evidence. Reap allowed. |
| Log ends **before** the "message sent to model" marker, with no error event | Dead spawn (never reached the provider). Death evidence. Reap allowed. |
| Silence **after** "message sent to model" | Provider stall — the model call is pending. **NOT death evidence. Do not reap.** A single giant gap that later resolves (stall-then-recover) is the known stall signature. |

## Step 2 — Re-read the log tail immediately before the write

The b67c6c10 reap fired **19 seconds after** the log had already resumed. Evidence goes stale in seconds. Re-run the tail read (Step 1) in the same shell session, immediately before the UPDATE, and re-check the liveness probe. If the log resumed or the probe flipped to live since Step 1, stop — the run recovered on its own.

## Step 3 — Guarded UPDATE with backup and provenance

1. **Full row backup first:**

   ```sql
   CREATE TABLE heartbeat_runs_reap_backup_<shortid> AS
   SELECT * FROM heartbeat_runs WHERE id = '<runId>';
   ```

2. **Agent-provenance banner (binding policy):** any agent-authored reap must be logged with an agent-provenance banner naming the agent, company/urlKey, and run id, stating "agent action — NOT an operator decision", and recorded on the linked incident issue in the same session.

3. **Guarded, re-verifying UPDATE** — the `WHERE` re-asserts the state you probed, so a run that finished between probe and write is not clobbered:

   ```sql
   UPDATE heartbeat_runs
   SET status = 'interrupted',
       finished_at = now(),
       error_code = 'manual_reap',
       error_message = 'Manual reap by <agent> — death evidence: <one-line reason>, probe negative at <iso-ts>, log tail re-read at <iso-ts>'
   WHERE id = '<runId>'
     AND status = 'running'
   RETURNING id, status, finished_at;
   ```

   **Zero rows returned = the run changed state under you.** Re-probe; do not force it.

4. **Incident record:** post the before/after row backup, the probe output, the log-tail evidence, and the banner on the incident issue.

## Cross-company rule

Do **not** self-reap another company's run row — you likely cannot even read it (out-of-company reads are a uniform 404), and a write you can force is still not yours to make. File a `[plugin-support]` issue to Platform with the run id, the observed symptom, and (if readable) the probe output; Platform coordinates with the owning company.

## Related

- `deploy/dev-plane-restart-hygiene.md` — restart bursts and `process_lost` recovery.
- Liveness probe API fields: `GET /api/heartbeat-runs/:runId` → `livenessProbe`.
