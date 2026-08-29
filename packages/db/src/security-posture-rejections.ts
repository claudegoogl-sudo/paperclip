/**
 * A block of schema columns deliberately *not* registered as security-posture
 * columns, and the reason.
 *
 * One entry may cover one column or every column of a table. The columns are
 * always enumerated: a table-level decision is a claim about the columns that
 * decision was made over, and if the enumeration were implied by "everything on
 * this table" then a column added tomorrow would inherit a classification nobody
 * made for it. That is the fail-open shape this list exists to close, so the
 * cost of listing names is the point rather than an accident.
 *
 * `reason` is required and is a falsifiable claim: it can be disproved by
 * pointing at a consumer that reads the column as a security predicate. Reasons
 * attached to a whole table are table-level claims — read them as "no column
 * here is read as a predicate", not as a per-column analysis of each one.
 */
export type SecurityPostureRejection = {
  readonly table: string;
  readonly columns: readonly string[];
  readonly reason: string;
};

/**
 * Every schema column that is not in `SECURITY_POSTURE_COLUMNS`.
 *
 * Together the two lists are a total classification of the schema, and
 * `assertSchemaColumnsClassified` fails when a column is in neither. That check
 * is what makes this list load-bearing rather than documentation: without it a
 * column added next week is unregistered, therefore unchecked, and nothing
 * anywhere notices.
 *
 * The entries below are ordered to match the analysis rather than the schema:
 * the individually-argued rejections first (the ones a later reader would
 * plausibly re-litigate, carried over from the sweep in
 * `doc/SECURITY-POSTURE-COLUMN-SWEEP.md`), then the table-level blocks.
 */
