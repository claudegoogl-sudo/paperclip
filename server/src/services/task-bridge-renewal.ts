import { createHash } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentApiKeys,
  agentKeyRenewalEvents,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
} from "@paperclipai/db";
import {
  bindingAutoRenewPolicySchema,
  type BindingAutoRenewPolicy,
  type BridgeKeyVerifyResult,
  type TaskBridgeAgentKeyScope,
} from "@paperclipai/shared";
import { agentService } from "./agents.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import { secretService } from "./secrets.js";
import { createTaskBridgeKeyClassifier, SANCTIONED_BRIDGE_ENV_KEY } from "./task-bridge-keys.js";

/**
 * Sweep cadence. Hourly, giving >= 8 retry attempts inside the 8h renewal
 * lead window before the 24h clamp expires a key.
 */
export const TASK_BRIDGE_RENEWAL_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Renew when the remaining TTL of the bound key drops to this horizon, so a
 * failed rotation has hours of retries left before the key dies.
 */
export const TASK_BRIDGE_RENEWAL_LEAD_MS = 8 * 60 * 60 * 1000;

/** Actor marker for version rows + audit provenance written by the renewer. */
export const TASK_BRIDGE_RENEWER_SYSTEM_ACTOR = "system:task-bridge-renewer";

export type RenewalTrigger = "scheduled" | "recovery" | "rollback" | "reconcile";

export interface RenewalEventInput {
  companyId: string;
  bindingId: string;
  agentId: string;
  trigger: RenewalTrigger;
  outcome: string;
  oldKeyId?: string | null;
  newKeyId?: string | null;
  newExpiresAt?: Date | null;
  scopeSnapshot?: TaskBridgeAgentKeyScope | null;
  errorCode?: string | null;
}

/**
 * Fault-injectable seams. The defaults bind to the real services; tests wrap
 * individual functions to fail a specific rotation stage (mint / append /
 * verify / revoke) against otherwise-real database state.
 */
