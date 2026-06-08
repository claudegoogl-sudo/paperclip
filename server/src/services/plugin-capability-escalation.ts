/**
 * Capability-escalation governance wiring (PLA-910).
 *
 * PLA-908 made the plugin loader park a capability-escalating upgrade in
 * `upgrade_pending` and file an approval through an injected
 * {@link CapabilityEscalationGateway}, completing or reverting it on the board's
 * decision. This module supplies the production wiring on top of that gate:
 *
 * 1. {@link createApprovalsCapabilityEscalationGateway} — a gateway backed by
 *    the company-scoped approvals service. It files a `request_board_approval`
 *    (the established plugin-governance pattern on this instance) carrying a
 *    `plugin_capability_escalation` payload, and dedups on the
 *    `(pluginId, toVersion)` payload tuple so a repeat upgrade while already
 *    parked does not double-file (PLA-908 criterion 5).
 * 2. A resolver registry ({@link registerCapabilityEscalationResolver} /
 *    {@link dispatchCapabilityEscalationResolution}). The approvals service
 *    dispatches escalation approvals here on approve/reject; the host registers
 *    a resolver that drives `completeUpgrade` / `revertPendingUpgrade`. The
 *    registry exists purely to break the approvals→loader import cycle.
 *
 * Company-scoping decision (PLA-910): a plugin capability escalation is
 * instance-wide but approvals are hard company-scoped, so the gateway files
 * against a single configured "platform" company. When no company is
 * configured, the host wires no gateway and the loader keeps failing closed.
 */

import { logger } from "../middleware/logger.js";
import type {
  ApprovedUpgrade,
  CapabilityEscalationGateway,
  CapabilityEscalationRequest,
} from "./plugin-loader.js";

const log = logger.child({ service: "plugin-capability-escalation" });

/**
 * Approval `type` used for capability-escalation approvals. Reuses the existing
 * board-approval kind (PLA-910 decision: no dedicated approval type) and
 * distinguishes escalations by the payload `kind` discriminator below.
 */
export const CAPABILITY_ESCALATION_APPROVAL_TYPE = "request_board_approval";

/** Payload discriminator marking a capability-escalation board approval. */
export const CAPABILITY_ESCALATION_PAYLOAD_KIND = "plugin_capability_escalation";

/**
 * Shape stored in `approvals.payload` for a capability escalation. Carries the
 * full escalation so the board can judge it and `findPending` can dedup on the
 * `(pluginId, toVersion)` tuple.
 */
export interface CapabilityEscalationPayload extends Record<string, unknown> {
  kind: typeof CAPABILITY_ESCALATION_PAYLOAD_KIND;
  pluginId: string;
  pluginKey: string;
  fromVersion: string;
  toVersion: string;
  addedCapabilities: string[];
  fromCapabilities: string[];
  toCapabilities: string[];
  // Content digest (`sha256:<hex>`) of the package captured at park (PLA-912).
  // Persisted so completeUpgrade can pin the applied package to the approved
  // contents. Optional because approvals filed before this anchor existed have
  // no stored digest — the loader's version + caps checks still apply to those.
  digest?: string;
}

/** Outcome the board reached on an escalation approval. */
export type CapabilityEscalationOutcome = "approved" | "rejected";

/** Minimal approvals-service surface this module needs (avoids a hard dep). */
export interface EscalationApprovalsPort {
  create(
    companyId: string,
    data: {
      type: string;
      payload: Record<string, unknown>;
      requestedByAgentId?: string | null;
      requestedByUserId?: string | null;
      status?: string;
    },
  ): Promise<{ id: string } | undefined>;
  list(
    companyId: string,
    status?: string,
  ): Promise<
    Array<{
      id: string;
      type: string;
      payload: unknown;
      decidedAt?: Date | string | null;
      createdAt?: Date | string | null;
    }>
  >;
}

/** Newest-decision-first ordering key for an approval row. */
function approvalDecisionTime(row: {
  decidedAt?: Date | string | null;
  createdAt?: Date | string | null;
}): number {
  const t = row.decidedAt ?? row.createdAt;
  if (!t) return 0;
  const ms = t instanceof Date ? t.getTime() : new Date(t).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Type guard for a capability-escalation approval payload. Tolerant of the
 * loosely-typed `jsonb` column.
 */
export function isCapabilityEscalationPayload(
  payload: unknown,
): payload is CapabilityEscalationPayload {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    p.kind === CAPABILITY_ESCALATION_PAYLOAD_KIND &&
    typeof p.pluginId === "string" &&
    typeof p.toVersion === "string"
  );
}

// ---------------------------------------------------------------------------
// Default approvals-backed gateway
// ---------------------------------------------------------------------------

/**
 * Build a {@link CapabilityEscalationGateway} backed by the company-scoped
 * approvals service, filing against a single configured platform company.
 *
 * @param approvals - approvals-service port (`create`, `list`).
 * @param companyId - the company the board approval is filed against.
 */
