---
title: Instance admission hold
summary: Hold new run starts across the instance while running work drains
---

The instance admission hold stops the scheduler from **starting** queued heartbeat runs. Use it before a planned service stop, so running work can finish first.

The hold is admission-only:

- Queued runs stay queued. The hold does not cancel or skip them.
- Running runs are not touched. They finish normally.
- Wakes still create queued runs. They start when the hold ends.
- The hold ends when you clear it, or when `holdUntil` passes. The server caps `holdUntil` at now + 60 minutes.
- A successful run does not clear the hold. (The usage-limit park is a different control. A successful run clears the park.)

Only an instance-admin board actor can use these routes. Agent keys get `403`.

## Routes

| Method | Path | Body | Result |
|---|---|---|---|
| `GET` | `/api/instance/admission-hold` | — | Current state |
| `PUT` | `/api/instance/admission-hold` | `{ "holdUntil": "<ISO-8601>", "reason": "<1-500 chars>" }` | Sets or replaces the hold |
| `DELETE` | `/api/instance/admission-hold` | — | Clears the hold, then starts queued runs. Safe to re-run. |

The state object:

```json
{
  "held": true,
  "holdUntil": "2026-10-10T14:00:00.000Z",
  "reason": "core install drain",
  "setByActorType": "user",
  "setByActorId": "<user id>",
  "updatedAt": "2026-10-10T13:35:00.000Z"
}
```

`PUT` returns `400` when `holdUntil` is missing, not a timestamp, or in the past, or when `reason` is empty.

## Example: drain before a service stop

```bash
# 1. Hold new starts for up to 25 minutes.
curl -sS -X PUT "$PAPERCLIP_URL/api/instance/admission-hold" \
  -H "Authorization: Bearer $BOARD_TOKEN" -H "Content-Type: application/json" \
  -d "{\"holdUntil\":\"$(date -u -d '+25 min' +%FT%TZ)\",\"reason\":\"core install drain\"}"

# 2. Wait until no run has status "running". Then stop, install, and start the service.

# 3. Clear the hold when the API is back. Queued runs start at once.
curl -sS -X DELETE "$PAPERCLIP_URL/api/instance/admission-hold" \
  -H "Authorization: Bearer $BOARD_TOKEN"
```

If step 3 never runs, the hold expires at `holdUntil`. The next scheduler tick then starts the queued runs.

## Observability

- Server log: `instance admission hold set: ...` (warn) and `instance admission hold cleared: ...` (info).
- Activity log: `instance.admission_hold.set` and `instance.admission_hold.cleared`, one entry per company.
- `GET /api/instance/admission-hold` shows the live state.
