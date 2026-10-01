/**
 * Model-selection keys an agent holding only `agents:configure-model` may
 * change on another agent in its company. This list is the single source of
 * truth: the server route and the docs both read it from here.
 */
export const AGENT_MODEL_CONFIG_KEYS = [
  "model",
  "thinking",
  "effort",
  "modelReasoningEffort",
  "variant",
] as const;
export type AgentModelConfigKey = (typeof AGENT_MODEL_CONFIG_KEYS)[number];

const AGENT_MODEL_CONFIG_KEY_SET: ReadonlySet<string> = new Set(AGENT_MODEL_CONFIG_KEYS);

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * True only when the PATCH body is exactly `{ adapterConfig: { ... } }`, the
 * adapterConfig object is non-empty, every key is a model-selection key, and
 * every value is a scalar. Any other top-level field (including
 * `replaceAdapterConfig`) makes the patch NOT model-only.
 */
export function isModelOnlyAgentPatch(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const topKeys = Object.keys(body);
  if (topKeys.length !== 1 || topKeys[0] !== "adapterConfig") return false;
  const adapterConfig = (body as Record<string, unknown>).adapterConfig;
  if (!adapterConfig || typeof adapterConfig !== "object" || Array.isArray(adapterConfig)) return false;
  const entries = Object.entries(adapterConfig as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(([key, value]) => AGENT_MODEL_CONFIG_KEY_SET.has(key) && isScalar(value));
}
