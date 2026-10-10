/**
 * Per-tenant plugin config-override scope gate.
 *
 * A plugin manifest marks a top-level `instanceConfigSchema` property as
 * tenant-overridable with `"x-paperclip-scope": "tenant"`. Any other value,
 * or no annotation, means `operator` (default-deny): only the operator-authored
 * `plugin_config` row may set that key.
 *
 * The scope is read ONLY from the host-stored `plugins.manifest_json`, never
 * from a worker-supplied value, so no plugin rebuild is needed.
 *
 * Keys whose schema declares `format: "uri"` or `format: "secret-ref"` are
 * high-risk: an override can redirect traffic or credentials. Setting them
 * needs instance-admin authority, even when the key is tenant-scoped.
 */

export const PLUGIN_CONFIG_SCOPE_KEYWORD = "x-paperclip-scope";
const HIGH_RISK_FORMATS = new Set(["uri", "secret-ref"]);

type SchemaLike = { properties?: Record<string, unknown> } | null | undefined;

function propertySchema(schema: SchemaLike, key: string): Record<string, unknown> | null {
  const props = schema && typeof schema === "object" ? schema.properties : undefined;
  if (!props || typeof props !== "object" || !Object.prototype.hasOwnProperty.call(props, key)) return null;
  const prop = (props as Record<string, unknown>)[key];
  return prop && typeof prop === "object" && !Array.isArray(prop) ? (prop as Record<string, unknown>) : null;
}

/** True only when the manifest explicitly declares the key tenant-scoped. */
export function isTenantScopedConfigKey(schema: SchemaLike, key: string): boolean {
  return propertySchema(schema, key)?.[PLUGIN_CONFIG_SCOPE_KEYWORD] === "tenant";
}

const MAX_SCHEMA_DEPTH = 16;
const SUBSCHEMA_KEYS = [
  "items", "additionalItems", "additionalProperties", "unevaluatedProperties", "unevaluatedItems",
  "contains", "propertyNames", "not", "if", "then", "else",
] as const;
const SUBSCHEMA_LIST_KEYS = ["oneOf", "anyOf", "allOf", "prefixItems", "items"] as const;
const SUBSCHEMA_MAP_KEYS = ["properties", "patternProperties", "dependentSchemas", "definitions", "$defs"] as const;

function resolveLocalRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) return undefined;
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let cur: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const part = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!cur || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Recursive walk over every subschema of `node`. Returns true when any
 * subschema declares a high-risk format. Fail-closed: an unresolvable `$ref`
 * or hitting the depth bound counts as high-risk.
 */
function subschemaIsHighRisk(root: unknown, node: unknown, depth: number, seen: Set<unknown>): boolean {
  if (typeof node === "boolean" || node == null) return false;
  if (typeof node !== "object" || Array.isArray(node)) return false;
  if (seen.has(node)) return false; // cycle: already being / been inspected
  if (depth > MAX_SCHEMA_DEPTH) return true;
  seen.add(node);
  const n = node as Record<string, unknown>;
  if (typeof n.format === "string" && HIGH_RISK_FORMATS.has(n.format)) return true;
  for (const refKey of ["$ref", "$dynamicRef", "$recursiveRef"] as const) {
    const ref = n[refKey];
    if (ref === undefined) continue;
    if (typeof ref !== "string") return true;
    const target = resolveLocalRef(root, ref);
    if (target === undefined) return true;
    if (subschemaIsHighRisk(root, target, depth + 1, seen)) return true;
  }
  const next = (c: unknown) => subschemaIsHighRisk(root, c, depth + 1, seen);
  for (const k of SUBSCHEMA_KEYS) if (n[k] !== undefined && !Array.isArray(n[k]) && next(n[k])) return true;
  for (const k of SUBSCHEMA_LIST_KEYS) {
    const list = n[k];
    if (Array.isArray(list)) for (const c of list) if (next(c)) return true;
  }
  for (const k of SUBSCHEMA_MAP_KEYS) {
    const map = n[k];
    if (map && typeof map === "object" && !Array.isArray(map)) for (const c of Object.values(map)) if (next(c)) return true;
  }
  const deps = n.dependencies;
  if (deps && typeof deps === "object" && !Array.isArray(deps)) {
    for (const c of Object.values(deps)) if (!Array.isArray(c) && next(c)) return true;
  }
  return false;
}

/**
 * True when the key's schema, or ANY nested subschema of it (properties,
 * items, combinators at any depth, `$ref` targets, if/then/else, not, ...),
 * declares a URL or secret-ref format. Unresolvable `$ref` or excessive depth
 * is treated as high-risk (fail-closed).
 */
export function isHighRiskConfigKey(schema: SchemaLike, key: string): boolean {
  const prop = propertySchema(schema, key);
  if (!prop) return false;
  return subschemaIsHighRisk(schema, prop, 0, new Set());
}

/** Override keys the manifest does not declare tenant-scoped. */
export function nonTenantOverrideKeys(schema: SchemaLike, overrides: Record<string, unknown>): string[] {
  return Object.keys(overrides).filter((k) => !isTenantScopedConfigKey(schema, k));
}

/** Override keys that need instance-admin authority. */
export function highRiskOverrideKeys(schema: SchemaLike, overrides: Record<string, unknown>): string[] {
  return Object.keys(overrides).filter((k) => isHighRiskConfigKey(schema, k));
}

/**
 * Merge-time filter: keep only tenant-scoped override keys. A row written
 * before the write gate existed can therefore never shadow an operator key.
 */
export function filterOverrideToTenantScope(
  schema: SchemaLike,
  overrides: Record<string, unknown>,
): { kept: Record<string, unknown>; dropped: string[] } {
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(overrides)) {
    if (isTenantScopedConfigKey(schema, k)) kept[k] = v;
    else dropped.push(k);
  }
  return { kept, dropped };
}
