import { Table, getTableColumns, getTableName, is } from "drizzle-orm";
import * as schema from "./schema/index.js";

export type TenancyBindingKey = {
  readonly table: string;
  readonly column: string;
  readonly reason: string;
};

/**
 * Structural shape of a drizzle table, narrow enough to read the *database*
 * names off it.
 */
type PostureTableShape = {
  readonly _: {
    readonly name: string;
    readonly columns: Record<string, { readonly _: { readonly name: string } }>;
  };
};

/**
 * A registry entry pinned to one table's literal names.
 */
type TenancyKeyOf<T extends PostureTableShape> = {
  readonly table: T["_"]["name"];
  readonly column: T["_"]["columns"][keyof T["_"]["columns"]]["_"]["name"];
  readonly reason: string;
};

/**
 * Tables whose tenancy/binding-scope keys are registered explicitly.
 *
 * These are the non-standard cases: tables that use tenancy keys other than
 * the universal `company_id`, or where the binding pattern is specific to
 * a feature's architecture (like plugin scope).
 */
type RegisteredTenancyKey =
  | TenancyKeyOf<typeof schema.pluginState>
  | TenancyKeyOf<typeof schema.pluginEntities>
  | TenancyKeyOf<typeof schema.budgetPolicies>
  | TenancyKeyOf<typeof schema.workspaceRuntimeServices>
  | TenancyKeyOf<typeof schema.budgetIncidents>;

/**
 * Tenancy and binding-scope keys that separate one tenant's data from another's.
 *
 * These columns differ from security-posture columns: they do not represent a
 * control whose *value* is dangerous (like `egress_allowlist_enforced = false`),
 * but rather a pointer that determines *which scope* a row belongs to. An
 * unqualified write that changes a tenancy key moves rows between tenants —
 * the enforcement still runs correctly, just against the wrong scope.
 *
 * ## Enumeration strategy (hybrid)
 *
 * This registry uses a **hybrid enumeration** strategy, justified by the
 * different failure modes:
 *
 * 1. **Explicit enumeration for plugin-scope tables** (`plugin_state`,
 *    `plugin_entities`, `budget_policies`, `workspace_runtime_services`,
 *    `budget_incidents`):
 *
 *    - These tables use custom scope keys (`scope_kind`/`scope_id`,
 *      `scope_type`/`scope_id`) that are specific to their feature's
 *      architecture.
 *    - The set is small and bounded (5 tables today).
 *    - Misnaming a scope column would silently fail to protect it, so
 *      explicit registration avoids that class of error.
 *    - New scope-key patterns are rare and should be reviewed deliberately.
 *
 * 2. **Column-name inference for `company_id`**:
 *
 *    - `company_id` is the standard tenancy column across ~100 tables.
 *    - It is a well-established naming convention, not an inference.
 *    - Explicitly listing 100+ table/column pairs is unmaintainable and
 *      immediately stale on every new table.
 *    - The naming convention is intentional: a table with `company_id` is
 *      company-scoped by definition.
 *
 * This hybrid approach diverges from the security-posture registry, which
 * refuses all naming inference. That refusal is correct for posture columns
 * (where `disabled` might mean anything), but wrong for tenancy (where
 * `company_id` has exactly one meaning).
 *
 * ## What this does NOT cover
 *
 * - Tables that are not company-scoped (instance-level tables like `plugins`)
 * - Tenancy patterns other than `company_id` (future multi-tenant designs)
 * - Columns that happen to contain `_id` but are not tenancy keys
 *
 * New tenancy patterns that differ from `company_id` must be registered here
 * explicitly, like the plugin-scope entries below.
 */
export const TENANCY_BINDING_KEYS = [
  {
    table: "plugin_state",
    column: "scope_kind",
    reason: "Plugin scope granularity (instance/company/project/etc.); flattening this moves plugin state between scopes.",
  },
  {
    table: "plugin_state",
    column: "scope_id",
    reason: "Plugin scope identifier; flattening this moves plugin state between scopes.",
  },
  {
    table: "plugin_entities",
    column: "scope_kind",
    reason: "Plugin entity scope granularity; flattening this moves external-entity mappings between scopes.",
  },
  {
    table: "plugin_entities",
    column: "scope_id",
    reason: "Plugin entity scope identifier; flattening this moves external-entity mappings between scopes.",
  },
  {
    table: "budget_policies",
    column: "scope_type",
    reason: "Budget policy scope (project/workspace/etc.); flattening this moves policies between scopes.",
  },
  {
    table: "budget_policies",
    column: "scope_id",
    reason: "Budget policy scope identifier; flattening this moves policies between scopes.",
  },
  {
    table: "workspace_runtime_services",
    column: "scope_type",
    reason: "Workspace service scope (project/workspace/etc.); flattening this moves services between scopes.",
  },
  {
    table: "workspace_runtime_services",
    column: "scope_id",
    reason: "Workspace service scope identifier; flattening this moves services between scopes.",
  },
  {
    table: "budget_incidents",
    column: "scope_type",
    reason: "Budget incident scope; flattening this moves incidents between scopes.",
  },
  {
    table: "budget_incidents",
    column: "scope_id",
    reason: "Budget incident scope identifier; flattening this moves incidents between scopes.",
  },
  {
    table: "budget_incidents",
    column: "policy_id",
    reason: "Budget incident parent policy; flattening this moves incidents between policies.",
  },
] as const satisfies readonly (TenancyBindingKey & RegisteredTenancyKey)[];

