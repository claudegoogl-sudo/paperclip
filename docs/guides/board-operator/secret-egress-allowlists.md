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

## Plugin config-key egress allowlist

A second, independent mechanism gates a plugin's `ctx.http.fetch` calls
against destinations derived from that plugin's **own declared instance
config** — specifically, any config key the plugin's manifest marks
`format: "uri"` (klipper's `moonrakerBaseUrl` is the first real subject: a
company points klipper at its own Moonraker host, and that host is
automatically the allowed destination). A config key's own declared value is
always part of the effective allowlist; you only ever need to review and add
*extra* destinations (e.g. a secondary printer host) or would-deny
suggestions from real traffic — the same review → set-allowlist → enforce
workflow as the per-binding mechanism above, at company-scoped routes under
`/api/companies/:companyId/plugins/:pluginId/config-egress/...`.

> **Not a per-tenant boundary.** Unlike the per-binding mechanism above, the
> config-key egress decision has no trustworthy per-call company context (the
> plugin worker's `ctx.http.fetch` only receives a URL), so it
> is evaluated **plugin-wide**: the effective allowlist is the UNION of every
> company's declared config value for that key, and enforcement is **OR**'d
> across every company's row for the plugin. Flipping *any one* company's row
> to enforced makes the whole plugin start enforcing for every company that
> has it enabled — including companies that never reviewed their own
> suggestions. The review response's `pluginWideEnforced` field always
> reflects this effective, plugin-wide posture (which may be `true` even when
> your own company's row is still log-only); the enforce route's response
> makes the same effect explicit via `pluginWideEnforced: true`.

> **Coverage.** This mechanism only gates a worker's `ctx.http.fetch`.
> **Vault** (`paperclip-plugin-vault`) now routes every Vaultwarden request
> through `ctx.http.fetch` (its `serverUrl` config key is declared
> `format:"uri"`), so vault egress **is** a subject of this mechanism, exactly
> like klipper's `moonrakerBaseUrl`: its `serverUrl` origin is harvested into
> would-deny suggestions and can be flipped to enforce — plugin-wide and
> log-only until an operator flips enforce, subject to the same
> **not-a-per-tenant-boundary** caveat as above. One transport is still **not**
> covered:
> - **Klipper's Moonraker WebSocket connection** (`new WebSocket(url)` in
>   `MoonrakerClient`) is a separate transport from `ctx.http.fetch` and is
>   also not covered — only klipper's plain HTTP calls to Moonraker are gated.
>
> Do not treat klipper as fully "egress-controlled" on the strength of this
> mechanism alone: its Moonraker WebSocket transport is unaffected. And
> remember that vault's coverage, like every config-key binding here, is
> plugin-wide and log-only until an operator explicitly enforces it.

### HTTP API

| Method & path | Purpose |
| --- | --- |
| `GET /api/companies/:companyId/plugins/:pluginId/config-egress` | Review: every `format:"uri"` config key the plugin declares, this company's own declared value + operator-added allowlist extras, this company's row posture, the effective plugin-wide posture (`pluginWideEnforced`), and plugin-wide harvested suggestions (each unselected). |
| `POST /api/companies/:companyId/plugins/:pluginId/config-egress/:configKey/allowlist` | Replace this company's operator-added extra destinations for `configKey`. Body: `{ "allowedEgress": ["https://secondary-printer.example", …] }`. Never touches enforcement. |
| `POST /api/companies/:companyId/plugins/:pluginId/config-egress/:configKey/enforce` | Flip this company's row for `configKey` to enforced — **plugin-wide effect, see above**. Body: `{}` (no `allowEmpty` — the plugin's own declared config value is always allowed, so there is no empty-allowlist-denies-everything footgun to opt out of). |

All three are board-authenticated only (`403` for an agent/worker token) and
company-scoped for BOLA (`403` for a company you do not belong to). Both
writes emit an activity-log entry (`plugin.config_egress_allowlist_set`,
`plugin.config_egress_allowlist_enforced`).

Setting an allowlist entry for a `configKey` the plugin does not declare as
`format:"uri"` is refused (`400`).

There is currently no CLI for this surface (HTTP API only). There is also no
bulk/enforce-all action — though note that, unlike the per-binding mechanism,
even a single enforce call already has a plugin-wide blast radius (see above),
so a one-at-a-time flip buys less isolation here than it does for a secret
binding.

Shipping this mechanism does not itself flip any instance to enforcing —
every existing plugin config-key row starts (and stays) log-only until an
operator explicitly reviews suggestions and calls the enforce route.
