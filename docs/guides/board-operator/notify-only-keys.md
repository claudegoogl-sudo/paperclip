# Notify-only agent keys (`scope.kind = "notify_only"`)

A notify-only key is a scoped agent API key for an out-of-band pager: a
systemd timer, a cron job, or any process that is not a heartbeat run. It can
file interaction cards (for example `request_confirmation`) on a fixed list of
issues. It can do nothing else.

## What the key can do

| Request | Result |
| --- | --- |
| `GET /api/issues/:id` for a listed issue | Allowed. |
| `POST /api/issues/:id/interactions` (`kind = request_confirmation`) for a listed issue | Allowed. No run id is needed. At most 10 per key per hour, then `429 agent_key_rate_limited`. |
| `POST /api/issues/:id/interactions` with any other kind (`suggest_tasks`, `ask_user_questions`) | `403 agent_key_scope_violation`. |
| Any route for an issue that is not listed | `403 agent_key_scope_violation`. |
| Every other route (comments, issue PATCH/create, issue lists, secrets, agents, board keys, interaction accept/resolve, ...) | `403 agent_key_scope_violation`. |

Rules:

- `:id` must be the issue **UUID**. Identifiers such as `ABC-12` are refused.
- The key never carries a run id. The server drops any `X-Paperclip-Run-Id`
  header. The card is stored with `sourceRunId = null`.
- Provenance: the `issue.thread_interaction_created` activity row records
  `actorType = agent`, the agent id, and the key id (`agentApiKeyId`). The
  card row records `createdByAgentId`. Join them by `details.interactionId`.
- A stored scope that no longer parses stays `notify_only` with an empty
  allow-list. It denies every route. It never falls back to `standard`.
- Each denial writes a `WARN agent key scope violation (notify_only)` log line
  with agent id, key id, method, and path.

## Mint a key

Only a board actor can mint a key. Every agent credential (agent JWT, and
agent keys of any scope) gets 403 on the mint route. A stolen agent credential
therefore cannot mint itself a durable run-less key.

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/agents/$AGENT_ID/keys" \
  -H "Authorization: Bearer <board credential>" \
  -H "Content-Type: application/json" \
  -d '{"name":"token-watch pager","ttlSeconds":7776000,"scope":{"kind":"notify_only","issueIds":["<issue-uuid>"]}}'
```

- `issueIds` holds 1 to 10 issue UUIDs. An empty list is `400`.
- Every listed issue must be in the agent's company, else `422`.
- An expiry is required: `ttlSeconds` or `expiresAt`, in the future and at
  most 90 days away. A missing or longer expiry is `422`. Re-mint before it
  runs out.

## Use the key

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/issues/<issue-uuid>/interactions" \
  -H "Authorization: Bearer <notify-only key>" \
  -H "Content-Type: application/json" \
  -d '{"kind":"request_confirmation","payload":{"version":1,"prompt":"Watch fired. Acknowledge?"}}'
```

Expect `201`. Revoke the key with `DELETE /api/agents/:id/keys/:keyId`.
