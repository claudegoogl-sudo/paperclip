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

  constructor(pluginId: string, method: string, capability: PluginCapability) {
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
  /** Provides `config.get`. */
  config: {
    /**
     * Return the instance-wide plugin configuration. Always available.
     *
     * For multi-tenant deployments, hosts SHOULD also implement
     * {@link HostServices.config.getForCompany} to deliver per-tenant
     * overrides; the gated wrapper for `config.get` consults
     * `getForCompany` first when the invocation carries a company scope.
     */
    get(): Promise<Record<string, unknown>>;
    /**
     * PLA-677: Return the effective plugin configuration for `companyId`,
     * i.e. the instance-wide config merged with this tenant's
     * `plugin_company_settings.settingsJson.configOverrides`.
     *
     * Optional — when omitted the gated wrapper falls back to {@link get},
     * preserving single-tenant behaviour for hosts that haven't adopted
     * per-tenant config delivery yet.
     */
    getForCompany?(companyId: string): Promise<Record<string, unknown>>;
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

  /** Provides `secrets.resolve` and `secrets.mintHandle`. */
  secrets: {
    resolve(params: WorkerToHostMethods["secrets.resolve"][0]): Promise<string>;
    mintHandle(
      params: WorkerToHostMethods["secrets.mintHandle"][0],
    ): Promise<WorkerToHostMethods["secrets.mintHandle"][1]>;
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
   * See PLA-574 for the threat model and the seven-point security checklist.
   */
  artifacts: {
    fetch(params: WorkerToHostMethods["artifacts.fetch"][0]): Promise<WorkerToHostMethods["artifacts.fetch"][1]>;
    /**
     * Provides `artifacts.create` (PLA-888) — host-mediated inbound attachment
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
    createComment(params: WorkerToHostMethods["issues.createComment"][0]): Promise<WorkerToHostMethods["issues.createComment"][1]>;
    createInteraction(params: WorkerToHostMethods["issues.createInteraction"][0]): Promise<WorkerToHostMethods["issues.createInteraction"][1]>;
  };

  /** Provides `issues.documents.list`, `issues.documents.get`, `issues.documents.upsert`, `issues.documents.delete`. */
  issueDocuments: {
    list(params: WorkerToHostMethods["issues.documents.list"][0]): Promise<WorkerToHostMethods["issues.documents.list"][1]>;
    get(params: WorkerToHostMethods["issues.documents.get"][0]): Promise<WorkerToHostMethods["issues.documents.get"][1]>;
    upsert(params: WorkerToHostMethods["issues.documents.upsert"][0]): Promise<WorkerToHostMethods["issues.documents.upsert"][1]>;
    delete(params: WorkerToHostMethods["issues.documents.delete"][0]): Promise<WorkerToHostMethods["issues.documents.delete"][1]>;
  };

  /** Provides `approvals.list` — reconcile read of pending board approvals (PLA-923). */
  approvals: {
    list(params: WorkerToHostMethods["approvals.list"][0]): Promise<WorkerToHostMethods["approvals.list"][1]>;
  };

  /** Provides `interactions.list` — reconcile read of pending issue interactions (PLA-923). */
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
const METHOD_CAPABILITY_MAP: Record<WorkerToHostMethodName, PluginCapability | null> = {
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
  // the same capability gate (PLA-702 Control 2).
  "secrets.mintHandle": "secrets.read-ref",

  // Artifacts — no capability gate: tool-dispatch implies attachment-read
  // (host enforces dispatching-agent authz via runContext lookup). See PLA-574.
  "artifacts.fetch": null,
  // Writing an attachment is a privileged mutation (unlike read), so it IS
  // gated behind a dedicated default-deny capability. See PLA-888.
  "artifacts.create": "issue.attachments.create",

  // Activity
  "activity.log": "activity.log.write",

  // Metrics
  "metrics.write": "metrics.write",

  // Telemetry
  "telemetry.track": "telemetry.track",

  // Logger — always allowed
  "log": null,

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
  "issues.createComment": "issue.comments.create",
  "issues.createInteraction": "issue.interactions.create",

  // Reconcile reads (PLA-923)
  "approvals.list": "board.approvals.read",
  "interactions.list": "issue.interactions.read",

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
 * host-minted `serviceScope` (PLA-768) — i.e. from a background dispatch or a
 * `setup()`-started loop (e.g. the messenger `getUpdates` poll loop) with NO
 * active dispatch to pin a tenant. Every other company-scoped method keeps
 * failing closed in that state.
 *
 * The bar for membership is that the call cannot widen which companies/entities
 * the plugin can reach beyond what a host-pinned dispatch already allows — the
 * `serviceScope` only relaxes *timing* (act while idle), never reach. Three
 * distinct safety arguments, one per entry:
 *
 *  - `events.subscribe` (PLA-810): a company filter requests a STRICT SUBSET of
 *    the unconditionally-allowed unfiltered subscribe; the host event bus only
 *    ever *removes* events that fail the filter, so a filter can only NARROW
 *    visibility, never widen it.
 *  - `state.get` / `state.set` / `state.delete`: company-scoped plugin state is
 *    the plugin's OWN data, partitioned by `(pluginId, company)`. Reading or
 *    writing its company-B partition leaks nothing cross-tenant and is reachable
 *    during any company-B dispatch anyway.
 *  - `issues.createComment`: the host service independently verifies the target
 *    issue belongs to the claimed company (`requireInCompany`), so a
 *    worker-forged `companyId` cannot reach a foreign issue. The reachable set
 *    equals the plugin's dispatch-lifetime reach (a plugin subscribed to
 *    `issue.*` already comments on every company's issues, one dispatch at a
 *    time); serviceScope only removes the "must be mid-dispatch" timing
 *    constraint.
 *  - `artifacts.create` (PLA-888): the host service stores the asset under the
 *    claimed `companyId`'s own storage namespace only and binds it to that
 *    company's issues; a worker-forged `companyId` cannot reach a foreign
 *    tenant's data, and the human-upload size ceiling + per-company rate limit
 *    bound storage cost. As with `issues.createComment`, the reachable set
 *    equals the plugin's dispatch-lifetime reach; serviceScope only relaxes the
 *    timing constraint so an inbound relay (e.g. Telegram webhook) can store
 *    while idle.
 *  - `approvals.list` / `interactions.list` (PLA-923): these reconcile reads run
 *    a real, method-scoped plugin↔company availability gate
 *    (`ensurePluginAvailableForCompany` in plugin-host-services) BEFORE any
 *    query and fail closed if the plugin is not installed+enabled for the
 *    claimed company. That gate is the entity cross-check that the excluded
 *    `issues.list` lacks: a worker-forged `companyId` can only reach a company
 *    the plugin is genuinely provisioned for, so the reachable set equals the
 *    plugin's install reach (== its instance-wide event-stream reach, the very
 *    set the digest already accumulates). serviceScope only relaxes the timing
 *    constraint so the digest can reconcile on worker startup / poll with no
 *    active dispatch. Both reject `kind:"all"` and missing/empty `companyId`, so
 *    no single call can enumerate across tenants.
 *
 * Deliberately excluded: any method that trusts `companyId` as the SOLE
 * authority with no entity cross-check (e.g. `issues.list`, `companies.get`).
 * Those must not run with a worker-chosen company outside a host-pinned
 * dispatch, or a background loop could enumerate arbitrary tenants.
 */
const SERVICE_SCOPE_COMPANY_METHODS: ReadonlySet<WorkerToHostMethodName> = new Set([
  "events.subscribe",
  "state.get",
  "state.set",
  "state.delete",
  "issues.createComment",
  "artifacts.create",
  "approvals.list",
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
   * active invocation scope when the worker omitted it. PLA-657 changed the
   * SDK signature of `ctx.secrets.resolve()` to require `runId`; plugins
   * bundled against the pre-PLA-657 SDK still call without it, which would
   * otherwise fail closed at the server's secrets handler (PLA-673). The
   * runId we fill in here came from the host's own outer dispatch — never
   * from the worker — so the security invariants of PLA-657/PLA-574 are
   * preserved.
   *
   * Only writes when (a) the worker omitted `runId` AND (b) a host-validated
   * scope carries a runId.
   *
   * The scope is sourced, in order, from:
   *   1. `context.invocationScope` — the worker echoed a `paperclipInvocationId`
   *      the host resolved to an active dispatch (post-PLA-657 SDKs).
   *   2. `context.singleInFlightScope` — PLA-719: the worker echoed no id (a
   *      pre-PLA-657 SDK such as platform.cad ≤0.1.7), but exactly one
   *      host→worker dispatch is in-flight, so the host attributes the callback
   *      to it. Both come from the host's own runContext, never from the worker,
   *      so the PLA-657/PLA-574 isolation model holds: a forged worker→host call
   *      outside any dispatch surfaces no scope here and still fails closed at
   *      the server's secrets handler (`runcontext_invalid`).
   *   3. `context.serviceScope` — PLA-768: the host-minted, worker-lifetime
   *      service run-context, surfaced on EVERY worker→host call. It is the
   *      fallback for a background dispatch (`onEvent`/`onWebhook`/`runJob`) or
   *      a loop started in `setup()` (e.g. a `getUpdates` long-poll) that calls
   *      `secrets.resolve` with NO dispatch in flight, so neither scope above
   *      exists. Checked last so an active dispatch's runId always wins. The
   *      service runId is host-minted (never worker-supplied) and resolves to a
   *      system actor at the server with the company derived from the secret
   *      binding — it grants no company scope here.
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
    if (!allowedCompanyId) {
      // PLA-810 / PLA-814 / PLA-818: when no dispatch pins a company, authorize
      // the narrow allowlist of company-scoped methods carrying the host-minted,
      // worker-lifetime `serviceScope` (PLA-768) — i.e. a background dispatch or
      // a loop started in `setup()` (e.g. the messenger `getUpdates` poll loop /
      // inbound `onWebhook` route) that cannot widen the plugin's reach beyond
      // what a host-pinned dispatch already grants (see
      // `SERVICE_SCOPE_COMPANY_METHODS` for the per-method safety argument).
      //
      // PLA-818 (guard-ordering fix): this bypass is evaluated BEFORE the
      // `invalidInvocationScope` rejection below. The inbound relay path resolves
      // to `invalidInvocationScope` in the host's base context (the worker→host
      // callback carries no resolvable dispatch id — see `contextForWorkerMessage`
      // / `baseContextForWorkerMessage` in plugin-worker-manager), so placing the
      // throw first made this bypass dead code for the only path it exists to
      // serve. Reaching the bypass here grants NO reach beyond the scope-less
      // (`{}`) case already allowed below: these exact allowlist methods are
      // server-side `requireInCompany` reach-checked, so a worker-forged
      // `companyId` cannot reach a foreign tenant regardless of whether the
      // worker echoed a bad id or no id. `requested.kind === "single"` ensures a
      // concrete target company (`kind: "all"` still fails closed below), and a
      // present `serviceScope.runId` is required. The `invalidInvocationScope`
      // throw below retains full force for every NON-allowlisted company-scoped
      // method, which is where its protective value actually lives.
      if (
        requested.kind === "single" &&
        readNonEmptyString(context?.serviceScope?.runId) &&
        SERVICE_SCOPE_COMPANY_METHODS.has(method)
      ) {
        return;
      }
      // The worker referenced a scope the host could not resolve to an active
      // dispatch (missing/expired/unknown id, or a background call the host could
      // not attribute). For non-allowlisted company-scoped methods this still
      // fails closed — serviceScope cannot launder it into reach the method's own
      // entity cross-check does not already grant.
      if (context?.invalidInvocationScope) {
        throw new InvocationScopeDeniedError(
          pluginId,
          method,
          "the worker referenced a missing, expired, or unknown invocation scope",
        );
      }
      // Fail closed (Complete Mediation / Fail Securely): a company-scoped
      // worker→host call arrived with no resolvable invocation scope — e.g. an
      // idle-window call between dispatches where the host pinned no tenant.
      // Deny rather than silently letting the tenant pin be bypassed.
      // companies.list legitimately enumerates every company and carries no
      // pin, so it stays allowed.
      if (method === "companies.list") return;
      throw new InvocationScopeDeniedError(
        pluginId,
        method,
        "no active invocation scope; company-scoped calls must run within a dispatch",
      );
    }

    if (requested.kind === "all") {
      if (method === "companies.list") return;
      throw new InvocationScopeDeniedError(
        pluginId,
        method,
        `the current invocation is scoped to company "${allowedCompanyId}"`,
      );
    }

    if (requested.companyId !== allowedCompanyId) {
      throw new InvocationScopeDeniedError(
        pluginId,
        method,
        `requested company "${requested.companyId}" but the current invocation is scoped to company "${allowedCompanyId}"`,
      );
    }
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
    "config.get": gated("config.get", async (_params, context) => {
      // PLA-677: When the invocation carries a company scope and the host
      // implements per-tenant config delivery, return the company-scoped
      // effective config; otherwise fall back to the instance-wide config.
      //
      // PLA-761: id-less legacy workers (e.g. platform.cad ≤0.1.x) echo no
      // `paperclipInvocationId`, so `invocationScope` is null. Consult the same
      // host-validated `singleInFlightScope` the runId backfill uses
      // (`backfillDispatchRunId`) so their per-tenant config — and the secret
      // refs it carries — resolves to the in-flight dispatch's company rather
      // than falling through to the instance-wide config. The companyId is
      // host-derived, never worker-supplied: `config.get` takes no companyId
      // param, so this is a scope *selection* read, not an enforcement bypass.
      // With 0 or 2+ in-flight dispatches the host pins no `singleInFlightScope`,
      // so behavior is unchanged (instance-wide config).
      const companyId =
        readNonEmptyString(context?.invocationScope?.companyId) ??
        readNonEmptyString(context?.singleInFlightScope?.companyId);
      if (companyId && services.config.getForCompany) {
        return services.config.getForCompany(companyId);
      }
      return services.config.get();
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
      // PLA-673 back-compat: plugins bundled against the pre-PLA-657 SDK send
      // `{ secretRef }` with no `runId`. Back-fill from the host-validated
      // active invocation scope (populated by the host's executeTool /
      // performAction bracket in plugin-worker-manager.ts:deriveInvocationScope)
      // so dispatch lookups succeed for legacy callers. The secrets handler's
      // fail-closed throw still fires when there is no active invocation, so a
      // forged worker→host call outside a tool dispatch keeps getting
      // `runcontext_invalid`.
      const enriched = backfillDispatchRunId(params, context);
      return services.secrets.resolve(enriched);
    }),

    // Secrets — borrowed-handle minting (PLA-702 Control 2). Same dispatch
    // run-id back-fill as `secrets.resolve`; the host keys the borrowed value
    // off the server-validated runContext and fail-closes outside a dispatch.
    "secrets.mintHandle": gated("secrets.mintHandle", async (params, context) => {
      const enriched = backfillDispatchRunId(params, context);
      return services.secrets.mintHandle(enriched);
    }),

    // Artifacts (PLA-574) — host enforces dispatching-agent authz via runContext
    "artifacts.fetch": gated("artifacts.fetch", async (params, context) => {
      // Same back-fill as secrets.resolve. The post-PLA-574 SDK threaded
      // runId here from day one, so this only kicks in for legacy callers
      // that bundled an older SDK.
      const enriched = backfillDispatchRunId(params, context);
      return services.artifacts.fetch(enriched);
    }),

    // Artifacts write (PLA-888) — gated behind issue.attachments.create.
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
    "issues.createComment": gated("issues.createComment", async (params) => {
      return services.issues.createComment(params);
    }),
    "issues.createInteraction": gated("issues.createInteraction", async (params) => {
      return services.issues.createInteraction(params);
    }),

    // Reconcile reads (PLA-923) — pending-blocker snapshot for the messenger
    // digest. Beyond the capability + serviceScope gates, each handler hard-
    // rejects a missing/empty `companyId` here. `requestedCompanyScope` maps a
    // missing companyId to `kind:"none"`, which makes `requireInvocationCompanyScope`
    // return early WITHOUT enforcement — so a company-less call would otherwise
    // slip the scope check entirely and let the server gate decide alone. These
    // are cross-tenant-sensitive enumerations, so we fail closed at the bridge:
    // no single call may run without a concrete target company (Complete
    // Mediation / Defense in Depth; the server `ensurePluginAvailableForCompany`
    // gate is the second, authoritative layer).
    "approvals.list": gated("approvals.list", async (params) => {
      if (!readNonEmptyString(params.companyId)) {
        throw new InvocationScopeDeniedError(
          pluginId,
          "approvals.list",
          "a concrete companyId is required; cross-tenant enumeration is not permitted",
        );
      }
      return services.approvals.list(params);
    }),
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
): PluginCapability | null {
  return METHOD_CAPABILITY_MAP[method];
}
