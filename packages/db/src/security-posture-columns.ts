import { Table, getTableColumns, getTableName, is } from "drizzle-orm";
import * as schema from "./schema/index.js";
import {
  SECURITY_POSTURE_REJECTIONS,
  type SecurityPostureRejection,
} from "./security-posture-rejections.js";

export type SecurityPostureColumn = {
  readonly table: string;
  readonly column: string;
  readonly reason: string;
};

/**
 * Structural shape of a drizzle table, narrow enough to read the *database*
 * names off it. `_.name` is the table name as it exists in Postgres and
 * `_.columns[k]._.name` is the column name — not the camelCase TS property,
 * which is what migration SQL would never contain.
 */
type PostureTableShape = {
  readonly _: {
    readonly name: string;
    readonly columns: Record<string, { readonly _: { readonly name: string } }>;
  };
};

/**
 * A registry entry pinned to one table's literal names.
 *
 * Both fields resolve to string-literal unions, so a pair that no longer exists
 * on that table is a *compile* error rather than a string that silently matches
 * nothing. Renaming `egress_allowlist_enforced` in the drizzle schema breaks
 * this file in the same change that renames it.
 */
type PostureColumnOf<T extends PostureTableShape> = {
  readonly table: T["_"]["name"];
  readonly column: T["_"]["columns"][keyof T["_"]["columns"]]["_"]["name"];
  readonly reason: string;
};

/** Every drizzle table reachable from the schema barrel, as a union. */
type AnySchemaTable = Extract<(typeof schema)[keyof typeof schema], PostureTableShape>;

/**
 * `PostureColumnOf` distributed over that union, so each member keeps its own
 * table's column names. Distribution is what preserves the pairing: a
 * non-distributive `PostureColumnOf<A | B>` would widen both fields
 * independently and accept `{table: A, column: <a column of B>}`.
 */
type RegisteredPostureColumn = AnySchemaTable extends infer T
  ? T extends PostureTableShape
    ? PostureColumnOf<T>
    : never
  : never;

/**
 * Columns whose value *is* a security control, not data about one.
 *
 * A migration that clears one of these without a selective WHERE silently
 * downgrades the posture of every row — which is what migration `0138` did to
 * every `company_secret_bindings` row when it was re-applied.
 *
 * This registry is explicit. Adding a pair must be a conscious edit and
 * removing one must be visible in review. It is NOT inferred from column
 * naming, and it is NOT derived from `table-size-estimates.ts` — that registry
 * is fail-open by construction (an unlisted table defaults to `"small"`), and a
 * security rule must not inherit that default.
 *
 * It started as a two-pair seed of the columns `0138` actually flattened. It is
 * now the output of a full schema sweep: every column was classified
 * register / do-not-register, and the rejections carry their reasons in
 * `SECURITY_POSTURE_REJECTIONS` below so the analysis does not have to be
 * re-derived.
 *
 * Entries are bound to the schema three ways, because a classification that
 * resolves to nothing protects nothing while the rule keeps reporting green:
 * - at compile time by `RegisteredPostureColumn`,
 * - at lint time by `assertSecurityPostureColumnsResolve` (registered pair -> no
 *   schema column: catches renames and drops), and
 * - at lint time by `assertSchemaColumnsClassified` (schema column -> no
 *   classification anywhere: catches additions).
 *
 * Every `reason` names the *dangerous direction*: the value which, if a
 * migration flattened the column to it, is the permissive one. For most entries
 * that value is also the column default, which is what makes an unqualified
 * write look innocuous in review.
 */