export function createApprovalsCapabilityEscalationGateway(input: {
  approvals: EscalationApprovalsPort;
  companyId: string;
}): CapabilityEscalationGateway {
  const { approvals, companyId } = input;

  async function findPending({
    pluginId,
    toVersion,
  }: {
    pluginId: string;
    toVersion: string;
  }): Promise<string | null> {
    // Dedup on the (pluginId, toVersion) payload tuple, NOT on company, so a
    // repeat upgrade call while already parked converges instead of re-filing.
    const pending = await approvals.list(companyId, "pending");
    for (const approval of pending) {
      if (approval.type !== CAPABILITY_ESCALATION_APPROVAL_TYPE) continue;
      if (!isCapabilityEscalationPayload(approval.payload)) continue;
      if (
        approval.payload.pluginId === pluginId &&
        approval.payload.toVersion === toVersion
      ) {
        return approval.id;
      }
    }
    return null;
  }

  async function findApproved({
    pluginId,
  }: {
    pluginId: string;
  }): Promise<ApprovedUpgrade | null> {
    // The loader self-enforces against the *granted* contract rather than
    // trusting the dispatched payload (PLA-911 Finding 1). Escalations
    // accumulate across upgrades, so among the approved escalation approvals
    // for this plugin we return the most-recently-decided one — the contract
    // for the upgrade currently being completed. completeUpgrade then verifies
    // the fetched package's version and capability delta against it and fails
    // closed on any mismatch.
    const approved = await approvals.list(companyId, "approved");
    const matches = approved.filter(
      (a) =>
        a.type === CAPABILITY_ESCALATION_APPROVAL_TYPE &&
        isCapabilityEscalationPayload(a.payload) &&
        a.payload.pluginId === pluginId,
    );
    if (matches.length === 0) return null;
    matches.sort((a, b) => approvalDecisionTime(b) - approvalDecisionTime(a));
    const chosen = matches[0]!;
    const payload = chosen.payload as CapabilityEscalationPayload;
    return {
      approvalId: chosen.id,
      toVersion: payload.toVersion,
      addedCapabilities: payload.addedCapabilities,
      // Surface the park-time digest so completeUpgrade can pin the applied
      // package to the approved contents (PLA-912). `null` for legacy approvals
      // filed before the digest anchor — the loader then falls back to version +
      // caps checks rather than failing closed on a digest it never captured.
      digest: payload.digest ?? null,
    };
  }

  async function file(request: CapabilityEscalationRequest): Promise<string> {
    const payload: CapabilityEscalationPayload = {
      kind: CAPABILITY_ESCALATION_PAYLOAD_KIND,
      pluginId: request.pluginId,
      pluginKey: request.pluginKey,
      fromVersion: request.fromVersion,
      toVersion: request.toVersion,
      addedCapabilities: request.addedCapabilities,
      fromCapabilities: request.fromCapabilities,
      toCapabilities: request.toCapabilities,
      digest: request.digest,
    };
    const created = await approvals.create(companyId, {
      type: CAPABILITY_ESCALATION_APPROVAL_TYPE,
      payload,
      status: "pending",
      requestedByAgentId: null,
      requestedByUserId: null,
    });
    if (!created?.id) {
      throw new Error(
        "capability-escalation gateway: approvals.create returned no id",
      );
    }
    log.info(
      {
        approvalId: created.id,
        companyId,
        pluginId: request.pluginId,
        toVersion: request.toVersion,
        addedCapabilities: request.addedCapabilities,
        digest: request.digest,
      },
      "capability-escalation: filed board approval for plugin capability escalation",
    );
    return created.id;
  }

  return { findPending, file, findApproved };
}

// ---------------------------------------------------------------------------
// Resolver registry (breaks the approvals -> loader import cycle)
// ---------------------------------------------------------------------------

/**
 * Resolver the host registers to apply a board decision to a parked upgrade.
 * Implemented at the lifecycle layer so it can re-activate the worker after
 * `completeUpgrade` / `revertPendingUpgrade` (the loader only mutates DB state).
 */
export type CapabilityEscalationResolver = (input: {
  payload: CapabilityEscalationPayload;
  outcome: CapabilityEscalationOutcome;
  approvalId: string;
}) => Promise<void>;

let registeredResolver: CapabilityEscalationResolver | null = null;

/**
 * Register the resolver that applies a board decision to a parked upgrade.
 * Returns an unregister function. Idempotent re-registration replaces the
 * previous resolver (the host wires exactly one).
 */
export function registerCapabilityEscalationResolver(
  resolver: CapabilityEscalationResolver,
): () => void {
  registeredResolver = resolver;
  return () => {
    if (registeredResolver === resolver) registeredResolver = null;
  };
}

/** Test/diagnostic hook: whether a resolver is currently registered. */
export function hasCapabilityEscalationResolver(): boolean {
  return registeredResolver !== null;
}

/**
 * Dispatch a resolved escalation approval to the registered resolver. Called by
 * the approvals service on approve/reject. A no-op (with a warning) when no
 * resolver is registered, so approval resolution never fails on a host that has
 * not wired the gate — the parked plugin simply stays `upgrade_pending` until
 * the resolver is wired and the decision re-applied.
 */
export async function dispatchCapabilityEscalationResolution(input: {
  payload: unknown;
  outcome: CapabilityEscalationOutcome;
  approvalId: string;
}): Promise<void> {
  const { payload, outcome, approvalId } = input;
  if (!isCapabilityEscalationPayload(payload)) return;

  if (!registeredResolver) {
    log.warn(
      { approvalId, pluginId: payload.pluginId, outcome },
      "capability-escalation: approval resolved but no resolver registered — parked plugin left in upgrade_pending",
    );
    return;
  }

  log.info(
    { approvalId, pluginId: payload.pluginId, toVersion: payload.toVersion, outcome },
    "capability-escalation: applying board decision to parked plugin upgrade",
  );
  await registeredResolver({ payload, outcome, approvalId });
}

/** Test-only: clear the registered resolver. */
export function __resetCapabilityEscalationResolverForTests(): void {
  registeredResolver = null;
}
