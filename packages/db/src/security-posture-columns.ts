import { Table, getTableColumns, getTableName, is } from "drizzle-orm";
import * as schema from "./schema/index.js";

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

/**
 * One union member per registered table. Registering a column on a new table
 * means adding that table's `PostureColumnOf<...>` here, which is exactly the
 * deliberate edit the registry is supposed to require.
 */
type RegisteredPostureColumn =
  | PostureColumnOf<typeof schema.companySecretBindings>
  | PostureColumnOf<typeof schema.agents>
  | PostureColumnOf<typeof schema.instanceUserRoles>
  | PostureColumnOf<typeof schema.companyMemberships>
  | PostureColumnOf<typeof schema.principalPermissionGrants>
  | PostureColumnOf<typeof schema.companies>
  | PostureColumnOf<typeof schema.agentApiKeys>
  | PostureColumnOf<typeof schema.boardApiKeys>
  | PostureColumnOf<typeof schema.companySecretVersions>
  | PostureColumnOf<typeof schema.companySecrets>
  | PostureColumnOf<typeof schema.invites>
  | PostureColumnOf<typeof schema.joinRequests>
  | PostureColumnOf<typeof schema.cliAuthChallenges>
  | PostureColumnOf<typeof schema.authVerifications>
  | PostureColumnOf<typeof schema.authSessions>
  | PostureColumnOf<typeof schema.issues>
  | PostureColumnOf<typeof schema.issueComments>
  | PostureColumnOf<typeof schema.documents>
  | PostureColumnOf<typeof schema.issueWorkProducts>
  | PostureColumnOf<typeof schema.documentAnnotationComments>
  | PostureColumnOf<typeof schema.plugins>
  | PostureColumnOf<typeof schema.pluginCompanySettings>
  | PostureColumnOf<typeof schema.pluginConfig>
  | PostureColumnOf<typeof schema.projects>
  | PostureColumnOf<typeof schema.environments>
  | PostureColumnOf<typeof schema.budgetPolicies>
  | PostureColumnOf<typeof schema.pipelines>
  | PostureColumnOf<typeof schema.feedbackExports>;

/**
 * Columns whose value *is* a security control, not data about one.
 *
 * A migration that clears one of these without a selective WHERE silently
 * downgrades the posture of every row — which is what migration `0138` did to
 * every `company_secret_bindings` row when it was re-applied.
 *
 * This registry is explicit. A table absent from it is unchecked, so adding a
 * pair must be a conscious edit and removing one must be visible in review. It
 * is NOT inferred from column naming, and it is NOT derived from
 * `table-size-estimates.ts` — that registry is fail-open by construction (an
 * unlisted table defaults to `"small"`), and a security rule must not inherit
 * that default.
 *
 * It started as a two-pair seed of the columns `0138` actually flattened. It is
 * now the output of a schema sweep, with the rejections and their reasons in
 * `doc/SECURITY-POSTURE-COLUMN-SWEEP.md` so the analysis does not have to be
 * re-derived. Adding a column to the schema does not add it here — the sweep has
 * to be re-run, and that is the registry's standing limit.
 *
 * Every `reason` names the *dangerous direction*: the value which, if a
 * migration flattened the column to it, is the permissive one. For most entries
 * that value is also the column default, which is what makes an unqualified
 * write look innocuous in review.
 *
 * Entries are bound to the schema twice, because a pair that resolves to nothing
 * protects nothing while the rule keeps reporting green:
 * - at compile time by `RegisteredPostureColumn`, and
 * - at lint time by `assertSecurityPostureColumnsResolve`, which the checker runs
 *   on every migration.
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

  // --- Authorization and identity ---
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
    column: "expires_at",
    reason: "Dangerous value NULL: the lookup short-circuits on !expiresAt, so NULL means never expires and makes every operator-scope key immortal.",
  },
  {
    table: "board_api_keys",
    column: "key_hash",
    reason: "Credential material; the unique index aborts a constant flatten but not a per-row rewrite, which would invalidate or re-point every operator key.",
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