export const SECURITY_POSTURE_COLUMNS = [
  // --- Egress (the columns migration `0138` flattened) ---
  {
    table: "company_secret_bindings",
    column: "egress_allowlist_enforced",
    reason: "Per-binding egress enforcement switch; false = borrowed-handle egress is log-only.",
  },
  {
    table: "company_secret_bindings",
    column: "allowed_egress",
    reason: "Destination allowlist the enforcement switch evaluates; emptying it is equivalent to disarming it.",
  },
  {
    table: "plugin_config_egress_allowlist",
    column: "egress_allowlist_enforced",
    reason: "Per-plugin config-key egress enforcement switch; false = ctx.http.fetch egress is log-only. Enforcement is plugin-wide OR'd across companies, so flipping one row governs the whole plugin.",
  },
  {
    table: "plugin_config_egress_allowlist",
    column: "allowed_egress",
    reason: "Operator-added extra destinations layered on the config key's own value; the enforcement switch evaluates it, so a blanket widen admits attacker-chosen origins plugin-wide.",
  },

  // --- Authorization and identity ---
  {
    table: "activity_log",
    column: "actor_source",
    reason: "Auth credential class for the write (board_key / agent_key / session / etc.); NULL obscures provenance.",
  },
  {
    table: "activity_log",
    column: "actor_key_id",
    reason: "API key UUID qualified by actor_source; clearing it buries which credential authenticated the write.",
  },
  {
    table: "agents",
    column: "role",
    reason: "Dangerous value 'ceo': an unconditional early-return in the authorization service, so a flatten grants every agent agent-creation and runtime-management authority.",
  },
  {
    table: "agents",
    column: "permissions",
    reason: "Dangerous value {}/NULL: holds canCreateAgents and the authorizationPolicy, and an empty object is read as 'no restriction configured', dissolving the low-trust preset.",
  },
  {
    table: "agents",
    column: "adapter_config",
    reason: "Dangerous value {}/NULL: carries dangerouslySkipPermissions, which defaults to true when the key is absent, so clearing it re-arms the adapter tool-permission bypass.",
  },
  {
    table: "agents",
    column: "status",
    reason: "Dangerous value 'active'/'idle': the only statuses blocking invocation are terminated/paused/pending_approval, so a flatten resurrects terminated agents and auto-passes the board hire gate.",
  },
  {
    table: "instance_user_roles",
    column: "role",
    reason: "Dangerous value 'instance_admin': an allow-all for every action and resource, so a flatten promotes every row to instance administrator.",
  },
  {
    table: "company_memberships",
    column: "status",
    reason: "Dangerous value 'active': the sole membership gate on every board authorization path, so a flatten reinstates revoked and archived memberships.",
  },
  {
    table: "company_memberships",
    column: "membership_role",
    reason: "Dangerous value NULL/empty: restriction is tested by inequality against 'viewer', so any other value passes and a flatten promotes every viewer to issue-mutate, runtime:manage and secrets:read.",
  },
  {
    table: "principal_permission_grants",
    column: "scope",
    reason: "Dangerous value {}/NULL: an empty scope is read as unconstrained, converting every narrowly-scoped grant into a company-wide one.",
  },
  {
    table: "principal_permission_grants",
    column: "permission_key",
    reason: "The grant's identity is its permission key; a flatten hands one privilege — possibly users:manage_permissions — to every principal holding any grant.",
  },
  {
    table: "companies",
    column: "require_board_approval_for_new_agents",
    reason: "Dangerous value false (also the column default): disables the board hire-approval gate, so agent- and plugin-initiated hires reach a runnable status without human review.",
  },
  {
    table: "companies",
    column: "status",
    reason: "Dangerous value 'active': the fleet execution kill-switch, so a flatten resumes every manually paused and budget-halted company at once.",
  },

  // --- Credential lifetime, revocation and scope ---
  {
    table: "agent_api_keys",
    column: "revoked_at",
    reason: "Dangerous value NULL: authentication matches on isNull(revoked_at), so a flatten resurrects every revoked agent key on both the HTTP and websocket paths.",
  },
  {
    table: "agent_api_keys",
    column: "expires_at",
    reason: "Dangerous value NULL/far-future: auth fails closed on expires_at <= now independent of revoked_at, so flattening it to NULL removes the max-TTL backstop and makes cross-company keys live forever.",
  },
  {
    table: "agent_api_keys",
    column: "scope_config",
    reason: "Dangerous value NULL/unparseable: the normalizer returns {kind:'standard'} on any parse failure, so clearing it silently unscopes every task_bridge key.",
  },
  {
    table: "agent_api_keys",
    column: "key_hash",
    reason: "Credential material under a non-unique index, so an unqualified write succeeds and makes one attacker-known token authenticate as an arbitrary agent.",
  },
  {
    table: "board_api_keys",
    column: "revoked_at",
    reason: "Dangerous value NULL: board-key auth matches on isNull(revoked_at), so a flatten resurrects every revoked operator-scope key.",
  },
  {
    table: "board_api_keys",
    column: "scope_config",
    reason: "Dangerous value NULL/{kind:'standard'}/unparseable: normalizeBoardApiKeyScope returns {kind:'standard'} on any parse failure, so clearing it silently unscopes every plugin_ops key back to full authority.",
  },
  {
    table: "board_api_keys",
    column: "expires_at",
    reason: "Dangerous value NULL: the lookup short-circuits on !expiresAt, so NULL means never expires and makes every operator-scope key immortal.",
  },
  {
    table: "board_api_keys",
    column: "key_hash",
    reason: "Credential material; the unique index aborts a constant flatten but not a per-row rewrite, which would invalidate or re-point every operator key.",
  },
  {
    table: "company_secret_bindings",
    column: "auto_renew_policy",
    reason: "Dangerous value any non-NULL policy object: the policy is simultaneously the operator's opt-in AND the scope approval the task_bridge auto-renewer mints under, so an unqualified write that sets it enrols every binding in automatic key minting with one writer-chosen scope. NULL itself is the correct default-deny value, so this is a widen-only column.",
  },
  {
    table: "company_secret_versions",
    column: "revoked_at",
    reason: "Dangerous value NULL: the version lookup does not filter, so revoked_at is the sole revocation gate and clearing it re-arms every revoked secret version for resolution.",
  },
  {
    table: "company_secrets",
    column: "status",
    reason: "Dangerous value 'active': resolution rejects deleted and non-active secrets, so a flatten un-deletes and reactivates every secret.",
  },
  {
    table: "company_secrets",
    column: "scope",
    reason: "Dangerous value 'company': the permissive scope that bypasses the user-secret declaration path; the scope-shape CHECK is satisfiable in the same statement.",
  },
  {
    table: "invites",
    column: "revoked_at",
    reason: "Dangerous value NULL: every redemption path gates on revoked_at being unset, so a flatten reinstates every revoked invite.",
  },
  {
    table: "invites",
    column: "expires_at",
    reason: "Dangerous value far-future: the column is NOT NULL so it cannot be cleared, but a flattened future date makes every invite permanently redeemable.",
  },
  {
    table: "invites",
    column: "allowed_join_types",
    reason: "Dangerous value 'both': the permissive value, so a flatten lets an agent-only invite mint a human company membership and vice versa.",
  },
  {
    table: "invites",
    column: "token_hash",
    reason: "Credential material; the unique index aborts a constant flatten but not a per-row rewrite, which would re-point every outstanding invite at an attacker-chosen token.",
  },
  {
    table: "join_requests",
    column: "status",
    reason: "Dangerous value 'approved': the claim path gates on status alone, so a flatten converts every pending and rejected join request into a redeemable one.",
  },
  {
    table: "join_requests",
    column: "claim_secret_expires_at",
    reason: "Dangerous value NULL: the expiry check short-circuits when unset, so a flatten leaves every outstanding agent-key claim secret live indefinitely.",
  },
  {
    table: "cli_auth_challenges",
    column: "expires_at",
    reason: "Dangerous value far-future: approving a challenge mints a board API key, so a flattened future expiry keeps every pending challenge approvable forever.",
  },
  {
    table: "cli_auth_challenges",
    column: "requested_access",
    reason: "Dangerous value 'board' (also the column default): strips the instance-admin approval requirement from every pending challenge.",
  },
  {
    table: "cli_auth_challenges",
    column: "pending_key_scope_config",
    reason: "Dangerous value NULL/{kind:'standard'}/unparseable: written verbatim onto board_api_keys.scope_config when the challenge is approved, so a flatten here is a flatten there — every plugin_ops login lands as an unscoped owner key.",
  },
  {
    table: "cli_auth_challenges",
    column: "pending_key_hash",
    reason: "Credential material copied verbatim into board_api_keys.key_hash when a challenge is approved, so a flatten makes the next approval mint an operator-scope board key whose token the attacker already holds. Registered on the same grounds as board_api_keys.key_hash and strictly more exposed: there is no unique index here to abort a constant flatten.",
  },
  {
    table: "cli_auth_challenges",
    column: "secret_hash",
    reason: "Credential material under a non-unique index, so an unqualified write succeeds and makes one attacker-known secret address every pending CLI challenge.",
  },
  {
    table: "verification",
    column: "expires_at",
    reason: "Lifetime bound on better-auth verification artefacts (email verification, password reset). Same library-behaviour grounds as session.expires_at: enforcement lives in better-auth rather than this repo, and no migration has a legitimate reason to rewrite it unqualified.",
  },
  {
    table: "session",
    column: "expires_at",
    reason: "Session lifetime bound. Enforcement lives in better-auth rather than this repo, so the direction is asserted from library behaviour and not from an in-repo predicate; registered because no migration has a legitimate reason to rewrite it unqualified.",
  },

  // --- Content-trust provenance (indirect prompt-injection containment) ---
  {
    table: "issues",
    column: "source_trust",
    reason: "Dangerous value NULL or a promoted disposition: NULL means trusted, so a flatten un-quarantines low-trust content and injects it raw into higher-trust agents' prompt context.",
  },
  {
    table: "issue_comments",
    column: "source_trust",
    reason: "Dangerous value NULL or a promoted disposition: comment bodies are sanitized for higher-trust readers only while this marker survives.",
  },
  {
    table: "documents",
    column: "source_trust",
    reason: "Dangerous value NULL or a promoted disposition: document bodies reach agent context unredacted once the marker is cleared.",
  },
  {
    table: "issue_work_products",
    column: "source_trust",
    reason: "Dangerous value NULL or a promoted disposition: quarantined artifact previews are only replaced while the marker survives.",
  },
  {
    table: "document_annotation_comments",
    column: "source_trust",
    reason: "Dangerous value NULL or a promoted disposition: annotation bodies are sanitized into pipeline conversation context based on this marker.",
  },

  // --- Plugin trust surface (plugins are global — one worker serves every tenant) ---
  {
    table: "plugins",
    column: "status",
    reason: "Dangerous value 'ready': the worker-load and tool-registration gate, so a flatten resurrects disabled, errored and uninstalled plugin workers instance-wide.",
  },
  {
    table: "plugins",
    column: "manifest_json",
    reason: "Carries the capabilities array the host enforces route, webhook, driver and external-object access against; a flatten grants every plugin one manifest's capability set.",
  },
  {
    table: "plugin_company_settings",
    column: "enabled",
    reason: "Dangerous value true (also the absent-row default): the sole per-company plugin opt-out, so a flatten re-enables plugins for companies that explicitly disabled them.",
  },
  {
    table: "plugin_config",
    column: "config_json",
    reason: "Per-plugin config carrying secret-ref bindings and per-company policy; a flatten copies one plugin's configuration — and its secret reach — onto every other plugin.",
  },

  // --- Execution policy, sandboxing and isolation ---
  {
    table: "issues",
    column: "execution_policy",
    reason: "Dangerous value NULL/{}: carries the per-issue authorizationPolicy, so clearing it resolves every low-trust-confined issue back to the default preset — full control-plane surface, full secret-binding reach, shared workspaces.",
  },
  {
    table: "issues",
    column: "assignee_adapter_overrides",
    reason: "Unconstrained adapter config merged into the launched run, including workspaceStrategy provision commands the host executes; a flatten writes one issue's overrides onto every issue.",
  },
  {
    table: "projects",
    column: "execution_workspace_policy",
    reason: "Dangerous value NULL or enabled:false: workspace-mode resolution falls through to shared_workspace, collapsing every isolated-workspace project onto one shared checkout.",
  },
  {
    table: "environments",
    column: "config",
    reason: "Dangerous value strictHostKeyChecking:false or a swapped sandbox provider; the table has no company_id, so any flatten is inherently cross-tenant.",
  },
  {
    table: "environments",
    column: "env_vars",
    reason: "Injected into the agent run environment; the table has no company_id, so a flatten transplants one environment's credentials into every tenant's runs.",
  },

  // --- Spend hard stops (the bound on runaway-agent abuse) ---
  {
    table: "budget_policies",
    column: "is_active",
    reason: "Dangerous value false: drops the policy from the hard-stop evaluator and every pre-invocation block, disabling budget enforcement fleet-wide.",
  },
  {
    table: "budget_policies",
    column: "hard_stop_enabled",
    reason: "Dangerous value false: keeps alerting but removes the pause-and-cancel, leaving agent spend unbounded.",
  },
  {
    table: "budget_policies",
    column: "amount",
    reason: "Dangerous value <= 0: short-circuits hard-stop evaluation entirely rather than meaning 'no allowance' — the same fail-open shape as hard_stop_enabled = false.",
  },

  // --- Process integrity ---
  {
    table: "pipelines",
    column: "enforce_transitions",
    reason: "Dangerous value false: disarms the stage-transition graph so required review stages can be skipped. Integrity and separation of duties, not authorization — actor checks run on a separate path.",
  },

  // --- Data protection ---
  {
    table: "feedback_exports",
    column: "status",
    reason: "Dangerous value 'pending': the sole gate on shipping a captured feedback trace off-instance, so a flatten uploads every local_only trace — including issue payload snapshots — to the external destination without consent.",
  },

  // --- Found by the classified-inventory check, not by the human sweep ---
  // Enumerating all 1,677 columns surfaced these; two prior passes over the same
  // schema did not. Each was confirmed against an in-repo predicate before
  // registering — the reason names that predicate, rather than guessing from the
  // column name.
  {
    table: "routine_triggers",
    column: "signing_mode",
    reason: "Dangerous value 'none': routines.ts skips signature verification entirely for that mode, leaving the publicId in the URL as the only secret, so a flatten converts every signed inbound webhook into an unauthenticated one.",
  },
  {
    table: "routine_triggers",
    column: "enabled",
    reason: "Dangerous value true: the first half of the trigger admission check, so a flatten re-arms every disabled inbound webhook — including ones disabled in response to abuse.",
  },
  {
    table: "routine_triggers",
    column: "replay_window_sec",
    reason: "Dangerous value a large number, or NULL which falls back to 300s: the bound on how long a captured signed request stays replayable, and widening it is invisible in the response.",
  },
  {
    table: "routine_triggers",
    column: "public_id",
    reason: "The unguessable half of the trigger URL, and under signing_mode 'none' it is the entire credential; a flatten makes one attacker-known id address every trigger.",
  },
  {
    table: "join_requests",
    column: "claim_secret_hash",
    reason: "Compared against the presented claim secret before an invite is redeemed; a flatten makes one attacker-held secret satisfy every pending join request, each of which mints an agent in its company.",
  },
  {
    table: "join_requests",
    column: "claim_secret_consumed_at",
    reason: "Dangerous value NULL: the sole single-use marker on a claim secret, so clearing it makes every already-redeemed invite redeemable again.",
  },
  {
    table: "company_secret_versions",
    column: "status",
    reason: "Dangerous value 'active': resolution refuses disabled and destroyed versions on this column, so a flatten un-revokes every retired secret version and makes it resolvable again.",
  },
  {
    table: "company_secret_versions",
    column: "material",
    reason: "The secret payload itself; an unqualified write copies one version's material across every other version, so a value the attacker controls becomes the resolved secret for bindings they never touched.",
  },
  {
    table: "project_workspaces",
    column: "setup_command",
    reason: "Executed by the host as `sh -c <value>` during workspace provisioning; a flatten runs one attacker-chosen command in every project's workspace, across tenants.",
  },
  {
    table: "project_workspaces",
    column: "cleanup_command",
    reason: "Same host `sh -c` execution path as setup_command, on the teardown side — and teardown runs even for runs that failed early, so it is the more reliable of the two to reach.",
  },
  {
    table: "pipeline_cases",
    column: "lease_token",
    reason: "Dangerous value NULL: lease ownership returns true unconditionally when the token is absent, so a flatten to NULL lets any actor mutate any leased case, and a flatten to a constant hands every case to whoever holds that one token.",
  },
  {
    table: "pipeline_cases",
    column: "lease_expires_at",
    reason: "The other half of the same check: a lease is only enforced while this timestamp is in the future, so flattening it to the past disarms lease ownership without touching lease_token.",
  },
  {
    table: "session",
    column: "token",
    reason: "The session bearer value better-auth looks sessions up by. Same library-behaviour grounds as session.expires_at: enforcement is out of repo, but no migration has a legitimate reason to rewrite session credentials unqualified, and a constant flatten would give one token every user's session.",
  },
  {
    table: "verification",
    column: "value",
    reason: "The verification/password-reset token better-auth matches on; a flatten makes one attacker-known value satisfy every outstanding reset. Registered on the same library-behaviour grounds as verification.expires_at.",
  },
  {
    table: "agents",
    column: "runtime_config",
    reason: "A second home for adapterConfig at modelProfiles.*.adapterConfig — guarded by the same mutation assertion as agents.adapter_config, and therefore carrying the same dangerouslySkipPermissions reach. Registering adapter_config alone would leave the bypass reachable through this column.",
  },
  {
    table: "routines",
    column: "status",
    reason: "Dangerous value 'active': the trigger admission check requires it, and the mutation paths refuse only 'archived', so a flatten re-arms every archived routine and its inbound triggers.",
  },
  {
    table: "routines",
    column: "env",
    reason: "Injected into the agent run environment and screened by assertLowTrustEnvConfigAllowed; a flatten transplants one routine's environment — credentials included — into every routine's runs. Same grounds as environments.env_vars.",
  },
  {
    table: "projects",
    column: "env",
    reason: "The project-scoped half of the same run-environment injection, screened by the same low-trust env gate; a flatten crosses tenants because it writes every project row.",
  },
  {
    table: "issues",
    column: "execution_workspace_preference",
    reason: "Dangerous value 'reuse_existing': resolves the run onto a previously-used execution workspace instead of a fresh one, carrying the prior run's on-disk residue — checked-out credentials, git remotes, installed dependencies — into the next issue. The project-level version of this decision (projects.execution_workspace_policy) is already registered; this is the same control one level down.",
  },
  {
    table: "issues",
    column: "execution_workspace_settings",
    reason: "Its `mode` takes precedence over execution_workspace_preference in workspace resolution, so registering the preference alone would leave the higher-precedence input unguarded.",
  },
  // --- sync/upstream-v2026.824.1: columns introduced by upstream 707->824 (classified during the 824.1 superset re-land) ---
  {
    table: "companies",
    column: "interaction_resolver_governance",
    reason: "Company-level governance mode for interaction resolvers; downgrading it weakens the fork's continuation gating.",
  },
  {
    table: "company_secret_proposals",
    column: "value_ciphertext",
    reason: "Ciphertext of a proposed secret value; an unqualified write can replace the proposed credential material before approval.",
  },
  {
    table: "company_skill_policies",
    column: "default_effect",
    reason: "Default verdict for unmatched skill tool accesses; flipping it to allow is a bulk authorization change.",
  },
  {
    table: "company_skill_policies",
    column: "rules",
    reason: "Skill tool-access policy rules; rewriting them grants tool access outside review.",
  },
  {
    table: "connection_grants",
    column: "credential_secret_refs",
    reason: "Secret refs backing this grant's credentials; repointing them is a credential swap.",
  },
  {
    table: "connection_token_issuances",
    column: "token_hash",
    reason: "Hash of the issued connection token; immutable audit of what was issued, and a swap would re-target an issued credential.",
  },
  {
    table: "decisions",
    column: "signed_spec",
    reason: "Signed decision spec authorizing effect execution; a rewrite forges an executable decision outside the approval chain.",
  },
  {
    table: "external_objects",
    column: "refresh_token",
    reason: "Stored OAuth refresh token for the external object; an unqualified write transplants a foreign or stale credential onto the row, so writes must stay qualified.",
  },
  {
    table: "tool_action_requests",
    column: "approval_id",
    reason: "Links a privileged action request to its board approval; repointing it attaches an unapproved action to someone else's approval.",
  },
  {
    table: "tool_action_requests",
    column: "signed_arguments",
    reason: "Approval-bound signature over the action arguments; rewriting it detaches the approval from what actually executes.",
  },
  {
    table: "tool_connections",
    column: "auth_kind",
    reason: "Selects how the connection authenticates; flipping it changes the interpretation of the credential columns and can bypass the intended auth path.",
  },
  {
    table: "tool_connections",
    column: "credential_refs",
    reason: "Secret references resolving this connection's credentials; repointing them (e.g. at an attacker-owned secret) is a credential swap and must be written qualified.",
  },
  {
    table: "tool_connections",
    column: "credential_secret_refs",
    reason: "Company-secret binding refs backing this connection; same credential-swap hazard as credential_refs.",
  },
  {
    table: "tool_connections",
    column: "ownership",
    reason: "Records the owning principal kind of the connection; rewriting it reassigns control of the connection's credentials and grants.",
  },
  {
    table: "tool_gateway_sessions",
    column: "token_hash",
    reason: "Hash of the gateway session token; same swap-to-known-hash hazard as gateway token hashes.",
  },
  {
    table: "tool_invocations",
    column: "approval_state",
    reason: "Records whether the invocation passed its approval gate; forging it launders an unapproved invocation after the fact.",
  },
  {
    table: "tool_invocations",
    column: "policy_decision",
    reason: "Recorded policy verdict (allow/deny); forging it hides denials from audit and downstream enforcement.",
  },
  {
    table: "tool_mcp_gateway_tokens",
    column: "allowed_actions",
    reason: "Capability allowlist of the gateway token; widening it is direct privilege escalation on the gateway surface.",
  },
  {
    table: "tool_mcp_gateway_tokens",
    column: "token_hash",
    reason: "Lookup hash of a gateway API token; swapping it for a hash the attacker knows mints them a working token without touching the secret store.",
  },
  {
    table: "tool_mcp_gateways",
    column: "auth_config",
    reason: "Auth configuration for the MCP gateway; may carry credential material or trusted endpoints and must never be flattened by an unqualified write.",
  },
  {
    table: "tool_mcp_gateways",
    column: "header_policy",
    reason: "Controls which headers are forwarded upstream; loosening it leaks internal headers to remote servers.",
  },
  {
    table: "tool_mcp_gateways",
    column: "metadata_policy",
    reason: "Controls which metadata is forwarded upstream; loosening it leaks internal context to remote servers.",
  },
  {
    table: "tool_oauth_states",
    column: "code_verifier",
    reason: "PKCE code verifier for an in-flight OAuth flow; exposure or a swap breaks the PKCE binding and enables code interception.",
  },
  {
    table: "tool_policies",
    column: "conditions",
    reason: "Policy matching conditions; rewriting them changes which calls a policy governs.",
  },
  {
    table: "tool_policies",
    column: "config",
    reason: "Policy effect configuration; rewriting it changes enforcement behavior.",
  },
  {
    table: "tool_policies",
    column: "enabled",
    reason: "Policy on/off switch; disabling a guard policy via an unqualified write removes enforcement.",
  },
  {
    table: "tool_policies",
    column: "selectors",
    reason: "Policy target selectors; rewriting them changes which calls a policy governs.",
  },
  {
    table: "tool_profile_entries",
    column: "effect",
    reason: "Per-tool allow/deny verdict; rewriting it grants or revokes tool access directly.",
  },
  {
    table: "tool_profiles",
    column: "default_action",
    reason: "Default verdict for unmatched tool accesses in the profile; flipping it is a bulk authorization change.",
  },
  {
    table: "user_inbox_agent_policies",
    column: "allowed_agent_ids",
    reason: "Allowlist of agents permitted to act inside the user's inbox; widening it grants agents inbox authority on the user's behalf.",
  },
] as const satisfies readonly (SecurityPostureColumn & RegisteredPostureColumn)[];

