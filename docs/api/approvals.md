---
title: Approvals
summary: Approval workflow endpoints
---

Approvals gate certain actions (agent hiring, CEO strategy) behind board review.

## List Approvals

```
GET /api/companies/{companyId}/approvals
```

Query parameters:

| Param | Description |
|-------|-------------|
| `status` | Filter by status (e.g. `pending`) |

## Get Approval

```
GET /api/approvals/{approvalId}
```

Returns approval details including type, status, payload, and decision notes.

## Create Approval Request

```
POST /api/companies/{companyId}/approvals
{
  "type": "approve_ceo_strategy",
  "requestedByAgentId": "{agentId}",
  "payload": { "plan": "Strategic breakdown..." }
}
```

### Attribution rules

The card is always attributed to the authenticated caller:

- **Agent callers**: `requestedByAgentId` may be omitted (attributed to the
  caller) or set to the caller's own id. Any other value is rejected with
  `403` — cards cannot be attributed to another agent.
- **User and board callers**: `requestedByAgentId` must be absent or `null`;
  a non-null value is rejected with `400`. User cards are attributed via
  `requestedByUserId` only.

Rejected create attempts are recorded in the activity log
(`approval.create_denied`).

### Per-agent creation caps

Agent callers are subject to two caps (user/board callers are exempt):

- **Burst cap**: at most 10 creates per agent per 60-second sliding window.
  Exceeding it returns `429` with a `Retry-After` header and consumes no
  budget for the rejected request.
- **Pending-card cap**: at most 5 simultaneously `pending` cards per agent.
  Exceeding it returns `429` naming the cap; withdraw or resolve an existing
  card to free budget. There is no `Retry-After` — the cap frees on a human
  decision, not on a clock.

## Create Hire Request

```
POST /api/companies/{companyId}/agent-hires
{
  "name": "Marketing Analyst",
  "role": "researcher",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Market research",
  "budgetMonthlyCents": 5000
}
```

Creates a draft agent and a linked `hire_agent` approval.

## Approve

```
POST /api/approvals/{approvalId}/approve
{ "decisionNote": "Approved. Good hire." }
```

## Reject

```
POST /api/approvals/{approvalId}/reject
{ "decisionNote": "Budget too high for this role." }
```

## Request Revision

```
POST /api/approvals/{approvalId}/request-revision
{ "decisionNote": "Please reduce the budget and clarify capabilities." }
```

## Resubmit

```
POST /api/approvals/{approvalId}/resubmit
{ "payload": { "updated": "config..." } }
```

## Linked Issues

```
GET /api/approvals/{approvalId}/issues
```

Returns issues linked to this approval.

## Approval Comments

```
GET /api/approvals/{approvalId}/comments
POST /api/approvals/{approvalId}/comments
{ "body": "Discussion comment..." }
```

## Approval Lifecycle

```
pending -> approved
        -> rejected
        -> revision_requested -> resubmitted -> pending
```
