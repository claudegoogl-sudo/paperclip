/**
 * In-memory registry of currently-dispatching tool invocations, keyed by
 * `(pluginDbId, runId)`. This is the host's authoritative source-of-truth
 * for "who is the dispatching agent for this in-flight tool call".
 *
 * PLA-574: A plugin worker is NOT trusted to assert dispatching-agent identity.
 * When the host hands a tool call to a worker, it first registers the agent's
 * runContext here. When the worker calls back via `artifacts.fetch`, the host
 * looks up the entry by `(pluginDbId, runId)` and uses the **registered**
 * runContext — never the values from the worker — to authorize.
 *
 * Entries are removed in the `finally` of the dispatch path. A TTL sweep is
 * provided as a safety net for orphans (e.g. worker crash mid-call); the
 * default TTL is intentionally generous (5 minutes) because rate-limiting
 * provides the abuse cap, and the registry only protects against forged
 * runIds, not slow tools.
 */

/**
 * A run-context backing a tool/action dispatch. The dispatching agent's
 * identity is server-validated and used to authorize worker→host callbacks.
 */
export interface RegisteredDispatchRunContext {
  /** Discriminator. Absent is treated as `"dispatch"` for back-compat. */
  kind?: "dispatch";
  /** UUID of the dispatching agent (server-validated). */
  agentId: string;
  /** UUID of the dispatching agent's company (server-validated). */
  companyId: string;
  /** UUID of the dispatching agent's run. */
  runId: string;
  /** UUID of the dispatching agent's project. */
  projectId: string;
  /** Tool the worker was asked to execute (for audit-log context). */
  toolName: string;
  /** Wall-clock when the entry was added (for TTL sweep). */
  registeredAt: number;
}

/**
 * PLA-768: a worker-lifetime **service** run-context. It backs background
 * plugin dispatches (`onEvent`/`onWebhook`/`runJob`) and loops started in
 * `setup()` that call `ctx.secrets.resolve` outside any dispatch. There is NO
 * dispatching agent or company: it is a system actor (`actorType: "plugin"`).
 * The secrets handler derives the dispatching company from the operator-created
 * secret binding — never from this entry — so a service context grants no
 * broader access than the plugin's own bindings. Unlike dispatch entries it is
 * exempt from the TTL sweep (a poll loop may run for hours) and is removed
 * explicitly when the worker stops/exits.
 */
export interface RegisteredServiceRunContext {
  kind: "service";
  /** Host-minted, worker-lifetime run UUID (never worker-supplied). */
  runId: string;
  /** Wall-clock when the entry was added. */
  registeredAt: number;
}

export type RegisteredRunContext =
  | RegisteredDispatchRunContext
  | RegisteredServiceRunContext;

export interface PluginRunContextRegistry {
  register(pluginDbId: string, ctx: RegisteredDispatchRunContext): void;
  /**
   * PLA-768: register a worker-lifetime service run-context (system actor).
   * Idempotent for a given `(pluginDbId, runId)`.
   */
  registerService(pluginDbId: string, runId: string): void;
  get(pluginDbId: string, runId: string): RegisteredRunContext | null;
  deregister(pluginDbId: string, runId: string): void;
  /** Test/diagnostic. Returns the number of live entries. */
  size(): number;
  /** Stops the sweep timer (for test teardown). */
  dispose(): void;
}

export interface CreateRegistryOptions {
  /** Override the entry TTL in ms. Default: 5 minutes. */
  ttlMs?: number;
  /** Override the sweep interval in ms. Default: 60s. */
  sweepIntervalMs?: number;
  /** Inject a clock for tests. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_SWEEP_MS = 60 * 1_000;

export function createPluginRunContextRegistry(
  opts: CreateRegistryOptions = {},
): PluginRunContextRegistry {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const sweepMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, RegisteredRunContext>();

  const compositeKey = (pluginDbId: string, runId: string) =>
    `${pluginDbId}:${runId}`;

  const sweep = () => {
    const cutoff = now() - ttlMs;
    for (const [key, value] of entries) {
      // PLA-768: service entries are worker-lifetime (a poll loop may run for
      // hours) and removed explicitly on worker stop — never TTL-swept.
      if (value.kind === "service") continue;
      if (value.registeredAt < cutoff) {
        entries.delete(key);
      }
    }
  };

  const timer = setInterval(sweep, sweepMs);
  // Don't keep the process alive just for the sweep timer.
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }

  return {
    register(pluginDbId, ctx) {
      entries.set(compositeKey(pluginDbId, ctx.runId), ctx);
    },
    registerService(pluginDbId, runId) {
      entries.set(compositeKey(pluginDbId, runId), {
        kind: "service",
        runId,
        registeredAt: now(),
      });
    },
    get(pluginDbId, runId) {
      const entry = entries.get(compositeKey(pluginDbId, runId));
      if (!entry) return null;
      // Guard against orphaned dispatch entries that survived past TTL between
      // sweeps. Service entries are worker-lifetime — never TTL-expired here.
      if (entry.kind !== "service" && entry.registeredAt < now() - ttlMs) {
        entries.delete(compositeKey(pluginDbId, runId));
        return null;
      }
      return entry;
    },
    deregister(pluginDbId, runId) {
      entries.delete(compositeKey(pluginDbId, runId));
    },
    size() {
      return entries.size;
    },
    dispose() {
      clearInterval(timer);
      entries.clear();
    },
  };
}
