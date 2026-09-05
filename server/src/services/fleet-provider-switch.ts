import type { Db } from "@paperclipai/db";
import { agentService, mergeAdapterConfigPatch } from "./agents.js";

/**
 * Host-side implementation of the `fleet.switchProvider` worker→host RPC.
 *
 * Design ref: PLA-6161 (spike/design), PLA-6162 (SecurityEngineer conditional
 * approve, conditions D1-D6), PLA-6163 (this implementation).
 *
 * SECURITY-CRITICAL: this module is the ONLY place that is allowed to flip an
 * agent's LLM provider/model on manual antbot/zbot trigger. Every condition
 * below is load-bearing; do not relax one to fix a caller.
 */

/**
 * D1: the dispatching agent id MUST come from the host-validated
 * `invocationScope` surfaced on a worker→host call for a REAL in-flight
 * dispatch (`WorkerHostCallContext.invocationScope`, populated by
 * `plugin-worker-manager.ts` from its own `activeInvocations` registry).
 *
 * It must NOT be taken from:
 *  - `singleInFlightScope` (an inference the host makes for legacy workers
 *    that cannot echo an invocation id — explicitly documented as unsafe for
 *    anything beyond the runId back-fill), or
 *  - `serviceScope` (the worker-lifetime scope attached to every callback,
 *    which carries no dispatching-agent identity at all), or
 *  - anything from the RPC payload.
 *
 * Fails closed (returns null) unless a concrete agentId is bound.
 */
export interface FleetSwitchProviderInvocationScope {
  invocationScope?: { agentId?: string | null; companyId?: string | null; runId?: string | null } | null;
  invalidInvocationScope?: boolean;
  singleInFlightScope?: unknown;
  serviceScope?: unknown;
}

export function resolveDispatchingAgentId(context: FleetSwitchProviderInvocationScope): string | null {
  if (context.invalidInvocationScope) return null;
  const agentId = context.invocationScope?.agentId;
  if (typeof agentId !== "string" || agentId.trim().length === 0) return null;
  return agentId;
}

/** Provider/model an allowlisted agent is switched to. D3: compiled, not agent-editable. */
export const FLEET_PROVIDER_MODEL_MAP: Readonly<Record<string, { provider: string; model: string }>> = Object.freeze({
  antbot: { provider: "anthropic", model: "claude-opus-4-6" },
  zbot: { provider: "zai", model: "glm-4.6" },
});

/**
 * D2: host-side hard allowlist of agent NAMES permitted to trigger a switch.
 * Deliberately not derived from any DB row, config table, or adapterConfig —
 * capability install-gating alone is not treated as sufficient (D2). The
 * plugin-capability grant is a governance action (operator/CTO); this
 * constant is the independent, non-bypassable second gate.
 */
export const FLEET_SWITCH_TRIGGER_AGENT_NAMES: ReadonlySet<string> = new Set(["antbot", "zbot"]);

/**
 * D3: agents that must never be a *target* of a switch, checked by BOTH id and
 * name — the trigger agents themselves (no self/peer switching) plus the
 * claude_local skip-list. Populated at call time from resolved agent rows,
 * see `isExcludedTarget`.
 */
const CLAUDE_LOCAL_SKIP_LIST_NAMES: ReadonlySet<string> = new Set(["CADWorker", "CEO"]);
const CLAUDE_LOCAL_SKIP_LIST_COMPANIES: ReadonlySet<string> = new Set(["3d-models", "paperclipai"]);

export interface FleetAgentRow {
  id: string;
  name: string;
  companyId: string;
  companyUrlKey?: string | null;
  adapterType?: string | null;
  adapterConfig: unknown;
}

/** D3: re-asserted immediately before every write, not just at enumeration time. */
export function isExcludedTarget(agent: FleetAgentRow, triggerAgentIds: ReadonlySet<string>): boolean {
  if (triggerAgentIds.has(agent.id)) return true;
  if (FLEET_SWITCH_TRIGGER_AGENT_NAMES.has(agent.name)) return true;
  if (agent.adapterType === "claude_local") {
    if (CLAUDE_LOCAL_SKIP_LIST_NAMES.has(agent.name)) return true;
    if (agent.companyUrlKey && CLAUDE_LOCAL_SKIP_LIST_COMPANIES.has(agent.companyUrlKey)) return true;
  }
  return false;
}

export type FleetSwitchOutcome = "CHANGED" | "NO_OP" | "SKIPPED" | "FAILED";

export interface FleetSwitchAuditRecord {
  agentId: string;
  agentName: string;
  outcome: FleetSwitchOutcome;
  reason?: string;
  dryRun: boolean;
}

export interface FleetSwitchAuditPoster {
  /** Posts the audit trail to the fixed Platform tracking issue. Must succeed
   * BEFORE the caller reports any per-agent success (D5). */
  postAudit(records: FleetSwitchAuditRecord[], dryRun: boolean): Promise<void>;
}

