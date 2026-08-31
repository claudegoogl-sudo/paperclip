/**
 * Host-side client factory — creates capability-gated handler maps for
 * servicing worker→host JSON-RPC calls.
 *
 * When a plugin worker calls `ctx.state.get(...)` inside its process, the
 * SDK serializes the call as a JSON-RPC request over stdio. On the host side,
 * the `PluginWorkerManager` receives the request and dispatches it to the
 * handler registered for that method. This module provides a factory that
 * creates those handlers for all `WorkerToHostMethods`, with automatic
 * capability enforcement.
 *
 * ## Design
 *
 * 1. **Capability gating**: Each handler checks the plugin's declared
 *    capabilities before executing. If the plugin lacks a required capability,
 *    the handler throws a `CapabilityDeniedError` (which the worker manager
 *    translates into a JSON-RPC error response with code
 *    `CAPABILITY_DENIED`).
 *
 * 2. **Service adapters**: The caller provides a `HostServices` object with
 *    concrete implementations of each platform service. The factory wires
 *    each handler to the appropriate service method.
 *
 * 3. **Type safety**: The returned handler map is typed as
 *    `WorkerToHostHandlers` (from `plugin-worker-manager.ts`) so it plugs
 *    directly into `WorkerStartOptions.hostHandlers`.
 *
 * @example
 * ```ts
 * const handlers = createHostClientHandlers({
 *   pluginId: "acme.linear",
 *   capabilities: manifest.capabilities,
 *   services: {
 *     config:    { get: () => registry.getConfig(pluginId) },
 *     state:     { get: ..., set: ..., delete: ... },
 *     entities:  { upsert: ..., list: ... },
 *     // ... all services
 *   },
 * });
 *
 * await workerManager.startWorker("acme.linear", {
 *   // ...
 *   hostHandlers: handlers,
 * });
 * ```
 *
 * @see PLUGIN_SPEC.md §13 — Host-Worker Protocol
 * @see PLUGIN_SPEC.md §15 — Capability Model
 */

import type { PluginCapability } from "@paperclipai/shared";
import type { WorkerHostCallContext, WorkerToHostMethods, WorkerToHostMethodName } from "./protocol.js";
import { PLUGIN_RPC_ERROR_CODES } from "./protocol.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when a plugin calls a host method it does not have the capability for.
 *
 * The `code` field is set to `PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED` so
 * the worker manager can propagate it as the correct JSON-RPC error code.
 */
export class CapabilityDeniedError extends Error {
  override readonly name = "CapabilityDeniedError";
  readonly code = PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED;

  constructor(pluginId: string, method: string, capability: string) {
    super(
      `Plugin "${pluginId}" is missing required capability "${capability}" for method "${method}"`,
    );
  }
}

/**
 * Thrown when a worker→host call asks for company-scoped data outside the
 * company authorized for the current top-level plugin invocation.
 */
export class InvocationScopeDeniedError extends Error {
  override readonly name = "InvocationScopeDeniedError";
  readonly code = PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED;

