const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidSecretRef(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Produce a redacted, log-safe descriptor for an arbitrary secret-ref input.
 *
 * Caller-controlled values may be secret-shaped (e.g. a raw GitHub PAT
 * mistakenly placed in a `format: "secret-ref"` slot). To prevent those values
 * from being echoed into log lines, error messages, or audit comments, this
 * helper never returns the raw input. It returns one of:
 *
 *   - `kind=undefined` / `kind=null`
 *   - `kind=non-string type=<typeof>`
 *   - `kind=empty`
 *   - `kind=whitespace len=<N>`
 *   - `kind=uuid value=<uuid>`  (UUID-shaped refs are the legitimate format
 *     and are safe to echo back; they are not secret material.)
 *   - `kind=opaque len=<N>`     (everything else — redacts secret-shaped input.)
 *
 * @see PLA-190 — host `secrets.resolve` rejected raw input echo defect.
 * @see PLA-198 — caller-side secret-ref validation with field-path context.
 */
export function describeSecretRefValue(value: unknown): string {
  if (value === undefined) return "kind=undefined";
  if (value === null) return "kind=null";
  if (typeof value !== "string") return `kind=non-string type=${typeof value}`;
  if (value.length === 0) return "kind=empty";
  const trimmed = value.trim();
  if (trimmed.length === 0) return `kind=whitespace len=${value.length}`;
  if (isUuidSecretRef(trimmed)) return `kind=uuid value=${trimmed}`;
  return `kind=opaque len=${value.length}`;
}

/**
 * Structured error raised when a `format: "secret-ref"` slot in a plugin or
 * environment config holds a value that is not a UUID-shaped secret ref.
 *
 * The message is `path=<dot.path> <descriptor>` — never the raw value. The
 * `path` field identifies the offending slot so operators can correct the
 * config without diffing it against the schema. Callers that surface this
 * error to API responses, logs, metric tags, or audit comments must continue
 * to use only `error.message` (or the explicit `path`/`descriptor` fields) —
 * never `error.cause` or any other field that might re-introduce the value.
 *
 * @see PLA-198 AC1, AC2 — caller-side path-aware validation.
 */
export class InvalidSecretRefAtPathError extends Error {
  public readonly path: string;
  public readonly descriptor: string;

  constructor(path: string, descriptor: string) {
    super(`path=${path} ${descriptor}`);
    this.name = "InvalidSecretRefAtPathError";
    this.path = path;
    this.descriptor = descriptor;
  }
}

/**
 * Walk every `format: "secret-ref"` path declared by `schema` and validate
 * the corresponding values in `configJson`. Returns the set of UUID-shaped
 * secret refs encountered; throws {@link InvalidSecretRefAtPathError} on the
 * first slot whose value is a non-empty string that does not match the UUID
 * sentinel shape (or any non-string non-nullish value).
 *
 * Empty / whitespace / undefined / null values at secret-ref paths are
 * treated as "not set" and silently skipped — they round-trip through
 * persistence without being interpreted as secrets and the caller can later
 * decide whether the slot is required via standard JSON Schema validation.
 *
 * The returned UUID set is suitable for scope-checking incoming
 * `secrets.resolve` calls.
 *
 * @see PLA-198 AC1 — emit structured InvalidSecretRefAtPath at extraction.
 */
export function validateSecretRefsAtPaths(
  configJson: unknown,
  schema: Record<string, unknown> | null | undefined,
): Set<string> {
  const refs = new Set<string>();
  if (configJson == null || typeof configJson !== "object" || Array.isArray(configJson)) {
    return refs;
  }
  const config = configJson as Record<string, unknown>;
  for (const dotPath of collectSecretRefPaths(schema)) {
    const value = readConfigValueAtPath(config, dotPath);

    // Treat unset / blank as "no ref configured" — JSON Schema `required`
    // is the right tool to enforce presence.
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      if (value.length === 0) continue;
      const trimmed = value.trim();
      if (trimmed.length === 0) continue;
      if (isUuidSecretRef(trimmed)) {
        refs.add(trimmed);
        continue;
      }
    }

    throw new InvalidSecretRefAtPathError(dotPath, describeSecretRefValue(value));
  }
  return refs;
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
