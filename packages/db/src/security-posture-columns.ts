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
type RegisteredPostureColumn = PostureColumnOf<typeof schema.companySecretBindings>;

/**
 * Columns whose value *is* a security control, not data about one.
 *
 * A migration that clears one of these without a selective WHERE silently
 * downgrades the posture of every row — which is what migration `0138` did to
 * every `company_secret_bindings` row when it was re-applied.
 *
 * This registry is deliberately explicit and deliberately small. A table absent
 * from it is unchecked, so adding a pair must be a conscious edit and removing
 * one must be visible in review. It is NOT inferred from column naming, and it
 * is NOT derived from `table-size-estimates.ts` — that registry is fail-open by
 * construction (an unlisted table defaults to `"small"`), and a security rule
 * must not inherit that default.
 *
 * Entries are bound to the schema twice, because a pair that resolves to nothing
 * protects nothing while the rule keeps reporting green:
 * - at compile time by `RegisteredPostureColumn`, and
 * - at lint time by `assertSecurityPostureColumnsResolve`, which the checker runs
 *   on every migration.
 */
export const SECURITY_POSTURE_COLUMNS = [
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