  constructor(pluginId: string, method: string, message: string) {
    super(`Plugin "${pluginId}" is not allowed to perform "${method}": ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Host service interfaces
// ---------------------------------------------------------------------------

/**
 * Service adapters that the host must provide. Each property maps to a group
 * of `WorkerToHostMethods`. The factory wires JSON-RPC params to these
 * function signatures.
 *
 * All methods return promises to support async I/O (database, HTTP, etc.).
 */
export interface HostServices {
  /** Provides `config.get` and the fork-only `config.getForServiceScope`. */
  config: {
    get(
      params: WorkerToHostMethods["config.get"][0],
      context?: WorkerHostCallContext,
    ): Promise<Record<string, unknown>>;
    /**
     * Fork-only background read: per-company effective plugin config
     * (company `plugin_config` row merged with the tenant `configOverrides`
     * subtree) behind the fail-closed server-side provisioning gate: the
     * company must hold a `plugin_config` row for THIS plugin install and
     * the plugin must be installed and enabled for it; every denial
     * collapses to one opaque error (no existence oracle). Reachable under
     * the bare worker-lifetime `serviceScope`; rejects a missing/empty
     * `companyId` and never accepts `kind:"all"`.
     */
    getForServiceScope(
      params: WorkerToHostMethods["config.getForServiceScope"][0],
    ): Promise<WorkerToHostMethods["config.getForServiceScope"][1]>;
  };

  /** Provides trusted company-scoped local folder helpers. */
  localFolders: {
    declarations(params: WorkerToHostMethods["localFolders.declarations"][0]): Promise<WorkerToHostMethods["localFolders.declarations"][1]>;
    configure(params: WorkerToHostMethods["localFolders.configure"][0]): Promise<WorkerToHostMethods["localFolders.configure"][1]>;
    status(params: WorkerToHostMethods["localFolders.status"][0]): Promise<WorkerToHostMethods["localFolders.status"][1]>;
    list(params: WorkerToHostMethods["localFolders.list"][0]): Promise<WorkerToHostMethods["localFolders.list"][1]>;
    readText(params: WorkerToHostMethods["localFolders.readText"][0]): Promise<WorkerToHostMethods["localFolders.readText"][1]>;
    writeTextAtomic(params: WorkerToHostMethods["localFolders.writeTextAtomic"][0]): Promise<WorkerToHostMethods["localFolders.writeTextAtomic"][1]>;
    deleteFile(params: WorkerToHostMethods["localFolders.deleteFile"][0]): Promise<WorkerToHostMethods["localFolders.deleteFile"][1]>;
  };

  /** Provides `state.get`, `state.set`, `state.delete`. */
  state: {
    get(params: WorkerToHostMethods["state.get"][0]): Promise<WorkerToHostMethods["state.get"][1]>;
    set(params: WorkerToHostMethods["state.set"][0]): Promise<void>;
    delete(params: WorkerToHostMethods["state.delete"][0]): Promise<void>;
  };

  /** Provides restricted plugin database namespace methods. */
  db: {
    namespace(params: WorkerToHostMethods["db.namespace"][0]): Promise<WorkerToHostMethods["db.namespace"][1]>;
    query(params: WorkerToHostMethods["db.query"][0]): Promise<WorkerToHostMethods["db.query"][1]>;
    execute(params: WorkerToHostMethods["db.execute"][0]): Promise<WorkerToHostMethods["db.execute"][1]>;
  };

  /** Provides `entities.upsert`, `entities.list`. */
  entities: {
    upsert(params: WorkerToHostMethods["entities.upsert"][0]): Promise<WorkerToHostMethods["entities.upsert"][1]>;
    list(params: WorkerToHostMethods["entities.list"][0]): Promise<WorkerToHostMethods["entities.list"][1]>;
  };

  /** Provides `events.emit` and `events.subscribe`. */
  events: {
    emit(params: WorkerToHostMethods["events.emit"][0]): Promise<void>;
    subscribe(params: WorkerToHostMethods["events.subscribe"][0]): Promise<void>;
  };

  /** Provides `http.fetch`. */
  http: {
    fetch(params: WorkerToHostMethods["http.fetch"][0]): Promise<WorkerToHostMethods["http.fetch"][1]>;
  };

  /** Provides `secrets.resolve`, `secrets.mintHandle` and the fork-only `secrets.resolveService`. */
  secrets: {
    resolve(
      params: WorkerToHostMethods["secrets.resolve"][0],
      context?: WorkerHostCallContext,
    ): Promise<string>;
    mintHandle(
      params: WorkerToHostMethods["secrets.mintHandle"][0],
    ): Promise<WorkerToHostMethods["secrets.mintHandle"][1]>;
    /**
     * Fork-only worker-lifetime service-context read: the company is derived
     * from the secret binding server-side (never worker-supplied), ambiguous
     * bindings collapse to not_found, and the host-minted `serviceScope.runId`
     * is mandatory at the bridge. This is the surface the messenger poll
     * loop's bot-token resolve targets.
     */
    resolveService(
      params: WorkerToHostMethods["secrets.resolveService"][0],
    ): Promise<WorkerToHostMethods["secrets.resolveService"][1]>;
  };

  /**
   * Provides `artifacts.fetch` — host-mediated cross-tenant attachment fetch.
   *
   * The service implementation is expected to:
   * 1. Look up the runContext keyed on `(pluginId, runId)` (the factory passes
   *    the runtime `pluginId` separately via closure when constructing the
   *    `HostServices` for a given plugin).
   * 2. Authorize against the dispatching agent's company, NOT the worker JWT.
   * 3. Rate-limit per dispatching agent.
   * 4. Audit-log with the six fields (attachmentId, attachmentCompanyId,
   *    dispatchingAgentId, dispatchingAgentCompanyId, pluginInstanceId,
   *    toolName).
   * 5. Return base64-encoded bytes plus metadata.
   *
   * See the threat model and the seven-point security checklist for the full
   * design rationale.
   */
  artifacts: {
    fetch(params: WorkerToHostMethods["artifacts.fetch"][0]): Promise<WorkerToHostMethods["artifacts.fetch"][1]>;
    /**
     * Provides `artifacts.create` — host-mediated inbound attachment
     * store. Inverse of `artifacts.fetch`. The service implementation must:
     * 1. Resolve the runContext keyed on `(pluginId, runId)`.
     * 2. Authorize `params.companyId` against the dispatching/service company
     *    scope (same resolution `fetch` uses); reject cross-tenant writes.
     * 3. Enforce the human-upload size ceiling and the plugin-artifact MIME
     *    allowlist.
     * 4. Dedupe on (companyId, sha256) so retries converge (idempotent).
     * 5. Audit-log without ever recording the bytes.
     */
    create(params: WorkerToHostMethods["artifacts.create"][0]): Promise<WorkerToHostMethods["artifacts.create"][1]>;
  };

  /** Provides `activity.log`. */
  activity: {
    log(params: {
      companyId: string;
      message: string;
      entityType?: string;
      entityId?: string;
      metadata?: Record<string, unknown>;
    }): Promise<void>;
  };

  /** Provides `metrics.write`. */
  metrics: {
    write(params: WorkerToHostMethods["metrics.write"][0]): Promise<void>;
  };

  /** Provides `telemetry.track`. */
  telemetry: {
    track(params: WorkerToHostMethods["telemetry.track"][0]): Promise<void>;
  };

  /** Provides `log`. */
  logger: {
    log(params: WorkerToHostMethods["log"][0]): Promise<void>;
  };

  /** Provides `span.record`. The context carries the host-minted `traceparent`. */
  tracer: {
    record(
      params: WorkerToHostMethods["span.record"][0],
      context?: WorkerHostCallContext,
    ): Promise<void>;
  };

  /** Provides `companies.list`, `companies.get`. */
  companies: {
    list(params: WorkerToHostMethods["companies.list"][0]): Promise<WorkerToHostMethods["companies.list"][1]>;
    get(params: WorkerToHostMethods["companies.get"][0]): Promise<WorkerToHostMethods["companies.get"][1]>;
  };

  /** Provides `projects.list`, `projects.get`, `projects.listWorkspaces`, `projects.getPrimaryWorkspace`, `projects.getWorkspaceForIssue`. */
  projects: {
    list(params: WorkerToHostMethods["projects.list"][0]): Promise<WorkerToHostMethods["projects.list"][1]>;
    get(params: WorkerToHostMethods["projects.get"][0]): Promise<WorkerToHostMethods["projects.get"][1]>;
    listWorkspaces(params: WorkerToHostMethods["projects.listWorkspaces"][0]): Promise<WorkerToHostMethods["projects.listWorkspaces"][1]>;
    getPrimaryWorkspace(params: WorkerToHostMethods["projects.getPrimaryWorkspace"][0]): Promise<WorkerToHostMethods["projects.getPrimaryWorkspace"][1]>;
    getWorkspaceForIssue(params: WorkerToHostMethods["projects.getWorkspaceForIssue"][0]): Promise<WorkerToHostMethods["projects.getWorkspaceForIssue"][1]>;
    getManaged(params: WorkerToHostMethods["projects.managed.get"][0]): Promise<WorkerToHostMethods["projects.managed.get"][1]>;
    reconcileManaged(params: WorkerToHostMethods["projects.managed.reconcile"][0]): Promise<WorkerToHostMethods["projects.managed.reconcile"][1]>;
    resetManaged(params: WorkerToHostMethods["projects.managed.reset"][0]): Promise<WorkerToHostMethods["projects.managed.reset"][1]>;
  };

  /** Provides `executionWorkspaces.get`. */
  executionWorkspaces: {
    get(params: WorkerToHostMethods["executionWorkspaces.get"][0]): Promise<WorkerToHostMethods["executionWorkspaces.get"][1]>;
  };

  /** Provides `routines.managed.*`. */
  routines: {
    managedGet(params: WorkerToHostMethods["routines.managed.get"][0]): Promise<WorkerToHostMethods["routines.managed.get"][1]>;
    managedReconcile(params: WorkerToHostMethods["routines.managed.reconcile"][0]): Promise<WorkerToHostMethods["routines.managed.reconcile"][1]>;
    managedReset(params: WorkerToHostMethods["routines.managed.reset"][0]): Promise<WorkerToHostMethods["routines.managed.reset"][1]>;
    managedUpdate(params: WorkerToHostMethods["routines.managed.update"][0]): Promise<WorkerToHostMethods["routines.managed.update"][1]>;
    managedRun(params: WorkerToHostMethods["routines.managed.run"][0]): Promise<WorkerToHostMethods["routines.managed.run"][1]>;
  };

  /** Provides `skills.managed.*`. */
  skills: {
    managedGet(params: WorkerToHostMethods["skills.managed.get"][0]): Promise<WorkerToHostMethods["skills.managed.get"][1]>;
    managedReconcile(params: WorkerToHostMethods["skills.managed.reconcile"][0]): Promise<WorkerToHostMethods["skills.managed.reconcile"][1]>;
    managedReset(params: WorkerToHostMethods["skills.managed.reset"][0]): Promise<WorkerToHostMethods["skills.managed.reset"][1]>;
  };

  /** Provides issue read/write, relation, checkout, wakeup, summary, comment methods. */
  issues: {
    list(params: WorkerToHostMethods["issues.list"][0]): Promise<WorkerToHostMethods["issues.list"][1]>;
    get(params: WorkerToHostMethods["issues.get"][0]): Promise<WorkerToHostMethods["issues.get"][1]>;
    create(params: WorkerToHostMethods["issues.create"][0]): Promise<WorkerToHostMethods["issues.create"][1]>;
    update(params: WorkerToHostMethods["issues.update"][0]): Promise<WorkerToHostMethods["issues.update"][1]>;
    getRelations(params: WorkerToHostMethods["issues.relations.get"][0]): Promise<WorkerToHostMethods["issues.relations.get"][1]>;
    setBlockedBy(params: WorkerToHostMethods["issues.relations.setBlockedBy"][0]): Promise<WorkerToHostMethods["issues.relations.setBlockedBy"][1]>;
    addBlockers(params: WorkerToHostMethods["issues.relations.addBlockers"][0]): Promise<WorkerToHostMethods["issues.relations.addBlockers"][1]>;
    removeBlockers(params: WorkerToHostMethods["issues.relations.removeBlockers"][0]): Promise<WorkerToHostMethods["issues.relations.removeBlockers"][1]>;
    assertCheckoutOwner(params: WorkerToHostMethods["issues.assertCheckoutOwner"][0]): Promise<WorkerToHostMethods["issues.assertCheckoutOwner"][1]>;
    getSubtree(params: WorkerToHostMethods["issues.getSubtree"][0]): Promise<WorkerToHostMethods["issues.getSubtree"][1]>;
    requestWakeup(params: WorkerToHostMethods["issues.requestWakeup"][0]): Promise<WorkerToHostMethods["issues.requestWakeup"][1]>;
    requestWakeups(params: WorkerToHostMethods["issues.requestWakeups"][0]): Promise<WorkerToHostMethods["issues.requestWakeups"][1]>;
    getOrchestrationSummary(params: WorkerToHostMethods["issues.summaries.getOrchestration"][0]): Promise<WorkerToHostMethods["issues.summaries.getOrchestration"][1]>;
    listComments(params: WorkerToHostMethods["issues.listComments"][0]): Promise<WorkerToHostMethods["issues.listComments"][1]>;
    listAttachments(params: WorkerToHostMethods["issues.listAttachments"][0]): Promise<WorkerToHostMethods["issues.listAttachments"][1]>;
    createComment(params: WorkerToHostMethods["issues.createComment"][0]): Promise<WorkerToHostMethods["issues.createComment"][1]>;
    createInteraction(params: WorkerToHostMethods["issues.createInteraction"][0]): Promise<WorkerToHostMethods["issues.createInteraction"][1]>;
    listInteractions(params: WorkerToHostMethods["issues.listInteractions"][0]): Promise<WorkerToHostMethods["issues.listInteractions"][1]>;
    respondInteraction(params: WorkerToHostMethods["issues.respondInteraction"][0]): Promise<WorkerToHostMethods["issues.respondInteraction"][1]>;
    getAttachmentContent(params: WorkerToHostMethods["issues.getAttachmentContent"][0]): Promise<WorkerToHostMethods["issues.getAttachmentContent"][1]>;
    resolveInteraction(params: WorkerToHostMethods["issues.resolveInteraction"][0]): Promise<WorkerToHostMethods["issues.resolveInteraction"][1]>;
  };

  /** Provides `approvals.list`, `approvals.get`, `approvals.decide` and the fork-only `approvals.listPending`. */
  approvals: {
    list(params: WorkerToHostMethods["approvals.list"][0]): Promise<WorkerToHostMethods["approvals.list"][1]>;
    get(params: WorkerToHostMethods["approvals.get"][0]): Promise<WorkerToHostMethods["approvals.get"][1]>;
    decide(params: WorkerToHostMethods["approvals.decide"][0]): Promise<WorkerToHostMethods["approvals.decide"][1]>;
    /** Fork-only reconcile read: pending-only, field-minimized, provisioned-gated. */
    listPending(
      params: WorkerToHostMethods["approvals.listPending"][0],
    ): Promise<WorkerToHostMethods["approvals.listPending"][1]>;
  };

  /** Provides `issues.documents.list`, `issues.documents.get`, `issues.documents.upsert`, `issues.documents.delete`. */
  issueDocuments: {
    list(params: WorkerToHostMethods["issues.documents.list"][0]): Promise<WorkerToHostMethods["issues.documents.list"][1]>;
    get(params: WorkerToHostMethods["issues.documents.get"][0]): Promise<WorkerToHostMethods["issues.documents.get"][1]>;
    upsert(params: WorkerToHostMethods["issues.documents.upsert"][0]): Promise<WorkerToHostMethods["issues.documents.upsert"][1]>;
    delete(params: WorkerToHostMethods["issues.documents.delete"][0]): Promise<WorkerToHostMethods["issues.documents.delete"][1]>;
  };

  /** Provides `interactions.list` — fork reconcile read of pending issue interactions. */
  interactions: {
    list(params: WorkerToHostMethods["interactions.list"][0]): Promise<WorkerToHostMethods["interactions.list"][1]>;
  };

  /** Provides `agents.list`, `agents.get`, `agents.pause`, `agents.resume`, `agents.invoke`. */
  agents: {
    list(params: WorkerToHostMethods["agents.list"][0]): Promise<WorkerToHostMethods["agents.list"][1]>;
    get(params: WorkerToHostMethods["agents.get"][0]): Promise<WorkerToHostMethods["agents.get"][1]>;
    pause(params: WorkerToHostMethods["agents.pause"][0]): Promise<WorkerToHostMethods["agents.pause"][1]>;
    resume(params: WorkerToHostMethods["agents.resume"][0]): Promise<WorkerToHostMethods["agents.resume"][1]>;
    invoke(params: WorkerToHostMethods["agents.invoke"][0]): Promise<WorkerToHostMethods["agents.invoke"][1]>;
    managedGet(params: WorkerToHostMethods["agents.managed.get"][0]): Promise<WorkerToHostMethods["agents.managed.get"][1]>;
    managedReconcile(params: WorkerToHostMethods["agents.managed.reconcile"][0]): Promise<WorkerToHostMethods["agents.managed.reconcile"][1]>;
    managedReset(params: WorkerToHostMethods["agents.managed.reset"][0]): Promise<WorkerToHostMethods["agents.managed.reset"][1]>;
  };

  /** Provides `agents.sessions.create`, `agents.sessions.list`, `agents.sessions.sendMessage`, `agents.sessions.close`. */
  agentSessions: {
    create(params: WorkerToHostMethods["agents.sessions.create"][0]): Promise<WorkerToHostMethods["agents.sessions.create"][1]>;
    list(params: WorkerToHostMethods["agents.sessions.list"][0]): Promise<WorkerToHostMethods["agents.sessions.list"][1]>;
    sendMessage(params: WorkerToHostMethods["agents.sessions.sendMessage"][0]): Promise<WorkerToHostMethods["agents.sessions.sendMessage"][1]>;
    close(params: WorkerToHostMethods["agents.sessions.close"][0]): Promise<void>;
  };

  /** Provides `goals.list`, `goals.get`, `goals.create`, `goals.update`. */
  goals: {
    list(params: WorkerToHostMethods["goals.list"][0]): Promise<WorkerToHostMethods["goals.list"][1]>;
    get(params: WorkerToHostMethods["goals.get"][0]): Promise<WorkerToHostMethods["goals.get"][1]>;
    create(params: WorkerToHostMethods["goals.create"][0]): Promise<WorkerToHostMethods["goals.create"][1]>;
    update(params: WorkerToHostMethods["goals.update"][0]): Promise<WorkerToHostMethods["goals.update"][1]>;
  };

  /** Provides `access.members.*` and `access.invites.*`. */
  access: {
    listMembers(params: WorkerToHostMethods["access.members.list"][0]): Promise<WorkerToHostMethods["access.members.list"][1]>;
    getMember(params: WorkerToHostMethods["access.members.get"][0]): Promise<WorkerToHostMethods["access.members.get"][1]>;
    updateMember(params: WorkerToHostMethods["access.members.update"][0]): Promise<WorkerToHostMethods["access.members.update"][1]>;
    listInvites(params: WorkerToHostMethods["access.invites.list"][0]): Promise<WorkerToHostMethods["access.invites.list"][1]>;
    createInvite(params: WorkerToHostMethods["access.invites.create"][0]): Promise<WorkerToHostMethods["access.invites.create"][1]>;
    revokeInvite(params: WorkerToHostMethods["access.invites.revoke"][0]): Promise<WorkerToHostMethods["access.invites.revoke"][1]>;
  };

  /** Provides authorization grant, policy, preview, and audit helpers. */
  authorization: {
    listGrants(params: WorkerToHostMethods["authorization.grants.list"][0]): Promise<WorkerToHostMethods["authorization.grants.list"][1]>;
    setGrants(params: WorkerToHostMethods["authorization.grants.set"][0]): Promise<WorkerToHostMethods["authorization.grants.set"][1]>;
    policySummary(params: WorkerToHostMethods["authorization.policies.summary"][0]): Promise<WorkerToHostMethods["authorization.policies.summary"][1]>;
    getPolicy(params: WorkerToHostMethods["authorization.policies.get"][0]): Promise<WorkerToHostMethods["authorization.policies.get"][1]>;
    updatePolicy(params: WorkerToHostMethods["authorization.policies.update"][0]): Promise<WorkerToHostMethods["authorization.policies.update"][1]>;
    previewAssignment(params: WorkerToHostMethods["authorization.policies.previewAssignment"][0]): Promise<WorkerToHostMethods["authorization.policies.previewAssignment"][1]>;
    explainAssignment(params: WorkerToHostMethods["authorization.policies.explainAssignment"][0]): Promise<WorkerToHostMethods["authorization.policies.explainAssignment"][1]>;
    searchAudit(params: WorkerToHostMethods["authorization.audit.search"][0]): Promise<WorkerToHostMethods["authorization.audit.search"][1]>;
  };
}

// ---------------------------------------------------------------------------
// Factory input
// ---------------------------------------------------------------------------

/**
 * Options for `createHostClientHandlers`.
 */
export interface HostClientFactoryOptions {
  /** The plugin ID. Used for error messages and logging. */
  pluginId: string;

  /**
   * The capabilities declared by the plugin in its manifest. The factory
   * enforces these at runtime before delegating to the service adapter.
   */
  capabilities: readonly PluginCapability[];

  /**
   * Concrete implementations of host platform services. Each handler in the
   * returned map delegates to the corresponding service method.
   */
  services: HostServices;
}

// ---------------------------------------------------------------------------
// Handler map type (compatible with WorkerToHostHandlers from worker manager)
// ---------------------------------------------------------------------------

/**
 * A handler function for a specific worker→host method.
 */
type HostHandler<M extends WorkerToHostMethodName> = (
  params: WorkerToHostMethods[M][0],
  context?: WorkerHostCallContext,
) => Promise<WorkerToHostMethods[M][1]>;

/**
 * A complete map of all worker→host method handlers.
 *
 * This type matches `WorkerToHostHandlers` from `plugin-worker-manager.ts`
 * but makes every handler required (the factory always provides all handlers).
 */
export type HostClientHandlers = {
  [M in WorkerToHostMethodName]: HostHandler<M>;
};

// ---------------------------------------------------------------------------
// Capability → method mapping
// ---------------------------------------------------------------------------

/**
 * Maps each worker→host RPC method to the capability required to invoke it.
 * Methods without a capability requirement (e.g. `config.get`, `log`) are
 * mapped to `null`.
 *
 * @see PLUGIN_SPEC.md §15 — Capability Model
 */
// Values are a required capability, an any-of list of accepted capabilities
// (fork: reconcile reads accept either the upstream or the fork grant), or
// null for no capability requirement.
const METHOD_CAPABILITY_MAP: Record<
  WorkerToHostMethodName,
  PluginCapability | PluginCapability[] | null
> = {
  // Config — always allowed
  "config.get": null,

  // Trusted local folders
  "localFolders.declarations": null,
  "localFolders.configure": "local.folders",
  "localFolders.status": "local.folders",
  "localFolders.list": "local.folders",
  "localFolders.readText": "local.folders",
  "localFolders.writeTextAtomic": "local.folders",
  "localFolders.deleteFile": "local.folders",

  // State
  "state.get": "plugin.state.read",
  "state.set": "plugin.state.write",
  "state.delete": "plugin.state.write",

  "db.namespace": "database.namespace.read",
  "db.query": "database.namespace.read",
  "db.execute": "database.namespace.write",

  // Entities — no specific capability required (plugin-scoped by design)
  "entities.upsert": null,
  "entities.list": null,

  // Events
  "events.emit": "events.emit",
  "events.subscribe": "events.subscribe",

  // HTTP
  "http.fetch": "http.outbound",

  // Secrets
  "secrets.resolve": "secrets.read-ref",
  // Minting a borrowed handle is part of resolving a secret-ref, so it shares
  // the same capability gate.
  "secrets.mintHandle": "secrets.read-ref",

  // Artifacts — no capability gate: tool-dispatch implies attachment-read
  // (host enforces dispatching-agent authz via runContext lookup).
  "artifacts.fetch": null,
  // Writing an attachment is a privileged mutation (unlike read), so it IS
  // gated behind a dedicated default-deny capability.
  "artifacts.create": "issue.attachments.create",

  // Activity
  "activity.log": "activity.log.write",

  // Metrics
  "metrics.write": "metrics.write",

  // Telemetry
  "telemetry.track": "telemetry.track",

  // Logger — always allowed
  "log": null,

  // Provider span sink — only a plugin that registers environment drivers may
  // emit a provider span. The gate rejects a span from any other plugin.
  "span.record": "environment.drivers.register",

  // Companies
  "companies.list": "companies.read",
  "companies.get": "companies.read",

  // Projects
  "projects.list": "projects.read",
  "projects.get": "projects.read",
  "projects.listWorkspaces": "project.workspaces.read",
  "projects.getPrimaryWorkspace": "project.workspaces.read",
  "projects.getWorkspaceForIssue": "project.workspaces.read",
  "executionWorkspaces.get": "execution.workspaces.read",
  "projects.managed.get": "projects.managed",
  "projects.managed.reconcile": "projects.managed",
    "projects.managed.reset": "projects.managed",
    "routines.managed.get": "routines.managed",
    "routines.managed.reconcile": "routines.managed",
    "routines.managed.reset": "routines.managed",
    "routines.managed.update": "routines.managed",
    "routines.managed.run": "routines.managed",
    "skills.managed.get": "skills.managed",
    "skills.managed.reconcile": "skills.managed",
    "skills.managed.reset": "skills.managed",

  // Issues
  "issues.list": "issues.read",
  "issues.get": "issues.read",
  "issues.create": "issues.create",
  "issues.update": "issues.update",
  "issues.relations.get": "issue.relations.read",
  "issues.relations.setBlockedBy": "issue.relations.write",
  "issues.relations.addBlockers": "issue.relations.write",
  "issues.relations.removeBlockers": "issue.relations.write",
  "issues.assertCheckoutOwner": "issues.checkout",
  "issues.getSubtree": "issue.subtree.read",
  "issues.requestWakeup": "issues.wakeup",
  "issues.requestWakeups": "issues.wakeup",
  "issues.summaries.getOrchestration": "issues.orchestration.read",
  "issues.listComments": "issue.comments.read",
  // Reading attachment metadata is a default-deny read, gated separately from
  // comment text so a plugin must opt in before it can enumerate asset ids.
  // The asset bytes still go through artifacts.fetch. Restored after a prior
  // SDK reset dropped this method, which broke outbound media relay.
  "issues.listAttachments": "issue.attachments.read",
  "issues.createComment": "issue.comments.create",
  "issues.createInteraction": "issue.interactions.create",
  "issues.listInteractions": "issue.interactions.read",
  "issues.respondInteraction": "issue.interactions.respond",
  "issues.resolveInteraction": "issue.interactions.resolve",
  "issues.getAttachmentContent": "issue.attachments.read",

  // Approvals — fork keeps the reconcile-read grant as an accepted
  // alternative capability; EITHER grant authorizes the read.
  "approvals.list": ["approvals.read", "board.approvals.read"],
  "approvals.get": "approvals.read",
  "approvals.decide": "approvals.respond",

  // Reconcile reads
  "interactions.list": "issue.interactions.read",
  "approvals.listPending": ["approvals.read", "board.approvals.read"],

  // Fork-only background reads. Config reads carry no capability upstream
  // (`config.get`: null); the background variant keeps that parity — its
  // entity check is the server-side provisioning gate, not a capability.
  // The service-context resolve shares the secret-ref capability.
  "config.getForServiceScope": null,
  "secrets.resolveService": "secrets.read-ref",

  // Issue Documents
  "issues.documents.list": "issue.documents.read",
  "issues.documents.get": "issue.documents.read",
  "issues.documents.upsert": "issue.documents.write",
  "issues.documents.delete": "issue.documents.write",

  // Agents
  "agents.list": "agents.read",
  "agents.get": "agents.read",
  "agents.pause": "agents.pause",
  "agents.resume": "agents.resume",
  "agents.invoke": "agents.invoke",
  "agents.managed.get": "agents.managed",
  "agents.managed.reconcile": "agents.managed",
  "agents.managed.reset": "agents.managed",

  // Agent Sessions
  "agents.sessions.create": "agent.sessions.create",
  "agents.sessions.list": "agent.sessions.list",
  "agents.sessions.sendMessage": "agent.sessions.send",
  "agents.sessions.close": "agent.sessions.close",

  // Goals
  "goals.list": "goals.read",
  "goals.get": "goals.read",
  "goals.create": "goals.create",
  "goals.update": "goals.update",

  // Access
  "access.members.list": "access.members.read",
  "access.members.get": "access.members.read",
  "access.members.update": "access.members.write",
  "access.invites.list": "access.invites.read",
  "access.invites.create": "access.invites.write",
  "access.invites.revoke": "access.invites.write",

  // Authorization
  "authorization.grants.list": "authorization.grants.read",
  "authorization.grants.set": "authorization.grants.write",
  "authorization.policies.summary": "authorization.policies.read",
  "authorization.policies.get": "authorization.policies.read",
  "authorization.policies.update": "authorization.policies.write",
  "authorization.policies.previewAssignment": "authorization.policies.read",
  "authorization.policies.explainAssignment": "authorization.policies.read",
  "authorization.audit.search": "authorization.audit.read",
};

/**
 * Company-scoped worker→host methods that are safe to run under the bare,
 * host-minted `serviceScope` — i.e. from a background dispatch or a
 * `setup()`-started loop (e.g. the messenger `getUpdates` poll loop) with NO
 * active dispatch to pin a tenant. Every other company-scoped method keeps
 * failing closed in that state.
 *
 * The bar for membership is that the call cannot widen which companies/entities
 * the plugin can reach beyond what a host-pinned dispatch already allows — the
 * `serviceScope` only relaxes *timing* (act while idle), never reach.
 *
 * MEMBERSHIP INVARIANT: an entry is admissible only when a compensating
 * server-side per-company reach-check backs it (`requireInCompany` or
 * `requirePluginEnabledForCompany`). A method the host cannot reach-check
 * server-side per company must never join this set — bridge-level guards
 * alone are not sufficient.
 *
 * A distinct safety argument per entry:
 *
 *  - `state.get` / `state.set` / `state.delete`: company-scoped plugin state is
 *    the plugin's OWN data, partitioned by `(pluginId, scopeKind, scopeId, ...)`,
 *    and every company-scoped call is reach-checked server-side by
 *    `requirePluginEnabledForCompany` (via `requireStateCompanyReach` in
 *    plugin-host-services) BEFORE the store is touched — fail-closed, including
 *    a missing/empty company `scopeId` (never served from the store's
 *    NULL-`scopeId` partition). A worker-forged `companyId` can therefore only
 *    reach companies the plugin is genuinely provisioned for: the reachable set
 *    equals the plugin's install reach; serviceScope only relaxes the timing
 *    constraint. Non-company `scopeKind`s key state by entity ids only the
 *    plugin itself can have written, so no company reach exists to widen.
 *  - `issues.createComment`: the host service independently verifies the target
 *    issue belongs to the claimed company (`requireInCompany`), so a
 *    worker-forged `companyId` cannot reach a foreign issue. The reachable set
 *    equals the plugin's dispatch-lifetime reach (a plugin subscribed to
 *    `issue.*` already comments on every company's issues, one dispatch at a
 *    time); serviceScope only removes the "must be mid-dispatch" timing
 *    constraint.
 *  - `artifacts.create`: the host service stores the asset under the
 *    claimed `companyId`'s own storage namespace only and binds it to that
 *    company's issues; a worker-forged `companyId` cannot reach a foreign
 *    tenant's data, and the human-upload size ceiling + per-company rate limit
 *    bound storage cost. As with `issues.createComment`, the reachable set
 *    equals the plugin's dispatch-lifetime reach; serviceScope only relaxes the
 *    timing constraint so an inbound relay (e.g. Telegram webhook) can store
 *    while idle.
 *  - `issues.resolveInteraction`: identical reach argument to
 *    `issues.createComment`. The host service independently verifies the target
 *    interaction belongs to the claimed company AND issue (`requireInCompany` +
 *    interaction company/issue cross-check), so a worker-forged `companyId`
 *    cannot reach a foreign tenant's interaction. It can only transition a
 *    *pending* interaction to terminal `expired` (never `accepted`), so it fires
 *    no accept side-effects and no continuation wake. The reachable set equals
 *    the plugin's dispatch-lifetime reach; serviceScope only lets the inbound
 *    Telegram relay retire the pending confirmation it just answered while idle.
 *  - `approvals.listPending` / `interactions.list`: these fork-only reconcile
 *    reads run a real, method-scoped plugin↔company availability gate
 *    (`requirePluginEnabledForCompany` in plugin-host-services) BEFORE any
 *    query and fail closed if the plugin is not installed+enabled for the
 *    claimed company. That gate is the entity cross-check that the excluded
 *    `issues.list` lacks: a worker-forged `companyId` can only reach a company
 *    the plugin is genuinely provisioned for, so the reachable set equals the
 *    plugin's install reach (== its instance-wide event-stream reach, the very
 *    set the digest already accumulates). serviceScope only relaxes the timing
 *    constraint so the digest can reconcile on worker startup / poll with no
 *    active dispatch. Both reject `kind:"all"` and missing/empty `companyId`, so
 *    no single call can enumerate across tenants. These reads deliberately keep
 *    distinguishable company-existence failures (`Company not found` /
 *    `not available` / `disabled`) so reconcile misconfig stays diagnosable;
 *    the byte-equal no-existence-oracle denial collapse is a
 *    `config.getForServiceScope`-specific contract, not a property of the
 *    allowlist as a whole.
 *  - `config.getForServiceScope`: per-company effective plugin config
 *    (company `plugin_config` row merged with the tenant `configOverrides`
 *    subtree) behind the server-side provisioning gate — the company must
 *    hold a `plugin_config` row for THIS install (fail-closed, opaque
 *    error), identical reach argument (configured-install reach only), and
 *    the rows returned are the plugin's OWN config surface for that
 *    company, which any dispatch for that company could read anyway.
 *    Rejects `kind:"all"` and missing/empty `companyId`.
 *
 * Deliberately excluded: the upstream public reads `config.get`,
 * `secrets.resolve` and `approvals.list`. Their guards are restored to
 * upstream semantics (a company-scoped call with no host-issued company
 * context is denied proactively at this layer); background/unscoped consumers
 * must target the fork-only methods above instead. `events.subscribe` is also
 * excluded: a setup()-time filtered subscribe for a CONFIGURED company is
 * already authorized by the host's options-seeded proactive scope (pinned
 * upstream), which surfaces as a real `invocationScope` — and keeping it out
 * preserves upstream's pinned denial for companies outside the seeded set.
 * Also excluded: any method
 * that trusts `companyId` as the SOLE authority with no entity cross-check
 * (e.g. `issues.list`, `companies.get`) — those must not run with a
 * worker-chosen company outside a host-pinned dispatch, or a background loop
 * could enumerate arbitrary tenants.
 */
const SERVICE_SCOPE_COMPANY_METHODS: ReadonlySet<WorkerToHostMethodName> = new Set([
  "state.get",
  "state.set",
  "state.delete",
  "issues.createComment",
  "issues.resolveInteraction",
  "artifacts.create",
  "approvals.listPending",
  "config.getForServiceScope",
  "interactions.list",
]);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a complete handler map for all worker→host JSON-RPC methods.
 *
 * Each handler:
 * 1. Checks the plugin's declared capabilities against the required capability
 *    for the method (if any).
 * 2. Delegates to the corresponding service adapter method.
 * 3. Returns the service result, which is serialized as the JSON-RPC response
 *    by the worker manager.
 *
 * If a capability check fails, the handler throws a `CapabilityDeniedError`
 * with code `CAPABILITY_DENIED`. The worker manager catches this and sends a
 * JSON-RPC error response to the worker, which surfaces as a `JsonRpcCallError`
 * in the plugin's SDK client.
 *
 * @param options - Plugin ID, capabilities, and service adapters
 * @returns A handler map suitable for `WorkerStartOptions.hostHandlers`
 */
export function createHostClientHandlers(
  options: HostClientFactoryOptions,
): HostClientHandlers {
  const { pluginId, services } = options;
  const capabilitySet = new Set<PluginCapability>(options.capabilities);

  type CompanyScopeRequest =
    | { kind: "none" }
    | { kind: "single"; companyId: string }
    | { kind: "all" };

  const noCompanyScope: CompanyScopeRequest = { kind: "none" };

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function readNonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  /**
   * Back-fill `runId` on a worker→host params record from the host-validated
   * active invocation scope when the worker omitted it. A prior SDK change
   * to the signature of `ctx.secrets.resolve()` made `runId` required; plugins
   * bundled against the older SDK still call without it, which would
   * otherwise fail closed at the server's secrets handler. The
   * runId we fill in here came from the host's own outer dispatch — never
   * from the worker — so the security invariants of that isolation model are
   * preserved.
   *
   * Only writes when (a) the worker omitted `runId` AND (b) a host-validated
   * scope carries a runId.
   *
   * The scope is sourced, in order, from:
   *   1. `context.invocationScope` — the worker echoed a `paperclipInvocationId`
   *      the host resolved to an active dispatch (SDKs that thread the
   *      invocation id).
   *   2. `context.singleInFlightScope` — the worker echoed no id (a legacy SDK
   *      such as platform.cad ≤0.1.7 that predates invocation-id threading),
   *      but exactly one
   *      host→worker dispatch is in-flight, so the host attributes the callback
   *      to it. Both come from the host's own runContext, never from the worker,
   *      so the isolation model holds: a forged worker→host call
   *      outside any dispatch surfaces no scope here and still fails closed at
   *      the server's secrets handler (`runcontext_invalid`).
   *   3. `context.serviceScope` — the host-minted, worker-lifetime
   *      service run-context, surfaced on EVERY worker→host call. It is the
   *      fallback for a background dispatch (`onEvent`/`onWebhook`/`runJob`) or
   *      a loop started in `setup()` (e.g. a `getUpdates` long-poll) that calls
   *      `secrets.resolve` with NO dispatch in flight, so neither scope above
   *      exists. Checked last so an active dispatch's runId always wins. The
   *      service runId is host-minted (never worker-supplied) and resolves to a
   *      system actor at the server with the company derived from the secret
   *      binding — it grants no company scope here.
   *
   * `serviceScope` being host-minted is NOT on its own a tenant-
   * isolation argument for `secrets.resolve`. `contextForWorkerMessage`
   * attaches `serviceScope` unconditionally, so whenever the host attributes a
   * call to a single in-flight dispatch BOTH keys are present and (2) shadows
   * (3). The runId written here IS the tenant binding — the server's secrets
   * handler re-derives the company from `(pluginDbId, runId)` — so a
   * no-dispatch caller reaching this with someone else's `singleInFlightScope`
   * resolves that tenant's secret. What keeps (2) off a no-dispatch caller is
   * the host, not this precedence chain: see `baseContextForWorkerMessage` in
   * plugin-worker-manager (the worker-declared `echoesInvocationId` plus
   * the host-observed per-method signal). Reordering the chain here is
   * NOT the fix — for a legacy id-less worker servicing its own dispatch, (2)
   * is the correct binding and (3) is not.
   */
  function backfillDispatchRunId<P>(
    params: P,
    context: WorkerHostCallContext | undefined,
  ): P {
    if (!isRecord(params)) return params;
    if (readNonEmptyString((params as Record<string, unknown>).runId)) return params;
    const scopedRunId =
      readNonEmptyString(context?.invocationScope?.runId) ??
      readNonEmptyString(context?.singleInFlightScope?.runId) ??
      readNonEmptyString(context?.serviceScope?.runId);
    if (!scopedRunId) return params;
    return { ...params, runId: scopedRunId } as P;
  }

  /**
   * Fork-only scope feed for legacy id-less workers (platform.cad ≤0.1.7,
   * klipper): when the host attributed an id-less callback to the single
   * in-flight dispatch (`context.singleInFlightScope` — host-observed, never
   * worker-supplied), present that scope AS the invocation scope so upstream's
   * `resolveRequiredCompanyId` authorizes the call exactly as if the worker
   * had echoed the invocation id. Upstream contexts never carry
   * `singleInFlightScope`, so this is a provable no-op for upstream behavior.
   * A worker that CAN echo but didn't (a `setup()` loop, `runJob`, timer) is
   * excluded by the host's attribution latch and still fails closed.
   */
  function forkLegacyScopeContext(
    context: WorkerHostCallContext | undefined,
  ): WorkerHostCallContext | undefined {
    if (!context || context.invocationScope || !context.singleInFlightScope) return context;
    return {
      ...context,
      invocationScope: context.singleInFlightScope,
      invalidInvocationScope: undefined,
    };
  }

  function requestedCompanyScope(
    method: WorkerToHostMethodName,
    params: unknown,
  ): CompanyScopeRequest {
    if (method === "companies.list") return { kind: "all" };
    if (!isRecord(params)) return noCompanyScope;

    const companyId = readNonEmptyString(params.companyId);
    if (companyId) return { kind: "single", companyId };

    if (params.scopeKind === "company") {
      const scopeId = readNonEmptyString(params.scopeId);
      return scopeId ? { kind: "single", companyId: scopeId } : { kind: "all" };
    }

    if (method === "events.subscribe" && isRecord(params.filter)) {
      const filterCompanyId = readNonEmptyString(params.filter.companyId);
      if (filterCompanyId) return { kind: "single", companyId: filterCompanyId };
    }

    return noCompanyScope;
  }

  function requireInvocationCompanyScope(
    method: WorkerToHostMethodName,
    params: unknown,
    context?: WorkerHostCallContext,
  ): void {
    const requested = requestedCompanyScope(method, params);
    if (requested.kind === "none") return;

    const allowedCompanyId = readNonEmptyString(context?.invocationScope?.companyId);

    // Fork-only bypass. When no dispatch pins a company, authorize the narrow
    // allowlist of company-scoped methods carrying the host-minted,
    // worker-lifetime `serviceScope` — a background dispatch or a
    // `setup()`-started loop (e.g. the messenger digest poll) that cannot
    // widen the plugin's reach beyond what a host-pinned dispatch already
    // grants (see `SERVICE_SCOPE_COMPANY_METHODS` for the per-method safety
    // argument). Every allowlisted method is independently reach-checked
    // server-side (`requireInCompany` or `requirePluginEnabledForCompany`),
    // so a worker-forged `companyId` cannot reach a foreign tenant;
    // `kind:"all"` and non-allowlisted methods keep failing closed below.
    //
    // The bypass is gated on `serviceScope.runId`, a key only the fork's host
    // ever attaches — upstream contexts provably never carry it, so the guard
    // below evaluates exactly as upstream wrote it and upstream's
    // proactive-denial semantics hold byte-for-byte on the public surface.
    if (
      !allowedCompanyId &&
      requested.kind === "single" &&
      readNonEmptyString(context?.serviceScope?.runId) &&
      SERVICE_SCOPE_COMPANY_METHODS.has(method)
    ) {
      return;
    }

    if (context?.invalidInvocationScope) {
      throw new InvocationScopeDeniedError(
        pluginId,
        method,
        "the worker referenced a missing, expired, or unknown invocation scope",
      );
    }

    if (requested.kind === "all") {
      if (method === "companies.list") return;
      if (!allowedCompanyId) {
        throw new InvocationScopeDeniedError(pluginId, method, "company context is required");
      }
      throw new InvocationScopeDeniedError(
        pluginId,
        method,
        `the current invocation is scoped to company "${allowedCompanyId}"`,
      );
    }

    if (!allowedCompanyId) {
      throw new InvocationScopeDeniedError(pluginId, method, "company context is required");
    }

    if (requested.companyId !== allowedCompanyId) {
      throw new InvocationScopeDeniedError(
        pluginId,
        method,
        `requested company "${requested.companyId}" but the current invocation is scoped to company "${allowedCompanyId}"`,
      );
    }
  }

  function resolveRequiredCompanyId(
    method: WorkerToHostMethodName,
    params: unknown,
    context?: WorkerHostCallContext,
  ): string {
    if (context?.invalidInvocationScope) {
      throw new InvocationScopeDeniedError(
        pluginId,
        method,
        "the worker referenced a missing, expired, or unknown invocation scope",
      );
    }

    const requested = requestedCompanyScope(method, params);
    const scopedCompanyId = readNonEmptyString(context?.invocationScope?.companyId);
    if (requested.kind === "single") {
      if (!scopedCompanyId) {
        throw new InvocationScopeDeniedError(pluginId, method, "company context is required");
      }
      if (requested.companyId !== scopedCompanyId) {
        throw new InvocationScopeDeniedError(
          pluginId,
          method,
          `requested company "${requested.companyId}" but the current invocation is scoped to company "${scopedCompanyId}"`,
        );
      }
      return scopedCompanyId;
    }

    if (scopedCompanyId) return scopedCompanyId;

    throw new InvocationScopeDeniedError(pluginId, method, "company context is required");
  }

  /**
   * Assert that the plugin has the required capability for a method.
   * Throws `CapabilityDeniedError` if the capability is missing.
   */
  function requireCapability(
    method: WorkerToHostMethodName,
  ): void {
    const required = METHOD_CAPABILITY_MAP[method];
    if (required === null) return; // No capability required
    if (Array.isArray(required)) {
      // Fork: any-of list — the method is authorized when the plugin holds at
      // least one of the accepted grants.
      if (required.some((c) => capabilitySet.has(c))) return;
      throw new CapabilityDeniedError(pluginId, method, required.join('" or "'));
    }
    if (capabilitySet.has(required)) return;
    throw new CapabilityDeniedError(pluginId, method, required);
  }

  /**
   * Create a capability-gated proxy handler for a method.
   *
   * @param method - The RPC method name (used for capability lookup)
   * @param handler - The actual handler implementation
   * @returns A wrapper that checks capabilities before delegating
   */
  function gated<M extends WorkerToHostMethodName>(
    method: M,
    handler: HostHandler<M>,
  ): HostHandler<M> {
    return async (params: WorkerToHostMethods[M][0], context?: WorkerHostCallContext) => {
      requireCapability(method);
      requireInvocationCompanyScope(method, params, context);
      return handler(params, context);
    };
  }

  // -------------------------------------------------------------------------
  // Build the complete handler map
  // -------------------------------------------------------------------------

  return {
    // Config
    "config.get": gated("config.get", async (params, context) => {
      // Upstream body, byte-compatible: a company-scoped call with no
      // host-issued company context is denied here, before host services run.
      // The only fork delta is `forkLegacyScopeContext`, which feeds the
      // host-attributed single-in-flight dispatch scope for legacy id-less
      // workers and is a no-op for every upstream-constructible context.
      const companyId = resolveRequiredCompanyId(
        "config.get",
        params,
        forkLegacyScopeContext(context),
      );
      return services.config.get({ ...params, companyId }, context);
    }),

    // Fork-only background config read (see SERVICE_SCOPE_COMPANY_METHODS for
    // the safety argument). Bridge-level complete mediation: the worker must
    // name a concrete company; the server re-checks plugin↔company
    // provisioning and never accepts `kind:"all"`.
    "config.getForServiceScope": gated("config.getForServiceScope", async (params) => {
      if (!readNonEmptyString((params as { companyId?: unknown } | undefined)?.companyId)) {
        throw new InvocationScopeDeniedError(
          pluginId,
          "config.getForServiceScope",
          "a concrete companyId is required; cross-tenant enumeration is not permitted",
        );
      }
      return services.config.getForServiceScope(params as { companyId: string });
    }),

    "localFolders.declarations": gated("localFolders.declarations", async (params) => {
      return services.localFolders.declarations(params);
    }),
    "localFolders.configure": gated("localFolders.configure", async (params) => {
      return services.localFolders.configure(params);
    }),
    "localFolders.status": gated("localFolders.status", async (params) => {
      return services.localFolders.status(params);
    }),
    "localFolders.list": gated("localFolders.list", async (params) => {
      return services.localFolders.list(params);
    }),
    "localFolders.readText": gated("localFolders.readText", async (params) => {
      return services.localFolders.readText(params);
    }),
    "localFolders.writeTextAtomic": gated("localFolders.writeTextAtomic", async (params) => {
      return services.localFolders.writeTextAtomic(params);
    }),
    "localFolders.deleteFile": gated("localFolders.deleteFile", async (params) => {
      return services.localFolders.deleteFile(params);
    }),

    // State
    "state.get": gated("state.get", async (params) => {
      return services.state.get(params);
    }),
    "state.set": gated("state.set", async (params) => {
      return services.state.set(params);
    }),
    "state.delete": gated("state.delete", async (params) => {
      return services.state.delete(params);
    }),

    "db.namespace": gated("db.namespace", async (params) => {
      return services.db.namespace(params);
    }),
    "db.query": gated("db.query", async (params) => {
      return services.db.query(params);
    }),
    "db.execute": gated("db.execute", async (params) => {
      return services.db.execute(params);
    }),

    // Entities
    "entities.upsert": gated("entities.upsert", async (params) => {
      return services.entities.upsert(params);
    }),
    "entities.list": gated("entities.list", async (params) => {
      return services.entities.list(params);
    }),

    // Events
    "events.emit": gated("events.emit", async (params) => {
      return services.events.emit(params);
    }),
    "events.subscribe": gated("events.subscribe", async (params) => {
      return services.events.subscribe(params);
    }),

    // HTTP
    "http.fetch": gated("http.fetch", async (params) => {
      return services.http.fetch(params);
    }),

    // Secrets
    "secrets.resolve": gated("secrets.resolve", async (params, context) => {
      // Fork back-compat (host-derived, upstream-invisible): plugins bundled
      // against an older SDK send `{ secretRef }` with no `runId`. Back-fill
      // from the host-validated scopes so server-side dispatch lookups succeed
      // for legacy callers; with no scope surfaced nothing is written and the
      // upstream guard below denies before host services run.
      const enriched = backfillDispatchRunId(params, context);
      // Upstream body, byte-compatible: proactive denial without host-issued
      // company context, before host services run. The only fork delta is
      // `forkLegacyScopeContext` (single-in-flight attribution for legacy
      // id-less workers; no-op for upstream contexts).
      const companyId = resolveRequiredCompanyId(
        "secrets.resolve",
        enriched,
        forkLegacyScopeContext(context),
      );
      return services.secrets.resolve({ ...enriched, companyId }, context);
    }),

    // Fork-only background secret read (worker-lifetime service context). The
    // company is NEVER worker-supplied here: the server derives it from the
    // secret binding (ambiguous cross-company bindings collapse to not_found),
    // rate-limits per plugin, and registers the value with the run-scoped
    // redactor. The host-minted `serviceScope.runId` is mandatory — a call
    // without it is not attributable to a worker-lifetime run-context and is
    // denied here. This is the surface the messenger poll loop's bot-token
    // resolve targets; `secrets.resolve` itself stays upstream-strict.
    "secrets.resolveService": gated("secrets.resolveService", async (params, context) => {
      if (!readNonEmptyString(context?.serviceScope?.runId)) {
        throw new InvocationScopeDeniedError(
          pluginId,
          "secrets.resolveService",
          "a host-minted service scope is required for background secret reads",
        );
      }
      if (readNonEmptyString((params as { companyId?: unknown } | undefined)?.companyId)) {
        throw new InvocationScopeDeniedError(
          pluginId,
          "secrets.resolveService",
          "the company is derived from the secret binding; passing companyId is not permitted",
        );
      }
      const enriched = backfillDispatchRunId(params, context);
      return services.secrets.resolveService(enriched);
    }),

    // Secrets — borrowed-handle minting (Control 2). Same dispatch
    // run-id back-fill as `secrets.resolve`; the host keys the borrowed value
    // off the server-validated runContext and fail-closes outside a dispatch.
    "secrets.mintHandle": gated("secrets.mintHandle", async (params, context) => {
      const enriched = backfillDispatchRunId(params, context);
      return services.secrets.mintHandle(enriched);
    }),

    // Artifacts — host enforces dispatching-agent authz via runContext
    "artifacts.fetch": gated("artifacts.fetch", async (params, context) => {
      // Same back-fill as secrets.resolve. The current SDK threads
      // runId here from day one, so this only kicks in for legacy callers
      // that bundled an older SDK.
      const enriched = backfillDispatchRunId(params, context);
      return services.artifacts.fetch(enriched);
    }),

    // Artifacts write — gated behind issue.attachments.create.
    // Same runId back-fill as fetch; the host re-validates company scope and
    // enforces size/mime/idempotency before storing.
    "artifacts.create": gated("artifacts.create", async (params, context) => {
      const enriched = backfillDispatchRunId(params, context);
      return services.artifacts.create(enriched);
    }),

    // Activity
    "activity.log": gated("activity.log", async (params) => {
      return services.activity.log(params);
    }),

    // Metrics
    "metrics.write": gated("metrics.write", async (params) => {
      return services.metrics.write(params);
    }),

    // Telemetry
    "telemetry.track": gated("telemetry.track", async (params) => {
      return services.telemetry.track(params);
    }),

    // Logger
    "log": gated("log", async (params) => {
      return services.logger.log(params);
    }),

    // Provider span sink. The context carries the host-minted `traceparent`.
    "span.record": gated("span.record", async (params, context) => {
      return services.tracer.record(params, context);
    }),

    // Companies
    "companies.list": gated("companies.list", async (params, context) => {
      const rows = await services.companies.list(params);
      const allowedCompanyId = readNonEmptyString(context?.invocationScope?.companyId);
      if (!allowedCompanyId) return rows;
      return rows.filter((company) =>
        isRecord(company) && company.id === allowedCompanyId,
      ) as WorkerToHostMethods["companies.list"][1];
    }),
    "companies.get": gated("companies.get", async (params) => {
      return services.companies.get(params);
    }),

    // Projects
    "projects.list": gated("projects.list", async (params) => {
      return services.projects.list(params);
    }),
    "projects.get": gated("projects.get", async (params) => {
      return services.projects.get(params);
    }),
    "projects.listWorkspaces": gated("projects.listWorkspaces", async (params) => {
      return services.projects.listWorkspaces(params);
    }),
    "projects.getPrimaryWorkspace": gated("projects.getPrimaryWorkspace", async (params) => {
      return services.projects.getPrimaryWorkspace(params);
    }),
    "projects.getWorkspaceForIssue": gated("projects.getWorkspaceForIssue", async (params) => {
      return services.projects.getWorkspaceForIssue(params);
    }),
    "executionWorkspaces.get": gated("executionWorkspaces.get", async (params) => {
      return services.executionWorkspaces.get(params);
    }),
    "projects.managed.get": gated("projects.managed.get", async (params) => {
      return services.projects.getManaged(params);
    }),
    "projects.managed.reconcile": gated("projects.managed.reconcile", async (params) => {
      return services.projects.reconcileManaged(params);
    }),
    "projects.managed.reset": gated("projects.managed.reset", async (params) => {
      return services.projects.resetManaged(params);
    }),

    // Routines
    "routines.managed.get": gated("routines.managed.get", async (params) => {
      return services.routines.managedGet(params);
    }),
    "routines.managed.reconcile": gated("routines.managed.reconcile", async (params) => {
      return services.routines.managedReconcile(params);
    }),
    "routines.managed.reset": gated("routines.managed.reset", async (params) => {
      return services.routines.managedReset(params);
    }),
    "routines.managed.update": gated("routines.managed.update", async (params) => {
      return services.routines.managedUpdate(params);
    }),
    "routines.managed.run": gated("routines.managed.run", async (params) => {
      return services.routines.managedRun(params);
    }),

    // Skills
    "skills.managed.get": gated("skills.managed.get", async (params) => {
      return services.skills.managedGet(params);
    }),
    "skills.managed.reconcile": gated("skills.managed.reconcile", async (params) => {
      return services.skills.managedReconcile(params);
    }),
    "skills.managed.reset": gated("skills.managed.reset", async (params) => {
      return services.skills.managedReset(params);
    }),

    // Issues
    "issues.list": gated("issues.list", async (params) => {
      return services.issues.list(params);
    }),
    "issues.get": gated("issues.get", async (params) => {
      return services.issues.get(params);
    }),
    "issues.create": gated("issues.create", async (params) => {
      return services.issues.create(params);
    }),
    "issues.update": gated("issues.update", async (params) => {
      return services.issues.update(params);
    }),
    "issues.relations.get": gated("issues.relations.get", async (params) => {
      return services.issues.getRelations(params);
    }),
    "issues.relations.setBlockedBy": gated("issues.relations.setBlockedBy", async (params) => {
      return services.issues.setBlockedBy(params);
    }),
    "issues.relations.addBlockers": gated("issues.relations.addBlockers", async (params) => {
      return services.issues.addBlockers(params);
    }),
    "issues.relations.removeBlockers": gated("issues.relations.removeBlockers", async (params) => {
      return services.issues.removeBlockers(params);
    }),
    "issues.assertCheckoutOwner": gated("issues.assertCheckoutOwner", async (params) => {
      return services.issues.assertCheckoutOwner(params);
    }),
    "issues.getSubtree": gated("issues.getSubtree", async (params) => {
      return services.issues.getSubtree(params);
    }),
    "issues.requestWakeup": gated("issues.requestWakeup", async (params) => {
      return services.issues.requestWakeup(params);
    }),
    "issues.requestWakeups": gated("issues.requestWakeups", async (params) => {
      return services.issues.requestWakeups(params);
    }),
    "issues.summaries.getOrchestration": gated("issues.summaries.getOrchestration", async (params) => {
      return services.issues.getOrchestrationSummary(params);
    }),
    "issues.listComments": gated("issues.listComments", async (params) => {
      return services.issues.listComments(params);
    }),
    "issues.listAttachments": gated("issues.listAttachments", async (params) => {
      return services.issues.listAttachments(params);
    }),
    "issues.createComment": gated("issues.createComment", async (params) => {
      if (params.actorUserId && !capabilitySet.has("issue.comments.create_human_attributed")) {
        throw new CapabilityDeniedError(
          pluginId,
          "issues.createComment",
          "issue.comments.create_human_attributed",
        );
      }
      return services.issues.createComment(params);
    }),
    "issues.createInteraction": gated("issues.createInteraction", async (params) => {
      return services.issues.createInteraction(params);
    }),
    "issues.listInteractions": gated("issues.listInteractions", async (params) => {
      return services.issues.listInteractions(params);
    }),
    "issues.respondInteraction": gated("issues.respondInteraction", async (params) => {
      return services.issues.respondInteraction(params);
    }),
    "issues.resolveInteraction": gated("issues.resolveInteraction", async (params) => {
      return services.issues.resolveInteraction(params);
    }),
    "issues.getAttachmentContent": gated("issues.getAttachmentContent", async (params) => {
      return services.issues.getAttachmentContent(params);
    }),

    // Approvals
    "approvals.list": gated("approvals.list", async (params) => {
      return services.approvals.list(params);
    }),

    // Fork-only reconcile read of PENDING board approvals for the messenger
    // digest (see SERVICE_SCOPE_COMPANY_METHODS for the safety argument).
    // Upstream's general `approvals.list` read surface stays byte-compatible;
    // the fail-closed provisioning gate, pending-only default, field-minimized
    // projection and defensive row cap all live on THIS method (bridge-level
    // complete mediation mirrors `interactions.list`).
    "approvals.listPending": gated("approvals.listPending", async (params) => {
      if (!readNonEmptyString(params.companyId)) {
        throw new InvocationScopeDeniedError(
          pluginId,
          "approvals.listPending",
          "a concrete companyId is required; cross-tenant enumeration is not permitted",
        );
      }
      return services.approvals.listPending(params);
    }),
    "approvals.get": gated("approvals.get", async (params) => {
      return services.approvals.get(params);
    }),
    "approvals.decide": gated("approvals.decide", async (params) => {
      return services.approvals.decide(params);
    }),

    // Fork reconcile reads — pending-blocker snapshot for the messenger
    // digest. Beyond the capability + serviceScope gates, each handler hard-
    // rejects a missing/empty `companyId` here (bridge-level complete mediation).
    "interactions.list": gated("interactions.list", async (params) => {
      if (!readNonEmptyString(params.companyId)) {
        throw new InvocationScopeDeniedError(
          pluginId,
          "interactions.list",
          "a concrete companyId is required; cross-tenant enumeration is not permitted",
        );
      }
      return services.interactions.list(params);
    }),

    // Issue Documents
    "issues.documents.list": gated("issues.documents.list", async (params) => {
      return services.issueDocuments.list(params);
    }),
    "issues.documents.get": gated("issues.documents.get", async (params) => {
      return services.issueDocuments.get(params);
    }),
    "issues.documents.upsert": gated("issues.documents.upsert", async (params) => {
      return services.issueDocuments.upsert(params);
    }),
    "issues.documents.delete": gated("issues.documents.delete", async (params) => {
      return services.issueDocuments.delete(params);
    }),

    // Agents
    "agents.list": gated("agents.list", async (params) => {
      return services.agents.list(params);
    }),
    "agents.get": gated("agents.get", async (params) => {
      return services.agents.get(params);
    }),
    "agents.pause": gated("agents.pause", async (params) => {
      return services.agents.pause(params);
    }),
    "agents.resume": gated("agents.resume", async (params) => {
      return services.agents.resume(params);
    }),
    "agents.invoke": gated("agents.invoke", async (params) => {
      return services.agents.invoke(params);
    }),
    "agents.managed.get": gated("agents.managed.get", async (params) => {
      return services.agents.managedGet(params);
    }),
    "agents.managed.reconcile": gated("agents.managed.reconcile", async (params) => {
      return services.agents.managedReconcile(params);
    }),
    "agents.managed.reset": gated("agents.managed.reset", async (params) => {
      return services.agents.managedReset(params);
    }),

    // Agent Sessions
    "agents.sessions.create": gated("agents.sessions.create", async (params) => {
      return services.agentSessions.create(params);
    }),
    "agents.sessions.list": gated("agents.sessions.list", async (params) => {
      return services.agentSessions.list(params);
    }),
    "agents.sessions.sendMessage": gated("agents.sessions.sendMessage", async (params) => {
      return services.agentSessions.sendMessage(params);
    }),
    "agents.sessions.close": gated("agents.sessions.close", async (params) => {
      return services.agentSessions.close(params);
    }),

    // Goals
    "goals.list": gated("goals.list", async (params) => {
      return services.goals.list(params);
    }),
    "goals.get": gated("goals.get", async (params) => {
      return services.goals.get(params);
    }),
    "goals.create": gated("goals.create", async (params) => {
      return services.goals.create(params);
    }),
    "goals.update": gated("goals.update", async (params) => {
      return services.goals.update(params);
    }),

    // Access
    "access.members.list": gated("access.members.list", async (params) => {
      return services.access.listMembers(params);
    }),
    "access.members.get": gated("access.members.get", async (params) => {
      return services.access.getMember(params);
    }),
    "access.members.update": gated("access.members.update", async (params) => {
      return services.access.updateMember(params);
    }),
    "access.invites.list": gated("access.invites.list", async (params) => {
      return services.access.listInvites(params);
    }),
    "access.invites.create": gated("access.invites.create", async (params) => {
      return services.access.createInvite(params);
    }),
    "access.invites.revoke": gated("access.invites.revoke", async (params) => {
      return services.access.revokeInvite(params);
    }),

    // Authorization
    "authorization.grants.list": gated("authorization.grants.list", async (params) => {
      return services.authorization.listGrants(params);
    }),
    "authorization.grants.set": gated("authorization.grants.set", async (params) => {
      return services.authorization.setGrants(params);
    }),
    "authorization.policies.summary": gated("authorization.policies.summary", async (params) => {
      return services.authorization.policySummary(params);
    }),
    "authorization.policies.get": gated("authorization.policies.get", async (params) => {
      return services.authorization.getPolicy(params);
    }),
    "authorization.policies.update": gated("authorization.policies.update", async (params) => {
      return services.authorization.updatePolicy(params);
    }),
    "authorization.policies.previewAssignment": gated("authorization.policies.previewAssignment", async (params) => {
      return services.authorization.previewAssignment(params);
    }),
    "authorization.policies.explainAssignment": gated("authorization.policies.explainAssignment", async (params) => {
      return services.authorization.explainAssignment(params);
    }),
    "authorization.audit.search": gated("authorization.audit.search", async (params) => {
      return services.authorization.searchAudit(params);
    }),
  };
}

// ---------------------------------------------------------------------------
// Utility: getRequiredCapability
// ---------------------------------------------------------------------------

/**
 * Get the capability required for a given worker→host method, or `null` if
 * no capability is required.
 *
 * Useful for inspecting capability requirements without calling the factory.
 *
 * @param method - The worker→host method name
 * @returns The required capability, or `null`
 */
export function getRequiredCapability(
  method: WorkerToHostMethodName,
): PluginCapability | PluginCapability[] | null {
  return METHOD_CAPABILITY_MAP[method];
}