const POSTURE_COLUMNS_BY_TABLE = new Map<string, Set<string>>();
for (const entry of SECURITY_POSTURE_COLUMNS) {
  const table = entry.table.toLowerCase();
  const columns = POSTURE_COLUMNS_BY_TABLE.get(table) ?? new Set<string>();
  columns.add(entry.column.toLowerCase());
  POSTURE_COLUMNS_BY_TABLE.set(table, columns);
}

/** True when the table holds at least one registered security-posture column. */
export function isSecurityPostureTable(table: string): boolean {
  return POSTURE_COLUMNS_BY_TABLE.has(table.toLowerCase());
}

/** Every registered posture column for `table`, lowercased and sorted. */
export function postureColumnsForTable(table: string): string[] {
  return [...(POSTURE_COLUMNS_BY_TABLE.get(table.toLowerCase()) ?? [])].sort();
}

/**
 * Registered posture columns among `columns` for `table`, lowercased.
 *
 * Comparison is case-insensitive: unquoted SQL identifiers fold to lowercase,
 * so `UPDATE COMPANY_SECRET_BINDINGS SET EGRESS_ALLOWLIST_ENFORCED = false`
 * targets the same column as the quoted lowercase form and must match.
 */
export function matchedPostureColumns(
  table: string,
  columns: readonly string[],
): string[] {
  const registered = POSTURE_COLUMNS_BY_TABLE.get(table.toLowerCase());
  if (!registered) return [];
  const matched = new Set<string>();
  for (const column of columns) {
    const normalized = column.toLowerCase();
    if (registered.has(normalized)) matched.add(normalized);
  }
  return [...matched].sort();
}

