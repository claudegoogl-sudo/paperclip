/**
 * PluginToolRegistry — host-side registry for plugin-contributed agent tools.
 *
 * Responsibilities:
 * - Store tool declarations (from plugin manifests) alongside routing metadata
 *   so the host can resolve namespaced tool names to the owning plugin worker.
 * - Namespace tools automatically: a tool `"search-issues"` from plugin
 *   `"acme.linear"` is exposed to agents as `"acme.linear:search-issues"`.
 * - Route `executeTool` calls to the correct plugin worker via the
 *   `PluginWorkerManager`.
 * - Provide tool discovery queries so agents can list available tools.
 * - Clean up tool registrations when a plugin is unloaded or its worker stops.
 *
 * The registry is an in-memory structure — tool declarations are derived from
 * the plugin manifest at load time and do not need persistence. When a plugin
 * worker restarts, the host re-registers its manifest tools.
 *
 * @see PLUGIN_SPEC.md §11 — Agent Tools
 * @see PLUGIN_SPEC.md §13.10 — `executeTool`
 */

import type {
  PaperclipPluginManifestV1,
  PluginToolDeclaration,
} from "@paperclipai/shared";
import type { ToolRunContext, ToolResult, ExecuteToolParams } from "@paperclipai/plugin-sdk";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { PluginRunContextRegistry } from "./plugin-run-context-registry.js";
import { logger } from "../middleware/logger.js";
import {
  collectHandleTokens,
  getHandleRecord,
  substituteHandles,
  UnresolvedHandleError,
} from "../handle-vault.js";
import {
  decideEgress,
  EgressNotAllowedError,
  formatOrigin,
  getHostMediatedEgress,
  type HandleEgressCapture,
} from "../handle-egress.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Separator between plugin ID and tool name in the namespaced tool identifier.
 *
 * Example: `"acme.linear:search-issues"`
 */
export const TOOL_NAMESPACE_SEPARATOR = ":";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A registered tool entry stored in the registry.
 *
 * Combines the manifest-level declaration with routing metadata so the host
 * can resolve a namespaced tool name → plugin worker in O(1).
 */
export interface RegisteredTool {
  /** The plugin key used for namespacing (e.g. `"acme.linear"`). */
  pluginId: string;
  /**
   * The plugin's database UUID, used for worker routing and availability
   * checks. Falls back to `pluginId` when not provided (e.g. in tests
   * where `id === pluginKey`).
   */
  pluginDbId: string;
  /** The tool's bare name (without namespace prefix). */
  name: string;
  /** Fully namespaced identifier: `"<pluginId>:<toolName>"`. */
  namespacedName: string;
  /** Human-readable display name. */
  displayName: string;
  /** Description provided to the agent so it knows when to use this tool. */
  description: string;
  /** JSON Schema describing the tool's input parameters. */
  parametersSchema: Record<string, unknown>;
}

/**
 * Filter criteria for listing available tools.
 */
export interface ToolListFilter {
  /** Only return tools owned by this plugin. */
  pluginId?: string;
}

/**
 * Result of executing a tool, extending `ToolResult` with routing metadata.
 */
export interface ToolExecutionResult {
  /** The plugin that handled the tool call. */
  pluginId: string;
  /** The bare tool name that was executed. */
  toolName: string;
  /** The result returned by the plugin's tool handler. */
  result: ToolResult;
}

/**
 * PLA-734 — sink for would-deny egress observations. The chokepoint computes the
 * NORMALIZED origin (scheme+host+port — never a raw URL) and the deduped, non-null
 * bindings of a would-deny call and hands them off here fire-and-forget. The sink
 * owns persistence + its own error isolation: harvesting MUST NOT affect the
 * dispatch it rides on. In production this is backed by `recordEgressWouldDeny`;
 * tests inject a fake to assert the chokepoint only ever emits parser output.
 */
export type EgressHarvestSink = (observation: {
  companyId: string;
  bindingIds: string[];
  origin: string;
}) => void;

// ---------------------------------------------------------------------------
// PluginToolRegistry interface
// ---------------------------------------------------------------------------

/**
 * The host-side tool registry — held by the host process.
 *
 * Created once at server startup and shared across the application. Plugins
 * register their tools when their worker starts, and unregister when the
 * worker stops or the plugin is uninstalled.
 */