const EXPLICIT_KEYS_BY_TABLE = new Map<string, Set<string>>();
for (const entry of TENANCY_BINDING_KEYS) {
  const table = entry.table.toLowerCase();
  const columns = EXPLICIT_KEYS_BY_TABLE.get(table) ?? new Set<string>();
  columns.add(entry.column.toLowerCase());
  EXPLICIT_KEYS_BY_TABLE.set(table, columns);
}

/**
 * Standard `company_id` tenancy column name.
 *
 * This is NOT inferred from naming in general — it is the single, well-defined
 * tenancy column that has been universal across the codebase. A table with a
 * column named `company_id` is company-scoped by design.
 */
const COMPANY_ID_COLUMN = "company_id";

/**
 * Check whether a column is a registered tenancy/binding-scope key.
 *
 * This combines:
 * - Explicitly registered scope keys (plugin_state, plugin_entities, etc.)
 * - The universal `company_id` column (by naming convention)
 *
 * Returns `true` for `company_id` on any table, and for explicitly-registered
 * scope columns on their respective tables.
 */
export function isTenancyBindingKey(table: string, column: string): boolean {
  const normalizedTable = table.toLowerCase();
  const normalizedColumn = column.toLowerCase();

  // Check explicit registry first
  const explicitColumns = EXPLICIT_KEYS_BY_TABLE.get(normalizedTable);
  if (explicitColumns?.has(normalizedColumn)) return true;

  // Fall back to company_id naming convention
  if (normalizedColumn === COMPANY_ID_COLUMN) return true;

  return false;
}

/**
 * Get all registered tenancy/binding-scope columns for a table.
 *
 * For tables with explicit registrations (plugin_state, etc.), returns those.
 * For all other tables, returns `["company_id"]` if the column exists.
 *
 * This is used during linting to check whether an UPDATE SET clause touches
 * a tenancy key.
 */
export function tenancyKeysForTable(
  table: string,
  allColumns?: readonly string[],
): string[] {
  const normalizedTable = table.toLowerCase();
  const result: string[] = [];

  // Explicit registry takes precedence
  const explicitColumns = EXPLICIT_KEYS_BY_TABLE.get(normalizedTable);
  if (explicitColumns) {
    result.push(...explicitColumns);
  }

  // Add company_id if present in the table's columns
  if (allColumns?.some((c) => c.toLowerCase() === COMPANY_ID_COLUMN)) {
    result.push(COMPANY_ID_COLUMN);
  }

  return [...new Set(result)].sort();
}

/**
 * Get all registered tenancy/binding-scope columns that appear in the given
 * column list for a table.
 *
 * Used during linting to extract which columns in an UPDATE SET clause are
 * tenancy keys.
 */
export function matchedTenancyKeys(
  table: string,
  columns: readonly string[],
): string[] {
  const result = new Set<string>();
  for (const column of columns) {
    if (isTenancyBindingKey(table, column)) {
      result.add(column.toLowerCase());
    }
  }
  return [...result].sort();
}

/** Database column names per database table name, both lowercased. */
export type SchemaColumnIndex = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Index the drizzle tables in `tables` by their *database* names.
 *
 * Copied from security-posture-columns.ts for the same purpose: verifying
 * that registry entries still resolve against the schema.
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
 * Fail when an explicitly-registered tenancy key no longer resolves.
 *
 * Only the explicit registry is validated — `company_id` is a naming
 * convention, not a registry entry. If an explicit registration becomes
 * unreachable (table dropped, column renamed), that's a compile-time error.
 */
export function assertTenancyBindingKeysResolve(
  tables: Record<string, unknown> = schema,
  entries: readonly TenancyBindingKey[] = TENANCY_BINDING_KEYS,
): void {
  if (entries.length === 0) {
    throw new Error(
      [
        "Tenancy/binding-key registry is empty: there are no (table, column) pairs left to protect.",
        "The migration lint rule would still run and still report success while covering zero",
        "explicitly-registered scope keys. Restore the entries, or retire the rule in the same",
        "change that empties them.",
      ].join("\n"),
    );
  }

  const index = buildSchemaColumnIndex(tables);
  if (index.size === 0) {
    throw new Error(
      [
        "Tenancy/binding-key registry could not be resolved: no drizzle tables were found in the schema.",
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
      `Tenancy/binding-key registry has ${unresolved.length} entry(s) that no longer resolve against the schema.`,
      "A registered pair that matches nothing protects nothing, while the migration lint",
      "rule keeps reporting green. Update TENANCY_BINDING_KEYS in the same change that",
      "renames or drops the column, or remove the entry deliberately.",
      "",
      "(Note: company_id is a naming convention and is not validated here —",
      "only the explicit scope-key registrations are checked.)",
      ...unresolved,
    ].join("\n"),
  );
}
