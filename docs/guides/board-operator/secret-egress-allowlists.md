---
title: Secret Egress Allowlists
summary: Review harvested destinations and flip borrowed-handle bindings to enforced, one binding at a time
---

When an agent uses a secret through a borrowed handle, Paperclip can restrict
which network destinations that handle is allowed to reach (its **egress
allowlist**). New bindings are born **enforcing**: only destinations on the
allowlist are permitted. Bindings that pre-date this feature were migrated to
**log-only** mode — nothing is blocked yet, but every destination that *would*
have been denied is recorded so you can build an accurate allowlist from real
traffic before you turn enforcement on.

This page covers the operator workflow for reviewing those recorded
destinations and flipping each migrated binding to enforced.

> **Operator-only.** Every action here requires board (operator) authentication.
> There is no agent- or worker-invokable path to read suggestions, set an
> allowlist, or flip a binding — an agent token is rejected with `403`. This is
> deliberate: the allowlist is the thing that constrains agents, so agents must
> not be able to edit it.

## The workflow

For each migrated (log-only) binding:

1. **Review** the destinations the binding's handles have actually tried to
   reach. These are shown as **unchecked suggestions** — Paperclip never
   pre-selects or auto-applies them. You decide which are legitimate.
2. **Set the allowlist** to the destinations you approve. This is a full
   replace: pass exactly the entries you want.
3. **Flip the binding to enforced.** From this point the handle can only reach
   the allowlisted destinations; anything else is denied.

You flip **one binding at a time**, as you sign off on it. There is no
bulk/enforce-all action — a misjudged allowlist breaks a single binding, never
every migrated secret at once.

> **Why suggestions are never pre-checked.** The recorded destinations come from
> traffic an agent can influence (an agent can drive a borrowed handle at an
> arbitrary URL). If Paperclip auto-applied them, an agent could poison its own
> allowlist by generating traffic to a destination it wants permitted. So
> harvested origins are surfaced as suggestions only; approving them is an
> affirmative operator action.

## CLI

All commands take `-C, --company-id <id>` and are board-authenticated.

### 1. Review

```bash
paperclipai secrets egress review -C <companyId>
```

Example output:

```
binding=3f1c… target=agent:coder configPath=adapterConfig.env.GH_TOKEN posture=log-only
  allowlist: (empty)
  suggestions (UNCHECKED — select to add, nothing auto-applied):
    [ ] https://api.github.com (count=412, lastSeen=2026-05-31T18:04:00.000Z)
    [ ] https://uploads.github.com (count=37, lastSeen=2026-05-31T17:55:12.000Z)
    [ ] https://exfil.example (count=2, lastSeen=2026-05-31T03:11:09.000Z)
```

The `[ ]` marks each suggestion as unselected. Inspect the list — the
high-count GitHub origins look legitimate for a `GH_TOKEN`; the low-count
`exfil.example` does not. Add `--json` for machine-readable output.

### 2. Set the allowlist

Pass only the destinations you approve (repeat `--allow` per entry):

```bash
paperclipai secrets egress set-allowlist -C <companyId> --binding-id <bindingId> \
  --allow https://api.github.com \
  --allow https://uploads.github.com
```

This replaces the binding's allowlist with exactly those two entries. (Omitting
`--allow` entirely clears the allowlist.)

### 3. Flip to enforced

```bash
paperclipai secrets egress enforce -C <companyId> --binding-id <bindingId>
```

The binding now enforces: handles minted under it can only reach the two
allowlisted GitHub origins. In-flight handles are purged so the new posture
takes effect immediately rather than at handle expiry.

Enforcing a binding whose allowlist is **empty** is refused (it would deny *all*
egress for that secret). If that is genuinely what you want — a deliberate
deny-all — pass `--allow-empty`.

## HTTP API

The CLI is a thin wrapper over three board-authenticated routes. All are
company-scoped; a binding from another company returns `404`, and a company you
do not belong to returns `403`.

| Method & path | Purpose |
| --- | --- |
| `GET /api/companies/:companyId/secret-egress-bindings` | Review: each binding's current allowlist, posture, and harvested suggestions (each `selected: false`). |
| `POST /api/companies/:companyId/secret-egress-bindings/:bindingId/allowlist` | Replace one binding's allowlist. Body: `{ "allowedEgress": ["https://api.github.com", …] }`. |
| `POST /api/companies/:companyId/secret-egress-bindings/:bindingId/enforce` | Flip one binding to enforced. Body: `{ "allowEmpty": false }`. |

The review response keeps `suggestions` in a field separate from
`allowedEgress`; they are never merged. Origins are returned as plain strings —
encode them for your output context when you render them (the CLI strips
terminal control characters before printing; a web console must escape them
rather than inject as HTML).

Both writes emit an activity-log entry (`secret.egress_allowlist_set`,
`secret.egress_allowlist_enforced`) so the review-and-flip is auditable.

## Idempotency

All three operations are safe to re-run. Re-setting the same allowlist or
re-flipping an already-enforced binding converges to the same state.
