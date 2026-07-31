import type { Db } from "@paperclipai/db";
import { pluginConfigEgressWouldDenyObservations } from "@paperclipai/db";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "plugin-config-egress-harvest" });

/**
 * Sibling of `egress-harvest.ts` for the config-key
 * egress allowlist. The `ctx.http.fetch` chokepoint calls
 * {@link recordPluginConfigEgressWouldDeny} whenever a destination WOULD have
 * been denied under enforcement but the plugin's config-key allowlist is
 * still in log-only mode. Operators read the rows via
 * {@link listPluginConfigEgressWouldDeny} to seed a config key's allowlist
 * from real traffic before the enforce-flip.
 *
 * Per-PLUGIN, not per-binding and not per-company: the enforcement decision
 * is company-agnostic (operator amendment A2), so there is no
 * meaningful company to key an observation on either.
 */

/** Max distinct origins retained per plugin — same DoS-bound rationale as the per-binding harvest. */
export const MAX_ORIGINS_PER_PLUGIN = 50;

export interface RecordPluginConfigEgressWouldDenyInput {
  pluginId: string;
  /** Egress-parser-normalized destination (scheme+host+port). Never a raw URL. */
  origin: string;
}

/**
 * Persist a would-deny observation for `pluginId` at `origin` (upsert-dedupe +
 * per-plugin cap). Best-effort: harvesting must never affect the fetch it
 * rides on, so the chokepoint invokes this fire-and-forget.
 */
export async function recordPluginConfigEgressWouldDeny(
  db: Db,
  input: RecordPluginConfigEgressWouldDenyInput,
): Promise<void> {
  const { pluginId, origin } = input;
  if (!pluginId || origin.length === 0) return;

  await db.transaction(async (tx) => {
    await tx
      .insert(pluginConfigEgressWouldDenyObservations)
      .values({ pluginId, origin })
      .onConflictDoUpdate({
        target: [
          pluginConfigEgressWouldDenyObservations.pluginId,
          pluginConfigEgressWouldDenyObservations.origin,
        ],
        set: {
          count: sql`${pluginConfigEgressWouldDenyObservations.count} + 1`,
          lastSeen: new Date(),
        },
      });

    const keep = tx
      .select({ id: pluginConfigEgressWouldDenyObservations.id })
      .from(pluginConfigEgressWouldDenyObservations)
      .where(eq(pluginConfigEgressWouldDenyObservations.pluginId, pluginId))
      .orderBy(
        desc(pluginConfigEgressWouldDenyObservations.count),
        desc(pluginConfigEgressWouldDenyObservations.lastSeen),
      )
      .limit(MAX_ORIGINS_PER_PLUGIN);

    await tx
      .delete(pluginConfigEgressWouldDenyObservations)
      .where(
        and(
          eq(pluginConfigEgressWouldDenyObservations.pluginId, pluginId),
          notInArray(pluginConfigEgressWouldDenyObservations.id, keep),
        ),
      );
  });

  log.debug(
    { pluginId, action: "plugin.config_egress_would_deny_harvested" },
    "recorded would-deny plugin config-egress observation",
  );
}

export interface PluginConfigEgressWouldDenyObservationRow {
  id: string;
  pluginId: string;
  origin: string;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
}

/**
 * Read would-deny observations for `pluginId`, most-frequent first. Rows are
 * UNTRUSTED suggestions — the review surface must not pre-check or
 * auto-apply any of them (allowlist-poisoning guard, matching the per-binding surface).
 */
export async function listPluginConfigEgressWouldDeny(
  db: Db,
  params: { pluginId: string },
): Promise<PluginConfigEgressWouldDenyObservationRow[]> {
  return db
    .select({
      id: pluginConfigEgressWouldDenyObservations.id,
      pluginId: pluginConfigEgressWouldDenyObservations.pluginId,
      origin: pluginConfigEgressWouldDenyObservations.origin,
      count: pluginConfigEgressWouldDenyObservations.count,
      firstSeen: pluginConfigEgressWouldDenyObservations.firstSeen,
      lastSeen: pluginConfigEgressWouldDenyObservations.lastSeen,
    })
    .from(pluginConfigEgressWouldDenyObservations)
    .where(eq(pluginConfigEgressWouldDenyObservations.pluginId, params.pluginId))
    .orderBy(
      desc(pluginConfigEgressWouldDenyObservations.count),
      desc(pluginConfigEgressWouldDenyObservations.lastSeen),
    );
}
