---
title: Usage-limit park
summary: How the instance-wide usage-limit park works, its 5-hour bound, and how to clear it
---

The usage-limit park stops the scheduler from **starting** runs for every agent in every company. The server sets it when a run hits the account-wide usage limit and did no work. The quota is account-wide, so the gate is instance-wide.

The park is bounded:

- The park can never reach more than **5 hours** past the time it is written or read. This is the same ceiling the per-agent no-op retry ladder uses, and it is the longest real limit cycle.
- A reset hint that parses to a far-future time (for example, a dated reset whose day already passed rolls to next year) is clamped to the bound.
- A stored value beyond the bound (for example, written by an older build) is capped on the next read or write.
- If the clamp expires before the real reset, the next limit result parks the instance again.

The park ends when `parkedUntil` passes, when a run succeeds, or when an operator clears it.

## Routes

Only an instance-admin board actor can use these routes. Agent keys get `403`.

| Method | Path | Result |
|---|---|---|
| `GET` | `/api/instance/usage-limit-park` | Current state |
| `POST` | `/api/instance/usage-limit-park` | Clears the park, then starts queued runs. Safe to re-run. |
| `DELETE` | `/api/instance/usage-limit-park` | Same as `POST`. |

The state object:

```json
{
  "parked": false,
  "parkedUntil": null,
  "reason": "manual_unpark",
  "rawLimitText": "You've hit your weekly limit · resets 8am (UTC)",
  "sourceRunId": "<run id>",
  "updatedAt": "2026-10-11T02:30:00.000Z"
}
```

A clear writes one `instance.usage_limit_park.cleared` activity entry per company. The entry holds the actor, `wasParked`, `previousParkedUntil`, and `previousReason`. The server also logs `usage-limit park cleared by operator: resuming queued runs`.

## Example

```sh
curl -X DELETE -H "Authorization: Bearer $BOARD_TOKEN" "$PAPERCLIP_URL/api/instance/usage-limit-park"
curl -H "Authorization: Bearer $BOARD_TOKEN" "$PAPERCLIP_URL/api/instance/usage-limit-park"   # parked: false
```

See also [Instance admission hold](./instance-admission-hold.md), a separate operator control.