export interface PluginToolRegistry {
  /**
   * Register all tools declared in a plugin's manifest.
   *
   * Called when a plugin worker starts and its manifest is loaded. Any
   * previously registered tools for the same plugin are replaced (idempotent).
   *
   * @param pluginId - The plugin's unique identifier (e.g. `"acme.linear"`)
   * @param manifest - The plugin manifest containing the `tools` array
   * @param pluginDbId - The plugin's database UUID, used for worker routing
   *   and availability checks. If omitted, `pluginId` is used (backwards-compat).
   */
  registerPlugin(pluginId: string, manifest: PaperclipPluginManifestV1, pluginDbId?: string): void;

  /**
   * Remove all tool registrations for a plugin.
   *
   * Called when a plugin worker stops, crashes, or is uninstalled.
   *
   * @param pluginId - The plugin to clear
   */
  unregisterPlugin(pluginId: string): void;

  /**
   * Look up a registered tool by its namespaced name.
   *
   * @param namespacedName - Fully qualified name, e.g. `"acme.linear:search-issues"`
   * @returns The registered tool entry, or `null` if not found
   */
  getTool(namespacedName: string): RegisteredTool | null;

  /**
   * Look up a registered tool by plugin ID and bare tool name.
   *
   * @param pluginId - The owning plugin
   * @param toolName - The bare tool name (without namespace prefix)
   * @returns The registered tool entry, or `null` if not found
   */
  getToolByPlugin(pluginId: string, toolName: string): RegisteredTool | null;

  /**
   * List all registered tools, optionally filtered.
   *
   * @param filter - Optional filter criteria
   * @returns Array of registered tool entries
   */
  listTools(filter?: ToolListFilter): RegisteredTool[];

  /**
   * Parse a namespaced tool name into plugin ID and bare tool name.
   *
   * @param namespacedName - e.g. `"acme.linear:search-issues"`
   * @returns `{ pluginId, toolName }` or `null` if the format is invalid
   */
  parseNamespacedName(namespacedName: string): { pluginId: string; toolName: string } | null;

  /**
   * Build a namespaced tool name from a plugin ID and bare tool name.
   *
   * @param pluginId - e.g. `"acme.linear"`
   * @param toolName - e.g. `"search-issues"`
   * @returns The namespaced name, e.g. `"acme.linear:search-issues"`
   */
  buildNamespacedName(pluginId: string, toolName: string): string;

  /**
   * Execute a tool by its namespaced name, routing to the correct plugin worker.
   *
   * Resolves the namespaced name to the owning plugin, validates the tool
   * exists, and dispatches the `executeTool` RPC call to the worker.
   *
   * @param namespacedName - Fully qualified tool name (e.g. `"acme.linear:search-issues"`)
   * @param parameters - The parsed parameters matching the tool's schema
   * @param runContext - Agent run context
   * @returns The execution result with routing metadata
   * @throws {Error} if the tool is not found or the worker is not running
   */
  executeTool(
    namespacedName: string,
    parameters: unknown,
    runContext: ToolRunContext,
  ): Promise<ToolExecutionResult>;

  /**
   * Get the number of registered tools, optionally scoped to a plugin.
   *
   * @param pluginId - If provided, count only this plugin's tools
   */
  toolCount(pluginId?: string): number;
}

// ---------------------------------------------------------------------------
// Factory: createPluginToolRegistry
// ---------------------------------------------------------------------------

/**
 * Create a new `PluginToolRegistry`.
 *
 * The registry is backed by two in-memory maps:
 * - `byNamespace`: namespaced name → `RegisteredTool` for O(1) lookups.
 * - `byPlugin`: pluginId → Set of namespaced names for efficient per-plugin ops.
 *
 * @param workerManager - The worker manager used to dispatch `executeTool` RPC
 *   calls to plugin workers. If not provided, `executeTool` will throw.
 *
 * @example
 * ```ts
 * const toolRegistry = createPluginToolRegistry(workerManager);
 *
 * // Register tools from a plugin manifest
 * toolRegistry.registerPlugin("acme.linear", linearManifest);
 *
 * // List all available tools for agents
 * const tools = toolRegistry.listTools();
 * // → [{ namespacedName: "acme.linear:search-issues", ... }]
 *
 * // Execute a tool
 * const result = await toolRegistry.executeTool(
 *   "acme.linear:search-issues",
 *   { query: "auth bug" },
 *   { agentId: "agent-1", runId: "run-1", companyId: "co-1", projectId: "proj-1" },
 * );
 * ```
 */
