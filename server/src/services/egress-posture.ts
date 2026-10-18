import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  companySecretBindingPostureAudit,
  companySecretBindings,
} from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

/**
 * Derived posture of a borrowed-handle binding.
 *
 * `deny_all` is the state this type exists for. `enforced = true` means "deny
 * everything" or "allow these origins" depending entirely on whether
 * `allowedEgress` is empty, so a caller holding the two fields separately has
 * to perform that inference itself. Nobody performed it for the bindings that
 * were born enforcing with an empty allowlist, and the first symptom would have
 * been a denied call in production. Naming the state is what makes it
 * displayable, alertable, and testable.
 */
export type EgressPosture = "log_only" | "enforcing" | "deny_all";

export function egressPostureFor(binding: {
  egressAllowlistEnforced: boolean;
  allowedEgress: readonly string[];
}): EgressPosture {
  if (!binding.egressAllowlistEnforced) return "log_only";
  return binding.allowedEgress.length === 0 ? "deny_all" : "enforcing";
}

/**
 * Operator-set egress posture of a binding row, carried across a
 * delete+reinsert sync.
 *
 * `company_secret_bindings` rows are re-created — with a fresh id and fresh
 * `created_at` — every time a config save re-syncs the bindings for a target.
 * The egress posture (`allowedEgress`, `egressAllowlistEnforced`) is operator
 * state keyed by the binding identity
 * `(companyId, targetType, targetId, configPath)`, not by the row id, so a
 * re-save must carry it onto the new rows instead of silently resetting it to
 * the column defaults. Resetting in either direction is a defect: an operator
 * allowlist would be wiped (deny-all while enforcing), or a log-only posture
 * would be silently re-armed.
 *
 * Every delete+reinsert binding sync must route its re-insert posture through
 * `preservedEgressPosture` — one shared definition, because the syncs drifting
 * into different semantics is exactly how one of them silently drifted into
 * wiping operator posture on every config save.
 */
export type EgressPostureCarry = {
  allowedEgress: string[];
  egressAllowlistEnforced: boolean;
};

/**
 * Resolve the egress posture a re-inserted binding row should carry.
 *
 * Falls back to the column defaults — empty allowlist, enforcement ON — when
 * there is no prior row at the same binding identity, so new bindings stay
 * born enforcing (EG4 secure-by-default) and no path regresses to born-false.
 */
export function preservedEgressPosture(
  existing?:
    | Pick<EgressPostureCarry, "allowedEgress" | "egressAllowlistEnforced">
    | null,
): EgressPostureCarry {
  return {
    allowedEgress: existing?.allowedEgress ?? [],
    egressAllowlistEnforced: existing?.egressAllowlistEnforced ?? true,
  };
}

/**
 * Map key for a carried egress posture. Within one sync the target is fixed,
 * so the binding identity reduces to `(companyId, configPath)`; the company
 * component matters for instance-scoped targets whose bindings span several
 * companies (e.g. environments). NUL-separated so a configPath can never
 * collide across a companyId/configPath split.
 */
export function egressPostureCarryKey(companyId: string, configPath: string): string {
  return `${companyId}\u0000${configPath}`;
}

/**
 * Index the posture of the rows a delete+reinsert sync is about to remove, so
 * the re-insert can look each row's posture up by binding identity.
 */
export function egressPostureCarryIndex(
  rows: ReadonlyArray<{
    companyId: string;
    configPath: string;
    allowedEgress: string[];
    egressAllowlistEnforced: boolean;
  }>,
): Map<string, EgressPostureCarry> {
  return new Map(
    rows.map((row) => [
      egressPostureCarryKey(row.companyId, row.configPath),
      {
        allowedEgress: row.allowedEgress,
        egressAllowlistEnforced: row.egressAllowlistEnforced,
      },
    ]),
  );
}

export const EGRESS_POSTURE_DENY_ALL_ACTION = "secret.egress_posture_deny_all";