export interface TaskBridgeRenewalDeps {
  createKey: (input: {
    agentId: string;
    name: string;
    scope: TaskBridgeAgentKeyScope;
    responsibleUserId: string;
  }) => Promise<{ id: string; token: string; expiresAt: Date | null }>;
  rotateSecret: (input: { secretId: string; value: string; rotationJobId: string }) => Promise<void>;
  revokeKey: (agentId: string, keyId: string) => Promise<unknown>;
  classify: (companyId: string, resolvedKey: string, now?: Date) => Promise<BridgeKeyVerifyResult>;
  /** Resolve the binding's current `latest` plaintext (the real env-binding path). */
  resolveLatestValue: (input: { companyId: string; agentId: string; secretId: string }) => Promise<string | null>;
  /**
   * Roll a botched rotation back to the previous secret version — but only
   * when the version currently at `latest` is still the one THIS rotation
   * appended (matched by its `rotationJobId`). Returns the version rolled
   * back to, `"superseded"` when `latest` was rewritten by someone else
   * (operator rotation, another job) and must not be touched, or `null` when
   * no rollback was possible at all.
   */
  rollbackLatestVersion: (input: { secretId: string; rotationJobId: string }) => Promise<number | "superseded" | null>;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * String values a boundary field contributes to the effective scope — same
 * semantics as `scopeAllows` in authorization.ts: a bare string is one entry,
 * an array contributes its non-empty string entries (trimmed), and anything
 * else (absent, null, empty) enumerates nothing.
 */
function scopeValueList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function dedupeSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Deterministic JSON for values of unknown scope fields: object keys sorted at
 * every depth, so key-order variation inside a preserved field cannot
 * differentiate two otherwise-equal scopes. Arrays keep their order — only the
 * known boundary fields get set semantics.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Canonical form of a task_bridge scope for equality comparison.
 *
 * Enforcement (`scopeAllows`) unions the singular and plural forms of each
 * boundary before matching, so `{projectId: X}` and `{projectIds: [X]}` are
 * the SAME effective scope: a key minted in one shape authorizes exactly what
 * a policy pinned in the other shape enumerates. The renewer's comparisons —
 * the scope-drift check and the stray-key skip — must therefore compare
 * effective sets, not raw bytes; a byte comparison spuriously suspends on
 * shape variation that changes nothing about what the key can do.
 *
 * Fail-closed by construction: `kind` must be `task_bridge`; boundary fields
 * union, dedupe, and sort (order and duplicates carry no boundary); and any
 * field OUTSIDE the known vocabulary is preserved verbatim (key-sorted), so a
 * scope carrying unknown structure can never canonicalize equal to a pinned
 * policy — unexplainable differences still suspend. Non-object shapes (null
 * included, e.g. a standard key's null `scopeConfig`) never equal a policy
 * scope.
 */
function canonicalTaskBridgeScope(scope: unknown): string | null {
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) return null;
  const record = scope as Record<string, unknown>;
  if (record.kind !== "task_bridge") return null;
  const projects = [
    ...scopeValueList(record.projectId),
    ...scopeValueList(record.projectIds),
  ];
  const parents = [
    ...scopeValueList(record.parentIssueId),
    ...scopeValueList(record.parentIssueIds),
  ];
  const assignees = scopeValueList(record.allowedAssigneeAgentIds);
  const knownFields = new Set([
    "kind",
    "projectId",
    "projectIds",
    "parentIssueId",
    "parentIssueIds",
    "allowedAssigneeAgentIds",
  ]);
  // Null prototype: an own `__proto__` key (e.g. planted by JSON.parse of a
  // corrupted row) must land in `rest` as a data property, not vanish into
  // Object.prototype's setter — unknown fields stay verbatim, never equal.
  const rest: Record<string, string> = Object.create(null);
  for (const key of Object.keys(record)) {
    if (!knownFields.has(key)) rest[key] = stableStringify(record[key]);
  }
  return JSON.stringify({
    kind: "task_bridge",
    projectIds: dedupeSorted(projects),
    parentIssueIds: dedupeSorted(parents),
    allowedAssigneeAgentIds: dedupeSorted(assignees),
    rest,
  });
}

export function scopeEquals(a: unknown, b: unknown): boolean {
  // Null-guard: two non-task_bridge shapes both canonicalize to null; without
  // this guard `null === null` would alias every malformed pair to "equal".
  const canonicalA = canonicalTaskBridgeScope(a);
  const canonicalB = canonicalTaskBridgeScope(b);
  return canonicalA !== null && canonicalA === canonicalB;
}

/**
 * Closed errorCode vocabulary for renewal audit rows. Raw `Error.message` is
 * NEVER stored verbatim: a Postgres unique violation on `key_hash`, for
 * example, embeds the hex digest in its message, and these rows are
 * board-visible. Known error classes (pg error codes, Node system errors)
 * map to a fixed code; anything else degrades to `unknown:<name>` plus a
 * scrubbed, truncated fragment. Hex runs of 16+ chars — key hashes and bare
 * uuids alike — never survive scrubbing.
 */
const ERROR_CODE_VOCABULARY: Record<string, string> = {
  // Postgres SQLSTATE codes
  "23505": "db_unique_violation",
  "23503": "db_foreign_key_violation",
  "23502": "db_not_null_violation",
  "23514": "db_check_violation",
  "22P02": "db_invalid_representation",
  "40001": "db_serialization_failure",
  "40P01": "db_deadlock_detected",
  "57014": "db_query_canceled",
  // Node system-error codes
  ECONNREFUSED: "connection_refused",
  ETIMEDOUT: "connection_timed_out",
  ENOTFOUND: "dns_not_found",
};

function scrubErrorMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{16,}/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function renewalErrorCode(err: unknown, fallback: string, maxLength = 200): string {
  const error = err as { code?: unknown; name?: unknown; message?: unknown } | null | undefined;
  const code = typeof error?.code === "string" ? error.code : "";
  const mapped = ERROR_CODE_VOCABULARY[code];
  if (mapped) return mapped;
  if (error === null || error === undefined) return fallback;
  const name = typeof error.name === "string" && error.name ? error.name : "Error";
  const message = typeof error.message === "string" ? scrubErrorMessage(error.message) : "";
  return `unknown:${name}${message ? `:${message}` : ""}`.slice(0, maxLength);
}

/**
 * Every renewal attempt — success, per-stage failure, suspension, recovery,
 * reconciliation cleanup — writes ALL THREE audit records: the append-only
 * `agent_key_renewal_events` row, a system activity-feed row, and a pino
 * line with a stable message. Minting without an event row is impossible
 * because the same function writes both. Key plaintext and key hashes NEVER
 * appear in any of them — ids, timestamps, and the non-secret scope snapshot
 * only.
 */
export async function recordRenewalEvent(db: Db, event: RenewalEventInput): Promise<void> {
  await db.insert(agentKeyRenewalEvents).values({
    companyId: event.companyId,
    bindingId: event.bindingId,
    agentId: event.agentId,
    trigger: event.trigger,
    outcome: event.outcome,
    oldKeyId: event.oldKeyId ?? null,
    newKeyId: event.newKeyId ?? null,
    newExpiresAt: event.newExpiresAt ?? null,
    scopeSnapshot: event.scopeSnapshot ?? null,
    errorCode: event.errorCode ?? null,
  });
  const succeeded = event.outcome === "success";
  const action = succeeded
    ? "agent.key_auto_renewed"
    : event.outcome.startsWith("suspended:")
      ? "agent.key_auto_renew_suspended"
      : "agent.key_auto_renewal_failed";
  await logActivity(db, {
    companyId: event.companyId,
    actorType: "system",
    actorId: TASK_BRIDGE_RENEWER_SYSTEM_ACTOR,
    action,
    entityType: "agent",
    entityId: event.agentId,
    agentId: event.agentId,
    details: {
      bindingId: event.bindingId,
      trigger: event.trigger,
      outcome: event.outcome,
      keyIds: [event.oldKeyId, event.newKeyId].filter(Boolean),
      ...(event.newExpiresAt ? { expiresAt: event.newExpiresAt.toISOString() } : {}),
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      scope: event.scopeSnapshot ?? null,
    },
  });
  const message = succeeded
    ? "task_bridge key auto-renewed"
    : event.outcome.startsWith("suspended:")
      ? "task_bridge key auto-renew suspended"
      : "task_bridge key auto-renew failed";
  (succeeded ? logger.info : logger.warn).call(logger, {
    bindingId: event.bindingId,
    agentId: event.agentId,
    trigger: event.trigger,
    outcome: event.outcome,
    oldKeyId: event.oldKeyId ?? null,
    newKeyId: event.newKeyId ?? null,
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
  }, message);
}

function defaultDeps(db: Db): TaskBridgeRenewalDeps {
  const agents = agentService(db);
  const secrets = secretService(db);
  return {
    createKey: async ({ agentId, name, scope, responsibleUserId }) =>
      agents.createApiKey(agentId, name, scope, { responsibleUserId, ttlSeconds: null }),
    rotateSecret: async ({ secretId, value, rotationJobId }) => {
      await secrets.rotate(secretId, { value, rotationJobId }, { userId: TASK_BRIDGE_RENEWER_SYSTEM_ACTOR });
    },
    revokeKey: (agentId, keyId) => agents.revokeKey(agentId, keyId),
    classify: (companyId, resolvedKey, now) => createTaskBridgeKeyClassifier(db, companyId)(resolvedKey, now),
    resolveLatestValue: async ({ companyId, agentId, secretId }) => {
      try {
        // configPath is derived inside resolveEnvBindings as `env.<key>` per
        // entry — the context only carries the consumer identity.
        const resolution = await secrets.resolveEnvBindings(
          companyId,
          { [SANCTIONED_BRIDGE_ENV_KEY]: { type: "secret_ref", secretId, version: "latest" } },
          {
            consumerType: "agent",
            consumerId: agentId,
          },
        );
        return resolution.env[SANCTIONED_BRIDGE_ENV_KEY] ?? null;
      } catch {
        return null;
      }
    },
    rollbackLatestVersion: async ({ secretId, rotationJobId }) => {
      // Single transaction (secret row locked FOR UPDATE) so the ownership
      // check and the rollback commit atomically: a concurrent `rotate` that
      // flips `latest` between the check and the write cannot slip through.
      return db.transaction(async (tx) => {
        const [secret] = await tx
          .select({ id: companySecrets.id, latestVersion: companySecrets.latestVersion })
          .from(companySecrets)
          .where(eq(companySecrets.id, secretId))
          .limit(1)
          .for("update");
        if (!secret || secret.latestVersion <= 1) return null;
        // Ownership guard: only roll back when the version currently at
        // `latest` is the one this rotation appended. If an operator (or any
        // other writer) rotated in the meantime, `latest` is theirs —
        // destroying it would break the binding and pin the blame on a key
        // the renewer itself revoked. Skip instead; the verify-failure path
        // below still revokes the renewer's own stray key.
        const [latestRow] = await tx
          .select({ rotationJobId: companySecretVersions.rotationJobId })
          .from(companySecretVersions)
          .where(and(
            eq(companySecretVersions.secretId, secretId),
            eq(companySecretVersions.version, secret.latestVersion),
          ))
          .limit(1);
        if (latestRow?.rotationJobId !== rotationJobId) return "superseded" as const;
        const versions = await tx
          .select({ version: companySecretVersions.version, status: companySecretVersions.status })
          .from(companySecretVersions)
          .where(eq(companySecretVersions.secretId, secretId));
        const previous = versions
          .filter((v) => v.version < secret.latestVersion && v.status !== "destroyed" && v.status !== "disabled")
          .sort((a, b) => b.version - a.version)[0];
        if (!previous) return null;
        await tx
          .update(companySecretVersions)
          .set({ status: "destroyed" })
          .where(and(
            eq(companySecretVersions.secretId, secretId),
            eq(companySecretVersions.version, secret.latestVersion),
          ));
        await tx
          .update(companySecretVersions)
          .set({ status: "current" })
          .where(and(
            eq(companySecretVersions.secretId, secretId),
            eq(companySecretVersions.version, previous.version),
          ));
        await tx
          .update(companySecrets)
          .set({ latestVersion: previous.version })
          .where(eq(companySecrets.id, secretId));
        return previous.version;
      });
    },
  };
}

export interface SweepResult {
  policies: number;
  renewed: number;
  recovered: number;
  suspended: number;
  failed: number;
  reconciled: number;
}

interface PolicyBindingRow {
  binding: typeof companySecretBindings.$inferSelect;
  policy: BindingAutoRenewPolicy;
}

async function findLiveKeyRowForValue(db: Db, companyId: string, value: string) {
  const [row] = await db
    .select({
      id: agentApiKeys.id,
      scopeConfig: agentApiKeys.scopeConfig,
      expiresAt: agentApiKeys.expiresAt,
    })
    .from(agentApiKeys)
    .where(and(
      eq(agentApiKeys.keyHash, sha256Hex(value)),
      eq(agentApiKeys.companyId, companyId),
      isNull(agentApiKeys.revokedAt),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * Rotate one policy binding's task_bridge key.
 *
 * THE INVARIANT: at every commit point, the binding's `latest` secret version
 * resolves to a key row that is live (revokedAt null, not expired). The old
 * key is revoked ONLY after a newer committed version has been verified to
 * resolve and classify ok.
 *
 * Ordering: mint -> append version -> verify (both) -> revoke old -> audit.
 * Failures reconcile on the next sweep instead of relying on a distributed
 * transaction (see the crash-state table in the module docs of the design).
 */
async function rotateBindingKey(
  db: Db,
  deps: TaskBridgeRenewalDeps,
  row: PolicyBindingRow,
  input: { trigger: RenewalTrigger; oldKeyId: string | null; now?: Date },
): Promise<"success" | "failed"> {
  const { binding, policy } = row;
  const agentId = binding.targetId;

  // 1. Mint. ttlSeconds is deliberately null: the 24h clamp is applied inside
  //    createApiKey itself (computeAgentKeyExpiresAt), so the renewer has no
  //    clamp-bypass path by construction — even against a hostile policy
  //    snapshot carrying a fat TTL-ish field.
  let newKey: { id: string; token: string; expiresAt: Date | null };
  try {
    newKey = await deps.createKey({
      agentId,
      name: `task_bridge auto-renew ${binding.id.slice(0, 8)}`,
      scope: policy.scope,
      responsibleUserId: policy.authorizedByUserId,
    });
  } catch (err) {
    await recordRenewalEvent(db, {
      companyId: binding.companyId, bindingId: binding.id, agentId,
      trigger: input.trigger, outcome: "failed:mint",
      oldKeyId: input.oldKeyId, scopeSnapshot: policy.scope,
      errorCode: renewalErrorCode(err, "mint_error"),
    });
    return "failed";
  }

  // 2. Append a new secret version. One transaction inside rotate() flips
  //    `latest` atomically.
  const rotationJobId = `task-bridge-renew:${binding.id}:${newKey.id}`;
  try {
    await deps.rotateSecret({ secretId: binding.secretId, value: newKey.token, rotationJobId });
  } catch (err) {
    // Fail at 2: revoke the just-minted stray key; old key untouched; retry
    // next sweep.
    await deps.revokeKey(agentId, newKey.id).catch(() => {});
    await recordRenewalEvent(db, {
      companyId: binding.companyId, bindingId: binding.id, agentId,
      trigger: input.trigger, outcome: "failed:append_version",
      oldKeyId: input.oldKeyId, newKeyId: newKey.id,
      scopeSnapshot: policy.scope,
      errorCode: renewalErrorCode(err, "append_version_error"),
    });
    return "failed";
  }

  // 3. Verify BOTH: (a) the binding's `latest` now resolves to the new key's
  //    hash; (b) the shared classifier — the same one the consumer path
  //    uses — classifies the new plaintext ok.
  const verifyFailure = await (async (): Promise<string | null> => {
    try {
      const resolved = await deps.resolveLatestValue({
        companyId: binding.companyId, agentId, secretId: binding.secretId,
      });
      if (resolved === null) return "resolve_returned_null";
      if (sha256Hex(resolved) !== sha256Hex(newKey.token)) return "latest_hash_mismatch";
      const classification = await deps.classify(binding.companyId, newKey.token, input.now);
      if (!classification.ok) return `classify_${classification.code}`;
      return null;
    } catch (err) {
      // Prefix + helper output kept under the 200-char errorCode convention.
      return `verify_error:${renewalErrorCode(err, "unknown", 180)}`;
    }
  })();

  if (verifyFailure !== null) {
    // Fail at 3: do NOT revoke the old key. Roll the new version back so
    // `latest` reverts to the previous version — unless `latest` was already
    // rewritten by a concurrent (operator) rotation, in which case it is
    // theirs and must survive. If the rollback itself fails, alert loudly —
    // the binding then points at the NEW key, which is itself live and
    // valid, so the invariant still holds.
    const rolledBack = await deps
      .rollbackLatestVersion({ secretId: binding.secretId, rotationJobId })
      .catch(() => null);
    if (rolledBack === null) {
      logger.error(
        { bindingId: binding.id, secretId: binding.secretId, rotationJobId, verifyFailure },
        "task_bridge renewal verify failed AND version rollback failed; binding points at the newly minted (live, valid) key — investigate",
      );
    } else if (rolledBack === "superseded") {
      logger.warn(
        { bindingId: binding.id, secretId: binding.secretId, rotationJobId, verifyFailure },
        "task_bridge renewal verify failed but version rollback skipped: `latest` was superseded by a concurrent rotation (operator?) — leaving it untouched",
      );
    }
    await deps.revokeKey(agentId, newKey.id).catch(() => {});
    await recordRenewalEvent(db, {
      companyId: binding.companyId, bindingId: binding.id, agentId,
      trigger: "rollback", outcome: "failed:verify",
      oldKeyId: input.oldKeyId, newKeyId: newKey.id,
      scopeSnapshot: policy.scope, errorCode: verifyFailure,
    });
    return "failed";
  }

  // 4. Only now revoke the old key. If this fails the binding is already
  // healthy on the new key; the lingering old key is live-but-unreferenced
  // and reconciliation revokes it on the next sweep (converges).
  if (input.oldKeyId) {
    try {
      await deps.revokeKey(agentId, input.oldKeyId);
    } catch (err) {
      await recordRenewalEvent(db, {
        companyId: binding.companyId, bindingId: binding.id, agentId,
        trigger: input.trigger, outcome: "failed:revoke_old",
        oldKeyId: input.oldKeyId, newKeyId: newKey.id,
        newExpiresAt: newKey.expiresAt, scopeSnapshot: policy.scope,
        errorCode: renewalErrorCode(err, "revoke_error"),
      });
      return "failed";
    }
  }

  // 5. Audit the success.
  await recordRenewalEvent(db, {
    companyId: binding.companyId, bindingId: binding.id, agentId,
    trigger: input.trigger, outcome: "success",
    oldKeyId: input.oldKeyId, newKeyId: newKey.id,
    newExpiresAt: newKey.expiresAt, scopeSnapshot: policy.scope,
  });
  return "success";
}

async function suspend(
  db: Db,
  row: PolicyBindingRow,
  reason: string,
  extra?: { trigger?: RenewalTrigger; oldKeyId?: string | null; errorCode?: string | null },
): Promise<void> {
  await recordRenewalEvent(db, {
    companyId: row.binding.companyId,
    bindingId: row.binding.id,
    agentId: row.binding.targetId,
    trigger: extra?.trigger ?? "scheduled",
    outcome: `suspended:${reason}`,
    oldKeyId: extra?.oldKeyId ?? null,
    scopeSnapshot: row.policy.scope,
    errorCode: extra?.errorCode ?? null,
  });
}

/**
 * Reconciliation: any LIVE key of this agent whose scope exactly equals the
 * pinned snapshot, other than the one the binding currently resolves to, is
 * a stray from an interrupted rotation (crash between mint and append, or
 * between append and revoke). Revoke it. This is what makes every crash
 * state converge to exactly one live key without a distributed transaction.
 */
async function reconcileStrayKeys(
  db: Db,
  deps: TaskBridgeRenewalDeps,
  row: PolicyBindingRow,
  liveKeyValue: string | null,
): Promise<number> {
  const liveKeyHash = liveKeyValue === null ? null : sha256Hex(liveKeyValue);
  const strays = await db
    .select({ id: agentApiKeys.id })
    .from(agentApiKeys)
    .where(and(
      eq(agentApiKeys.agentId, row.binding.targetId),
      eq(agentApiKeys.companyId, row.binding.companyId),
      isNull(agentApiKeys.revokedAt),
    ));
  let revoked = 0;
  for (const stray of strays) {
    const [detail] = await db
      .select({ scopeConfig: agentApiKeys.scopeConfig, keyHash: agentApiKeys.keyHash })
      .from(agentApiKeys)
      .where(eq(agentApiKeys.id, stray.id))
      .limit(1);
    if (!detail) continue;
    if (!scopeEquals(detail.scopeConfig, row.policy.scope)) continue; // not ours to touch
    if (liveKeyHash !== null && detail.keyHash === liveKeyHash) continue; // the bound key
    await deps.revokeKey(row.binding.targetId, stray.id).catch(() => {});
    revoked += 1;
    await recordRenewalEvent(db, {
      companyId: row.binding.companyId,
      bindingId: row.binding.id,
      agentId: row.binding.targetId,
      trigger: "reconcile",
      outcome: "success",
      oldKeyId: stray.id,
      scopeSnapshot: row.policy.scope,
    });
  }
  return revoked;
}

async function renewOneBinding(
  db: Db,
  deps: TaskBridgeRenewalDeps,
  binding: typeof companySecretBindings.$inferSelect,
  now: Date,
): Promise<Pick<SweepResult, "renewed" | "recovered" | "suspended" | "failed" | "reconciled">> {
  const counters = { renewed: 0, recovered: 0, suspended: 0, failed: 0, reconciled: 0 };

  // Policy shape re-validated on EVERY sweep: a drifted/corrupt row suspends
  // (fail-closed, audited) rather than being trusted.
  const parsedPolicy = bindingAutoRenewPolicySchema.safeParse(binding.autoRenewPolicy);
  if (!parsedPolicy.success) {
    // The stored policy failed re-validation (drifted or corrupt). No policy
    // object exists to snapshot — record the suspension directly with a null
    // scopeSnapshot rather than fabricating one.
    await recordRenewalEvent(db, {
      companyId: binding.companyId,
      bindingId: binding.id,
      agentId: binding.targetId,
      trigger: "scheduled",
      outcome: "suspended:policy_invalid",
      scopeSnapshot: null,
      // Zod issue codes are a closed vocabulary and carry no received values,
      // unlike issue messages.
      errorCode: `policy_invalid:${parsedPolicy.error.issues[0]?.code ?? "unknown"}`.slice(0, 200),
    });
    counters.suspended += 1;
    return counters;
  }
  const row: PolicyBindingRow = { binding, policy: parsedPolicy.data };
  if (!row.policy.enabled) return counters; // opted out; snapshot retained

  // Binding shape gate: the renewer only understands the sanctioned bridge
  // slot resolved via `latest`.
  if (
    binding.targetType !== "agent"
    || binding.configPath !== `env.${SANCTIONED_BRIDGE_ENV_KEY}`
    || binding.versionSelector !== "latest"
  ) {
    await suspend(db, row, "binding_shape");
    counters.suspended += 1;
    return counters;
  }

  // Resolve what `latest` currently delivers — via the REAL env-binding
  // resolution path, which enforces the binding row exists for
  // (agent, env.PAPERCLIP_BRIDGE_API_KEY) before resolving.
  const value = await deps.resolveLatestValue({
    companyId: binding.companyId,
    agentId: binding.targetId,
    secretId: binding.secretId,
  });
  if (value === null) {
    await suspend(db, row, "secret_unresolved");
    counters.suspended += 1;
    return counters;
  }

  const classification = await deps.classify(binding.companyId, value, now);
  if (!classification.ok && classification.code === "key_revoked") {
    // Deliberate operator revocation: operator intent beats availability
    // (Separation of Duties). The renewer must never un-revoke what a human
    // revoked.
    await suspend(db, row, "key_revoked_by_operator", {
      ...(classification.keyId ? { oldKeyId: classification.keyId } : {}),
    });
    counters.suspended += 1;
    return counters;
  }
  if (!classification.ok && classification.code === "key_scope_mismatch") {
    await suspend(db, row, "scope_mismatch", {
      errorCode: classification.actualScopeKind ?? null,
    });
    counters.suspended += 1;
    return counters;
  }

  const trigger: RenewalTrigger = classification.ok ? "scheduled" : "recovery";
  let oldKeyId: string | null = null;
  if (classification.ok) {
    const liveRow = await findLiveKeyRowForValue(db, binding.companyId, value);
    if (!liveRow) {
      // Classified ok but row vanished between calls — treat as missing.
      const result = await rotateBindingKey(db, deps, row, { trigger: "recovery", oldKeyId: null, now });
      counters[result === "success" ? "recovered" : "failed"] += 1;
      return counters;
    }
    // Scope pinning: the live key's scope must EXACTLY equal the pinned
    // snapshot. Drift in either direction suspends — never auto-propagates —
    // because a human changed something.
    if (!scopeEquals(liveRow.scopeConfig, row.policy.scope)) {
      await suspend(db, row, "scope_drift", { oldKeyId: liveRow.id });
      counters.suspended += 1;
      return counters;
    }
    if (liveRow.expiresAt === null) {
      // task_bridge keys are clamped to a 24h ceiling at mint; a non-expiring
      // one is an invariant violation — do not silently adopt it.
      await suspend(db, row, "unexpected_nonexpiring_key", { oldKeyId: liveRow.id });
      counters.suspended += 1;
      return counters;
    }
    const remainingMs = liveRow.expiresAt.getTime() - now.getTime();
    if (remainingMs > TASK_BRIDGE_RENEWAL_LEAD_MS) {
      // Healthy and not yet inside the renewal lead window. Reconcile any
      // strays from an interrupted earlier rotation, then done.
      counters.reconciled += await reconcileStrayKeys(db, deps, row, value);
      return counters;
    }
    oldKeyId = liveRow.id;
  } else if (classification.code === "key_expired" || classification.code === "key_missing") {
    // Natural expiry or a missing row: emergency re-mint from the snapshot.
    // This is the steady-state recovery path — the first sweep after an
    // operator opts in typically finds the key already expired.
    const result = await rotateBindingKey(db, deps, row, { trigger: "recovery", oldKeyId: null, now });
    counters[result === "success" ? "recovered" : "failed"] += 1;
    return counters;
  }

  const result = await rotateBindingKey(db, deps, row, { trigger, oldKeyId, now });
  if (result === "success") {
    counters[trigger === "recovery" ? "recovered" : "renewed"] += 1;
  } else {
    counters.failed += 1;
  }
  return counters;
}

/**
 * One renewal sweep pass. Selects every binding carrying a non-null
 * auto-renew policy (default-deny: NULL is never touched, even at expiry)
 * and drives each to a terminal outcome for this pass.
 */
export async function runTaskBridgeRenewalSweep(
  db: Db,
  options?: { deps?: Partial<TaskBridgeRenewalDeps>; now?: Date },
): Promise<SweepResult> {
  const deps = { ...defaultDeps(db), ...(options?.deps ?? {}) };
  const now = options?.now ?? new Date();
  const result: SweepResult = {
    policies: 0, renewed: 0, recovered: 0, suspended: 0, failed: 0, reconciled: 0,
  };
  const rows = await db
    .select()
    .from(companySecretBindings)
    .where(isNotNull(companySecretBindings.autoRenewPolicy));
  for (const binding of rows) {
    result.policies += 1;
    try {
      const counters = await renewOneBinding(db, deps, binding, now);
      result.renewed += counters.renewed;
      result.recovered += counters.recovered;
      result.suspended += counters.suspended;
      result.failed += counters.failed;
      result.reconciled += counters.reconciled;
    } catch (err) {
      // One bad binding never kills the sweep.
      result.failed += 1;
      logger.error({ err, bindingId: binding.id }, "task_bridge renewal pass crashed for a binding");
    }
  }
  return result;
}

/**
 * Start the in-process renewal sweep timer.
 *
 * Deliberately registered UNCONDITIONALLY in server startup — NOT gated by
 * `heartbeatSchedulerEnabled` and not subject to heartbeat suppression, for
 * the same failure-open reason the egress posture sweep documents: a
 * security/continuity loop that silently stops when an unrelated scheduling
 * flag is off is failure-open. The sweep is the only system-privileged
 * scheduler: it runs inside the untokened server process, calls internal
 * services directly, and registers NO route — nothing agent-callable can
 * trigger, schedule, or parameterize a renewal.
 *
 * CONCURRENCY NOTE (single-process assumption): serialization relies on this
 * being the only sweep in the process (enforced by the in-flight guard
 * below). If the server ever runs multi-instance, a per-policy Postgres
 * advisory lock (`pg_try_advisory_lock(hashtext(binding_id))` around each
 * binding's pass) is MANDATORY before scaling out — two sweeps racing one
 * binding could double-mint and interleave version appends.
 */
export function startTaskBridgeRenewalSweep(
  db: Db,
  intervalMs: number = TASK_BRIDGE_RENEWAL_SWEEP_INTERVAL_MS,
): () => void {
  let sweeping = false;
  const tick = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const result = await runTaskBridgeRenewalSweep(db);
      if (result.renewed + result.recovered + result.suspended + result.failed + result.reconciled > 0) {
        logger.info({ ...result }, "task_bridge renewal sweep completed");
      }
    } catch (err) {
      logger.error({ err }, "task_bridge renewal sweep failed");
    } finally {
      sweeping = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