export function createPluginToolRegistry(
  workerManager?: PluginWorkerManager,
  runContextRegistry?: PluginRunContextRegistry,
  egressHarvestSink?: EgressHarvestSink,
): PluginToolRegistry {
  const log = logger.child({ service: "plugin-tool-registry" });

  // Primary index: namespaced name → tool entry
  const byNamespace = new Map<string, RegisteredTool>();

  // Secondary index: pluginId → set of namespaced names (for bulk operations)
  const byPlugin = new Map<string, Set<string>>();

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  function buildName(pluginId: string, toolName: string): string {
    return `${pluginId}${TOOL_NAMESPACE_SEPARATOR}${toolName}`;
  }

  function parseName(namespacedName: string): { pluginId: string; toolName: string } | null {
    const sepIndex = namespacedName.lastIndexOf(TOOL_NAMESPACE_SEPARATOR);
    if (sepIndex <= 0 || sepIndex >= namespacedName.length - 1) {
      return null;
    }
    return {
      pluginId: namespacedName.slice(0, sepIndex),
      toolName: namespacedName.slice(sepIndex + 1),
    };
  }

  function addTool(pluginId: string, decl: PluginToolDeclaration, pluginDbId: string): void {
    const namespacedName = buildName(pluginId, decl.name);

    const entry: RegisteredTool = {
      pluginId,
      pluginDbId,
      name: decl.name,
      namespacedName,
      displayName: decl.displayName,
      description: decl.description,
      parametersSchema: decl.parametersSchema,
    };

    byNamespace.set(namespacedName, entry);

    let pluginTools = byPlugin.get(pluginId);
    if (!pluginTools) {
      pluginTools = new Set();
      byPlugin.set(pluginId, pluginTools);
    }
    pluginTools.add(namespacedName);
  }

  function removePluginTools(pluginId: string): number {
    const pluginTools = byPlugin.get(pluginId);
    if (!pluginTools) return 0;

    const count = pluginTools.size;
    for (const name of pluginTools) {
      byNamespace.delete(name);
    }
    byPlugin.delete(pluginId);

    return count;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    registerPlugin(pluginId: string, manifest: PaperclipPluginManifestV1, pluginDbId?: string): void {
      const dbId = pluginDbId ?? pluginId;

      // Remove any previously registered tools for this plugin (idempotent)
      const previousCount = removePluginTools(pluginId);
      if (previousCount > 0) {
        log.debug(
          { pluginId, previousCount },
          "cleared previous tool registrations before re-registering",
        );
      }

      const tools = manifest.tools ?? [];
      if (tools.length === 0) {
        log.debug({ pluginId }, "plugin declares no tools");
        return;
      }

      for (const decl of tools) {
        addTool(pluginId, decl, dbId);
      }

      log.info(
        {
          pluginId,
          toolCount: tools.length,
          tools: tools.map((t) => buildName(pluginId, t.name)),
        },
        `registered ${tools.length} tool(s) for plugin`,
      );
    },

    unregisterPlugin(pluginId: string): void {
      const removed = removePluginTools(pluginId);
      if (removed > 0) {
        log.info(
          { pluginId, removedCount: removed },
          `unregistered ${removed} tool(s) for plugin`,
        );
      }
    },

    getTool(namespacedName: string): RegisteredTool | null {
      return byNamespace.get(namespacedName) ?? null;
    },

    getToolByPlugin(pluginId: string, toolName: string): RegisteredTool | null {
      const namespacedName = buildName(pluginId, toolName);
      return byNamespace.get(namespacedName) ?? null;
    },

    listTools(filter?: ToolListFilter): RegisteredTool[] {
      if (filter?.pluginId) {
        const pluginTools = byPlugin.get(filter.pluginId);
        if (!pluginTools) return [];
        const result: RegisteredTool[] = [];
        for (const name of pluginTools) {
          const tool = byNamespace.get(name);
          if (tool) result.push(tool);
        }
        return result;
      }

      return Array.from(byNamespace.values());
    },

    parseNamespacedName(namespacedName: string): { pluginId: string; toolName: string } | null {
      return parseName(namespacedName);
    },

    buildNamespacedName(pluginId: string, toolName: string): string {
      return buildName(pluginId, toolName);
    },

    async executeTool(
      namespacedName: string,
      parameters: unknown,
      runContext: ToolRunContext,
    ): Promise<ToolExecutionResult> {
      // 1. Resolve the namespaced name
      const parsed = parseName(namespacedName);
      if (!parsed) {
        throw new Error(
          `Invalid tool name "${namespacedName}". Expected format: "<pluginId>${TOOL_NAMESPACE_SEPARATOR}<toolName>"`,
        );
      }

      const { pluginId, toolName } = parsed;

      // 2. Verify the tool is registered
      const tool = byNamespace.get(namespacedName);
      if (!tool) {
        throw new Error(
          `Tool "${namespacedName}" is not registered. ` +
          `The plugin may not be installed or its worker may not be running.`,
        );
      }

      // 3. Verify the worker manager is available
      if (!workerManager) {
        throw new Error(
          `Cannot execute tool "${namespacedName}" — no worker manager configured. ` +
          `Tool execution requires a PluginWorkerManager.`,
        );
      }

      // 4. Verify the plugin worker is running (use DB UUID for worker lookup)
      const dbId = tool.pluginDbId;
      if (!workerManager.isRunning(dbId)) {
        throw new Error(
          `Cannot execute tool "${namespacedName}" — ` +
          `worker for plugin "${pluginId}" is not running.`,
        );
      }

      // 5. Dispatch the executeTool RPC call to the worker
      log.debug(
        { pluginId, pluginDbId: dbId, toolName, namespacedName, agentId: runContext.agentId, runId: runContext.runId },
        "executing tool via plugin worker",
      );

      // PLA-702 Control 2 — borrowed-handle egress substitution chokepoint.
      //
      // This is the STRUCTURAL chokepoint (RC5 placement): every plugin tool
      // dispatch routes through here, including the `getRegistry()` escape
      // hatch that bypasses the higher-level dispatcher. Before handing the
      // parameters to the worker we replace any borrowed-handle substrings with
      // the plaintext borrowed for THIS run (keyed by the host's own
      // `runContext.runId`, never a handle-embedded run id — RC3), so the
      // executing tool sees the real secret while the transcript / persisted
      // call record keeps the opaque handle.
      //
      // The substitution is on a throwaway deep copy (RC4): `parameters` — the
      // handle-bearing object the caller persists and audits — is never
      // mutated. A handle-shaped token that does not resolve in this run's
      // vault (foreign / expired / forged) aborts the call fail-closed (RC5);
      // a literal `vault-handle://` must never leave the host outbound.
      //
      // PLA-723 Control-2 residual — per-binding egress allowlist. The
      // destination decision runs BEFORE any plaintext substitution (EG5): we
      // enumerate the borrowed handles present in the RAW parameters and check
      // each handle's OWN captured allowlist against the call's declared,
      // host-mediated destination. A non-host-mediated tool (EG1), an
      // undeterminable destination, or any enforced handle whose allowlist
      // excludes the destination aborts the whole call fail-closed — the
      // handle is never resolved to plaintext and the worker is never invoked.
      let dispatchParameters: unknown;
      try {
        const handleTokens = collectHandleTokens(parameters);
        if (handleTokens.length > 0) {
          // Resolve each handle's metadata (NOT its plaintext) for the decision.
          // A token unresolvable in this run (foreign/expired/forged) fails
          // closed exactly as before (RC5).
          const captures: HandleEgressCapture[] = handleTokens.map((handle) => {
            const record = getHandleRecord(runContext.runId, handle);
            if (!record) throw new UnresolvedHandleError(handle);
            return {
              handle,
              allowedEgress: record.allowedEgress,
              enforced: record.enforced,
              bindingId: record.bindingId,
              unmediatedOptInTools: record.unmediatedOptInTools,
            };
          });

          const decision = decideEgress({
            namespacedName,
            descriptor: getHostMediatedEgress(namespacedName),
            rawParameters: parameters,
            handles: captures,
          });

          if (!decision.allow) {
            throw new EgressNotAllowedError(decision.reason, decision.destination);
          }
          // Log-only migration bindings (EG4): record would-deny, do not block.
          if (decision.wouldDeny.length > 0) {
            log.warn(
              {
                pluginId,
                toolName,
                namespacedName,
                runId: runContext.runId,
                // attacker-influenced — logged as data only, never eval'd (EG6).
                destination: decision.destination,
                wouldDenyBindings: decision.wouldDeny.map((h) => h.bindingId),
                action: "secret.egress_would_deny",
              },
              "egress would be denied under enforcement; binding is in log-only mode",
            );

            // PLA-734 (option b) — persist a queryable would-deny observation so
            // operators can seed this binding's allowlist before the enforce-flip.
            // We persist the NORMALIZED origin only (scheme+host+port, via the
            // egress parser that already produced `decision.origin`); a non-`ok`
            // / null origin — a non-host-mediated or undeterminable destination —
            // is dropped, never stored, because only path/query-free parser output
            // is safe to keep (it cannot carry tokens/PII). Fire-and-forget: a
            // harvest failure must never break the dispatch it rides on.
            if (egressHarvestSink) {
              const origin = formatOrigin(decision.origin);
              if (origin) {
                const bindingIds = [
                  ...new Set(
                    decision.wouldDeny
                      .map((h) => h.bindingId)
                      .filter((b): b is string => b !== null),
                  ),
                ];
                if (bindingIds.length > 0) {
                  try {
                    egressHarvestSink({ companyId: runContext.companyId, bindingIds, origin });
                  } catch (harvestErr) {
                    log.warn(
                      { err: harvestErr, action: "secret.egress_would_deny_harvest_failed" },
                      "failed to record would-deny egress observation (non-fatal)",
                    );
                  }
                }
              }
            }
          }
        }
        dispatchParameters = substituteHandles(runContext.runId, parameters);
      } catch (err) {
        if (err instanceof EgressNotAllowedError) {
          log.warn(
            {
              pluginId,
              toolName,
              namespacedName,
              runId: runContext.runId,
              reason: err.reason,
              // attacker-influenced — logged as data only, never eval'd (EG6).
              destination: err.destination,
              action: "secret.egress_denied",
            },
            "aborting tool dispatch: borrowed handle not allowed to egress to this destination (fail-closed)",
          );
          throw new Error(
            `Cannot execute tool "${namespacedName}" — a borrowed secret handle in its ` +
            `parameters is not permitted to egress to the call's destination. The call ` +
            `was aborted before the handle was resolved to plaintext.`,
          );
        }
        if (err instanceof UnresolvedHandleError) {
          log.warn(
            { pluginId, toolName, namespacedName, runId: runContext.runId, handle: err.handle },
            "aborting tool dispatch: unresolvable borrowed handle in parameters (fail-closed)",
          );
          throw new Error(
            `Cannot execute tool "${namespacedName}" — a borrowed secret handle in ` +
            `its parameters does not belong to this run. The call was aborted so the ` +
            `opaque handle is never sent downstream.`,
          );
        }
        throw err;
      }

      const rpcParams: ExecuteToolParams = {
        toolName,
        parameters: dispatchParameters,
        runContext,
      };

      // PLA-574: register the dispatching agent's runContext under
      // (pluginDbId, runId) so the host's `artifacts.fetch` handler can
      // authorize on the dispatching agent — not the worker JWT — when the
      // worker calls back via the SDK helper. Always deregister to keep the
      // in-memory registry bounded; the registry also has a TTL sweep as a
      // belt-and-braces guard against orphans from a crashed worker.
      runContextRegistry?.register(dbId, {
        agentId: runContext.agentId,
        companyId: runContext.companyId,
        runId: runContext.runId,
        projectId: runContext.projectId,
        toolName,
        registeredAt: Date.now(),
      });
      let result: ToolResult;
      try {
        result = await workerManager.call(dbId, "executeTool", rpcParams);
      } finally {
        runContextRegistry?.deregister(dbId, runContext.runId);
      }

      log.debug(
        {
          pluginId,
          toolName,
          namespacedName,
          hasContent: !!result.content,
          hasData: result.data !== undefined,
          hasError: !!result.error,
        },
        "tool execution completed",
      );

      return { pluginId, toolName, result };
    },

    toolCount(pluginId?: string): number {
      if (pluginId !== undefined) {
        return byPlugin.get(pluginId)?.size ?? 0;
      }
      return byNamespace.size;
    },
  };
}
