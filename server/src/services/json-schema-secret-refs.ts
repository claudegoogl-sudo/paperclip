const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidSecretRef(value: string): boolean {
  return UUID_RE.test(value);
}

export function collectSecretRefPaths(
  schema: Record<string, unknown> | null | undefined,
): Set<string> {
  const paths = new Set<string>();
  if (!schema || typeof schema !== "object") return paths;

  function walk(node: Record<string, unknown>, prefix: string): void {
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        if (!branch || typeof branch !== "object" || Array.isArray(branch)) continue;
        walk(branch as Record<string, unknown>, prefix);
      }
    }

    const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
    if (!properties || typeof properties !== "object") return;
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!propertySchema || typeof propertySchema !== "object") continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (propertySchema.format === "secret-ref") {
        paths.add(path);
      }
      walk(propertySchema, path);
    }
  }

  walk(schema, "");
  return paths;
}

export function readConfigValueAtPath(
  config: Record<string, unknown>,
  dotPath: string,
): unknown {
  let current: unknown = config;
  for (const key of dotPath.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function writeConfigValueAtPath(
  config: Record<string, unknown>,
  dotPath: string,
  value: unknown,
): Record<string, unknown> {
  const result = structuredClone(config) as Record<string, unknown>;
  const keys = dotPath.split(".");
  let cursor: Record<string, unknown> = result;

  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index]!;
    const next = cursor[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }

  const leafKey = keys[keys.length - 1]!;
  if (value === undefined) {
    delete cursor[leafKey];
  } else {
    cursor[leafKey] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// PLA-1944 / PLA-1957: canonical (key-order-independent) structural equality.
// This is the ONE comparator shared by the no-dispatch `config.get` agreement
// gate (`plugin-host-services.ts` `getAgreedOrDeny`) and the admin write-path
// guard (PLA-1957) that defends the same invariant on write. Do not fork a
// second comparator — both sides must agree on what "diverge" means or the
// guard and the gate drift out of sync with each other.
// ---------------------------------------------------------------------------

export function canonicalizeForComparison(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForComparison);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalizeForComparison((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function structurallyEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalizeForComparison(a)) === JSON.stringify(canonicalizeForComparison(b));
}

/** Strip every declared secret-ref path from a config object (delete, not null). */
export function stripSecretRefPaths(
  config: Record<string, unknown>,
  secretRefPaths: Set<string>,
): Record<string, unknown> {
  let result = config;
  for (const path of secretRefPaths) {
    result = writeConfigValueAtPath(result, path, undefined);
  }
  return result;
}

/**
 * Layer `sourceConfig`'s values at each declared secret-ref path back onto
 * `strippedConfig`. Used to preserve a non-target company's own secret-ref
 * values when fanning out a non-secret config change to its row.
 */
export function restoreSecretRefPaths(
  strippedConfig: Record<string, unknown>,
  sourceConfig: Record<string, unknown>,
  secretRefPaths: Set<string>,
): Record<string, unknown> {
  let result = strippedConfig;
  for (const path of secretRefPaths) {
    const value = readConfigValueAtPath(sourceConfig, path);
    if (value !== undefined) {
      result = writeConfigValueAtPath(result, path, value);
    }
  }
  return result;
}

/** Top-level keys at which the given (already-comparable) configs disagree. */
export function computeDivergingTopLevelKeys(configs: Record<string, unknown>[]): string[] {
  const divergingKeys = new Set<string>();
  const keyUnion = new Set<string>();
  for (const config of configs) {
    for (const key of Object.keys(config)) keyUnion.add(key);
  }
  for (const key of keyUnion) {
    const values = configs.map((config) => config[key]);
    const [firstValue, ...restValues] = values;
    if (!restValues.every((value) => structurallyEqual(value, firstValue))) {
      divergingKeys.add(key);
    }
  }
  return [...divergingKeys];
}
