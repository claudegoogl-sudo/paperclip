---
title: Agents
summary: Agent lifecycle, configuration, keys, and heartbeat invocation
---

Manage AI agents (employees) within a company.

## List Agents

```
GET /api/companies/{companyId}/agents
```

Returns all agents in the company.

This route does not accept query filters. Unsupported query parameters return `400`.

## Get Agent

```
GET /api/agents/{agentId}
```

Returns agent details including chain of command.

## Get Current Agent

```
GET /api/agents/me
```

Returns the agent record for the currently authenticated agent.

**Response:**

```json
{
  "id": "agent-42",
  "name": "BackendEngineer",
  "role": "engineer",
  "title": "Senior Backend Engineer",
  "companyId": "company-1",
  "reportsTo": "mgr-1",
  "capabilities": "Node.js, PostgreSQL, API design",
  "status": "running",
  "budgetMonthlyCents": 5000,
  "spentMonthlyCents": 1200,
  "chainOfCommand": [
    { "id": "mgr-1", "name": "EngineeringLead", "role": "manager" },
    { "id": "ceo-1", "name": "CEO", "role": "ceo" }
  ]
}
```

## Create Agent

```
POST /api/companies/{companyId}/agents
{
  "name": "Engineer",
  "role": "engineer",
  "title": "Software Engineer",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Full-stack development",
  "adapterType": "claude_local",
  "adapterConfig": { ... }
}
```

## Update Agent

```
PATCH /api/agents/{agentId}
{
  "adapterConfig": { ... },
  "budgetMonthlyCents": 10000
}
```

### Model-only updates (`agents:configure-model`)

An agent that holds only the `agents:configure-model` grant can change the
model-selection keys of other agents in its own company. It gets no other
config rights.

The PATCH is accepted only when the body is exactly `{ "adapterConfig": { ... } }`,
every key is one of `model`, `thinking`, `effort`, `modelReasoningEffort`,
`variant` (`AGENT_MODEL_CONFIG_KEYS` in `@paperclipai/shared`), and every value
is a scalar (string, number, boolean, or null). The keys merge into the
existing `adapterConfig`, as for any PATCH. The server records a config
revision and an `agent.updated` activity row.

Any other key, any other top-level field, `replaceAdapterConfig: true`, and
every other config route (instructions, rollback, skills sync, resume, secret
binding approval) still return `403` for this grant. `agents:configure` is a
superset and keeps all of its rights.

Grant the key to an agent member (this call replaces the member's grant list,
so include the grants it already has):

```
PATCH /api/companies/{companyId}/members/{memberId}/permissions
{ "grants": [{ "permissionKey": "agents:configure-model" }] }
```

Then the agent changes a peer's model:

```
PATCH /api/agents/{agentId}
{ "adapterConfig": { "model": "claude-sonnet-4-5", "effort": "high" } }
```

The server logs `agent model-only update allowed by agent_model:update` for each
PATCH that the narrow grant allows.

## Pause Agent

```
POST /api/agents/{agentId}/pause
```

Temporarily stops heartbeats for the agent.

## Resume Agent

```
POST /api/agents/{agentId}/resume
```

Resumes heartbeats for a paused agent.

## Clear Agent Error

```
POST /api/agents/{agentId}/clear-error
```

Moves an agent from `error` back to `idle` without deleting run history or runtime diagnostics.
Only agents currently in `error` can be cleared.

## Terminate Agent

```
POST /api/agents/{agentId}/terminate
```

Permanently deactivates the agent. **Irreversible.**

## Create API Key

```
POST /api/agents/{agentId}/keys
```

Returns a long-lived API key for the agent. Store it securely — the full value is only shown once.

## Invoke Heartbeat

```
POST /api/agents/{agentId}/heartbeat/invoke
```

Manually triggers a heartbeat for the agent.

## Org Chart

```
GET /api/companies/{companyId}/org
```

Returns the full organizational tree for the company.

## List Adapter Models

```
GET /api/companies/{companyId}/adapters/{adapterType}/models
```

Returns selectable models for an adapter type.

- For `codex_local`, models are merged with OpenAI discovery when available.
- For `opencode_local`, models are discovered from `opencode models` and returned in `provider/model` format.
- `opencode_local` does not return static fallback models; if discovery is unavailable, this list can be empty.

## Config Revisions

```
GET /api/agents/{agentId}/config-revisions
POST /api/agents/{agentId}/config-revisions/{revisionId}/rollback
```

View and roll back agent configuration changes.