export const EGRESS_POSTURE_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Surfaces every binding sitting in the `deny_all` posture as an `activity_log`
 * event, which the company Activity screen already renders — an operator-reachable
 * surface that needs no shell.
 *
 * Detection is by scanning STATE rather than by instrumenting the write paths.
 * A binding reaches `deny_all` via the column DEFAULT on insert, via a migration,
 * or via an operator flip, and it is exactly as dangerous in all three cases; only
 * a scan sees all of them.
 *
 * Deduplicated against the binding's last recorded POSTURE change, not against its
 * `updatedAt`. `updated_at` is only bumped by writers that remember to bump it, and
 * the write that motivated this ticket — `UPDATE company_secret_bindings SET
 * egress_allowlist_enforced = false` at the tail of migration 0138 — did not. Keying
 * dedup on `updated_at` would therefore reproduce the exact blind spot the ticket is
 * about: a binding re-entering deny-all by that same class of write would be
 * suppressed as "already announced". The 0144 audit trigger fires below every writer,
 * so it is the only clock here that sees all of them.
 */
export async function sweepDenyAllEgressBindings(
  db: Db,
): Promise<{ scanned: number; announced: number }> {
  const candidates = await db
    .select({
      id: companySecretBindings.id,
      companyId: companySecretBindings.companyId,
      secretId: companySecretBindings.secretId,
      targetType: companySecretBindings.targetType,
      targetId: companySecretBindings.targetId,
      configPath: companySecretBindings.configPath,
      updatedAt: companySecretBindings.updatedAt,
    })
    .from(companySecretBindings)
    .where(
      and(
        eq(companySecretBindings.egressAllowlistEnforced, true),
        eq(sql`cardinality(${companySecretBindings.allowedEgress})`, 0),
      ),
    );

  if (candidates.length === 0) return { scanned: 0, announced: 0 };

  const announced = await db
    .select({
      entityId: activityLog.entityId,
      lastAt: sql<Date>`max(${activityLog.createdAt})`.as("last_at"),
    })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.action, EGRESS_POSTURE_DENY_ALL_ACTION),
        eq(activityLog.entityType, "secret_binding"),
        inArray(
          activityLog.entityId,
          candidates.map((candidate) => candidate.id),
        ),
      ),
    )
    .groupBy(activityLog.entityId);

  const lastAnnouncedAt = new Map(
    announced.map((row) => [row.entityId, new Date(row.lastAt)] as const),
  );

  const postureChanges = await db
    .select({
      bindingId: companySecretBindingPostureAudit.bindingId,
      lastAt: sql<Date>`max(${companySecretBindingPostureAudit.changedAt})`.as("last_at"),
    })
    .from(companySecretBindingPostureAudit)
    .where(
      inArray(
        companySecretBindingPostureAudit.bindingId,
        candidates.map((candidate) => candidate.id),
      ),
    )
    .groupBy(companySecretBindingPostureAudit.bindingId);

  const lastPostureChangeAt = new Map(
    postureChanges.map((row) => [row.bindingId, new Date(row.lastAt)] as const),
  );

  let emitted = 0;
  for (const candidate of candidates) {
    const previous = lastAnnouncedAt.get(candidate.id);
    // Falls back to `updatedAt` only for a binding with no audit row at all, which
    // 0144's insert trigger and baseline backfill together should make impossible.
    const changedAt = lastPostureChangeAt.get(candidate.id) ?? candidate.updatedAt;
    if (previous && previous.getTime() >= changedAt.getTime()) continue;

    await logActivity(db, {
      companyId: candidate.companyId,
      actorType: "system",
      actorId: "egress-posture-sweep",
      action: EGRESS_POSTURE_DENY_ALL_ACTION,
      entityType: "secret_binding",
      entityId: candidate.id,
      details: {
        posture: "deny_all" satisfies EgressPosture,
        secretId: candidate.secretId,
        targetType: candidate.targetType,
        targetId: candidate.targetId,
        configPath: candidate.configPath,
        message:
          "Binding enforces its egress allowlist but the allowlist is empty, " +
          "so every borrowed-handle egress for this secret is denied. Seed the " +
          "allowlist, or confirm deny-all is intended.",
      },
    });
    emitted += 1;
  }

  return { scanned: candidates.length, announced: emitted };
}

export function startEgressPostureSweep(db: Db, intervalMs: number): NodeJS.Timeout {
  const run = () => {
    void sweepDenyAllEgressBindings(db)
      .then((result) => {
        if (result.announced > 0) {
          logger.warn({ ...result }, "egress posture sweep surfaced deny-all secret bindings");
        }
      })
      .catch((err) => {
        logger.error({ err }, "egress posture sweep failed");
      });
  };
  run();
  return setInterval(run, intervalMs);
}
