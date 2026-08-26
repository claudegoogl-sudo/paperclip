# Task bridge keys (`PAPERCLIP_BRIDGE_API_KEY`) — refusal codes, auto-renew, manual re-mint

A task bridge key is a scoped agent API key (`scope.kind = "task_bridge"`) an
operator binds to an agent's `adapterConfig.env.PAPERCLIP_BRIDGE_API_KEY` via a
`secret_ref` + `company_secret_bindings` row. It lets an external-logging
adapter call the board API without ever holding the broad run key.

## Why bridge delivery fails: the refusal codes

When the server resolves the bridge credential at run start it refuses
fail-closed — no credential is injected — and since the typed-refusal change it
says **which** state it hit, as a stable `TASK_BRIDGE_*` line in the run log /
server log and a `bridgeKeyStatus` field in the agent's wake context:

| Code | Meaning | Action |
| --- | --- | --- |
| `key_expired` | The bound key's 24h clamp elapsed (`expiresAt` passed). | Re-mint (below). |
| `key_revoked` | The bound key row has `revokedAt` set. | Re-mint, or un-revoke deliberately. |
| `key_missing` | No `agent_api_keys` row matches the bound credential. | Re-mint and rotate the secret to the new key. |
| `key_scope_mismatch` | The key is live but not `task_bridge`-scoped (e.g. `standard`). | Re-mint with a `task_bridge` scope. |
| `binding_absent` | The agent's board-gated env has no bridge binding at all. | Expected for agents without a bridge — nothing to fix. |
| `binding_malformed` | The env binding is not a valid binding object. | Fix `adapterConfig.env.PAPERCLIP_BRIDGE_API_KEY`. |
| `binding_not_secret_ref` | The binding is a bare string / `plain` / `user_secret_ref`. | Bind an operator `secret_ref` instead. |
| `secret_unresolved` | The backing secret failed to resolve (deleted, inactive, provider error). | Fix the secret or its provider. |
| `verifier_unavailable` | Server misconfiguration — no verifier wired. | Report as a server bug. |

Example line (expired key, the most common state because task bridge keys are
clamped to 24h):

```
TASK_BRIDGE_KEY_EXPIRED: bridge key 6f0c… expired 2026-08-25T08:09:00.000Z
```

## Manual re-mint (fallback when auto-renew is not enabled)

Task bridge keys are clamped to 24h (`CROSS_COMPANY_AGENT_KEY_MAX_TTL_SECONDS`),
so without an auto-renewal policy every bound key eventually hits
`key_expired`. Manual fallback, with a board token:

```bash
# 1. Mint a fresh task_bridge-scoped key (plaintext shown exactly once):
NEW_KEY=$(curl -s -X POST "$API/api/agents/$AGENT_ID/keys" \
  -H "Authorization: Bearer $BOARD_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"task_bridge manual re-mint","scope":{"kind":"task_bridge","projectId":"<project-uuid>","parentIssueIds":["<parent-issue-uuid>"],"allowedAssigneeAgentIds":["<agent-uuid>"]}}' \
  | jq -r .token)
# 2. Rotate the bound secret to the new key so the binding resolves to it:
curl -s -X POST "$API/api/secrets/$SECRET_ID/rotate" \
  -H "Authorization: Bearer $BOARD_TOKEN" -H "Content-Type: application/json" \
  -d "{\"value\":\"$NEW_KEY\"}"
```

Keep the scope pinned to the minimum the consumer needs (project / parent
issues / allowed assignees). The old key dies with its own 24h clamp at the
latest; revoke it explicitly with `DELETE /api/agents/{agentId}/keys/{keyId}`
to close the overlap window.

## Auto-renew (recommended: opt a binding in once, never hand-mint again)

The server runs an internal, hourly renewal sweep. It is **default-deny**: a
binding is only ever renewed if an operator set an explicit auto-renew policy
on it, and the policy pins the *exact* minimum scope the renewer may mint —
your opt-in is both the authorization and the scope approval. Nothing
agent-callable can set, clear, or trigger a renewal; the sweep is
server-internal and registers no route.

Opt in, with a board token (one call per binding):

```bash
curl -s -X POST "$API/api/companies/$COMPANY_ID/secret-bindings/$BINDING_ID/auto-renew-policy" \
  -H "Authorization: Bearer $BOARD_TOKEN" -H "Content-Type: application/json" \
  -d '{"policy":{"version":1,"enabled":true,"scope":{"kind":"task_bridge","projectId":"<project-uuid>","parentIssueIds":["<parent-issue-uuid>"],"allowedAssigneeAgentIds":["<agent-uuid>"]}}}'
```

(`authorizedByUserId` / `createdAt` are stamped server-side from the calling
board identity — do not send them.) The binding must target an agent at
`env.PAPERCLIP_BRIDGE_API_KEY`. Clear the opt-in any time with
`{"policy": null}`.

The project boundary may be pinned either way — `"projectId":"<uuid>"` or
`"projectIds":["<uuid>", …]` — and the sweep compares **effective scope**, not
raw shape: singular and plural forms that enumerate the same boundaries are
treated as identical, on both the pinned snapshot and the live key. A key
minted `projectIds:["X"]` matches a policy pinned `projectId:"X"` and vice
versa, including across differently-ordered or duplicated array entries.
What still counts as drift (and suspends fail-closed): a genuinely different
set of projects / parent issues / allowed assignees, or any scope field the
renewer does not know.

How it rotates, once per day per policy:

- The sweep renews when the bound key's remaining TTL drops to ≤ 8h — mint new
  key (same pinned scope, still clamped to 24h) → append a new secret version
  (the binding points at `latest`, so it flips atomically) → verify the new
  version resolves and classifies OK → only then revoke the old key.
- An already-expired or missing bound key is re-minted immediately on the next
  sweep (`trigger: "recovery"`), so opting in a dead binding heals it.
- If the live key's scope ever drifts from your pinned snapshot, or someone
  revokes the bound key by hand, the policy **suspends** (fail-closed) and says
  so in the audit trail instead of minting. Deliberate human action always
  beats availability.
- Do **not** hand-mint a duplicate `task_bridge` key with the pinned scope for
  an agent under an active auto-renew policy: the sweep's reconciliation
  revokes any live key of that agent whose scope exactly equals the pinned
  snapshot and is not the bound value — the next sweep (within the hour) will
  revoke your duplicate.

Every attempt — success, per-stage failure, suspension, recovery — is audited
in three places: the append-only `agent_key_renewal_events` table, the board
activity feed (`agent.key_auto_renewed` / `…_failed` / `…_suspended` system
events), and a greppable `task_bridge key auto-renew*` server log line. No key
material ever appears in any of them. Inspect the rotation history with a
board token:

```bash
curl -s "$API/api/secrets/$SECRET_ID/renewal-events?limit=50" \
  -H "Authorization: Bearer $BOARD_TOKEN"
```
