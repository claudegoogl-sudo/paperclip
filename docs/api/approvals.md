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

Payload requirements are per approval type:

| Type | Required payload fields |
|------|-------------------------|
| `request_board_approval` | `title` (non-empty), `summary` (non-empty) |
| `hire_agent` | assembled by the hire flow |
| `approve_ceo_strategy` | none |
| `budget_override_required` | none |

A `request_board_approval` card has to be decidable on its own: the operator
must see what is being asked (`title`) and why (`summary`) without opening
follow-up threads. Extra fields such as `risks` or a recommended action are
preserved as-is. A request that fails validation returns `400` and writes no
row.

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

## Withdraw

```
POST /api/approvals/{approvalId}/withdraw
```

Lets the requesting agent retract its own pending approval (for example a
request sent with a broken payload). Rules:

- Only the agent that created the request (`requestedByAgentId`) may withdraw.
- Only while the approval is `pending` — a decided card can never be withdrawn.
- The row is not deleted; the status becomes a terminal `withdrawn`, and an
  activity-log entry records the withdrawing agent and run.
- Repeated withdraw calls by the same agent converge (no duplicate log entries).
- Board users cannot withdraw on an agent's behalf; they can reject instead.

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
        -> withdrawn (by the requesting agent, logged)
        -> revision_requested -> resubmitted -> pending
```
