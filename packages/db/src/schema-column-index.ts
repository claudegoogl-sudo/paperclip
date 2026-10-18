import { Table, getTableColumns, getTableName, is } from "drizzle-orm";

/** Database column names per database table name, both lowercased. */
export type SchemaColumnIndex = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Index the drizzle tables in `tables` by their *database* names.
 *
 * `getTableName` / `getTableColumns` are used rather than the exported binding
 * names and object keys, because the registry names columns the way migration
 * SQL does — `egress_allowlist_enforced`, not `egressAllowlistEnforced`.
 *
 * Shared by security-posture-columns.ts and tenancy-binding-keys.ts, which
 * both verify a registry of (table, column) pairs still resolves against the
 * schema.
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
