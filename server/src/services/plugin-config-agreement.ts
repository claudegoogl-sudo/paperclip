/**
 * PLA-1887/PLA-1929/PLA-1937/PLA-1942 — the host-minted "agreement gate" for
 * construction-time `config.get` reads (setup(), poll loops, anything with no
 * per-dispatch tenant scope to pin a company). When no dispatch names a
 * tenant, resolve by checking whether every owning `plugin_config` row for
 * the plugin agrees; if they do, hand back the agreed config, otherwise deny
 * loudly rather than silently degrading to `{}` or leaking one tenant's
 * config into another's read.
 */

import { readConfigValueAtPath, writeConfigValueAtPath } from "./json-schema-secret-refs.js";

export interface ConfigAgreementRow {
  companyId: string;
  configJson: Record<string, unknown>;
}

export interface ConfigAgreementDenyInfo {
  /** Top-level config keys that disagree across owning rows. Never values. */
  disagreeingKeys: string[];
  /** Every company that owns a row for this plugin. */
  companyIds: string[];
}

export interface ConfigAgreementLogger {
  error(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface GetAgreedOrDenyDeps {
  pluginId: string;
  pluginKey: string;
  /** Every owning row for this plugin — MUST be the complete set, no LIMIT. */
  listConfigRows: () => Promise<ConfigAgreementRow[]>;
  /** Manifest-declared `format: "secret-ref"` dot-paths, excluded from the agreement comparison. */
  secretRefPaths: ReadonlySet<string>;
  /**
   * Called when rows disagree on a non-secret-ref field, AFTER the full-detail
   * `log.error` has already fired. Implementations must write a tenant-neutral
   * message only (no company ids) — see PLA-1942 A2.
   */
  onDeny: (info: ConfigAgreementDenyInfo) => Promise<void> | void;
  /** Called on every successful resolution (0 rows, 1 row, or N rows agreeing). */
  onResolve?: () => Promise<void> | void;
  logger: ConfigAgreementLogger;
}

export class ConfigAgreementDeniedError extends Error {
  readonly pluginId: string;
  readonly disagreeingKeys: string[];

  constructor(pluginId: string, disagreeingKeys: string[]) {
    super(
      `config.get denied: owning config rows for plugin "${pluginId}" disagree on key(s): ${disagreeingKeys.join(", ")}`,
    );
    this.name = "ConfigAgreementDeniedError";
    this.pluginId = pluginId;
    this.disagreeingKeys = disagreeingKeys;
  }
}

/** Structural/canonical equality — NOT `JSON.stringify(a) === JSON.stringify(b)`.
 * Independent `upsertConfig` calls produce different key insertion order with
 * no semantic difference; a naive string compare would produce spurious
 * denials and spurious "distinct value" counts for secret-ref fields. */
export function deepEqualStructural(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((value, index) => deepEqualStructural(value, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>).sort();
    const bKeys = Object.keys(b as Record<string, unknown>).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let index = 0; index < aKeys.length; index += 1) {
      if (aKeys[index] !== bKeys[index]) return false;
    }
    return aKeys.every((key) =>
      deepEqualStructural((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

function dedupeStructural(values: unknown[]): unknown[] {
  const distinct: unknown[] = [];
  for (const value of values) {
    if (!distinct.some((existing) => deepEqualStructural(existing, value))) {
      distinct.push(value);
    }
  }
  return distinct;
}

function stripSecretRefPaths(
  config: Record<string, unknown>,
  secretRefPaths: ReadonlySet<string>,
): Record<string, unknown> {
  let result = config;
  for (const path of secretRefPaths) {
    result = writeConfigValueAtPath(result, path, undefined);
  }
  return result;
}

function collectDisagreeingTopLevelKeys(
  base: Record<string, unknown>,
  candidate: Record<string, unknown>,
  disagreeing: Set<string>,
): void {
  const keys = new Set([...Object.keys(base), ...Object.keys(candidate)]);
  for (const key of keys) {
    if (!deepEqualStructural(base[key], candidate[key])) {
      disagreeing.add(key);
    }
  }
}

/**
 * Resolve a construction-time `config.get` (no dispatch pins a tenant) by
 * checking agreement across every owning row, or deny loudly.
 *
 * C1 (PLA-1937, repeated in PLA-1942 — binding): this mechanism must NEVER be
 * extended to a future write RPC. Its safety argument is a reads-leak-nothing
 * argument: resolving a value because every owning row ALREADY agrees on it
 * hands a caller nothing it couldn't already see in its own row. That
 * argument does not generalise to writes — an agreement-gated write would let
 * one tenant's write silently apply to another tenant's row whenever the rows
 * happened to already agree, which is a completely different and unsound
 * argument (the agreement would be a precondition of the write's effect, not
 * evidence the write is safe). There is no `config.set` in the wire protocol
 * today (`protocol.ts`: `config.get` params are `{companyId?: string}`,
 * read-only) — keeping it that way is load-bearing for this function to stay
 * a safe read-only shortcut.
 */
export async function getAgreedOrDeny(deps: GetAgreedOrDenyDeps): Promise<Record<string, unknown>> {
  const rows = await deps.listConfigRows();

  if (rows.length === 0) {
    await deps.onResolve?.();
    return {};
  }

  if (rows.length === 1) {
    await deps.onResolve?.();
    return rows[0]!.configJson;
  }

  const stripped = rows.map((row) => ({
    companyId: row.companyId,
    config: stripSecretRefPaths(row.configJson, deps.secretRefPaths),
  }));

  const base = stripped[0]!.config;
  const disagreeingKeys = new Set<string>();
  for (const row of stripped.slice(1)) {
    collectDisagreeingTopLevelKeys(base, row.config, disagreeingKeys);
  }

  const companyIds = rows.map((row) => row.companyId);

  if (disagreeingKeys.size > 0) {
    const disagreeingKeysList = [...disagreeingKeys];
    // Full detail (company ids + disagreeing top-level key NAMES) goes only
    // to the host-side log — no values, no secret-ref paths, ever. A2
    // (PLA-1942): no company-scoped API surface may expose this.
    deps.logger.error(
      {
        pluginId: deps.pluginId,
        pluginKey: deps.pluginKey,
        companyIds,
        disagreeingKeys: disagreeingKeysList,
      },
      "config-agreement: unscoped config.get denied; owning config rows disagree",
    );
    await deps.onDeny({ disagreeingKeys: disagreeingKeysList, companyIds });
    throw new ConfigAgreementDeniedError(deps.pluginId, disagreeingKeysList);
  }

  // Base (non-secret-ref) fields agree across every owning row. A1
  // (PLA-1942): union in each secret-ref field using "at most one DISTINCT
  // non-null value" — NOT "exactly one row non-null". Post-0164 fan-out
  // copies the legacy row's secret-ref UUID verbatim into every company's
  // row, so every row is non-null with the SAME value; a row-count check
  // reads that as N-way conflict and drops the field, which is precisely the
  // regression this rule exists to prevent (see PLA-1942 A1).
  let merged = base;
  for (const path of deps.secretRefPaths) {
    const values = rows
      .map((row) => readConfigValueAtPath(row.configJson, path))
      .filter((value) => value !== undefined && value !== null);
    const distinct = dedupeStructural(values);

    if (distinct.length === 0) continue; // nothing to union, drop silently
    if (distinct.length === 1) {
      merged = writeConfigValueAtPath(merged, path, distinct[0]);
      continue;
    }

    // 2+ distinct values: drop just this field, per-field warning, never deny
    // the whole config over a secret-ref disagreement.
    deps.logger.warn(
      { pluginId: deps.pluginId, pluginKey: deps.pluginKey, path },
      "config-agreement: secret-ref field has diverging values across owning rows; dropping field",
    );
  }

  await deps.onResolve?.();
  return merged;
}