/** Database column names per database table name, both lowercased. */
export type SchemaColumnIndex = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Index the drizzle tables in `tables` by their *database* names.
 *
 * `getTableName` / `getTableColumns` are used rather than the exported binding
 * names and object keys, because the registry names columns the way migration
 * SQL does — `egress_allowlist_enforced`, not `egressAllowlistEnforced`.
 */
export function buildSchemaColumnIndex(tables: Record<string, unknown>): SchemaColumnIndex {
  const index = new Map<string, Set<string>>();
  for (const value of Object.values(tables)) {
    if (!is(value, Table)) continue;
    const table = getTableName(value).toLowerCase();
    const columns = index.get(table) ?? new Set<string>();
    for (const column of Object.values(getTableColumns(value))) {
      columns.add(column.name.toLowerCase());
    }
    index.set(table, columns);
  }
  return index;
}

/**
 * Fail when a registry entry no longer resolves against the schema.
 *
 * The registry names `(table, column)` pairs as strings. If a registered column
 * is renamed, dropped, or moved, the entry matches nothing: the rule still runs,
 * still passes, and protects zero columns, and CI stays green the whole time.
 * That green check then reads as evidence of a control that is no longer there,
 * which is worse than having no rule at all.
 *
 * So an unresolvable entry is an error — never a warning and never a skip. The
 * two failure modes are reported separately because they need different fixes: a
 * missing table means the table itself was renamed or dropped, a missing column
 * on a present table is the likelier and more innocent-looking case, a rename.
 *
 * Both vacuous inputs throw rather than passing: a schema with no reachable
 * tables, and an empty registry. An empty registry is the bulk form of the very
 * degradation this function exists to catch — every entry gone at once instead of
 * one entry rotted — and it is indistinguishable in the output from a drifted one,
 * so it cannot be allowed to report success.
 *
 * Note this only proves the registry agrees with the *drizzle* schema; a column
 * renamed in raw SQL without the matching schema edit is out of reach here (and
 * would break every query against that table).
 */
