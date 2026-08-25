import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys } from "@paperclipai/db";
import {
  isAgentApiKeyExpired,
  normalizeAgentApiKeyScope,
  type BridgeKeyVerifyResult,
} from "@paperclipai/shared";

/**
 * Pure classification of the two `agent_api_keys` lookups behind the
 * `task_bridge` credential check. Split out from the DB-touching factory so
 * the full refusal taxonomy (missing / revoked / expired / scope-mismatch)
 * is unit-testable without a database.
 *
 * `liveRow` is the lookup WITH the `revokedAt IS NULL` filter (a live row);
 * `anyRow` is the same key hash looked up WITHOUT it, used only to tell a
 * revoked key (`key_revoked`) from one this company never minted
 * (`key_missing`) when no live row exists.
 */
export function classifyAgentApiKeyRow(input: {
  liveRow: { id: string; scopeConfig: unknown; expiresAt: Date | string | null } | null;
  anyRow: { id: string } | null;
  now?: Date;
}): BridgeKeyVerifyResult {
  const { liveRow } = input;
  if (!liveRow) {
    return input.anyRow
      ? { ok: false, code: "key_revoked", keyId: input.anyRow.id }
      : { ok: false, code: "key_missing" };
  }
  if (isAgentApiKeyExpired(liveRow.expiresAt, input.now)) {
    const expiresAt = liveRow.expiresAt instanceof Date
      ? liveRow.expiresAt
      : new Date(liveRow.expiresAt ?? 0);
    return {
      ok: false,
      code: "key_expired",
      keyId: liveRow.id,
      ...(Number.isNaN(expiresAt.getTime()) ? {} : { expiresAt: expiresAt.toISOString() }),
    };
  }
  const scopeKind = normalizeAgentApiKeyScope(liveRow.scopeConfig).kind;
  if (scopeKind !== "task_bridge") {
    return { ok: false, code: "key_scope_mismatch", keyId: liveRow.id, actualScopeKind: scopeKind };
  }
  return { ok: true };
}

/**
 * Build the bridge-key verifier for one company. This is THE shared verifier:
 * the heartbeat consumer path (sanctioned `PAPERCLIP_BRIDGE_API_KEY`
 * delivery) and the task_bridge auto-renewer's post-rotation verification
 * both use it, so both sides classify identically — one code path.
 */
export function createTaskBridgeKeyClassifier(db: Db, companyId: string) {
  return async (resolvedKey: string): Promise<BridgeKeyVerifyResult> => {
    const tokenHash = createHash("sha256").update(resolvedKey).digest("hex");
    // INFO (defense-in-depth): scope the lookup to this company so an operator
    // who accidentally stores a cross-company key as a company secret cannot
    // have it pass the task_bridge scope check here. Boundary enforcement
    // (projectId/parentIssueId/allowedAssigneeAgentIds) still belongs at the
    // task_bridge API on use; this is a cheap extra fence.
    const [liveRow] = await db
      .select({
        id: agentApiKeys.id,
        scopeConfig: agentApiKeys.scopeConfig,
        expiresAt: agentApiKeys.expiresAt,
      })
      .from(agentApiKeys)
      .where(and(
        eq(agentApiKeys.keyHash, tokenHash),
        eq(agentApiKeys.companyId, companyId),
        isNull(agentApiKeys.revokedAt),
      ))
      .limit(1);
    if (liveRow) {
      return classifyAgentApiKeyRow({ liveRow, anyRow: null });
    }
    // No LIVE row: a second lookup WITHOUT the `revokedAt IS NULL` filter
    // distinguishes a deliberately revoked key from a missing one.
    const [anyRow] = await db
      .select({ id: agentApiKeys.id })
      .from(agentApiKeys)
      .where(and(
        eq(agentApiKeys.keyHash, tokenHash),
        eq(agentApiKeys.companyId, companyId),
      ))
      .limit(1);
    return classifyAgentApiKeyRow({ liveRow: null, anyRow: anyRow ?? null });
  };
}
