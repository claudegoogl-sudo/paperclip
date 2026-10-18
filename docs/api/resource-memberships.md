---
title: Resource Memberships
summary: Per-user join/leave and star state for projects, agents, and documents
---

Track which projects, agents, and documents the signed-in board user has
joined or starred in a company. This is personal state for the caller — it
does not change who else can access a resource, only how it shows up in the
caller's own views (e.g. a starred-items list or a "my projects" filter).

All routes require a signed-in board user. Membership state is scoped to the
caller's own user ID, not asserted via a separate company-access check.

## List My Memberships

```
GET /api/companies/{companyId}/resource-memberships/me
```

Returns the caller's project, agent, and document memberships and star
flags for the company.

## Update a Membership

```
PUT /api/companies/{companyId}/resource-memberships/me/projects/{projectId}
PUT /api/companies/{companyId}/resource-memberships/me/agents/{agentId}
PUT /api/companies/{companyId}/resource-memberships/me/documents/{documentId}
```

Body:

| Field | Description |
|-------|-------------|
| `state` | `"joined"` or `"left"`. Not applicable to documents, which only support starring. |
| `starred` | Star or unstar the resource. |

Response fields:

| Field | Description |
|-------|-------------|
| `state` | The resource's membership state after the write |
| `starredAt` | Timestamp the resource was starred, or `null` |

## Activity Logging

A write only appends to the [activity log](/api/activity) when it actually
changes something — re-joining an already-joined project, for example, logs
nothing. When it does change state, the log action is one of
`resource_membership.joined`, `.left`, `.starred`, or `.unstarred`.