export function assertSecurityPostureColumnsResolve(
  tables: Record<string, unknown> = schema,
  entries: readonly SecurityPostureColumn[] = SECURITY_POSTURE_COLUMNS,
): void {
  if (entries.length === 0) {
    throw new Error(
      [
        "Security-posture registry is empty: there are no (table, column) pairs left to protect.",
        "The migration lint rule would still run and still report success while covering zero",
        "columns, which is the same false evidence a drifted entry produces. Restore the entries,",
        "or retire the rule in the same change that empties them.",
      ].join("\n"),
    );
  }

  const index = buildSchemaColumnIndex(tables);
  if (index.size === 0) {
    throw new Error(
      [
        "Security-posture registry could not be resolved: no drizzle tables were found in the schema.",
        "Every registered pair would be unverifiable, so this fails rather than passing vacuously.",
      ].join("\n"),
    );
  }

  const unresolved = entries.flatMap((entry) => {
    const table = entry.table.toLowerCase();
    const columns = index.get(table);
    if (!columns) {
      return [`  ${entry.table}.${entry.column} — table "${entry.table}" is not in the schema`];
    }
    if (columns.has(entry.column.toLowerCase())) return [];
    const present = [...columns].sort().join(", ");
    return [
      `  ${entry.table}.${entry.column} — no such column on "${entry.table}" (renamed?); it has: ${present}`,
    ];
  });
  if (unresolved.length === 0) return;

  throw new Error(
    [
      `Security-posture registry has ${unresolved.length} entry(s) that no longer resolve against the schema.`,
      "A registered pair that matches nothing protects nothing, while the migration lint",
      "rule keeps reporting green. Update SECURITY_POSTURE_COLUMNS in the same change that",
      "renames or drops the column, or remove the entry deliberately.",
      ...unresolved,
    ].join("\n"),
  );
}

