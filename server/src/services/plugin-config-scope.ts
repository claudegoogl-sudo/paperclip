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

/** True when the key's schema declares a URL or secret-ref format. */
export function isHighRiskConfigKey(schema: SchemaLike, key: string): boolean {
  const prop = propertySchema(schema, key);
  if (!prop) return false;
  const formats = [prop.format];
  for (const branch of ["oneOf", "anyOf", "allOf"] as const) {
    const list = prop[branch];
    if (Array.isArray(list)) for (const b of list) if (b && typeof b === "object") formats.push((b as Record<string, unknown>).format);
  }
  return formats.some((f) => typeof f === "string" && HIGH_RISK_FORMATS.has(f));
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
