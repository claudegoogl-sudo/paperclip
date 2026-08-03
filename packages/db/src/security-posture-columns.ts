export type SecurityPostureColumn = {
  readonly table: string;
  readonly column: string;
  readonly reason: string;
};

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
] as const satisfies readonly SecurityPostureColumn[];

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