/** Shortest reason that can carry an argument rather than a shrug. */
const MIN_REJECTION_REASON_LENGTH = 30;

/**
 * Fail when a schema column is classified in neither list.
 *
 * `assertSecurityPostureColumnsResolve` walks registry -> schema and catches
 * deletions: an entry that stops resolving because its column was renamed or
 * dropped. This walks schema -> classification and catches the opposite drift,
 * additions: a column that exists and is named nowhere, so the rule does not
 * check it and nothing says so.
 *
 * That direction is the one a human pass cannot hold. The sweep that grew the
 * registry from 2 pairs to 53 missed four columns on its first read of the same
 * schema it was sweeping, and found them only by diffing mechanically. A
 * classification that only a re-sweep refreshes is one forgotten sweep from
 * stale, and staleness here is silent — an unclassified column looks exactly
 * like a safe one.
 *
 * So the contract is a total partition: every column is either a registered
 * posture column or an explicitly reasoned rejection, and "absent" is not a
 * third state. Six ways to violate it, all errors:
 *
 * 1. a schema column in neither list,
 * 2. a rejection whose reason is missing or too short to be an argument,
 * 3. a rejection that enumerates no columns — the whole-table default by
 *    implication, which would re-open the gap for every column added later,
 * 4. a rejection naming a table or column that is not in the schema, which is
 *    the rejection-side twin of a rotted registry entry,
 * 5. a pair claimed as both a control and not a control, and
 * 6. either input being vacuously empty.
 */
