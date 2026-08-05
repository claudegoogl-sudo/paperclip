/**
 * Tenancy and binding-scope columns: the security boundary that separates tenants.
 *
 * Unlike security-posture columns (whose dangerous value is a control downgrade),
 * a tenancy key has no "dangerous value" — every value is correct for exactly one
 * tenant. The danger is an *unqualified write*, which re-assigns every row to the
 * wrong scope. The enforcement still runs, correctly, against the wrong tenant.
 *
 * This matters because plugins are global: one plugin worker serves all tenants,
 * and plugin_state / plugin_entities scope columns are the only separation between
 * companies' plugin data.
 *
 * ## Enumeration strategy
 *
 * ### Pattern-based: company_id
 * `company_id` is near-universal (100+ tables) and its semantics are identical
 * everywhere: it names the tenant that owns the row. An explicit pair-by-pair
 * registry would be immediately stale and adds no safety value. Pattern-matching
 * on column name is appropriate here because:
 * - The failure mode is *wrong tenant*, not *disabled control* — any value is
 *   equally wrong if it isn't the row's true owner
 * - `company_id` on any table has the same meaning: tenancy
 * - A missed table is a real gap, not a false negative
 *
 * This is explicitly NOT the posture registry's strategy. Posture columns name
 * a *dangerous value*; a missed table there silently accepts a flatten to the
 * permissive state. Tenancy keys have no permissive state, so the risk calculus
 * is different.
 *
 * ### Explicit registry: scope columns
 * `scope_type`, `scope_kind`, `scope_id` are tenancy keys on some tables but
 * not others. On `budget_policies`, `scope_type`/`scope_id` name the budget's
 * target (company / agent / plugin). On `env_vars`, they're just configuration.
 * These are registered per-table.
 *
 * ### Table-specific additions: policy_id
 * `policy_id` is a regular foreign-key column on most tables (a reference to
 * some policy). On `budget_incidents`, it's a tenancy key: incidents are
 * scoped to the policy they alert on. Registered as a table-specific addition.
 *
 * ## What this does NOT cover
 *
 * - Foreign-key columns that reference a tenanted table but are not themselves
 *   tenancy boundaries (e.g., `agent_id`, `company_id` on a join table)
 * - "Soft" tenancy like user_id on user-owned resources — those are data
 *   relationships, not security boundaries
 * - Hardcoded patterns in migration SQL that bypass these columns entirely
 */

import { buildSchemaColumnIndex, type SchemaColumnIndex } from "./security-posture-columns.js";

/**
 * Tables where specific columns are tenancy keys.
 *
 * Format: table -> column -> reason (why this column is a tenancy boundary on this table)
 */
const TENANCY_KEY_ADDITIONS = new Map<
  string,
  ReadonlyMap<string, string>
>(
  [
    [
      "budget_incidents",
      new Map([
        ["scope_type", "Names the incident's scope target (company/agent/plugin)"],
        ["scope_id", "Identifies the incident's scoped target"],
        ["policy_id", "Incidents are scoped to the policy they alert on"],
      ]),
    ],
    [
      "budget_policies",
      new Map([
        ["scope_type", "Names the budget's scope target (company/agent/plugin)"],
        ["scope_id", "Identifies the policy's scoped target"],
      ]),
    ],
    [
      "plugin_state",
      new Map([
        ["scope_kind", "Plugin workers are global; scope_kind separates tenant state"],
        ["scope_id", "Identifies which tenant this plugin state belongs to"],
      ]),
    ],
    [
      "plugin_entities",
      new Map([
        ["scope_kind", "Plugin entities are stored in a global worker; this separates tenants"],
        ["scope_id", "Identifies which tenant this entity belongs to"],
      ]),
    ],
    [
      "workspace_runtime_services",
      new Map([
        ["scope_type", "Runtime services are scoped; this names the scope kind"],
        ["scope_id", "Identifies the scoped target of this runtime service"],
      ]),
    ],
  ],
);

/** Pattern-based tenancy keys: any table with a column matching this pattern. */
const TENANCY_KEY_PATTERNS = [/^company_id$/];

/**
 * True when `column` on `table` is a registered tenancy key.
 *
 * Checks explicit additions first, then pattern-based match.
 */
export function isTenancyKey(
  table: string,
  column: string,
  index?: SchemaColumnIndex,
): boolean {
  const normalizedTable = table.toLowerCase();
  const normalizedColumn = column.toLowerCase();

  // Check explicit additions first (scope columns on specific tables)
  const additions = TENANCY_KEY_ADDITIONS.get(normalizedTable);
  if (additions?.has(normalizedColumn)) return true;

  // Then pattern-based (company_id on any table)
  for (const pattern of TENANCY_KEY_PATTERNS) {
    if (pattern.test(normalizedColumn)) return true;
  }

  return false;
}

/**
 * All tenancy key columns for `table`, lowercased and sorted.
 *
 * Returns both pattern-based and explicitly-registered keys.
 */
export function tenancyKeysForTable(
  table: string,
  index?: SchemaColumnIndex,
): string[] {
  const normalizedTable = table.toLowerCase();
  const keys = new Set<string>();

  // Pattern-based keys
  for (const pattern of TENANCY_KEY_PATTERNS) {
    const patternStr = pattern.source.replace("^", "").replace("$", "");
    keys.add(patternStr);
  }

  // Explicit additions
  const additions = TENANCY_KEY_ADDITIONS.get(normalizedTable);
  if (additions) {
    for (const column of additions.keys()) {
      keys.add(column);
    }
  }

  return [...keys].sort();
}

/**
 * Registered tenancy columns among `columns` for `table`, lowercased and sorted.
 *
 * Used to check which columns in a SET clause are tenancy keys.
 */
export function matchedTenancyKeys(
  table: string,
  columns: readonly string[],
  index?: SchemaColumnIndex,
): string[] {
  const matched = new Set<string>();
  for (const column of columns) {
    if (isTenancyKey(table, column, index)) {
      matched.add(column.toLowerCase());
    }
  }
  return [...matched].sort();
}
