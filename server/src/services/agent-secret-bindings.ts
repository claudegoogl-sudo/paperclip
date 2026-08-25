import { envBindingSchema, type SecretVersionSelector } from "@paperclipai/shared";

interface AgentSecretBindingSyncService {
  syncSecretRefsForTarget?: (
    companyId: string,
    target: { targetType: "agent"; targetId: string },
    refs: Array<{
      secretId: string;
      configPath: string;
      versionSelector?: SecretVersionSelector;
      required?: boolean;
      label?: string | null;
    }>,
    options?: { replaceAll?: boolean },
  ) => Promise<unknown>;
  syncEnvBindingsForTarget?: (
    companyId: string,
    target: { targetType: "agent"; targetId: string; pathPrefix?: string },
    envValue: unknown,
  ) => Promise<unknown>;
  syncUserSecretDeclarationsForTarget?: (
    companyId: string,
    target: { targetType: "agent"; targetId: string; pathPrefix?: string },
    refs: Array<{
      definitionKey: string;
      configPath: string;
      envKey: string;
      versionSelector?: SecretVersionSelector;
      required?: boolean;
      allowMissingOverride?: boolean;
      label?: string | null;
    }>,
    options?: { replaceAll?: boolean },
  ) => Promise<unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function collectSecretRefs(adapterConfig: unknown): Array<{
  secretId: string;
  configPath: string;
  versionSelector?: SecretVersionSelector;
}> {
  const config = asRecord(adapterConfig);
  if (!config) return [];
  const refs: Array<{
    secretId: string;
    configPath: string;
    versionSelector?: SecretVersionSelector;
  }> = [];

  const envValue = asRecord(config.env);
  for (const [key, rawBinding] of Object.entries(envValue ?? {})) {
    const parsed = envBindingSchema.safeParse(rawBinding);
    if (!parsed.success) continue;
    const binding = parsed.data;
    if (typeof binding !== "object" || binding === null || binding.type !== "secret_ref") continue;
    refs.push({
      secretId: binding.secretId,
      configPath: `env.${key}`,
      versionSelector: binding.version ?? "latest",
    });
  }

  for (const [key, rawBinding] of Object.entries(config)) {
    if (key === "env") continue;
    const parsed = envBindingSchema.safeParse(rawBinding);
    if (!parsed.success) continue;
    const binding = parsed.data;
    if (typeof binding !== "object" || binding === null || binding.type !== "secret_ref") continue;
    refs.push({
      secretId: binding.secretId,
      configPath: key,
      versionSelector: binding.version ?? "latest",
    });
  }

  return refs;
}

function collectUserSecretRefs(adapterConfig: unknown): Array<{
  definitionKey: string;
  configPath: string;
  envKey: string;
  versionSelector?: SecretVersionSelector;
  required?: boolean;
  allowMissingOverride?: boolean;
}> {
  const config = asRecord(adapterConfig);
  if (!config) return [];
  const refs: Array<{
    definitionKey: string;
    configPath: string;
    envKey: string;
    versionSelector?: SecretVersionSelector;
    required?: boolean;
    allowMissingOverride?: boolean;
  }> = [];

  const envValue = asRecord(config.env);
  for (const [key, rawBinding] of Object.entries(envValue ?? {})) {
    const parsed = envBindingSchema.safeParse(rawBinding);
    if (!parsed.success) continue;
    const binding = parsed.data;
    if (typeof binding !== "object" || binding === null || binding.type !== "user_secret_ref") continue;
    refs.push({
      definitionKey: binding.key,
      configPath: `env.${key}`,
      envKey: key,
      versionSelector: binding.version ?? "latest",
      required: binding.required ?? true,
      allowMissingOverride: binding.allowMissingOverride ?? false,
    });
  }

  for (const [key, rawBinding] of Object.entries(config)) {
    if (key === "env") continue;
    const parsed = envBindingSchema.safeParse(rawBinding);
    if (!parsed.success) continue;
    const binding = parsed.data;
    if (typeof binding !== "object" || binding === null || binding.type !== "user_secret_ref") continue;
    refs.push({
      definitionKey: binding.key,
      configPath: key,
      envKey: key,
      versionSelector: binding.version ?? "latest",
      required: binding.required ?? true,
      allowMissingOverride: binding.allowMissingOverride ?? false,
    });
  }

  return refs;
}

/**
 * Config paths of `previousRefs` that `incomingConfig` does not explicitly
 * address. A path `env.K` is addressed when the incoming config carries an env
 * object containing key K (whatever the value); a top-level path `K` is
 * addressed when the incoming config contains key K.
 *
 * This distinguishes an explicit decommission (`{type:"secret_ref"}` rewritten
 * to a plain value on the SAME key — key still present) from a config form that
 * silently dropped `env` altogether (`env: {}` / missing — key absent). The two
 * are indistinguishable from the ref list alone, so we key on presence.
 */
function unaddressedSecretRefConfigPaths(
  previousRefs: Array<{ configPath: string }>,
  incomingConfig: unknown,
): string[] {
  const config = asRecord(incomingConfig);
  const env = asRecord(config?.env);
  const unaddressed: string[] = [];
  for (const ref of previousRefs) {
    if (ref.configPath.startsWith("env.")) {
      const key = ref.configPath.slice("env.".length);
      if (!env || !(key in env)) unaddressed.push(ref.configPath);
    } else if (!config || !(ref.configPath in config)) {
      unaddressed.push(ref.configPath);
    }
  }
  return unaddressed;
}

/**
 * Reconcile an agent's secret bindings with its (already-persisted) adapter
 * config. When `previousAdapterConfig` is supplied (agent update path) and the
 * incoming config yields zero refs while the previous config still referenced
 * secrets at paths the incoming config does not explicitly address, the
 * delete-and-reinsert reconcile is SKIPPED for those families: server-side we
 * cannot tell "the form dropped env" from "the user removed the only secret
 * key", and a stale binding row is far cheaper than a silently bricked agent.
 * The refused paths are returned so the caller can emit an activity event.
 */
export async function syncAgentAdapterEnvBindings(input: {
  secretsSvc: AgentSecretBindingSyncService;
  companyId: string;
  agentId: string;
  adapterConfig: unknown;
  previousAdapterConfig?: unknown;
}): Promise<{ refusedConfigPaths: string[] }> {
  const incomingRefs = collectSecretRefs(input.adapterConfig);
  const incomingUserRefs = collectUserSecretRefs(input.adapterConfig);

  // Each family is guarded independently so a legitimate rewrite of one family
  // does not block the reconcile of the other.
  const previousRefs = collectSecretRefs(input.previousAdapterConfig);
  const previousUserRefs = collectUserSecretRefs(input.previousAdapterConfig);
  const unaddressedRefs =
    input.previousAdapterConfig !== undefined && incomingRefs.length === 0
      ? unaddressedSecretRefConfigPaths(previousRefs, input.adapterConfig)
      : [];
  const unaddressedUserRefs =
    input.previousAdapterConfig !== undefined && incomingUserRefs.length === 0
      ? unaddressedSecretRefConfigPaths(previousUserRefs, input.adapterConfig)
      : [];
  const refuseSecretRefs = unaddressedRefs.length > 0;
  const refuseUserDeclarations = unaddressedUserRefs.length > 0;
  const refusedConfigPaths = [...unaddressedRefs, ...unaddressedUserRefs];

  if (input.secretsSvc.syncSecretRefsForTarget) {
    if (!refuseSecretRefs) {
      await input.secretsSvc.syncSecretRefsForTarget(
        input.companyId,
        { targetType: "agent", targetId: input.agentId },
        incomingRefs,
        { replaceAll: true },
      );
    }
    if (!refuseUserDeclarations) {
      await input.secretsSvc.syncUserSecretDeclarationsForTarget?.(
        input.companyId,
        { targetType: "agent", targetId: input.agentId },
        incomingUserRefs,
        { replaceAll: true },
      );
    }
    return { refusedConfigPaths };
  }
  if (!refuseSecretRefs && !refuseUserDeclarations) {
    const envValue = asRecord(asRecord(input.adapterConfig)?.env);
    await input.secretsSvc.syncEnvBindingsForTarget?.(
      input.companyId,
      { targetType: "agent", targetId: input.agentId },
      envValue,
    );
  }
  return { refusedConfigPaths };
}