export function assertSchemaColumnsClassified(
  tables: Record<string, unknown> = schema,
  registered: readonly SecurityPostureColumn[] = SECURITY_POSTURE_COLUMNS,
  rejections: readonly SecurityPostureRejection[] = SECURITY_POSTURE_REJECTIONS,
): void {
  const index = buildSchemaColumnIndex(tables);
  if (index.size === 0) {
    throw new Error(
      [
        "Security-posture inventory could not be checked: no drizzle tables were found in the schema.",
        "There would be nothing to classify, so this fails rather than passing vacuously.",
      ].join("\n"),
    );
  }
  if (rejections.length === 0) {
    throw new Error(
      [
        "Security-posture rejection list is empty: every unregistered column would be unclassified.",
        "An empty list cannot make the inventory total, and reporting success on it would mean the",
        "check passes precisely when it covers nothing. Restore SECURITY_POSTURE_REJECTIONS.",
      ].join("\n"),
    );
  }

  const malformed: string[] = [];
  const unresolved: string[] = [];
  const rejected = new Map<string, string>();

  for (const entry of rejections) {
    const table = entry.table.toLowerCase();
    if (entry.reason.trim().length < MIN_REJECTION_REASON_LENGTH) {
      malformed.push(
        `  ${entry.table} — reason is missing or shorter than ${MIN_REJECTION_REASON_LENGTH} characters`,
      );
    }
    if (entry.columns.length === 0) {
      malformed.push(
        `  ${entry.table} — enumerates no columns; a table-level decision must list the columns it was made over`,
      );
    }

    const schemaColumns = index.get(table);
    for (const column of entry.columns) {
      const normalized = column.toLowerCase();
      if (!schemaColumns) {
        unresolved.push(`  ${entry.table}.${column} — table "${entry.table}" is not in the schema`);
      } else if (!schemaColumns.has(normalized)) {
        unresolved.push(
          `  ${entry.table}.${column} — no such column on "${entry.table}" (renamed or dropped?)`,
        );
      }
      rejected.set(`${table}.${normalized}`, entry.reason);
    }
  }

  const contradictory = registered
    .filter((entry) => rejected.has(`${entry.table.toLowerCase()}.${entry.column.toLowerCase()}`))
    .map(
      (entry) =>
        `  ${entry.table}.${entry.column} — registered as a control and rejected as not one`,
    );

  const unclassified: string[] = [];
  const registeredKeys = new Set(
    registered.map((entry) => `${entry.table.toLowerCase()}.${entry.column.toLowerCase()}`),
  );
  for (const [table, columns] of [...index].sort(([a], [b]) => a.localeCompare(b))) {
    for (const column of [...columns].sort()) {
      const key = `${table}.${column}`;
      if (registeredKeys.has(key) || rejected.has(key)) continue;
      unclassified.push(`  ${table}.${column}`);
    }
  }

  const problems = [
    ...(malformed.length > 0
      ? [`${malformed.length} malformed rejection entry(s):`, ...malformed]
      : []),
    ...(unresolved.length > 0
      ? [
          `${unresolved.length} rejection(s) that no longer resolve against the schema:`,
          ...unresolved,
        ]
      : []),
    ...(contradictory.length > 0
      ? [`${contradictory.length} contradictory classification(s):`, ...contradictory]
      : []),
    ...(unclassified.length > 0
      ? [
          `${unclassified.length} schema column(s) classified in neither list:`,
          ...unclassified,
        ]
      : []),
  

  ];
  if (problems.length === 0) return;

  throw new Error(
    [
      "Security-posture classification is not total.",
      "Every schema column must be either a registered posture column in SECURITY_POSTURE_COLUMNS",
      "or an explicitly reasoned entry in SECURITY_POSTURE_REJECTIONS. A column in neither is not",
      "checked by the migration lint rule, and nothing else reports that — which is the same",
      "absent-means-unprotected shape the rule exists to fix, one level up.",
      ...problems,
    ].join("\n"),
  );
}

