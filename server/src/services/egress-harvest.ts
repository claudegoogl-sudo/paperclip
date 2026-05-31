import type { Db } from "@paperclipai/db";
import { egressWouldDenyObservations } from "@paperclipai/db";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "egress-harvest" });

/**
 * PLA-734 — queryable would-deny egress observations (CTO PLA-733, option (b)).
 *
 * The egress chokepoint (plugin-tool-registry) calls {@link recordEgressWouldDeny}
 * whenever a borrowed-handle call WOULD have been denied under enforcement but
 * the binding is still in log-only / migration mode. Operators read the rows via
 * {@link listEgressWouldDeny} to seed per-binding allowlists from real traffic
 * before the enforce-flip.
 *
 * SecurityEngineer constraints implemented here:
 *  - The caller passes an ALREADY-normalized `origin` (scheme+host+port). This
 *    module never accepts or persists a raw URL — normalization + drop-on-unparse
 *    happens at the chokepoint via the egress parser. We still treat the string
 *    as opaque data (parameterized SQL only; never interpolated).
 *  - Upsert-dedupe on `(binding_id, origin)`: a repeat observation bumps `count`
 *    and advances `last_seen`, it does NOT insert a new row (no row-per-request).
 *  - Per-binding cardinality cap: after an upsert that may have introduced a new
 *    origin, prune to the top-N by `(count, last_seen)` so a flood of distinct
 *    destinations cannot bloat the table or the operator-review surface (DoS).
 *  - Rows are untrusted suggestions: this module NEVER writes to a binding's
 *    `allowed_egress`. Nothing here auto-applies anything.
 */

/**
 * Max distinct origins retained per binding. A would-deny flood (many distinct
 * destinations under one binding) is pruned to the most-frequent / most-recent
 * N; the dropped tail is low-signal for allowlist seeding anyway.
 */
export const MAX_ORIGINS_PER_BINDING = 50;

export interface RecordEgressWouldDenyInput {
  /** Company that owns the bindings (denormalized for the BOLA-safe read path). */
  companyId: string;
  /** Bindings whose handles would have been denied to `origin` (non-null only). */
  bindingIds: readonly string[];
  /**
   * The egress-parser-normalized destination (scheme+host+port). MUST already be
   * parser output — see {@link formatOrigin} at the chokepoint. Never a raw URL.
   */
  origin: string;
}

/**
 * Persist a would-deny observation for each binding at `origin` (upsert-dedupe +
 * per-binding cap). Best-effort and self-contained: harvesting is observation
 * only and MUST NOT affect the dispatch it rides on, so the chokepoint invokes
 * this fire-and-forget. Throwing is still possible for the caller to log.
 */
export async function recordEgressWouldDeny(
  db: Db,
  input: RecordEgressWouldDenyInput,
): Promise<void> {
  const { companyId, origin } = input;
  // De-dupe binding ids; a single call can name the same binding twice if a
  // tool's parameters carry multiple handles minted under one binding.
  const bindingIds = [...new Set(input.bindingIds)];
  if (bindingIds.length === 0 || origin.length === 0) return;

  await db.transaction(async (tx) => {
    for (const bindingId of bindingIds) {
      await tx
        .insert(egressWouldDenyObservations)
        .values({ companyId, bindingId, origin })
        .onConflictDoUpdate({
          target: [egressWouldDenyObservations.bindingId, egressWouldDenyObservations.origin],
          set: {
            count: sql`${egressWouldDenyObservations.count} + 1`,
            lastSeen: new Date(),
          },
        });

      // Cap: keep the top-N origins for this binding by (count desc, last_seen
      // desc). Pruning the tail bounds per-binding cardinality regardless of how
      // many distinct destinations an attacker drives through a log-only binding.
      const keep = tx
        .select({ id: egressWouldDenyObservations.id })
        .from(egressWouldDenyObservations)
        .where(eq(egressWouldDenyObservations.bindingId, bindingId))
        .orderBy(desc(egressWouldDenyObservations.count), desc(egressWouldDenyObservations.lastSeen))
        .limit(MAX_ORIGINS_PER_BINDING);

      await tx
        .delete(egressWouldDenyObservations)
        .where(
          and(
            eq(egressWouldDenyObservations.bindingId, bindingId),
            notInArray(egressWouldDenyObservations.id, keep),
          ),
        );
    }
  });

  log.debug(
    { companyId, bindingCount: bindingIds.length, action: "secret.egress_would_deny_harvested" },
    "recorded would-deny egress observation(s)",
  );
}

export interface EgressWouldDenyObservationRow {
  id: string;
  bindingId: string;
  origin: string;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
}

/**
 * Company-scoped read of would-deny observations (BOLA): callers MUST pass the
 * authenticated company id; rows for other companies are never returned. Pass a
 * `bindingId` to scope to a single binding. Ordered most-frequent first so the
 * operator-review surface shows the strongest allowlist candidates on top.
 *
 * These rows are UNTRUSTED suggestions — the review surface must not pre-check
 * or auto-apply any of them.
 */
export async function listEgressWouldDeny(
  db: Db,
  params: { companyId: string; bindingId?: string },
): Promise<EgressWouldDenyObservationRow[]> {
  const filters = [eq(egressWouldDenyObservations.companyId, params.companyId)];
  if (params.bindingId !== undefined) {
    filters.push(eq(egressWouldDenyObservations.bindingId, params.bindingId));
  }
  return db
    .select({
      id: egressWouldDenyObservations.id,
      bindingId: egressWouldDenyObservations.bindingId,
      origin: egressWouldDenyObservations.origin,
      count: egressWouldDenyObservations.count,
      firstSeen: egressWouldDenyObservations.firstSeen,
      lastSeen: egressWouldDenyObservations.lastSeen,
    })
    .from(egressWouldDenyObservations)
    .where(and(...filters))
    .orderBy(desc(egressWouldDenyObservations.count), desc(egressWouldDenyObservations.lastSeen));
}