export const SECURITY_POSTURE_REJECTIONS = [
  {
    table: "agents",
    columns: ["capabilities"],
    reason: "Free-text display and search metadata. No authorization or execution path reads it.",
  },
  {
    table: "agents",
    columns: ["paused_at"],
    reason: "Audit timestamp. The enforcing value is agents.status, which is registered.",
  },
  {
    table: "user",
    columns: ["email_verified"],
    reason: "Never read as a predicate; written unconditionally true on the cloud-tenant bootstrap path.",
  },
  {
    table: "environment_leases",
    columns: ["expires_at"],
    reason: "Written but never compared against now anywhere in server/src, so there is no expiry to disarm.",
  },
  {
    table: "issue_recovery_actions",
    columns: ["wake_policy", "monitor_policy"],
    reason: "Written and echoed back; no read-side decision consumes either one.",
  },
  {
    table: "company_skills",
    columns: ["public_share_token"],
    reason: "No route resolves a skill by token — public sharing is unimplemented, so the token gates nothing.",
  },
  {
    table: "join_requests",
    columns: ["approved_at"],
    reason: "Audit metadata; the gate is join_requests.status, which is registered.",
  },
  {
    table: "company_skills",
    columns: ["trust_level"],
    reason: "The executable-content gate (assertImportedSkillSourceAllowed) reads a value freshly derived from the incoming file inventory at import time, not the stored column. Stored reads only echo it.",
  },
  {
    table: "company_secret_bindings",
    columns: ["required"],
    reason: "The authorization gate is the existence of the binding row; required is not projected into any decision.",
  },
  {
    table: "user_secret_declarations",
    columns: ["required", "allow_missing_override"],
    reason: "Same shape as company_secret_bindings.required — the reachability gate is row existence plus the adapter-config binding, not these columns.",
  },
  {
    table: "companies",
    columns: ["budget_monthly_cents"],
    reason: "Denormalised display mirror written by upsertPolicy. The hard stop reads budget_policies, which is registered.",
  },
  {
    table: "agents",
    columns: ["budget_monthly_cents"],
    reason: "Denormalised display mirror written by upsertPolicy. The hard stop reads budget_policies, which is registered.",
  },
  {
    table: "companies",
    columns: ["feedback_data_sharing_enabled"],
    reason: "A consent record captured at vote time. The column that gates the off-instance upload is feedback_exports.status, which is registered.",
  },
  {
    table: "feedback_votes",
    columns: ["shared_with_labs"],
    reason: "A consent record captured at vote time. The column that gates the off-instance upload is feedback_exports.status, which is registered.",
  },
  {
    table: "environment_leases",
    columns: ["lease_policy"],
    reason: "A coarse pre-filter; the load-bearing isolation check is a company/agent/workspace/config-fingerprint match in metadata.reusableSandboxLease. Flattening it cannot cross tenants.",
  },
  {
    table: "cli_auth_challenges",
    columns: ["approved_at"],
    reason: "Read only in conjunction with board_api_key_id, so a single-column flatten cannot manufacture an approval.",
  },
  {
    table: "companies",
    columns: ["attachment_max_bytes"],
    reason: "Both <= 0 and NULL normalise to the default rather than to unlimited, and every value is Math.min-ed against a process ceiling, so no flatten widens it.",
  },
  {
    table: "issue_tree_holds",
    columns: ["release_policy"],
    reason: "NULL normalises to {strategy:\"manual\"}, the strictest value, so a flatten fails closed.",
  },
  {
    table: "project_workspaces",
    columns: ["visibility"],
    reason: "The enum is default/advanced — a UI disclosure-level flag. There is no public value and no access check reads it.",
  },
  {
    table: "company_skills",
    columns: ["sharing_scope"],
    reason: "A client-supplied list filter applied inside an already company-scoped query.",
  },
  {
    table: "budget_policies",
    columns: ["notify_enabled"],
    reason: "Alerting only; disabling it changes no enforcement decision. The hard stop is hard_stop_enabled, which is registered.",
  },
  {
    table: "routines",
    columns: ["concurrency_policy", "catch_up_policy"],
    reason: "Availability and cost scheduling knobs. Catch-up replay is bounded by a hard cap regardless, and spend is bounded by the budget hard stops.",
  },
  {
    table: "issue_thread_interactions",
    columns: ["continuation_policy"],
    reason: "Scheduling semantics for resuming an agent; not an input to any authorization decision.",
  },
  {
    table: "account",
    columns: ["scope", "access_token_expires_at"],
    reason: "Outbound OAuth provider scope and expiry for a third-party account link, with no in-repo predicate reading either.",
  },
  {
    table: "instance_settings",
    columns: ["general", "experimental"],
    reason: "Singleton table: an unqualified write is the only way to write it, so the rule would be pure false-positive noise with no flatten shape left to catch.",
  },
  {
    table: "account",
    columns: [
      "access_token", "account_id", "created_at", "id", "id_token", "password",
      "provider_id", "refresh_token", "refresh_token_expires_at", "updated_at", "user_id"
    ],
    reason: "Third-party OAuth account links owned by better-auth. Credential material here is presented to the remote provider, which is the enforcing party; no in-repo predicate reads these columns to make a local access decision.",
  },
  {
    table: "activity_log",
    columns: [
      "action", "actor_id", "actor_type", "agent_id", "company_id", "created_at", "details",
      "entity_id", "entity_type", "id", "run_id"
    ],
    reason: "Append-only audit trail. Rows are written after the fact and read only for display and forensics; no column is an input to an access decision.",
  },
  {
    table: "agent_api_keys",
    columns: [
      "agent_id", "company_id", "created_at", "id", "last_used_at", "name",
      "responsible_user_id"
    ],
    reason: "Ownership, naming and last-use metadata around the key. The authentication predicates are revoked_at, scope_config and key_hash, which are registered.",
  },
  {
    table: "agent_config_revisions",
    columns: [
      "after_config", "agent_id", "before_config", "changed_keys", "company_id",
      "created_at", "created_by_agent_id", "created_by_user_id", "id",
      "rolled_back_from_revision_id", "source"
    ],
    reason: "Immutable before/after snapshots of an agent config change. The live config the runtime reads is agents.adapter_config and agents.permissions, both registered; these rows are history.",
  },
  {
    table: "agent_key_renewal_events",
    columns: [
      "agent_id", "binding_id", "company_id", "created_at", "error_code", "id",
      "new_expires_at", "new_key_id", "old_key_id", "outcome", "scope_snapshot", "trigger"
    ],
    reason: "Append-only audit trail for task_bridge key-renewal attempts, same shape as activity_log and secret_access_events. Rows are written after the fact and read only for display and forensics; the gates they record — agent_api_keys.revoked_at/expires_at/scope_config and company_secret_bindings.auto_renew_policy — are registered.",
  },
  {
    table: "agent_memberships",
    columns: [
      "agent_id", "company_id", "created_at", "id", "starred_at", "state", "updated_at",
      "user_id"
    ],
    reason: "Per-user sidebar and starring state for an agent. Membership authorization is company_memberships, whose status and membership_role are registered.",
  },
  {
    table: "agent_runtime_state",
    columns: [
      "adapter_type", "agent_id", "company_id", "created_at", "last_error", "last_run_id",
      "last_run_status", "session_id", "session_params_json", "state_json", "total_cached_input_tokens",
      "total_cost_cents", "total_input_tokens", "total_output_tokens", "updated_at"
    ],
    reason: "Runtime bookkeeping and token/cost counters for the current session. Read for display and continuation, not as a predicate in any authorization, egress or sandbox decision.",
  },
  {
    table: "agent_task_sessions",
    columns: [
      "adapter_type", "agent_id", "company_id", "created_at", "id", "last_error",
      "last_run_id", "session_display_id", "session_params_json", "task_key", "updated_at"
    ],
    reason: "Adapter session continuity bookkeeping. Identifies which session to resume; no column gates whether a run may proceed or what it may reach.",
  },
  {
    table: "agent_wakeup_requests",
    columns: [
      "agent_id", "claimed_at", "coalesced_count", "company_id", "created_at", "error",
      "finished_at", "id", "idempotency_key", "payload", "reason", "requested_at",
      "requested_by_actor_id", "requested_by_actor_type", "run_id", "source", "status",
      "trigger_detail", "updated_at"
    ],
    reason: "Queue rows for waking an agent. Status and claim fields sequence delivery; the authority the woken run gets comes from the agent and issue rows, not from here.",
  },
  {
    table: "agents",
    columns: [
      "adapter_type", "company_id", "created_at", "default_environment_id", "error_reason",
      "icon", "id", "last_heartbeat_at", "metadata", "name", "pause_reason", "reports_to",
      "spent_monthly_cents", "title", "updated_at"
    ],
    reason: "Identity, display and bookkeeping fields around an agent. The trust-bearing columns on this table — role, permissions, adapter_config, runtime_config, status — are registered separately.",
  },
  {
    table: "approval_comments",
    columns: [
      "approval_id", "author_agent_id", "author_user_id", "body", "company_id",
      "created_at", "id", "updated_at"
    ],
    reason: "Free-text discussion on an approval. The decision is carried by approvals.status; comment bodies are not read as predicates.",
  },
  {
    table: "approvals",
    columns: [
      "company_id", "created_at", "decided_at", "decided_by_user_id", "decision_note", "id",
      "payload", "requested_by_agent_id", "requested_by_user_id", "status", "type",
      "updated_at"
    ],
    reason: "Board approval records. status is the decision, but it is read only together with decided_by_user_id and the request payload, so a single-column flatten cannot manufacture a decided approval; the gate that actually blocks agent creation is companies.require_board_approval_for_new_agents, which is registered.",
  },
  {
    table: "assets",
    columns: [
      "byte_size", "company_id", "content_type", "created_at", "created_by_agent_id",
      "created_by_user_id", "id", "object_key", "original_filename", "provider", "sha256",
      "updated_at"
    ],
    reason: "Uploaded blob metadata — size, content type, checksum and object key. Access is authorized by the owning company and the route, not by any column here.",
  },
  {
    table: "board_api_keys",
    columns: ["created_at", "id", "last_used_at", "name", "user_id"],
    reason: "Naming and last-use metadata. The authentication predicates on this table are revoked_at, expires_at, key_hash and scope_config, which are registered.",
  },
  {
    table: "budget_incidents",
    columns: [
      "amount_limit", "amount_observed", "approval_id", "company_id", "created_at", "id",
      "metric", "policy_id", "resolved_at", "scope_id", "scope_type", "status",
      "threshold_type", "updated_at", "window_end", "window_kind", "window_start"
    ],
    reason: "Records of budget thresholds already crossed. Enforcement reads budget_policies, whose is_active, hard_stop_enabled and amount are registered.",
  },
  {
    table: "budget_policies",
    columns: [
      "company_id", "created_at", "created_by_user_id", "id", "metric", "scope_id",
      "scope_type", "updated_at", "updated_by_user_id", "warn_percent", "window_kind"
    ],
    reason: "Scope, metric, window and authorship of a spend policy. The three columns that decide whether the hard stop fires — is_active, hard_stop_enabled, amount — are registered.",
  },
  {
    table: "cli_auth_challenges",
    columns: [
      "approved_by_user_id", "board_api_key_id", "cancelled_at", "client_name", "command",
      "created_at", "id", "pending_key_name", "requested_company_id", "updated_at"
    ],
    reason: "Client naming, command text and lifecycle timestamps for a pending CLI login. The credential and gate columns — pending_key_hash, pending_key_scope_config, secret_hash, expires_at, requested_access — are registered.",
  },
  {
    table: "companies",
    columns: [
      "brand_color", "created_at", "default_responsible_user_id", "description",
      "feedback_data_sharing_consent_at", "feedback_data_sharing_consent_by_user_id",
      "feedback_data_sharing_terms_version", "id", "issue_counter", "issue_prefix", "name",
      "pause_reason", "paused_at", "spent_monthly_cents", "updated_at"
    ],
    reason: "Company identity, branding, issue numbering and spend mirrors. The two enforcement columns — status and require_board_approval_for_new_agents — are registered.",
  },
  {
    table: "company_logos",
    columns: ["asset_id", "company_id", "created_at", "id", "updated_at"],
    reason: "Join row pointing a company at an uploaded asset. No access decision reads it.",
  },
  {
    table: "company_memberships",
    columns: ["company_id", "created_at", "id", "principal_id", "principal_type", "updated_at"],
    reason: "Principal identity and timestamps for a membership. The two authorization columns — status and membership_role — are registered.",
  },
  {
    table: "company_secret_binding_posture_audit",
    columns: [
      "actor", "application_name", "binding_id", "changed_at", "company_id", "db_user",
      "id", "new_allowed_egress", "new_enforced", "old_allowed_egress", "old_enforced",
      "op", "secret_id", "txid"
    ],
    reason: "Trigger-written audit of egress-posture changes on secret bindings. It records what the enforcing columns were set to; it is evidence, never the control.",
  },
  {
    table: "company_secret_bindings",
    columns: [
      "company_id", "config_path", "created_at", "id", "label", "secret_id", "target_id",
      "target_type", "updated_at", "version_selector"
    ],
    reason: "Binding target, label and version selector. The egress control columns — egress_allowlist_enforced and allowed_egress — are registered, and the authorization gate is the existence of the row.",
  },
  {
    table: "company_secret_provider_configs",
    columns: [
      "company_id", "config", "created_at", "created_by_agent_id", "created_by_user_id",
      "disabled_at", "display_name", "health_checked_at", "health_details",
      "health_message", "health_status", "id", "is_default", "provider", "status",
      "updated_at"
    ],
    reason: "Provider connection settings, health probe results and display naming. Resolution is gated by company_secrets.status and company_secret_versions.status, both registered; a disabled provider config surfaces as a resolution failure rather than a silent widening.",
  },
  {
    table: "company_secret_versions",
    columns: [
      "created_at", "created_by_agent_id", "created_by_user_id", "fingerprint_sha256", "id",
      "provider_version_ref", "rotation_job_id", "secret_id", "value_sha256", "version"
    ],
    reason: "Version numbering, authorship and integrity digests. The two columns that decide whether a version resolves — status and revoked_at — are registered, as is the material itself.",
  },
  {
    table: "company_secrets",
    columns: [
      "company_id", "created_at", "created_by_agent_id", "created_by_user_id", "deleted_at",
      "description", "external_ref", "id", "key", "last_resolved_at", "last_rotated_at",
      "latest_version", "managed_mode", "name", "owner_user_id", "provider",
      "provider_config_id", "provider_metadata", "updated_at", "user_secret_definition_id"
    ],
    reason: "Secret naming, provider routing and rotation bookkeeping. The three columns that gate resolution — status, scope and the deleted marker via status — are registered.",
  },
  {
    table: "company_skill_comments",
    columns: [
      "author_agent_id", "author_user_id", "body", "company_id", "company_skill_id",
      "created_at", "deleted_at", "id", "parent_comment_id", "updated_at"
    ],
    reason: "Free-text discussion on a shared skill. Not read as a predicate anywhere.",
  },
  {
    table: "company_skill_stars",
    columns: ["agent_id", "company_id", "company_skill_id", "created_at", "id", "user_id"],
    reason: "Per-user starring of a skill. Display ordering only.",
  },
  {
    table: "company_skill_versions",
    columns: [
      "author_agent_id", "author_user_id", "company_id", "company_skill_id", "created_at",
      "file_inventory", "id", "label", "revision_number"
    ],
    reason: "Immutable per-version snapshot of a skill's file inventory and authorship. The executable-content gate re-derives trust from the incoming inventory at import time rather than reading a stored column.",
  },
  {
    table: "company_skills",
    columns: [
      "author_name", "categories", "color", "company_id", "compatibility", "created_at",
      "current_version_id", "description", "file_inventory", "fork_count",
      "forked_from_company_id", "forked_from_skill_id", "homepage_url", "icon_url", "id",
      "install_count", "key", "markdown", "metadata", "name", "slug", "source_locator",
      "source_ref", "source_type", "star_count", "tagline", "updated_at"
    ],
    reason: "Skill catalogue metadata — naming, provenance, counters and markdown body. The two columns a reader would re-litigate, trust_level and sharing_scope, are rejected individually above.",
  },
  {
    table: "company_user_sidebar_preferences",
    columns: ["company_id", "created_at", "id", "project_order", "updated_at", "user_id"],
    reason: "Per-user sidebar ordering. Presentation only.",
  },
  {
    table: "cost_events",
    columns: [
      "agent_id", "biller", "billing_code", "billing_type", "cached_input_tokens",
      "company_id", "cost_cents", "created_at", "goal_id", "heartbeat_run_id", "id",
      "input_tokens", "issue_id", "model", "occurred_at", "output_tokens", "project_id",
      "provider", "run_identifier"
    ],
    reason: "Per-invocation cost and token telemetry. Spend enforcement reads budget_policies, which is registered; these rows are the measurement, not the limit.",
  },
  {
    table: "document_annotation_anchor_snapshots",
    columns: [
      "anchor_confidence", "anchor_state", "company_id", "created_at", "document_id",
      "failure_reason", "from_revision_id", "from_revision_number", "id", "next_anchor",
      "previous_anchor", "thread_id", "to_revision_id", "to_revision_number"
    ],
    reason: "Anchor re-resolution history for annotations across document revisions. Positional bookkeeping with no access decision attached.",
  },
  {
    table: "document_annotation_comments",
    columns: [
      "author_agent_id", "author_type", "author_user_id", "body", "company_id",
      "created_at", "created_by_run_id", "document_id", "id", "issue_comment_id",
      "issue_id", "routine_id", "thread_id", "updated_at"
    ],
    reason: "Annotation comment bodies and authorship. The one column that gates how the body reaches agent context, source_trust, is registered.",
  },
  {
    table: "document_annotation_threads",
    columns: [
      "anchor_confidence", "anchor_selector", "anchor_state", "company_id", "created_at",
      "created_by_agent_id", "created_by_user_id", "current_revision_id",
      "current_revision_number", "document_id", "document_key", "id", "issue_id",
      "markdown_end", "markdown_start", "normalized_end", "normalized_start",
      "original_revision_id", "original_revision_number", "prefix_text", "resolved_at",
      "resolved_by_agent_id", "resolved_by_user_id", "routine_id", "selected_text",
      "status", "suffix_text", "updated_at"
    ],
    reason: "Anchor geometry, selected text and resolution state for an annotation thread. Positional and workflow state; no access decision reads it.",
  },
  {
    table: "document_revisions",
    columns: [
      "body", "change_summary", "company_id", "created_at", "created_by_agent_id",
      "created_by_run_id", "created_by_user_id", "document_id", "format", "id",
      "revision_number", "title"
    ],
    reason: "Immutable revision bodies and authorship. The trust marker that gates how content reaches agent context lives on documents.source_trust, which is registered.",
  },
  {
    table: "documents",
    columns: [
      "company_id", "created_at", "created_by_agent_id", "created_by_user_id", "format",
      "id", "latest_body", "latest_revision_id", "latest_revision_number", "locked_at",
      "locked_by_agent_id", "locked_by_user_id", "title", "updated_at",
      "updated_by_agent_id", "updated_by_user_id"
    ],
    reason: "Document title, body mirror, locking and authorship. The trust marker that gates how content reaches agent context, source_trust, is registered.",
  },
  {
    table: "egress_would_deny_observations",
    columns: ["binding_id", "company_id", "count", "first_seen", "id", "last_seen", "origin"],
    reason: "Counters recording egress destinations that would have been denied in log-only mode. Diagnostic evidence for the enforcement switch, never consulted by it.",
  },
  {
    table: "environment_custom_image_setup_sessions",
    columns: [
      "base_template_ref", "connection_secret_ref", "connection_summary", "created_at",
      "environment_id", "environment_lease_id", "expires_at", "failure_reason",
      "finished_at", "id", "metadata", "promoted_template_id", "provider",
      "provider_lease_id", "started_by_agent_id", "started_by_user_id", "status",
      "template_id", "updated_at"
    ],
    reason: "Lifecycle of an interactive custom-image build session. The credential it references is a secret-ref resolved through the secrets service, which applies its own gates; no column here is a predicate.",
  },
  {
    table: "environment_custom_image_templates",
    columns: [
      "captured_at", "created_at", "created_by_agent_id", "created_by_user_id",
      "environment_id", "id", "last_used_at", "metadata", "provider",
      "source_environment_config_fingerprint", "source_template_ref", "status",
      "superseded_by_template_id", "template_kind", "template_ref", "updated_at"
    ],
    reason: "Captured image template metadata and supersession chain. Selecting a template does not widen what the resulting sandbox may reach — that is environments.config and env_vars, both registered.",
  },
  {
    table: "environment_leases",
    columns: [
      "acquired_at", "cleanup_status", "company_id", "created_at", "environment_id",
      "execution_workspace_id", "failure_reason", "heartbeat_run_id", "id", "issue_id",
      "last_used_at", "metadata", "provider", "provider_lease_id", "released_at", "status",
      "updated_at"
    ],
    reason: "Lease lifecycle, provider handles and cleanup state. The isolation decision is a company/agent/workspace/config-fingerprint match in metadata rather than any single column here.",
  },
  {
    table: "environments",
    columns: [
      "created_at", "description", "driver", "id", "metadata", "name", "status",
      "updated_at"
    ],
    reason: "Driver selection, naming and status for an execution environment. The two columns that carry the sandbox posture and injected credentials — config and env_vars — are registered.",
  },
  {
    table: "execution_workspaces",
    columns: [
      "base_ref", "branch_name", "cleanup_eligible_at", "cleanup_reason", "closed_at",
      "company_id", "created_at", "cwd", "derived_from_execution_workspace_id", "id",
      "last_used_at", "metadata", "mode", "name", "opened_at", "project_id",
      "project_workspace_id", "provider_ref", "provider_type", "repo_url",
      "source_issue_id", "status", "strategy_type", "updated_at"
    ],
    reason: "Workspace provisioning bookkeeping — refs, paths, provider handles and cleanup state. The isolation decision is resolved from projects.execution_workspace_policy, which is registered.",
  },
  {
    table: "external_object_mentions",
    columns: [
      "canonical_identity", "canonical_identity_hash", "company_id", "confidence",
      "created_at", "created_by_plugin_id", "detector_key", "document_key", "id",
      "matched_text_redacted", "object_id", "object_type", "property_key", "provider_key",
      "sanitized_display_url", "source_issue_id", "source_kind", "source_record_id",
      "updated_at"
    ],
    reason: "Detected references to third-party objects in issue and document text, with the matched text already redacted. Display enrichment only.",
  },
  {
    table: "external_objects",
    columns: [
      "canonical_identity_hash", "company_id", "created_at", "data", "display_key",
      "display_title", "etag", "external_id", "icon_key", "id", "is_terminal",
      "last_changed_at", "last_error_at", "last_error_code", "last_error_message",
      "last_resolved_at", "liveness", "next_refresh_at", "object_type", "plugin_id",
      "provider_key", "remote_version", "sanitized_canonical_url", "status_category",
      "status_icon_key", "status_key", "status_label", "status_tone", "updated_at"
    ],
    reason: "Cached projections of third-party objects fetched by plugins. Read for display; the capability to fetch them is enforced from plugins.manifest_json, which is registered.",
  },
  {
    table: "feedback_exports",
    columns: [
      "attempt_count", "author_user_id", "bundle_version", "company_id", "consent_version",
      "created_at", "destination", "export_id", "exported_at", "failure_reason",
      "feedback_vote_id", "id", "issue_id", "last_attempted_at", "payload_digest",
      "payload_snapshot", "payload_version", "project_id", "redaction_summary",
      "schema_version", "target_id", "target_summary", "target_type", "updated_at", "vote"
    ],
    reason: "Export attempt bookkeeping, payload snapshots and redaction summaries. The single column that gates shipping a trace off-instance, status, is registered.",
  },
  {
    table: "feedback_votes",
    columns: [
      "author_user_id", "company_id", "consent_version", "created_at", "id", "issue_id",
      "reason", "redaction_summary", "shared_at", "target_id", "target_type", "updated_at",
      "vote"
    ],
    reason: "The vote itself plus the consent record captured at vote time. The off-instance upload is gated by feedback_exports.status, which is registered.",
  },
  {
    table: "finance_events",
    columns: [
      "agent_id", "amount_cents", "biller", "billing_code", "company_id", "cost_event_id",
      "created_at", "currency", "description", "direction", "estimated", "event_kind",
      "execution_adapter_type", "external_invoice_id", "goal_id", "heartbeat_run_id", "id",
      "issue_id", "metadata_json", "model", "occurred_at", "pricing_tier", "project_id",
      "provider", "quantity", "region", "unit"
    ],
    reason: "Billing ledger rows. Measurement of spend that already happened; the hard stop reads budget_policies, which is registered.",
  },
  {
    table: "goals",
    columns: [
      "company_id", "created_at", "description", "id", "level", "owner_agent_id",
      "parent_id", "status", "title", "updated_at"
    ],
    reason: "Goal titles, hierarchy and status. Planning metadata with no access decision attached.",
  },
  {
    table: "heartbeat_run_events",
    columns: [
      "agent_id", "color", "company_id", "created_at", "event_type", "id", "level",
      "message", "payload", "run_id", "seq", "stream"
    ],
    reason: "Append-only per-run event stream. Written by the runner and read for display and diagnostics; no column is read as a predicate.",
  },
  {
    table: "heartbeat_run_watchdog_decisions",
    columns: [
      "company_id", "created_at", "created_by_agent_id", "created_by_run_id",
      "created_by_user_id", "decision", "evaluation_issue_id", "id", "reason", "run_id",
      "snoozed_until"
    ],
    reason: "Recorded watchdog verdicts on a run. Evidence of a decision already made, not an input to one.",
  },
  {
    table: "heartbeat_runs",
    columns: [
      "agent_id", "company_id", "context_snapshot", "continuation_attempt", "created_at",
      "error", "error_code", "exit_code", "external_run_id", "finished_at", "id",
      "invocation_source", "issue_comment_retry_queued_at",
      "issue_comment_satisfied_by_comment_id", "issue_comment_status", "last_output_at",
      "last_output_bytes", "last_output_seq", "last_output_stream", "last_useful_action_at",
      "liveness_reason", "liveness_state", "log_bytes", "log_compressed", "log_ref",
      "log_sha256", "log_store", "next_action", "process_group_id",
      "process_loss_retry_count", "process_pid", "process_started_at",
      "responsible_user_id", "result_json", "retry_of_run_id", "scheduled_retry_at",
      "scheduled_retry_attempt", "scheduled_retry_reason", "session_id_after",
      "session_id_before", "signal", "started_at", "status", "stderr_excerpt",
      "stdout_excerpt", "trigger_detail", "updated_at", "usage_json", "wakeup_request_id"
    ],
    reason: "Run lifecycle, process handles, log pointers and output excerpts. What a run is allowed to do is resolved from the agent and issue rows at launch; these columns record what happened.",
  },
  {
    table: "inbox_dismissals",
    columns: [
      "company_id", "created_at", "dismissed_at", "id", "item_key", "updated_at", "user_id"
    ],
    reason: "Per-user inbox dismissal state. Presentation only.",
  },
  {
    table: "instance_settings",
    columns: ["created_at", "default_environment_id", "id", "singleton_key", "updated_at"],
    reason: "Singleton settings row. Every write to a singleton is unqualified by construction, so the rule has no flatten shape to catch here and would be pure false-positive noise.",
  },
  {
    table: "instance_user_roles",
    columns: ["created_at", "id", "updated_at", "user_id"],
    reason: "Instance-level role assignment. The one column that carries the grant, role, is registered.",
  },
  {
    table: "invites",
    columns: [
      "accepted_at", "company_id", "created_at", "defaults_payload", "id", "invite_type",
      "invited_by_user_id", "updated_at"
    ],
    reason: "Invite type, defaults payload and authorship. The four columns that gate redemption — revoked_at, expires_at, allowed_join_types, token_hash — are registered.",
  },
  {
    table: "issue_approvals",
    columns: [
      "approval_id", "company_id", "created_at", "issue_id", "linked_by_agent_id",
      "linked_by_user_id"
    ],
    reason: "Join row linking an issue to an approval record. The decision lives on approvals.",
  },
  {
    table: "issue_attachments",
    columns: [
      "asset_id", "company_id", "created_at", "id", "issue_comment_id", "issue_id",
      "updated_at"
    ],
    reason: "Join row linking an issue or comment to an uploaded asset. Access is authorized by the owning company and route.",
  },
  {
    table: "issue_comments",
    columns: [
      "author_agent_id", "author_type", "author_user_id", "body", "company_id",
      "created_at", "created_by_run_id", "deleted_at", "deleted_by_agent_id",
      "deleted_by_run_id", "deleted_by_type", "deleted_by_user_id",
      "derived_author_agent_id", "derived_author_source", "derived_created_by_run_id", "id",
      "issue_id", "metadata", "presentation", "updated_at"
    ],
    reason: "Comment bodies, authorship and deletion markers. The column that gates how a body reaches higher-trust agent context, source_trust, is registered.",
  },
  {
    table: "issue_documents",
    columns: ["company_id", "created_at", "document_id", "id", "issue_id", "key", "updated_at"],
    reason: "Join row linking an issue to a document under a key. The trust marker lives on documents.source_trust, which is registered.",
  },
  {
    table: "issue_execution_decisions",
    columns: [
      "actor_agent_id", "actor_user_id", "body", "company_id", "created_at",
      "created_by_run_id", "id", "issue_id", "outcome", "stage_id", "stage_type",
      "updated_at"
    ],
    reason: "Recorded stage decisions on an issue. Evidence of a decision, not an input to one; the transition graph is gated by pipelines.enforce_transitions, which is registered.",
  },
  {
    table: "issue_inbox_archives",
    columns: [
      "archived_at", "company_id", "created_at", "id", "issue_id", "updated_at", "user_id"
    ],
    reason: "Per-user archive state for an issue. Presentation only.",
  },
  {
    table: "issue_labels",
    columns: ["company_id", "created_at", "issue_id", "label_id"],
    reason: "Join row between an issue and a label. No access decision reads it.",
  },
  {
    table: "issue_plan_decompositions",
    columns: [
      "accepted_interaction_id", "accepted_plan_revision_id", "child_issue_ids",
      "company_id", "completed_at", "created_at", "id", "owner_agent_id", "owner_run_id",
      "owner_user_id", "request_fingerprint", "requested_child_count", "requested_children",
      "source_issue_id", "status", "updated_at"
    ],
    reason: "Bookkeeping for a plan-to-children expansion, including the accepted revision and the resulting child ids. Records what was accepted rather than gating it.",
  },
  {
    table: "issue_read_states",
    columns: [
      "company_id", "created_at", "id", "issue_id", "last_read_at", "updated_at", "user_id"
    ],
    reason: "Per-user read markers. Presentation only.",
  },
  {
    table: "issue_recovery_actions",
    columns: [
      "attempt_count", "cause", "company_id", "created_at", "evidence", "fingerprint", "id",
      "kind", "last_attempt_at", "max_attempts", "next_action", "outcome", "owner_agent_id",
      "owner_type", "owner_user_id", "previous_owner_agent_id", "recovery_issue_id",
      "resolution_note", "resolved_at", "return_owner_agent_id", "source_issue_id",
      "status", "timeout_at", "updated_at"
    ],
    reason: "Recovery attempt bookkeeping — cause, evidence, ownership handoff and attempt counters. Availability machinery; no column widens what a recovered run may reach.",
  },
  {
    table: "issue_reference_mentions",
    columns: [
      "company_id", "created_at", "document_key", "id", "matched_text", "source_issue_id",
      "source_kind", "source_record_id", "target_issue_id", "updated_at"
    ],
    reason: "Detected cross-references between issues in text. Display enrichment only.",
  },
  {
    table: "issue_relations",
    columns: [
      "company_id", "created_at", "created_by_agent_id", "created_by_user_id", "id",
      "issue_id", "related_issue_id", "type", "updated_at"
    ],
    reason: "Typed links between issues. Graph structure with no access decision attached.",
  },
  {
    table: "issue_thread_interactions",
    columns: [
      "company_id", "created_at", "created_by_agent_id", "created_by_user_id", "id",
      "idempotency_key", "issue_id", "kind", "payload", "resolved_at",
      "resolved_by_agent_id", "resolved_by_user_id", "result", "source_comment_id",
      "source_run_id", "status", "summary", "title", "updated_at"
    ],
    reason: "Interaction prompts, payloads and resolution state. The authority to act on a resolved interaction comes from the resolving principal, not from these columns.",
  },
  {
    table: "issue_tree_hold_members",
    columns: [
      "active_run_id", "active_run_status", "assignee_agent_id", "assignee_user_id",
      "company_id", "created_at", "depth", "hold_id", "id", "issue_id", "issue_identifier",
      "issue_status", "issue_title", "parent_issue_id", "skip_reason", "skipped"
    ],
    reason: "Denormalised snapshot of the issues covered by a hold. Display and progress reporting; the hold itself is the control.",
  },
  {
    table: "issue_tree_holds",
    columns: [
      "company_id", "created_at", "created_by_actor_type", "created_by_agent_id",
      "created_by_run_id", "created_by_user_id", "id", "mode", "reason", "release_metadata",
      "release_reason", "released_at", "released_by_actor_type", "released_by_agent_id",
      "released_by_run_id", "released_by_user_id", "root_issue_id", "status", "updated_at"
    ],
    reason: "Hold mode, status, authorship and release bookkeeping. The one column that could fail open, release_policy, is rejected individually above because NULL normalises to the strictest value.",
  },
  {
    table: "issue_watchdogs",
    columns: [
      "company_id", "created_at", "created_by_agent_id", "created_by_run_id",
      "created_by_user_id", "id", "instructions", "issue_id", "last_completed_at",
      "last_observed_fingerprint", "last_reviewed_fingerprint", "last_triggered_at",
      "status", "trigger_count", "updated_at", "updated_by_agent_id", "updated_by_run_id",
      "updated_by_user_id", "watchdog_agent_id", "watchdog_issue_id"
    ],
    reason: "Watchdog instructions, fingerprints and trigger counters. Schedules an observing agent; it does not widen what that agent may reach.",
  },
  {
    table: "issue_work_products",
    columns: [
      "company_id", "created_at", "created_by_run_id", "execution_workspace_id",
      "external_id", "health_status", "id", "is_primary", "issue_id", "metadata",
      "project_id", "provider", "review_state", "runtime_service_id", "status", "summary",
      "title", "type", "updated_at", "url"
    ],
    reason: "Work-product metadata — type, provider, health and review state. The column that gates how a quarantined preview is rendered, source_trust, is registered.",
  },
  {
    table: "issues",
    columns: [
      "assignee_agent_id", "assignee_user_id", "billing_code", "cancelled_at",
      "checkout_run_id", "company_id", "completed_at", "created_at", "created_by_agent_id",
      "created_by_user_id", "description", "execution_agent_name_key",
      "execution_locked_at", "execution_run_id", "execution_state",
      "execution_workspace_id", "goal_id", "hidden_at", "id", "identifier", "issue_number",
      "monitor_attempt_count", "monitor_last_triggered_at", "monitor_next_check_at",
      "monitor_notes", "monitor_scheduled_by", "monitor_wake_requested_at",
      "origin_fingerprint", "origin_id", "origin_kind", "origin_run_id", "parent_id",
      "priority", "project_id", "project_workspace_id", "request_depth",
      "responsible_user_id", "started_at", "status", "title", "updated_at", "work_mode"
    ],
    reason: "Issue title, body, status, assignment and scheduling. The four columns that carry execution authority — execution_policy, assignee_adapter_overrides, source_trust and the workspace preference — are registered.",
  },
  {
    table: "join_requests",
    columns: [
      "adapter_type", "agent_defaults_payload", "agent_name", "approved_by_user_id",
      "capabilities", "company_id", "created_agent_id", "created_at", "id", "invite_id",
      "rejected_at", "rejected_by_user_id", "request_email_snapshot", "request_ip",
      "request_type", "requesting_user_id", "updated_at"
    ],
    reason: "Request identity, snapshots and rejection bookkeeping. The columns that gate approval and key claim — status, claim_secret_expires_at, claim_secret_hash, claim_secret_consumed_at — are registered.",
  },
  {
    table: "labels",
    columns: ["color", "company_id", "created_at", "id", "name", "updated_at"],
    reason: "Label naming and colour. Presentation only.",
  },
  {
    table: "pipeline_automation_executions",
    columns: [
      "automation_id", "case_id", "company_id", "created_at", "error", "execution_issue_id",
      "generation", "id", "retry_of_execution_id", "routine_id", "status",
      "triggering_event_id", "updated_at"
    ],
    reason: "Bookkeeping for an automation run against a case. Records generation, retries and the resulting issue; the transition gate is pipelines.enforce_transitions, which is registered.",
  },
  {
    table: "pipeline_case_blockers",
    columns: ["blocked_by_case_id", "case_id", "company_id", "created_at", "id", "updated_at"],
    reason: "Join row expressing one case blocking another. Workflow structure only.",
  },
  {
    table: "pipeline_case_documents",
    columns: ["case_id", "company_id", "created_at", "document_id", "id", "key", "updated_at"],
    reason: "Join row linking a case to a document under a key. The trust marker lives on documents.source_trust.",
  },
  {
    table: "pipeline_case_events",
    columns: [
      "actor_agent_id", "actor_type", "actor_user_id", "case_id", "company_id",
      "created_at", "from_stage_id", "id", "payload", "run_id", "to_stage_id", "type",
      "updated_at"
    ],
    reason: "Append-only case event stream with actor attribution. Evidence of transitions already made.",
  },
  {
    table: "pipeline_case_issue_links",
    columns: [
      "automation_attempt_id", "case_id", "company_id", "created_at", "created_by_run_id",
      "id", "issue_id", "retired_at", "retired_by_attempt_id", "retired_reason", "role",
      "updated_at"
    ],
    reason: "Join rows between cases and issues, with retirement bookkeeping. Workflow structure only.",
  },
  {
    table: "pipeline_cases",
    columns: [
      "automation_attempt_id", "case_key", "child_count", "company_id", "created_at",
      "created_by_agent_id", "created_by_user_id", "fields", "hidden_from_board_at", "id",
      "lease_agent_id", "lease_owner_type", "lease_user_id", "origin_run_id",
      "parent_case_id", "parent_case_version", "pending_suggestion", "pipeline_id",
      "request_key", "retired_at", "retired_by_attempt_id", "retired_reason", "stage_id",
      "summary", "terminal_at", "terminal_child_count", "terminal_kind", "title",
      "updated_at", "version", "workspace_ref"
    ],
    reason: "Case fields, staging, hierarchy and retirement bookkeeping. The two columns that carry the work-claim lease — lease_token and lease_expires_at — are registered.",
  },
  {
    table: "pipeline_documents",
    columns: [
      "company_id", "created_at", "document_id", "id", "key", "pipeline_id", "updated_at"
    ],
    reason: "Join row linking a pipeline to a document under a key.",
  },
  {
    table: "pipeline_stages",
    columns: [
      "config", "created_at", "id", "key", "kind", "name", "pipeline_id", "position",
      "updated_at"
    ],
    reason: "Stage naming, ordering and per-stage config. Which stages exist is structure; whether they can be skipped is pipelines.enforce_transitions, which is registered.",
  },
  {
    table: "pipeline_transitions",
    columns: [
      "created_at", "from_stage_id", "id", "label", "pipeline_id", "to_stage_id",
      "updated_at"
    ],
    reason: "Allowed stage-to-stage edges. The edges are the graph, and the column that decides whether the graph is enforced at all, pipelines.enforce_transitions, is registered.",
  },
  {
    table: "pipelines",
    columns: [
      "archived_at", "company_id", "created_at", "created_by_agent_id",
      "created_by_user_id", "description", "id", "key", "name", "project_id", "updated_at"
    ],
    reason: "Pipeline naming, ownership and archival. The one integrity column, enforce_transitions, is registered.",
  },
  {
    table: "plugin_company_settings",
    columns: [
      "company_id", "created_at", "id", "last_error", "plugin_id", "settings_json",
      "updated_at"
    ],
    reason: "Per-company plugin settings payload and last error. The single opt-out gate, enabled, is registered.",
  },
  {
    table: "plugin_config",
    columns: ["created_at", "id", "last_error", "plugin_id", "updated_at"],
    reason: "Per-plugin last-error and timestamps. The column carrying secret-ref bindings and per-company policy, config_json, is registered.",
  },
  {
    table: "plugin_config_egress_allowlist",
    columns: ["company_id", "config_key", "created_at", "id", "plugin_id", "updated_at"],
    reason: "Row identity, tenant/config-key addressing, and timestamps for the config-key egress allowlist. The enforcement switch and destination list, egress_allowlist_enforced and allowed_egress, are registered.",
  },
  {
    table: "plugin_config_egress_would_deny_observations",
    columns: ["count", "first_seen", "id", "last_seen", "origin", "plugin_id"],
    reason: "Counters recording config-key egress destinations that would have been denied in log-only mode. Diagnostic evidence for the enforcement switch, never consulted by it.",
  },
  {
    table: "plugin_database_namespaces",
    columns: [
      "created_at", "id", "namespace_mode", "namespace_name", "plugin_id", "plugin_key",
      "status", "updated_at"
    ],
    reason: "Per-plugin database namespace allocation. The namespace bounds what a plugin's own migrations may touch, but it is assigned by the host from the plugin key rather than read back as a permission; the capability gate is plugins.manifest_json, which is registered.",
  },
  {
    table: "plugin_entities",
    columns: [
      "company_id", "created_at", "data", "entity_type", "external_id", "id", "plugin_id",
      "scope_id", "scope_kind", "status", "title", "updated_at"
    ],
    reason: "Plugin-owned entity rows scoped by company. Data the plugin stores; the reach that produced it is gated by plugins.manifest_json and plugin_company_settings.enabled, both registered.",
  },
  {
    table: "plugin_job_runs",
    columns: [
      "company_id", "created_at", "duration_ms", "error", "finished_at", "id", "job_id",
      "logs", "plugin_id", "started_at", "status", "trigger"
    ],
    reason: "Per-execution job run telemetry — timing, status and logs. Records what ran.",
  },
  {
    table: "plugin_jobs",
    columns: [
      "created_at", "id", "job_key", "last_run_at", "next_run_at", "plugin_id", "schedule",
      "status", "updated_at"
    ],
    reason: "Registered plugin job schedules and last/next run markers. Scheduling only; what a job may reach is the manifest capability set, which is registered.",
  },
  {
    table: "plugin_logs",
    columns: ["company_id", "created_at", "id", "level", "message", "meta", "plugin_id"],
    reason: "Plugin log lines. Diagnostics only.",
  },
  {
    table: "plugin_managed_resources",
    columns: [
      "company_id", "created_at", "defaults_json", "id", "plugin_id", "plugin_key",
      "resource_id", "resource_key", "resource_kind", "updated_at"
    ],
    reason: "Host resources a plugin declared and the host provisioned. Declaration is bounded by the manifest capabilities, which are registered.",
  },
  {
    table: "plugin_migrations",
    columns: [
      "applied_at", "checksum", "error_message", "id", "migration_key", "namespace_name",
      "plugin_id", "plugin_key", "plugin_version", "started_at", "status"
    ],
    reason: "Applied-migration ledger for a plugin's own namespace, with checksums. Records what ran inside an already-bounded namespace.",
  },
  {
    table: "plugin_state",
    columns: [
      "id", "namespace", "plugin_id", "scope_id", "scope_kind", "state_key", "updated_at",
      "value_json"
    ],
    reason: "Plugin key/value state scoped by kind and id. Data storage; the reach that wrote it is gated by the manifest, which is registered.",
  },
  {
    table: "plugin_webhook_deliveries",
    columns: [
      "company_id", "created_at", "duration_ms", "error", "external_id", "finished_at",
      "headers", "id", "payload", "plugin_id", "started_at", "status", "webhook_key"
    ],
    reason: "Inbound webhook delivery records — headers, payload, timing and status. Evidence of a delivery already authorized by the plugin's own gate.",
  },
  {
    table: "plugins",
    columns: [
      "api_version", "categories", "id", "install_order", "installed_at", "last_error",
      "package_name", "package_path", "plugin_key", "updated_at", "version"
    ],
    reason: "Plugin packaging, versioning and install bookkeeping. The two trust columns — status and manifest_json — are registered.",
  },
  {
    table: "principal_permission_grants",
    columns: [
      "company_id", "created_at", "granted_by_user_id", "id", "principal_id",
      "principal_type", "updated_at"
    ],
    reason: "Principal identity and grant authorship. The two columns that carry the grant itself — permission_key and scope — are registered.",
  },
  {
    table: "project_goals",
    columns: ["company_id", "created_at", "goal_id", "project_id", "updated_at"],
    reason: "Join row between a project and a goal.",
  },
  {
    table: "project_memberships",
    columns: [
      "company_id", "created_at", "id", "project_id", "starred_at", "state", "updated_at",
      "user_id"
    ],
    reason: "Per-user project membership and starring. Company-level authorization is company_memberships, whose status and membership_role are registered.",
  },
  {
    table: "project_workspaces",
    columns: [
      "company_id", "created_at", "cwd", "default_ref", "id", "is_primary", "metadata",
      "name", "project_id", "remote_provider", "remote_workspace_ref", "repo_ref",
      "repo_url", "shared_workspace_key", "source_type", "updated_at"
    ],
    reason: "Workspace naming, repo pointers and reuse keys. The two columns whose values are executed by the host shell — setup_command and cleanup_command — are registered.",
  },
  {
    table: "projects",
    columns: [
      "archived_at", "color", "company_id", "created_at", "description", "goal_id", "icon",
      "id", "lead_agent_id", "name", "pause_reason", "paused_at", "status", "target_date",
      "updated_at"
    ],
    reason: "Project naming, archival, pause bookkeeping and environment reference. The one column that resolves workspace isolation, execution_workspace_policy, is registered.",
  },
  {
    table: "routine_documents",
    columns: [
      "company_id", "created_at", "document_id", "id", "key", "routine_id", "updated_at"
    ],
    reason: "Join row linking a routine to a document under a key.",
  },
  {
    table: "routine_revisions",
    columns: [
      "change_summary", "company_id", "created_at", "created_by_agent_id",
      "created_by_run_id", "created_by_user_id", "description", "id", "responsible_user_id",
      "restored_from_revision_id", "revision_number", "routine_id", "snapshot", "title"
    ],
    reason: "Immutable snapshots of a routine definition. The live routine row is what dispatch reads.",
  },
  {
    table: "routine_runs",
    columns: [
      "coalesced_into_run_id", "company_id", "completed_at", "created_at",
      "dispatch_fingerprint", "failure_reason", "id", "idempotency_key", "linked_issue_id",
      "responsible_user_id", "routine_id", "routine_revision_id", "source", "status",
      "trigger_id", "trigger_payload", "triggered_at", "updated_at"
    ],
    reason: "Per-dispatch run bookkeeping — trigger payload, coalescing and outcome. Records what ran.",
  },
  {
    table: "routine_triggers",
    columns: [
      "company_id", "created_at", "created_by_agent_id", "created_by_user_id",
      "cron_expression", "id", "kind", "label", "last_fired_at", "last_result",
      "last_rotated_at", "next_run_at", "routine_id", "secret_id", "timezone", "updated_at",
      "updated_by_agent_id", "updated_by_user_id"
    ],
    reason: "Trigger naming, scheduling and rotation bookkeeping. The four columns that gate inbound webhook authentication — enabled, signing_mode, replay_window_sec, public_id — are registered.",
  },
  {
    table: "routines",
    columns: [
      "assignee_agent_id", "company_id", "created_at", "created_by_agent_id",
      "created_by_user_id", "description", "goal_id", "id", "last_enqueued_at",
      "last_triggered_at", "latest_revision_id", "latest_revision_number", "origin_id",
      "origin_kind", "parent_issue_id", "priority", "project_id", "responsible_user_id",
      "title", "updated_at", "updated_by_agent_id", "updated_by_user_id", "variables"
    ],
    reason: "Routine definition, ownership and scheduling metadata. The two columns that gate dispatch and injected environment — status and env — are registered.",
  },
  {
    table: "secret_access_events",
    columns: [
      "actor_id", "actor_type", "company_id", "config_path", "consumer_id", "consumer_type",
      "created_at", "credential_owner_user_id", "credential_subject_id",
      "credential_subject_type", "error_code", "heartbeat_run_id", "id", "issue_id",
      "outcome", "plugin_id", "provider", "responsible_user_id", "secret_id",
      "secret_scope", "user_secret_definition_id", "version"
    ],
    reason: "Append-only audit of secret resolution attempts and their outcomes. Evidence; the gates it records are on company_secrets and company_secret_versions, which are registered.",
  },
  {
    table: "session",
    columns: ["created_at", "id", "ip_address", "updated_at", "user_agent", "user_id"],
    reason: "Session identity, address and user-agent recorded by better-auth. The two columns that bound a session — expires_at and token — are registered on library-behaviour grounds.",
  },
  {
    table: "usage_limit_parks",
    columns: [
      "created_at", "id", "parked_until", "raw_limit_text", "reason", "singleton_key",
      "source_run_id", "updated_at"
    ],
    reason: "Singleton parking record for provider usage limits. Availability backoff; parking never widens what a resumed run may reach.",
  },
  {
    table: "user",
    columns: ["created_at", "email", "id", "image", "name", "updated_at"],
    reason: "User identity and display fields owned by better-auth. Authorization is instance_user_roles.role and company_memberships, both registered.",
  },
  {
    table: "user_secret_declarations",
    columns: [
      "company_id", "config_path", "created_at", "env_key", "id", "label", "target_id",
      "target_type", "updated_at", "user_secret_definition_id", "version_selector"
    ],
    reason: "Declared per-user secret slots — key, label, target and version selector. The reachability gate is the existence of the declaration plus the adapter-config binding, not any column here.",
  },
  {
    table: "user_secret_definitions",
    columns: [
      "company_id", "created_at", "created_by_agent_id", "created_by_user_id", "deleted_at",
      "description", "id", "key", "managed_mode", "name", "provider", "provider_config_id",
      "provider_metadata", "status", "updated_at", "updated_by_agent_id",
      "updated_by_user_id", "usage_guidance"
    ],
    reason: "Definition naming, provider routing and authorship for a user-scoped secret. Resolution is gated by company_secrets.status and company_secret_versions.status, both registered.",
  },
  {
    table: "user_sidebar_preferences",
    columns: ["company_order", "created_at", "id", "updated_at", "user_id"],
    reason: "Per-user company ordering. Presentation only.",
  },
  {
    table: "verification",
    columns: ["created_at", "id", "identifier", "updated_at"],
    reason: "better-auth verification artefacts for email verification and password reset. The two columns that bound one — expires_at and value — are registered on library-behaviour grounds.",
  },
  {
    table: "workspace_operations",
    columns: [
      "command", "company_id", "created_at", "cwd", "execution_workspace_id", "exit_code",
      "finished_at", "heartbeat_run_id", "id", "issue_id", "log_bytes", "log_compressed",
      "log_ref", "log_sha256", "log_store", "metadata", "phase", "started_at", "status",
      "stderr_excerpt", "stdout_excerpt", "updated_at"
    ],
    reason: "Append-only record of workspace commands the host already ran, with captured output. The command text here is history; the columns the host reads to decide what to run are project_workspaces.setup_command and cleanup_command, which are registered.",
  },
  {
    table: "workspace_runtime_services",
    columns: [
      "command", "company_id", "created_at", "cwd", "execution_workspace_id",
      "health_status", "id", "issue_id", "last_used_at", "lifecycle", "owner_agent_id",
      "port", "project_id", "project_workspace_id", "provider", "provider_ref", "reuse_key",
      "scope_id", "scope_type", "service_name", "started_at", "started_by_run_id", "status",
      "stop_policy", "stopped_at", "updated_at", "url"
    ],
    reason: "Long-running dev-service bookkeeping — ports, health, lifecycle and provider handles. The command is supplied per start request rather than re-read from this row to launch a new process.",
  },

  // --- sync/upstream-v2026.824.1: columns introduced by upstream 707->824 (classified during the 824.1 superset re-land) ---
  // activity_log — fork activity log (new upstream columns); the columns below are metadata-only.

  {
    table: "activity_log",
    columns: ["responsible_user_id"],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  // adapter_auth_sessions — upstream adapter auth session/promotion records; the columns below are metadata-only.

  {
    table: "adapter_auth_sessions",
    columns: [
     "company_id",
     "environment_id",
     "id",
     "provider_lease_id",
     "started_by_user_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "adapter_auth_sessions",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "adapter_auth_sessions",
    columns: [
     "adapter_type",
     "failure_reason"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "adapter_auth_sessions",
    columns: [
     "created_at",
     "expires_at",
     "finished_at",
     "promotion_expires_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // built_in_managed_resources — upstream built-in managed resource catalog; the columns below are metadata-only.

  {
    table: "built_in_managed_resources",
    columns: ["bundle_key"],
    reason: "Bundle natural key (catalog identity), not a credential.",
  },
  {
    table: "built_in_managed_resources",
    columns: ["resource_key"],
    reason: "Resource natural key within a bundle, not a credential.",
  },
  {
    table: "built_in_managed_resources",
    columns: [
     "company_id",
     "id",
     "resource_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "built_in_managed_resources",
    columns: [
     "defaults_json",
     "resource_kind"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "built_in_managed_resources",
    columns: [
     "stock_hash",
     "stock_version"
    ],
    reason: "Numeric bookkeeping (counts, durations, sizes, versions); it carries no authorization semantics.",
  },
  {
    table: "built_in_managed_resources",
    columns: [
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // case_attachments — upstream case attachment links; the columns below are metadata-only.

  {
    table: "case_attachments",
    columns: [
     "asset_id",
     "case_id",
     "company_id",
     "id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "case_attachments",
    columns: [
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // case_documents — upstream case-document links; the columns below are metadata-only.

  {
    table: "case_documents",
    columns: ["key"],
    reason: "Natural/uniqueness key column, not a credential.",
  },
  {
    table: "case_documents",
    columns: [
     "case_id",
     "company_id",
     "document_id",
     "id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "case_documents",
    columns: [
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // case_events — upstream Cases v1 event log; the columns below are metadata-only.

  {
    table: "case_events",
    columns: [
     "actor_agent_id",
     "actor_user_id",
     "case_id",
     "company_id",
     "id",
     "run_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "case_events",
    columns: [
     "actor_type",
     "kind"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "case_events",
    columns: ["payload"],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "case_events",
    columns: [
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // case_issue_links — upstream case-issue links; the columns below are metadata-only.

  {
    table: "case_issue_links",
    columns: ["role"],
    reason: "Role label on a link row for display; authorization is enforced by membership tables.",
  },
  {
    table: "case_issue_links",
    columns: [
     "case_id",
     "company_id",
     "created_by_run_id",
     "id",
     "issue_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "case_issue_links",
    columns: [
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // case_labels — upstream case label links; the columns below are metadata-only.

  {
    table: "case_labels",
    columns: [
     "case_id",
     "company_id",
     "id",
     "label_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "case_labels",
    columns: [
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // cases — upstream Cases v1 case rows; the columns below are metadata-only.

  {
    table: "cases",
    columns: ["key"],
    reason: "Natural/uniqueness key column, not a credential.",
  },
  {
    table: "cases",
    columns: [
     "summary",
     "title"
    ],
    reason: "Display text rendered in the UI; it carries no authorization semantics.",
  },
  {
    table: "cases",
    columns: [
     "company_id",
     "created_by_agent_id",
     "created_by_user_id",
     "id",
     "parent_case_id",
     "project_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "cases",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "cases",
    columns: [
     "case_number",
     "case_type",
     "fields",
     "identifier"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "cases",
    columns: [
     "completed_at",
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // claude_setup_token_sessions — upstream claude setup-token login sessions; the columns below are metadata-only.

  {
    table: "claude_setup_token_sessions",
    columns: ["owner_user_id"],
    reason: "FK to the owning user; the user's authority is evaluated at the API layer.",
  },
  {
    table: "claude_setup_token_sessions",
    columns: ["session_id"],
    reason: "FK to the setup-token login session row; the token itself never persists.",
  },
  {
    table: "claude_setup_token_sessions",
    columns: [
     "company_id",
     "environment_id",
     "id",
     "lease_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "claude_setup_token_sessions",
    columns: ["state"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "claude_setup_token_sessions",
    columns: ["adapter_type"],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "claude_setup_token_sessions",
    columns: [
     "bound_at",
     "created_at",
     "deadline_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // companies — company row (new upstream column); the columns below are metadata-only.

  // company_onboarding_seeds — upstream company onboarding seed spec; the columns below are metadata-only.

  {
    table: "company_onboarding_seeds",
    columns: ["agent_role"],
    reason: "Seed profile role label; not a runtime authorization decision.",
  },
  {
    table: "company_onboarding_seeds",
    columns: [
     "agent_id",
     "company_id",
     "goal_id",
     "id",
     "issue_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "company_onboarding_seeds",
    columns: [
     "agent_name",
     "first_task_title",
     "mission"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "company_onboarding_seeds",
    columns: ["revision"],
    reason: "Numeric bookkeeping (counts, durations, sizes, versions); it carries no authorization semantics.",
  },
  {
    table: "company_onboarding_seeds",
    columns: ["first_task_details"],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "company_onboarding_seeds",
    columns: [
     "applied_at",
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // company_secret_bindings — fork secret binding rows (new fork columns); the columns below are metadata-only.

  {
    table: "company_secret_bindings",
    columns: ["projection_allowlist_key"],
    reason: "Names which config projection allowlist entry a binding mirrors; the allowlist itself lives in plugin config.",
  },
  {
    table: "company_secret_bindings",
    columns: ["projection_class"],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  // company_secret_proposals — fork+upstream secret-proposal workflow records; the columns below are metadata-only.

  {
    table: "company_secret_proposals",
    columns: ["created_secret_id"],
    reason: "FK to the company_secrets row created from an approved proposal; the secret row carries the authorization.",
  },
  {
    table: "company_secret_proposals",
    columns: ["secret_id"],
    reason: "FK to the company_secrets row; the secret row carries the authorization.",
  },
  {
    table: "company_secret_proposals",
    columns: ["secret_proposal_id"],
    reason: "FK within the proposals subsystem.",
  },
  {
    table: "company_secret_proposals",
    columns: ["proposed_key"],
    reason: "Proposed secret key name (label), not credential material.",
  },
  {
    table: "company_secret_proposals",
    columns: ["binding_target_policy_snapshot"],
    reason: "Snapshot of binding policy at proposal time for audit; live bindings carry the authorization.",
  },
  {
    table: "company_secret_proposals",
    columns: [
     "company_id",
     "id",
     "origin_issue_id",
     "origin_run_id",
     "proposed_by_agent_id",
     "resolved_by_user_id",
     "target_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "company_secret_proposals",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "company_secret_proposals",
    columns: [
     "applied_binding_config_path",
     "config_path",
     "justification",
     "kind",
     "projection_class",
     "proposed_description",
     "proposed_name",
     "resolution_reason",
     "target_type",
     "value_fingerprint_sha256",
     "value_length"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "company_secret_proposals",
    columns: [
     "proposer_ancestor_ids_snapshot",
     "target_ancestor_ids_snapshot"
    ],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "company_secret_proposals",
    columns: [
     "ciphertext_scrubbed_at",
     "created_at",
     "expires_at",
     "resolved_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // company_skill_policies — upstream company skill tool-access policies; the columns below are metadata-only.

  {
    table: "company_skill_policies",
    columns: ["company_id"],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "company_skill_policies",
    columns: [
     "revision",
     "schema_version"
    ],
    reason: "Numeric bookkeeping (counts, durations, sizes, versions); it carries no authorization semantics.",
  },
  {
    table: "company_skill_policies",
    columns: [
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // company_skill_test_inputs — upstream skill-studio test inputs; the columns below are metadata-only.

  {
    table: "company_skill_test_inputs",
    columns: ["name"],
    reason: "Display text rendered in the UI; it carries no authorization semantics.",
  },
  {
    table: "company_skill_test_inputs",
    columns: [
     "company_id",
     "id",
     "skill_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "company_skill_test_inputs",
    columns: ["created_by"],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "company_skill_test_inputs",
    columns: ["content"],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "company_skill_test_inputs",
    columns: [
     "created_at",
     "deleted_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // company_skill_test_run_templates — upstream skill-studio test templates; the columns below are metadata-only.

  {
    table: "company_skill_test_run_templates",
    columns: [
     "description",
     "name"
    ],
    reason: "Display text rendered in the UI; it carries no authorization semantics.",
  },
  {
    table: "company_skill_test_run_templates",
    columns: [
     "company_id",
     "created_by_agent_id",
     "created_by_user_id",
     "id",
     "updated_by_agent_id",
     "updated_by_user_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "company_skill_test_run_templates",
    columns: ["body"],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "company_skill_test_run_templates",
    columns: [
     "created_at",
     "deleted_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // company_skill_test_runs — upstream skill-studio test run records; the columns below are metadata-only.

  {
    table: "company_skill_test_runs",
    columns: ["output_document_key"],
    reason: "Object-store key of the produced document; access goes through the document ACLs.",
  },
  {
    table: "company_skill_test_runs",
    columns: [
     "agent_id",
     "company_id",
     "id",
     "input_id",
     "issue_id",
     "skill_id",
     "skill_version_id",
     "template_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "company_skill_test_runs",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "company_skill_test_runs",
    columns: [
     "harness_issue_description",
     "template_name"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "company_skill_test_runs",
    columns: [
     "agent_config_snapshot",
     "error",
     "input_snapshot",
     "output_snapshot",
     "rendered_template_body",
     "template_body"
    ],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "company_skill_test_runs",
    columns: [
     "created_at",
     "deleted_at",
     "harness_issue_deleted_at",
     "harness_issue_expires_at",
     "superseded_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // company_skill_versions — upstream skill version pointers; the columns below are metadata-only.

  {
    table: "company_skill_versions",
    columns: ["release_id"],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "company_skill_versions",
    columns: ["release_name"],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "company_skill_versions",
    columns: ["released_at"],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // company_skills — fork company skills (new upstream columns); the columns below are metadata-only.

  {
    table: "company_skills",
    columns: ["folder_id"],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  // company_transfer_runs — company import/export transfer runs; the columns below are metadata-only.

  {
    table: "company_transfer_runs",
    columns: ["idempotency_key"],
    reason: "Client-supplied idempotency discriminator, not a credential.",
  },
  {
    table: "company_transfer_runs",
    columns: ["actor_key"],
    reason: "Label of the transfer actor for audit; authority is checked from the session, not this column.",
  },
  {
    table: "company_transfer_runs",
    columns: [
     "company_id",
     "id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "company_transfer_runs",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "company_transfer_runs",
    columns: [
     "completed_parts",
     "container_ref",
     "direction",
     "manifest",
     "manifest_sha256"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "company_transfer_runs",
    columns: [
     "blob_count",
     "chunk_count"
    ],
    reason: "Numeric bookkeeping (counts, durations, sizes, versions); it carries no authorization semantics.",
  },
  {
    table: "company_transfer_runs",
    columns: ["error"],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "company_transfer_runs",
    columns: [
     "created_at",
     "finished_at",
     "started_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // connection_grants — upstream connection grant registry; the columns below are metadata-only.

  {
    table: "connection_grants",
    columns: [
     "company_id",
     "connection_id",
     "created_by_agent_id",
     "created_by_user_id",
     "id",
     "revoked_by_agent_id",
     "revoked_by_user_id",
     "subject_user_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "connection_grants",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "connection_grants",
    columns: [
     "is_default",
     "kind",
     "provider_tenant"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "connection_grants",
    columns: [
     "created_at",
     "last_used_at",
     "revoked_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // connection_token_issuances — upstream connection token issuance audit; the columns below are metadata-only.

  {
    table: "connection_token_issuances",
    columns: ["issued_scope"],
    reason: "Audit of what was granted at issuance; enforcement happens against live connection grants.",
  },
  {
    table: "connection_token_issuances",
    columns: ["requested_scope"],
    reason: "Audit of what was requested during issuance; enforcement happens against live connection grants.",
  },
  {
    table: "connection_token_issuances",
    columns: [
     "agent_id",
     "application_id",
     "company_id",
     "connection_id",
     "id",
     "issue_id",
     "project_id",
     "responsible_user_id",
     "run_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "connection_token_issuances",
    columns: [
     "error_code",
     "outcome",
     "path"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "connection_token_issuances",
    columns: ["ttl_seconds"],
    reason: "Numeric bookkeeping (counts, durations, sizes, versions); it carries no authorization semantics.",
  },
  {
    table: "connection_token_issuances",
    columns: ["metadata"],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "connection_token_issuances",
    columns: [
     "created_at",
     "expires_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // cost_events — fork cost events (new upstream column); the columns below are metadata-only.

  {
    table: "cost_events",
    columns: ["cost_status"],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  // decision_archive_notification_outbox — upstream decision archive notification outbox; the columns below are metadata-only.

  {
    table: "decision_archive_notification_outbox",
    columns: [
     "company_id",
     "id",
     "origin_agent_id",
     "origin_issue_id",
     "source_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "decision_archive_notification_outbox",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "decision_archive_notification_outbox",
    columns: ["source_kind"],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "decision_archive_notification_outbox",
    columns: [
     "archive_version",
     "attempt_count"
    ],
    reason: "Numeric bookkeeping (counts, durations, sizes, versions); it carries no authorization semantics.",
  },
  {
    table: "decision_archive_notification_outbox",
    columns: [
     "created_at",
     "delivered_at",
     "last_attempt_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // decision_bundles — upstream decision bundles; the columns below are metadata-only.

  {
    table: "decision_bundles",
    columns: [
     "summary",
     "title"
    ],
    reason: "Display text rendered in the UI; it carries no authorization semantics.",
  },
  {
    table: "decision_bundles",
    columns: [
     "company_id",
     "id",
     "origin_agent_id",
     "origin_issue_id",
     "origin_run_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "decision_bundles",
    columns: ["created_at"],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // decision_effect_executions — upstream decision effect execution ledger; the columns below are metadata-only.

  {
    table: "decision_effect_executions",
    columns: [
     "activity_log_id",
     "decision_id",
     "id",
     "target_issue_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "decision_effect_executions",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "decision_effect_executions",
    columns: [
     "effect_index",
     "effect_type"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "decision_effect_executions",
    columns: [
     "error",
     "result"
    ],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "decision_effect_executions",
    columns: ["executed_at"],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // decision_queue_items — upstream decision queue items; the columns below are metadata-only.

  {
    table: "decision_queue_items",
    columns: ["added_by_agent_api_key_id"],
    reason: "Attribution FK recording which API key added the item.",
  },
  {
    table: "decision_queue_items",
    columns: [
     "added_by_agent_id",
     "added_by_run_id",
     "added_by_user_id",
     "company_id",
     "id",
     "queue_id",
     "responsible_user_id",
     "source_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "decision_queue_items",
    columns: [
     "added_by_type",
     "source_kind"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "decision_queue_items",
    columns: ["created_at"],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // decision_queues — upstream decision queue config; the columns below are metadata-only.

  {
    table: "decision_queues",
    columns: ["created_by_agent_api_key_id"],
    reason: "Attribution FK recording which API key created the row; the key's authority is checked at the API layer.",
  },
  {
    table: "decision_queues",
    columns: ["key"],
    reason: "Natural/uniqueness key column, not a credential.",
  },
  {
    table: "decision_queues",
    columns: [
     "description",
     "title"
    ],
    reason: "Display text rendered in the UI; it carries no authorization semantics.",
  },
  {
    table: "decision_queues",
    columns: [
     "company_id",
     "created_by_agent_id",
     "created_by_run_id",
     "created_by_user_id",
     "id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "decision_queues",
    columns: [
     "created_by_type",
     "retention_days",
     "seed_rules",
     "seed_rules_enabled"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "decision_queues",
    columns: [
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // decision_retention — upstream decision archival/retention records; the columns below are metadata-only.

  {
    table: "decision_retention",
    columns: [
     "archived_by_agent_id",
     "archived_by_run_id",
     "archived_by_user_id",
     "company_id",
     "id",
     "source_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "decision_retention",
    columns: [
     "archived_by_type",
     "archived_reason",
     "keep",
     "source_kind"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "decision_retention",
    columns: [
     "archive_version",
     "version"
    ],
    reason: "Numeric bookkeeping (counts, durations, sizes, versions); it carries no authorization semantics.",
  },
  {
    table: "decision_retention",
    columns: [
     "archived_at",
     "created_at",
     "source_activity_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // decision_target_issues — upstream decision target links; the columns below are metadata-only.

  {
    table: "decision_target_issues",
    columns: [
     "company_id",
     "decision_id",
     "issue_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  // decision_training_examples — upstream decision training corpus; the columns below are metadata-only.

  {
    table: "decision_training_examples",
    columns: ["retention_policy"],
    reason: "Retention bucket label for cleanup ordering; not an authorization decision.",
  },
  {
    table: "decision_training_examples",
    columns: [
     "company_id",
     "created_by_user_id",
     "id",
     "issue_id",
     "source_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "decision_training_examples",
    columns: [
     "decision_outcome",
     "notes_history",
     "source_kind"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "decision_training_examples",
    columns: [
     "notes",
     "snapshot"
    ],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "decision_training_examples",
    columns: [
     "created_at",
     "cutoff_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // decision_triage — upstream decision triage state; the columns below are metadata-only.

  {
    table: "decision_triage",
    columns: ["set_by_agent_api_key_id"],
    reason: "Attribution FK recording which API key last set the row; the key's authority is checked at the API layer.",
  },
  {
    table: "decision_triage",
    columns: [
     "company_id",
     "id",
     "responsible_user_id",
     "set_by_agent_id",
     "set_by_run_id",
     "set_by_user_id",
     "source_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "decision_triage",
    columns: [
     "decide_by",
     "decide_by_date",
     "set_by_type",
     "snoozed_until",
     "source_kind"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "decision_triage",
    columns: ["version"],
    reason: "Numeric bookkeeping (counts, durations, sizes, versions); it carries no authorization semantics.",
  },
  {
    table: "decision_triage",
    columns: [
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // decision_triage_events — upstream decision triage audit events; the columns below are metadata-only.

  {
    table: "decision_triage_events",
    columns: ["agent_api_key_id"],
    reason: "Attribution FK recording which API key drove the triage event.",
  },
  {
    table: "decision_triage_events",
    columns: [
     "actor_agent_id",
     "actor_run_id",
     "actor_user_id",
     "company_id",
     "id",
     "queue_id",
     "responsible_user_id",
     "source_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "decision_triage_events",
    columns: [
     "action",
     "actor_type",
     "source_kind"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "decision_triage_events",
    columns: ["details"],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "decision_triage_events",
    columns: ["created_at"],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // decisions — upstream Decisions v1 records; the columns below are metadata-only.

  {
    table: "decisions",
    columns: ["idempotency_key"],
    reason: "Client-supplied idempotency discriminator, not a credential.",
  },
  {
    table: "decisions",
    columns: ["rule_key"],
    reason: "Decision rule natural key; not a credential.",
  },
  {
    table: "decisions",
    columns: ["continuation_policy"],
    reason: "Scheduling semantics for resuming an agent; not an input to any authorization decision.",
  },
  {
    table: "decisions",
    columns: ["title"],
    reason: "Display text rendered in the UI; it carries no authorization semantics.",
  },
  {
    table: "decisions",
    columns: [
     "bundle_id",
     "chosen_option_id",
     "company_id",
     "decided_by_user_id",
     "id",
     "origin_agent_id",
     "origin_issue_id",
     "origin_run_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "decisions",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "decisions",
    columns: [
     "execution_status",
     "input_values",
     "options",
     "target_snapshots"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "decisions",
    columns: [
     "body",
     "inputs",
     "metadata"
    ],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "decisions",
    columns: [
     "created_at",
     "decided_at",
     "expires_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // document_annotation_comments — fork annotation comments (new upstream columns); the columns below are metadata-only.

  {
    table: "document_annotation_comments",
    columns: ["case_id"],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  // document_annotation_threads — fork annotation threads (new upstream columns); the columns below are metadata-only.

  {
    table: "document_annotation_threads",
    columns: ["case_id"],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  // document_memberships — upstream per-user document membership; the columns below are metadata-only.

  {
    table: "document_memberships",
    columns: [
     "company_id",
     "document_id",
     "id",
     "user_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "document_memberships",
    columns: [
     "created_at",
     "starred_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // execution_workspace_runtime_leases — upstream execution-workspace lease mutual exclusion; the columns below are metadata-only.

  {
    table: "execution_workspace_runtime_leases",
    columns: ["owner_agent_id"],
    reason: "FK to the owning agent; the agent's authority is evaluated at the API layer.",
  },
  {
    table: "execution_workspace_runtime_leases",
    columns: ["owner_issue_id"],
    reason: "FK to the owning issue; lease authority is enforced via the lease columns.",
  },
  {
    table: "execution_workspace_runtime_leases",
    columns: ["owner_run_id"],
    reason: "FK to the owning run; lease authority is enforced via the lease columns.",
  },
  {
    table: "execution_workspace_runtime_leases",
    columns: ["owner_key"],
    reason: "Lease identity key for mutual-exclusion matching; not a credential.",
  },
  {
    table: "execution_workspace_runtime_leases",
    columns: [
     "company_id",
     "execution_workspace_id",
     "id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "execution_workspace_runtime_leases",
    columns: ["last_action"],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "execution_workspace_runtime_leases",
    columns: ["metadata"],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "execution_workspace_runtime_leases",
    columns: [
     "claimed_at",
     "created_at",
     "expires_at",
     "renewed_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // external_objects — upstream external object links (new columns); the columns below are metadata-only.

  {
    table: "external_objects",
    columns: ["refresh_started_at"],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // folders — upstream folder organization tree; the columns below are metadata-only.

  {
    table: "folders",
    columns: ["system_key"],
    reason: "Reserved-row discriminator key, not a credential.",
  },
  {
    table: "folders",
    columns: [
     "color",
     "name",
     "slug"
    ],
    reason: "Display text rendered in the UI; it carries no authorization semantics.",
  },
  {
    table: "folders",
    columns: [
     "company_id",
     "id",
     "parent_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "folders",
    columns: [
     "kind",
     "position"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "folders",
    columns: [
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // inbox_dismissals — fork inbox dismissal rows (new upstream columns); the columns below are metadata-only.

  {
    table: "inbox_dismissals",
    columns: [
     "kind",
     "snoozed_until"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  // issue_comments — fork issue comments (new upstream columns); the columns below are metadata-only.

  {
    table: "issue_comments",
    columns: ["on_behalf_of_user_id"],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  // issue_create_idempotency_keys — upstream idempotent issue creation keys; the columns below are metadata-only.

  {
    table: "issue_create_idempotency_keys",
    columns: ["idempotency_key"],
    reason: "Client-supplied idempotency discriminator, not a credential.",
  },
  {
    table: "issue_create_idempotency_keys",
    columns: [
     "company_id",
     "id",
     "issue_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "issue_create_idempotency_keys",
    columns: ["created_at"],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // issue_inbox_archives — upstream inbox archive attribution; the columns below are metadata-only.

  {
    table: "issue_inbox_archives",
    columns: [
     "archived_by_agent_id",
     "archived_by_run_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "issue_inbox_archives",
    columns: ["archived_by_actor_type"],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  // issue_thread_interactions — fork interaction continuation rows (new upstream columns); the columns below are metadata-only.

  {
    table: "issue_thread_interactions",
    columns: ["effective_resolver_policy_source"],
    reason: "Provenance label of the resolved continuation policy.",
  },
  {
    table: "issue_thread_interactions",
    columns: ["resolver_policy_provenance"],
    reason: "Provenance label of the resolver policy actually applied.",
  },
  {
    table: "issue_thread_interactions",
    columns: ["requested_resolver_policy"],
    reason: "Requested (pre-resolution) continuation policy for audit.",
  },
  {
    table: "issue_thread_interactions",
    columns: ["effective_resolver_policy"],
    reason: "Resolved continuation-policy record for interaction wakeups; not an authorization decision.",
  },
  {
    table: "issue_thread_interactions",
    columns: [
     "addressee_agent_id",
     "resolved_by_run_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  // issue_watchdogs — fork watchdog rows (new upstream columns); the columns below are metadata-only.

  {
    table: "issue_watchdogs",
    columns: [
     "last_observed_stop_snapshot",
     "last_reviewed_stop_snapshot"
    ],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  // issues — fork issue rows (new upstream columns); the columns below are metadata-only.

  {
    table: "issues",
    columns: ["review_policy"],
    reason: "Issue review routing preference; not an authorization decision (route-level authz applies).",
  },
  {
    table: "issues",
    columns: ["blocked_owner_notified_at"],
    reason: "Timestamp of owner notification for a blocked issue; audit only.",
  },
  {
    table: "issues",
    columns: [
     "harness_kind",
     "unblock_descriptor"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "issues",
    columns: ["blocked_transition_at"],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // plugin_config — plugin config rows (new upstream columns); the columns below are metadata-only.

  {
    table: "plugin_config",
    columns: ["company_id"],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  // routines — fork routine rows (new upstream columns); the columns below are metadata-only.

  {
    table: "routines",
    columns: ["activity_gate_policy"],
    reason: "Routine activity-gate mode label; enforcement lives in the routine scheduler.",
  },
  {
    table: "routines",
    columns: ["activity_gate_scope"],
    reason: "Routine activity-gate scope label; enforcement lives in the routine scheduler.",
  },
  {
    table: "routines",
    columns: ["folder_id"],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  // smoke_run_steps — upstream smoke-lab run step records; the columns below are metadata-only.

  {
    table: "smoke_run_steps",
    columns: [
     "company_id",
     "id",
     "run_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "smoke_run_steps",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "smoke_run_steps",
    columns: [
     "detail",
     "path",
     "scenario_step",
     "screenshot_artifact_ref"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "smoke_run_steps",
    columns: ["duration_ms"],
    reason: "Numeric bookkeeping (counts, durations, sizes, versions); it carries no authorization semantics.",
  },
  {
    table: "smoke_run_steps",
    columns: [
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // smoke_runs — upstream smoke-lab run records; the columns below are metadata-only.

  {
    table: "smoke_runs",
    columns: ["summary"],
    reason: "Display text rendered in the UI; it carries no authorization semantics.",
  },
  {
    table: "smoke_runs",
    columns: [
     "company_id",
     "id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "smoke_runs",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "smoke_runs",
    columns: ["trigger"],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "smoke_runs",
    columns: [
     "created_at",
     "finished_at",
     "started_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // status_card_updates — upstream status-card generation/update runs; the columns below are metadata-only.

  {
    table: "status_card_updates",
    columns: [
     "card_id",
     "generation_issue_id",
     "id",
     "run_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "status_card_updates",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "status_card_updates",
    columns: [
     "change_summary",
     "changes",
     "kind",
     "model",
     "trigger"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "status_card_updates",
    columns: [
     "cost_cents",
     "input_tokens",
     "output_tokens",
     "query_version"
    ],
    reason: "Numeric bookkeeping (counts, durations, sizes, versions); it carries no authorization semantics.",
  },
  {
    table: "status_card_updates",
    columns: ["error"],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "status_card_updates",
    columns: [
     "finished_at",
     "started_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // status_cards — upstream status-card feature state; the columns below are metadata-only.

  {
    table: "status_cards",
    columns: ["refresh_policy"],
    reason: "UI refresh cadence label for the card; not security relevant.",
  },
  {
    table: "status_cards",
    columns: ["title"],
    reason: "Display text rendered in the UI; it carries no authorization semantics.",
  },
  {
    table: "status_cards",
    columns: [
     "agent_id",
     "archived_by_agent_id",
     "archived_by_user_id",
     "company_id",
     "created_by_agent_id",
     "created_by_user_id",
     "document_id",
     "generating_issue_id",
     "id",
     "query_compiled_by_agent_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "status_cards",
    columns: ["state"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "status_cards",
    columns: [
     "failure_reason",
     "fingerprint",
     "interest_prompt",
     "last_model",
     "last_update_run_kind",
     "mentioned_issue_ids",
     "queries",
     "title_pinned"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "status_cards",
    columns: [
     "pending_change_count",
     "pending_change_hash",
     "query_version"
    ],
    reason: "Numeric bookkeeping (counts, durations, sizes, versions); it carries no authorization semantics.",
  },
  {
    table: "status_cards",
    columns: [
     "archived_at",
     "created_at",
     "fingerprint_at",
     "last_change_at",
     "last_generated_at",
     "next_eval_at",
     "query_compiled_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // summary_slots — upstream document summary slot state; the columns below are metadata-only.

  {
    table: "summary_slots",
    columns: ["slot_key"],
    reason: "Natural key for the slot, not a credential.",
  },
  {
    table: "summary_slots",
    columns: [
     "scope_id",
     "scope_kind"
    ],
    reason: "Scope discriminator for namespacing; not an authorization grant by itself.",
  },
  {
    table: "summary_slots",
    columns: [
     "company_id",
     "document_id",
     "generating_issue_id",
     "id",
     "last_generated_by_agent_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "summary_slots",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "summary_slots",
    columns: [
     "failure_reason",
     "last_model"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "summary_slots",
    columns: [
     "created_at",
     "last_generated_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_access_audit_events — upstream tool access audit events; the columns below are metadata-only.

  {
    table: "tool_access_audit_events",
    columns: ["gateway_token_id"],
    reason: "FK to the gateway token row; the token hash column is the protected surface.",
  },
  {
    table: "tool_access_audit_events",
    columns: [
     "actor_id",
     "catalog_entry_id",
     "company_id",
     "connection_id",
     "correlation_id",
     "gateway_id",
     "gateway_public_id",
     "id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_access_audit_events",
    columns: [
     "action",
     "actor_type",
     "client_name",
     "outcome",
     "reason_code"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "tool_access_audit_events",
    columns: ["details"],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "tool_access_audit_events",
    columns: ["created_at"],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_action_requests — upstream gated tool action requests; the columns below are metadata-only.

  {
    table: "tool_action_requests",
    columns: [
     "company_id",
     "decided_by_agent_id",
     "decided_by_user_id",
     "id",
     "interaction_id",
     "invocation_id",
     "issue_id",
     "requested_by_agent_id",
     "requested_by_user_id",
     "resolved_by_agent_id",
     "resolved_by_user_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_action_requests",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "tool_action_requests",
    columns: [
     "canonical_arguments_summary",
     "preview_markdown"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "tool_action_requests",
    columns: ["canonical_arguments_hash"],
    reason: "Numeric bookkeeping (counts, durations, sizes, versions); it carries no authorization semantics.",
  },
  {
    table: "tool_action_requests",
    columns: [
     "created_at",
     "decided_at",
     "expires_at",
     "resolved_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_applications — upstream tool application registry; the columns below are metadata-only.

  {
    table: "tool_applications",
    columns: ["owner_agent_id"],
    reason: "FK to the owning agent; the agent's authority is evaluated at the API layer.",
  },
  {
    table: "tool_applications",
    columns: ["owner_user_id"],
    reason: "FK to the owning user; the user's authority is evaluated at the API layer.",
  },
  {
    table: "tool_applications",
    columns: ["application_key"],
    reason: "Natural key for the application binding, not a credential.",
  },
  {
    table: "tool_applications",
    columns: [
     "description",
     "name"
    ],
    reason: "Display text rendered in the UI; it carries no authorization semantics.",
  },
  {
    table: "tool_applications",
    columns: [
     "company_id",
     "id",
     "plugin_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_applications",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "tool_applications",
    columns: ["type"],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "tool_applications",
    columns: ["metadata"],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "tool_applications",
    columns: [
     "archived_at",
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_call_events — upstream tool-gateway audit event stream; the columns below are metadata-only.

  {
    table: "tool_call_events",
    columns: ["credential_scope_summary"],
    reason: "Audit summary of the credential scope for display; not the credential itself.",
  },
  {
    table: "tool_call_events",
    columns: ["matched_policy_ids"],
    reason: "Audit summary of which policies matched; enforcement lives in tool_policies evaluated at call time.",
  },
  {
    table: "tool_call_events",
    columns: ["header_policy_summary"],
    reason: "Audit summary text about header policy; not the enforcing configuration.",
  },
  {
    table: "tool_call_events",
    columns: ["gateway_token_id"],
    reason: "FK to the gateway token row; the token hash column is the protected surface.",
  },
  {
    table: "tool_call_events",
    columns: ["policy_explanation"],
    reason: "Human-readable audit text explaining the policy verdict; not the enforcing configuration.",
  },
  {
    table: "tool_call_events",
    columns: ["mcp_session_id"],
    reason: "Upstream MCP session correlation id, not an authorization grant.",
  },
  {
    table: "tool_call_events",
    columns: [
     "action_request_id",
     "actor_id",
     "agent_id",
     "application_id",
     "catalog_entry_id",
     "client_subject_id",
     "company_id",
     "connection_id",
     "correlation_id",
     "gateway_id",
     "gateway_public_id",
     "id",
     "invocation_id",
     "issue_id",
     "run_id",
     "runtime_slot_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_call_events",
    columns: [
     "actor_type",
     "arguments_summary",
     "client_name",
     "client_subject_type",
     "decision",
     "error_code",
     "error_message",
     "event_type",
     "outcome",
     "rate_limit_state",
     "reason_code",
     "redaction_plan",
     "request_summary",
     "result_summary",
     "tool_name"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "tool_call_events",
    columns: [
     "latency_ms",
     "request_hash",
     "result_hash",
     "result_size_bytes"
    ],
    reason: "Numeric bookkeeping (counts, durations, sizes, versions); it carries no authorization semantics.",
  },
  {
    table: "tool_call_events",
    columns: ["metadata"],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "tool_call_events",
    columns: ["created_at"],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_catalog_entries — upstream tool catalog (discovered tools, schemas, review state); the columns below are metadata-only.

  {
    table: "tool_catalog_entries",
    columns: [
     "description",
     "name",
     "title"
    ],
    reason: "Display text rendered in the UI; it carries no authorization semantics.",
  },
  {
    table: "tool_catalog_entries",
    columns: [
     "application_id",
     "company_id",
     "connection_id",
     "id",
     "reviewed_by_agent_id",
     "reviewed_by_user_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_catalog_entries",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "tool_catalog_entries",
    columns: [
     "annotations",
     "entry_kind",
     "input_schema",
     "is_destructive",
     "is_read_only",
     "is_write",
     "output_schema",
     "quarantine_reason",
     "risk_level",
     "tool_name"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "tool_catalog_entries",
    columns: [
     "schema_hash",
     "version",
     "version_hash"
    ],
    reason: "Numeric bookkeeping (counts, durations, sizes, versions); it carries no authorization semantics.",
  },
  {
    table: "tool_catalog_entries",
    columns: [
     "created_at",
     "first_seen_at",
     "last_seen_at",
     "quarantined_at",
     "reviewed_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_connection_installs — upstream connection install scoping; the columns below are metadata-only.

  {
    table: "tool_connection_installs",
    columns: [
     "company_id",
     "connection_id",
     "created_by_agent_id",
     "created_by_user_id",
     "id",
     "target_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_connection_installs",
    columns: ["target_type"],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "tool_connection_installs",
    columns: ["created_at"],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_connections — upstream outbound tool connection config; the columns below are metadata-only.

  {
    table: "tool_connections",
    columns: ["name"],
    reason: "Display text rendered in the UI; it carries no authorization semantics.",
  },
  {
    table: "tool_connections",
    columns: [
     "application_id",
     "company_id",
     "created_by_agent_id",
     "created_by_user_id",
     "id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_connections",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "tool_connections",
    columns: [
     "connection_kind",
     "enabled",
     "health_message",
     "health_status",
     "transport",
     "uid"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "tool_connections",
    columns: [
     "config",
     "last_error",
     "transport_config"
    ],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "tool_connections",
    columns: [
     "created_at",
     "health_checked_at",
     "last_catalog_refresh_at",
     "last_health_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_gateway_rate_limit_counters — upstream gateway rate-limit counters; the columns below are metadata-only.

  {
    table: "tool_gateway_rate_limit_counters",
    columns: ["counter_key"],
    reason: "Rate-limit counter identity; limits live in code/config, not this column.",
  },
  {
    table: "tool_gateway_rate_limit_counters",
    columns: [
     "company_id",
     "id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_gateway_rate_limit_counters",
    columns: ["limit"],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "tool_gateway_rate_limit_counters",
    columns: [
     "count",
     "window_ms"
    ],
    reason: "Numeric bookkeeping (counts, durations, sizes, versions); it carries no authorization semantics.",
  },
  {
    table: "tool_gateway_rate_limit_counters",
    columns: [
     "created_at",
     "reset_at",
     "updated_at",
     "window_start_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_gateway_sessions — upstream gateway session registry; the columns below are metadata-only.

  {
    table: "tool_gateway_sessions",
    columns: ["gateway_token_id"],
    reason: "FK to the gateway token row; the token hash column is the protected surface.",
  },
  {
    table: "tool_gateway_sessions",
    columns: ["mcp_session_id"],
    reason: "Upstream MCP session correlation id, not an authorization grant.",
  },
  {
    table: "tool_gateway_sessions",
    columns: [
     "agent_id",
     "client_subject_id",
     "company_id",
     "correlation_id",
     "gateway_id",
     "gateway_public_id",
     "id",
     "issue_id",
     "project_id",
     "run_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_gateway_sessions",
    columns: [
     "client_name",
     "client_subject_type"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "tool_gateway_sessions",
    columns: [
     "created_at",
     "expires_at",
     "last_used_at",
     "revoked_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_invocations — upstream tool-gateway invocation ledger (who called what, with what result); the columns below are metadata-only.

  {
    table: "tool_invocations",
    columns: ["credential_scope_summary"],
    reason: "Audit summary of the credential scope for display; not the credential itself.",
  },
  {
    table: "tool_invocations",
    columns: ["matched_policy_ids"],
    reason: "Audit summary of which policies matched; enforcement lives in tool_policies evaluated at call time.",
  },
  {
    table: "tool_invocations",
    columns: ["header_policy_summary"],
    reason: "Audit summary text about header policy; not the enforcing configuration.",
  },
  {
    table: "tool_invocations",
    columns: ["idempotency_key"],
    reason: "Client-supplied idempotency discriminator, not a credential.",
  },
  {
    table: "tool_invocations",
    columns: ["gateway_token_id"],
    reason: "FK to the gateway token row; the token hash column is the protected surface.",
  },
  {
    table: "tool_invocations",
    columns: ["policy_explanation"],
    reason: "Human-readable audit text explaining the policy verdict; not the enforcing configuration.",
  },
  {
    table: "tool_invocations",
    columns: ["application_key"],
    reason: "Natural key for the application binding, not a credential.",
  },
  {
    table: "tool_invocations",
    columns: ["mcp_session_id"],
    reason: "Upstream MCP session correlation id, not an authorization grant.",
  },
  {
    table: "tool_invocations",
    columns: [
     "actor_id",
     "agent_id",
     "application_id",
     "catalog_entry_id",
     "client_subject_id",
     "company_id",
     "connection_id",
     "correlation_id",
     "gateway_id",
     "gateway_public_id",
     "id",
     "issue_id",
     "result_artifact_id",
     "run_id",
     "upstream_request_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_invocations",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "tool_invocations",
    columns: [
     "actor_type",
     "arguments_summary",
     "client_name",
     "client_subject_type",
     "error_code",
     "error_message",
     "provider_type",
     "result_summary",
     "risk_level",
     "tool_name",
     "upstream_tool_name"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "tool_invocations",
    columns: [
     "arguments_hash",
     "catalog_schema_hash",
     "catalog_version_hash",
     "result_hash",
     "result_size_bytes"
    ],
    reason: "Numeric bookkeeping (counts, durations, sizes, versions); it carries no authorization semantics.",
  },
  {
    table: "tool_invocations",
    columns: [
     "completed_at",
     "created_at",
     "started_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_mcp_gateway_tokens — upstream MCP gateway API tokens; the columns below are metadata-only.

  {
    table: "tool_mcp_gateway_tokens",
    columns: ["token_prefix"],
    reason: "Display prefix for identifying a token in UI; token bytes/hash are protected separately.",
  },
  {
    table: "tool_mcp_gateway_tokens",
    columns: ["name"],
    reason: "Display text rendered in the UI; it carries no authorization semantics.",
  },
  {
    table: "tool_mcp_gateway_tokens",
    columns: [
     "company_id",
     "created_by_agent_id",
     "created_by_user_id",
     "expiry_override_by_agent_id",
     "expiry_override_by_user_id",
     "gateway_id",
     "id",
     "subject_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_mcp_gateway_tokens",
    columns: [
     "client_label",
     "expiry_override_reason",
     "owner_note",
     "subject_type"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "tool_mcp_gateway_tokens",
    columns: [
     "created_at",
     "expires_at",
     "expiry_override_at",
     "last_used_at",
     "revoked_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_mcp_gateways — upstream MCP gateway configuration; the columns below are metadata-only.

  {
    table: "tool_mcp_gateways",
    columns: [
     "context_scope_id",
     "context_scope_type"
    ],
    reason: "Context discriminator for gateway calls; not an authorization grant by itself.",
  },
  {
    table: "tool_mcp_gateways",
    columns: ["approval_issue_id"],
    reason: "FK to the gating board issue; enforcement happens at action time via the approvals service.",
  },
  {
    table: "tool_mcp_gateways",
    columns: [
     "description",
     "name",
     "slug"
    ],
    reason: "Display text rendered in the UI; it carries no authorization semantics.",
  },
  {
    table: "tool_mcp_gateways",
    columns: [
     "agent_id",
     "company_id",
     "created_by_agent_id",
     "created_by_user_id",
     "gateway_public_id",
     "id",
     "issue_id",
     "profile_id",
     "project_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_mcp_gateways",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "tool_mcp_gateways",
    columns: [
     "default_profile_mode",
     "display_slug"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "tool_mcp_gateways",
    columns: [
     "metadata",
     "on_demand_tools_config"
    ],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "tool_mcp_gateways",
    columns: [
     "archived_at",
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_oauth_states — upstream OAuth flow state for tool connections; the columns below are metadata-only.

  {
    table: "tool_oauth_states",
    columns: ["requested_scopes"],
    reason: "Audit of the consent request; grants are enforced server-side at issuance, not from this column.",
  },
  {
    table: "tool_oauth_states",
    columns: ["created_by_session_id"],
    reason: "FK to the browser/session that started the OAuth flow; flow completion is validated server-side.",
  },
  {
    table: "tool_oauth_states",
    columns: [
     "company_id",
     "connection_id",
     "created_by_actor_id",
     "interaction_id",
     "issue_id",
     "subject_user_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_oauth_states",
    columns: ["state"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "tool_oauth_states",
    columns: [
     "created_by_actor_type",
     "return_to"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "tool_oauth_states",
    columns: [
     "created_at",
     "expires_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_policies — upstream tool access policy definitions; the columns below are metadata-only.

  {
    table: "tool_policies",
    columns: ["policy_type"],
    reason: "Discriminator of which policy shape a row stores; not an authorization decision.",
  },
  {
    table: "tool_policies",
    columns: [
     "description",
     "name"
    ],
    reason: "Display text rendered in the UI; it carries no authorization semantics.",
  },
  {
    table: "tool_policies",
    columns: [
     "company_id",
     "created_by_agent_id",
     "created_by_user_id",
     "id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_policies",
    columns: ["priority"],
    reason: "Numeric bookkeeping (counts, durations, sizes, versions); it carries no authorization semantics.",
  },
  {
    table: "tool_policies",
    columns: [
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_profile_bindings — upstream tool profile bindings; the columns below are metadata-only.

  {
    table: "tool_profile_bindings",
    columns: [
     "company_id",
     "created_by_agent_id",
     "created_by_user_id",
     "id",
     "profile_id",
     "target_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_profile_bindings",
    columns: ["target_type"],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "tool_profile_bindings",
    columns: ["priority"],
    reason: "Numeric bookkeeping (counts, durations, sizes, versions); it carries no authorization semantics.",
  },
  {
    table: "tool_profile_bindings",
    columns: ["metadata"],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "tool_profile_bindings",
    columns: [
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_profile_entries — upstream tool profile per-tool entries; the columns below are metadata-only.

  {
    table: "tool_profile_entries",
    columns: [
     "application_id",
     "catalog_entry_id",
     "company_id",
     "connection_id",
     "id",
     "profile_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_profile_entries",
    columns: [
     "conditions",
     "risk_level",
     "selector_type",
     "tool_name"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "tool_profile_entries",
    columns: [
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_profiles — upstream tool access profiles; the columns below are metadata-only.

  {
    table: "tool_profiles",
    columns: ["profile_key"],
    reason: "Natural key for the profile, not a credential.",
  },
  {
    table: "tool_profiles",
    columns: [
     "description",
     "name"
    ],
    reason: "Display text rendered in the UI; it carries no authorization semantics.",
  },
  {
    table: "tool_profiles",
    columns: [
     "company_id",
     "id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_profiles",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "tool_profiles",
    columns: ["metadata"],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "tool_profiles",
    columns: [
     "created_at",
     "new_tools_reviewed_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_rate_limit_counters — upstream tool rate-limit counters; the columns below are metadata-only.

  {
    table: "tool_rate_limit_counters",
    columns: ["policy_id"],
    reason: "FK to the tool_policies row; the policy row is the enforcing record.",
  },
  {
    table: "tool_rate_limit_counters",
    columns: ["counter_key"],
    reason: "Rate-limit counter identity; limits live in code/config, not this column.",
  },
  {
    table: "tool_rate_limit_counters",
    columns: [
     "scope_id",
     "scope_type"
    ],
    reason: "Scope discriminator for namespacing; not an authorization grant by itself.",
  },
  {
    table: "tool_rate_limit_counters",
    columns: [
     "company_id",
     "id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_rate_limit_counters",
    columns: [
     "limit",
     "remaining",
     "window_kind"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "tool_rate_limit_counters",
    columns: [
     "created_at",
     "reset_at",
     "updated_at",
     "window_start_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_runtime_metric_counters — upstream tool runtime metric counters; the columns below are metadata-only.

  {
    table: "tool_runtime_metric_counters",
    columns: [
     "company_id",
     "id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_runtime_metric_counters",
    columns: ["metric"],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "tool_runtime_metric_counters",
    columns: ["count"],
    reason: "Numeric bookkeeping (counts, durations, sizes, versions); it carries no authorization semantics.",
  },
  {
    table: "tool_runtime_metric_counters",
    columns: [
     "bucket_start_at",
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_runtime_slots — upstream tool-gateway runtime slot bookkeeping; the columns below are metadata-only.

  {
    table: "tool_runtime_slots",
    columns: ["credential_scope_hash"],
    reason: "Hash of the credential scope used for slot-reuse matching; no credential bytes.",
  },
  {
    table: "tool_runtime_slots",
    columns: ["reuse_key"],
    reason: "Hash used only to match reusable slot candidates; not credential material.",
  },
  {
    table: "tool_runtime_slots",
    columns: ["slot_key"],
    reason: "Natural key for the slot, not a credential.",
  },
  {
    table: "tool_runtime_slots",
    columns: ["workspace_scope"],
    reason: "Scope discriminator for workspace reuse matching; not an authorization grant.",
  },
  {
    table: "tool_runtime_slots",
    columns: [
     "owner_scope_id",
     "owner_scope_type"
    ],
    reason: "Scope discriminator naming the owning scope; authorization flows through the owner tables.",
  },
  {
    table: "tool_runtime_slots",
    columns: [
     "application_id",
     "company_id",
     "connection_id",
     "execution_workspace_id",
     "id",
     "issue_id",
     "process_id",
     "project_workspace_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_runtime_slots",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "tool_runtime_slots",
    columns: [
     "command_template_key",
     "health_message",
     "health_status",
     "provider",
     "provider_ref",
     "runtime_kind"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "tool_runtime_slots",
    columns: [
     "last_error",
     "metadata"
    ],
    reason: "Payload or audit snapshot content; authorization is enforced by the service layer before this content is written.",
  },
  {
    table: "tool_runtime_slots",
    columns: [
     "created_at",
     "idle_deadline_at",
     "idle_expires_at",
     "last_health_check_at",
     "last_started_at",
     "last_used_at",
     "started_at",
     "stopped_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // tool_stdio_command_templates — upstream stdio tool command templates; the columns below are metadata-only.

  {
    table: "tool_stdio_command_templates",
    columns: ["env_keys"],
    reason: "Names of environment variables to forward; values resolve through the secret system at run time.",
  },
  {
    table: "tool_stdio_command_templates",
    columns: ["template_key"],
    reason: "Natural key for the command template, not a credential.",
  },
  {
    table: "tool_stdio_command_templates",
    columns: [
     "description",
     "name"
    ],
    reason: "Display text rendered in the UI; it carries no authorization semantics.",
  },
  {
    table: "tool_stdio_command_templates",
    columns: [
     "company_id",
     "created_by_agent_id",
     "created_by_user_id",
     "id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "tool_stdio_command_templates",
    columns: ["status"],
    reason: "Lifecycle status used for workflow bookkeeping and display; not consulted by any authorization decision.",
  },
  {
    table: "tool_stdio_command_templates",
    columns: [
     "args",
     "command",
     "tools"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "tool_stdio_command_templates",
    columns: [
     "created_at",
     "disabled_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // user_inbox_agent_policies — upstream per-user inbox agent policies; the columns below are metadata-only.

  {
    table: "user_inbox_agent_policies",
    columns: [
     "company_id",
     "id",
     "user_id"
    ],
    reason: "Identifier or foreign-key column; it points at another row and carries no authorization decision of its own.",
  },
  {
    table: "user_inbox_agent_policies",
    columns: ["mode"],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
  {
    table: "user_inbox_agent_policies",
    columns: [
     "created_at",
     "updated_at"
    ],
    reason: "Lifecycle timestamp for bookkeeping and audit display; it is never consulted by an authorization decision.",
  },
  // workspace_runtime_services — upstream workspace runtime service registry; the columns below are metadata-only.

  {
    table: "workspace_runtime_services",
    columns: [
     "backend_url",
     "exposure",
     "exposure_handle"
    ],
    reason: "Metadata column with no authorization semantics; the enforcing gates for this subsystem are registered as posture columns separately.",
  },
];
