# Security-posture column sweep

Backing analysis for `packages/db/src/security-posture-columns.ts`, the registry
that drives the migration-lint rule `unqualified-mutation-security-posture-column`.

The rule shipped with a two-pair seed: the columns of the incident that motivated
it. Migration `0138` ran `UPDATE "company_secret_bindings" SET
"egress_allowlist_enforced" = false;` with no `WHERE` and disarmed egress
enforcement on every binding. Two registered pairs meant the rule's guarantee was
"the columns someone remembered to register" — absent means unchecked, the same
fail-open shape the rule exists to fix. This sweep is the answer to that: every
schema column classified register / do-not-register, with rejections recorded
below so the analysis does not have to be re-derived.

## What qualifies

A column is registered when its **value is itself a control** — something the
server reads to make a security decision — rather than data *about* a control.
Concretely, a column qualifies if flattening it across all rows would:

1. disarm an enforcement decision (authorization, egress, sandboxing, trust), or
2. widen a scope, grant, or capability, or
3. resurrect a credential, session, or grant that had been revoked or expired.

For every registered pair the `reason` field names the **dangerous direction** —
which value is the permissive one. This matters more than it looks: for most of
these the dangerous value is also the column *default*, so an unqualified write
to it reads as harmless in review. `NULL` is the permissive value far more often
than not (`revoked_at`, `expires_at`, `source_trust`, `scope`, `permissions`,
`execution_policy`), because absent almost always decodes to "no restriction
configured" rather than "deny".

## What does not qualify

Recorded here so the analysis does not have to be re-derived. Each rejection is a
claim that can be falsified by pointing at a consumer I missed.

### No runtime consumer

| Column | Reason |
| --- | --- |
| `agents.capabilities` | Free-text display/search metadata. No authorization or execution path reads it. |
| `agents.paused_at` | Audit timestamp. The enforcing value is `agents.status`, which is registered. |
| `user.email_verified` | Never read as a predicate; written unconditionally `true` on the cloud-tenant bootstrap path. |
| `environment_leases.expires_at` | Written but never compared against `now` anywhere in `server/src`. |
| `issue_recovery_actions.wake_policy`, `.monitor_policy` | Written and echoed; no read-side decision. |
| `company_skills.public_share_token` | No route resolves a skill by token — public sharing is unimplemented. |
| `join_requests.approved_at` | Audit metadata; the gate is `join_requests.status`, which is registered. |

### The control lives elsewhere

| Column | Reason |
| --- | --- |
| `company_skills.trust_level` | The executable-content gate (`assertImportedSkillSourceAllowed`) reads a value freshly derived from the incoming file inventory at import time, not the stored column. Stored reads only echo it. |
| `company_secret_bindings.required` | The authorization gate is the *existence* of the binding row; `required` is not projected into any decision. |
| `user_secret_declarations.required`, `.allow_missing_override` | Same shape — the reachability gate is row existence plus the adapter-config binding, not these columns. |
| `companies.budget_monthly_cents`, `agents.budget_monthly_cents` | Denormalised display mirrors written by `upsertPolicy`. The hard stop reads `budget_policies`, which is registered. |
| `companies.feedback_data_sharing_enabled`, `feedback_votes.shared_with_labs` | Consent *records* captured at vote time. The column that actually gates the off-instance upload is `feedback_exports.status`, which is registered. |
| `environment_leases.lease_policy` | A coarse pre-filter; the load-bearing isolation check is a company/agent/workspace/config-fingerprint match in `metadata.reusableSandboxLease`. Flattening it cannot cross tenants. |
| `cli_auth_challenges.approved_at` | Read only in conjunction with `board_api_key_id`, so a single-column flatten cannot manufacture an approval. |

### No fail-open value exists

| Column | Reason |
| --- | --- |
| `companies.attachment_max_bytes` | `<= 0` and `NULL` normalise to the *default*, not to unlimited, and every value is `Math.min`-ed against a process ceiling. |
| `issue_tree_holds.release_policy` | `NULL` normalises to `{strategy:"manual"}`, the strictest value; a flatten fails closed. |
| `board_api_keys.key_hash` (constant flatten) | A unique index aborts it. Registered anyway for the per-row-rewrite case. |

### Not a security control

| Column | Reason |
| --- | --- |
| `project_workspaces.visibility` | The enum is `default` / `advanced` — a UI disclosure-level flag. There is no `public` value and no access check reads it. |
| `company_skills.sharing_scope` | A client-supplied list filter applied inside an already company-scoped query. |
| `budget_policies.notify_enabled` | Alerting only; disabling it changes no enforcement decision. |
| `routines.concurrency_policy`, `.catch_up_policy` | Availability/cost scheduling knobs. Catch-up replay is bounded by a hard cap regardless, and spend is bounded by the budget hard stops. |
| `issue_thread_interactions.continuation_policy` | Scheduling semantics for resuming an agent; no authorization input. |
| `cloud_upstream_connections.scopes` | *Outbound* requested consent sent to a remote instance, which is the enforcing party. Empty falls back to defaults; widening still requires the remote to approve. |
| `account.scope`, `account.access_token_expires_at` | Outbound OAuth provider scope/expiry with no in-repo predicate. |
| `instance_settings.general`, `.experimental` | Singleton table. An unqualified write is the *only* way to write it, so the rule would be pure false-positive noise with no flatten shape to catch. |

### Deferred as a separate rule shape

Tenancy and binding keys — `company_id` everywhere, `plugin_state.scope_kind` /
`scope_id`, `plugin_entities.scope_kind` / `scope_id`, `budget_policies.scope_type`
/ `scope_id` — are **not** registered. Flattening one does breach isolation, but
they are a different rule shape ("unqualified write to a tenancy key"), and
registering a handful of them piecemeal would imply a coverage this registry does
not have. Tracked separately rather than half-covered here.

`principal_permission_grants.permission_key` *is* registered despite looking like
a key, because the row's entire purpose is to be a grant and the key names the
privilege being granted.

## Known limits

- **The registry is a snapshot.** A column added to the schema tomorrow is
  unregistered, therefore unchecked. Nothing forces a re-sweep. This is the same
  absent-means-unprotected shape the rule exists to fix, moved up one level; the
  fix is a classified-inventory test that fails when a schema column appears in
  neither the registry nor a rejection list. Tracked separately.
- **`session.expires_at`** is registered on library-behaviour grounds. Enforcement
  is inside `better-auth`, so the direction is not backed by an in-repo predicate.
- **Parser reach** bounds everything here: a statement shape the checker cannot
  parse is unchecked regardless of what is registered. The known gaps are
  documented on the rule itself and probed in both directions by
  `check-migration-safety.test.ts`.

## Result

49 pairs registered across 27 tables, up from the 2-pair seed. Re-running the
lint against all historical migrations surfaced **no new findings**, so nothing
was baselined and no historical posture flatten needed escalating.