export interface FleetSwitchFeatureFlag {
  /** D6.2: host-side kill switch, no redeploy required. */
  isEnabled(): boolean;
}

export interface FleetSwitchFirstInvocationGuard {
  /** D6.5: forces the first post-deploy invocation to dry-run regardless of
   * the caller-supplied `dryRun` flag. Must be durable across process
   * restarts (backed by a DB row / file, not in-memory only). */
  consumeIsFirstInvocation(): Promise<boolean>;
}

export interface FleetSwitchDeps {
  db: Db;
  listFleetTargets(triggerAgentId: string): Promise<FleetAgentRow[]>;
  auditPoster: FleetSwitchAuditPoster;
  featureFlag: FleetSwitchFeatureFlag;
  firstInvocationGuard: FleetSwitchFirstInvocationGuard;
}

export interface FleetSwitchProviderParams {
  dryRun?: boolean;
}

export class FleetSwitchProviderDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FleetSwitchProviderDeniedError";
  }
}

export async function handleFleetSwitchProvider(
  context: FleetSwitchProviderInvocationScope,
  params: FleetSwitchProviderParams | undefined,
  deps: FleetSwitchDeps,
): Promise<{ dryRun: boolean; results: FleetSwitchAuditRecord[] }> {
  // D6.2 kill switch, checked before anything else touches the DB.
  if (!deps.featureFlag.isEnabled()) {
    throw new FleetSwitchProviderDeniedError("fleet.switchProvider is disabled by host feature flag");
  }

  // D1: fail closed on identity.
  const dispatchingAgentId = resolveDispatchingAgentId(context);
  if (!dispatchingAgentId) {
    throw new FleetSwitchProviderDeniedError(
      "fleet.switchProvider requires a host-validated dispatch invocationScope with a concrete agentId; refusing (fail closed)",
    );
  }

  // Only `dryRun: boolean` is accepted from the payload; everything else
  // (provider/model/agentId/companyId/env) is host-derived or rejected.
  const requestedDryRun = params?.dryRun === true;
  const forcedFirstRunDryRun = await deps.firstInvocationGuard.consumeIsFirstInvocation();
  const dryRun = requestedDryRun || forcedFirstRunDryRun;

  const targets = await deps.listFleetTargets(dispatchingAgentId);
  const triggerAgent = targets.find((a) => a.id === dispatchingAgentId);

  // D2: independent host-side hard allowlist check on the resolved dispatcher.
  if (!triggerAgent || !FLEET_SWITCH_TRIGGER_AGENT_NAMES.has(triggerAgent.name)) {
    throw new FleetSwitchProviderDeniedError(
      `fleet.switchProvider caller '${dispatchingAgentId}' is not on the host hard allowlist`,
    );
  }

  const triggerAgentIds = new Set(targets.filter((a) => FLEET_SWITCH_TRIGGER_AGENT_NAMES.has(a.name)).map((a) => a.id));
  const svc = agentService(deps.db);
  const records: FleetSwitchAuditRecord[] = [];

  for (const target of targets) {
    // D3: re-assert exclusion immediately before each write, not just at
    // enumeration time.
    if (isExcludedTarget(target, triggerAgentIds)) {
      records.push({ agentId: target.id, agentName: target.name, outcome: "SKIPPED", reason: "excluded target", dryRun });
      continue;
    }
    const desired = FLEET_PROVIDER_MODEL_MAP[triggerAgent.name];
    if (!desired) {
      records.push({ agentId: target.id, agentName: target.name, outcome: "SKIPPED", reason: "no provider mapping", dryRun });
      continue;
    }
    const existingConfig = target.adapterConfig;
    const currentProvider = (existingConfig as Record<string, unknown> | null)?.provider;
    const currentModel = (existingConfig as Record<string, unknown> | null)?.model;
    if (currentProvider === desired.provider && currentModel === desired.model) {
      records.push({ agentId: target.id, agentName: target.name, outcome: "NO_OP", dryRun });
      continue;
    }
    if (dryRun) {
      records.push({ agentId: target.id, agentName: target.name, outcome: "NO_OP", reason: "dry run", dryRun });
      continue;
    }
    try {
      // D4: read-merge-write. Never write a bare {provider, model} patch —
      // that would full-replace adapterConfig and wipe env/secret_ref.
      const mergedAdapterConfig = mergeAdapterConfigPatch(existingConfig, {
        provider: desired.provider,
        model: desired.model,
      });
      await svc.update(target.id, { adapterConfig: mergedAdapterConfig });
      records.push({ agentId: target.id, agentName: target.name, outcome: "CHANGED", dryRun });
    } catch (err) {
      records.push({
        agentId: target.id,
        agentName: target.name,
        outcome: "FAILED",
        reason: err instanceof Error ? err.message : String(err),
        dryRun,
      });
    }
  }

  // D5: write+confirm audit BEFORE reporting success; if it fails, the whole
  // action fails.
  await deps.auditPoster.postAudit(records, dryRun);

  return { dryRun, results: records };
}
