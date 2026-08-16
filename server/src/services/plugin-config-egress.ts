import type { Db } from "@paperclipai/db";
import { pluginConfigEgressAllowlist } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  formatOrigin,
  isValidAllowlistEntry,
  matchesAllowlist,
  normalizeDestination,
  type NormalizedOrigin,
} from "../handle-egress.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { collectUriConfigPaths, readConfigValueAtPath } from "./json-schema-secret-refs.js";
import { pluginRegistryService } from "./plugin-registry.js";
import {
  listPluginConfigEgressWouldDeny,
  recordPluginConfigEgressWouldDeny,
  type PluginConfigEgressWouldDenyObservationRow,
} from "./plugin-config-egress-harvest.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "plugin-config-egress" });

/**
 * Host-side plugin config-key egress gate. Gates a plugin worker's
 * `ctx.http.fetch` against destinations derived from that plugin's OWN
 * declared `format:"uri"` instance-config values (klipper's
 * `moonrakerBaseUrl`, the first real subject), modeled directly on the
 * existing per-binding egress allowlist (`../handle-egress.ts`)
 * and its would-deny harvest (`./egress-harvest.ts`).
 *
 * Operator decision, binding amendments:
 *  - A2 — the deny decision is keyed on `plugin_id` ONLY, against a
 *    host-derived UNION of the config key's value across every company with
 *    the plugin enabled. There is no trustworthy per-call company context on
 *    this path (`http.fetch` receives only `url`/`init`; `pluginId` is a
 *    `buildHostServices` closure binding, and klipper's dominant paths have
 *    no run context on the fetch path). This is NOT a per-tenant boundary:
 *    flipping one company's `plugin_config_egress_allowlist` row to enforcing
 *    affects egress for the whole plugin.
 *  - A3 — rows backfilled by migration 0149 for already-installed instances
 *    are born `egress_allowlist_enforced = false` (log-only); `DEFAULT true`
 *    only applies to rows created after that migration shipped.
 *  - Fail closed on error, matching `enforceBindingEgress` / `decideEgress`.
 */

export class PluginConfigEgressDeniedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`plugin config egress not allowed (${reason})`);
    this.name = "PluginConfigEgressDeniedError";
    this.reason = reason;
  }
}

export interface PluginConfigEgressDecision {
  allow: boolean;
  /** Value-free reason code (audit + error). */
  reason: string;
  /** Destination AFTER egress-parser normalization; null if not evaluated. */
  origin: NormalizedOrigin | null;
  /** True when this destination would be denied under enforcement but the plugin is (at least partly) log-only. */
  wouldDeny: boolean;
}

/**
 * Build the plugin-wide allowed-origin list: the UNION, across every company
 * with the plugin enabled, of every `format:"uri"` config key's value
 * (origin-normalized — path/query stripped), plus any operator-added
 * `allowed_egress` extras from `plugin_config_egress_allowlist` rows for this
 * plugin. Also returns whether ANY row for this plugin enforces (OR
 * semantics — see A2).
 */
async function loadPluginEgressAllowlist(
  db: Db,
  pluginId: string,
): Promise<{ uriPaths: Set<string>; allowlist: string[]; enforced: boolean }> {
  const registry = pluginRegistryService(db);
  const plugin = await registry.getById(pluginId);
  const schema = (plugin?.manifestJson as { instanceConfigSchema?: unknown } | null | undefined)
    ?.instanceConfigSchema as Record<string, unknown> | null | undefined;
  const uriPaths = collectUriConfigPaths(schema);
  if (uriPaths.size === 0) {
    return { uriPaths, allowlist: [], enforced: false };
  }

  const [companySettings, allowlistRows] = await Promise.all([
    registry.listEnabledCompanySettings(pluginId),
    db
      .select()
      .from(pluginConfigEgressAllowlist)
      .where(eq(pluginConfigEgressAllowlist.pluginId, pluginId)),
  ]);

  const allowlist: string[] = [];
  for (const settings of companySettings) {
    const config = (settings.settingsJson as Record<string, unknown> | null | undefined) ?? {};
    for (const path of uriPaths) {
      const raw = readConfigValueAtPath(config, path);
      if (typeof raw !== "string" || raw.length === 0) continue;
      // Origin-normalize the config value itself: a config value is stored as
      // a full URI (may include a trailing slash / path); only its origin
      // (scheme+host+port) is a valid allowlist entry (matchesAllowlist would
      // otherwise treat a stray path segment as part of the host and never
      // match).
      const formatted = formatOrigin(normalizeDestination("url", raw));
      if (formatted) allowlist.push(formatted);
    }
  }
  for (const row of allowlistRows) {
    allowlist.push(...row.allowedEgress);
  }

  const enforced = allowlistRows.some((row) => row.egressAllowlistEnforced);
  return { uriPaths, allowlist, enforced };
}

/**
 * Decide whether `destinationUrl` is a permitted `ctx.http.fetch` egress
 * target for `pluginId`. A plugin with no `format:"uri"` config keys is not
 * gated by this mechanism at all — nothing is declared to derive an
 * allowlist from, and no `plugin_config_egress_allowlist` row can ever exist
 * for it (the operator route and the 0141 backfill both key off a real
 * config-key path), so the decision is unconditionally `allow` with no
 * observation write.
 *
 * Fails closed: any lookup error is a deny, never a silent allow.
 */
export async function decidePluginConfigEgress(
  db: Db,
  pluginId: string,
  destinationUrl: string,
): Promise<PluginConfigEgressDecision> {
  const { uriPaths, allowlist, enforced } = await loadPluginEgressAllowlist(db, pluginId);
  if (uriPaths.size === 0) {
    return { allow: true, reason: "no_uri_config_keys", origin: null, wouldDeny: false };
  }

  const origin = normalizeDestination("url", destinationUrl);
  const permitted = matchesAllowlist(allowlist, origin);
  if (permitted) {
    return { allow: true, reason: "allowed", origin, wouldDeny: false };
  }

  const reason = origin.ok ? "destination_not_allowlisted" : `undeterminable_destination:${origin.reason}`;
  if (enforced) {
    return { allow: false, reason, origin, wouldDeny: false };
  }
  return { allow: true, reason, origin, wouldDeny: true };
}

/**
 * Enforce the config-key egress allowlist at the `ctx.http.fetch` chokepoint
 * (`plugin-host-services.ts`, ahead of DNS resolve). Throws
 * {@link PluginConfigEgressDeniedError} — fail-closed, before any DNS
 * resolution or connection — when the instance is enforcing and the
 * destination is not derived from the plugin's own declared config. Records
 * a would-deny observation (fire-and-forget; a harvest failure must never
 * block the fetch) when the destination would have been denied but the
 * plugin is still log-only.
 */
export async function enforcePluginConfigEgress(
  db: Db,
  pluginId: string,
  destinationUrl: string,
): Promise<void> {
  let decision: PluginConfigEgressDecision;
  try {
    decision = await decidePluginConfigEgress(db, pluginId, destinationUrl);
  } catch (err) {
    log.error(
      { err, pluginId, action: "plugin.config_egress_check_failed" },
      "plugin config-egress lookup failed — failing closed",
    );
    throw new PluginConfigEgressDeniedError("lookup_failed");
  }

  if (decision.wouldDeny) {
    const originStr = formatOrigin(decision.origin);
    if (originStr) {
      void recordPluginConfigEgressWouldDeny(db, { pluginId, origin: originStr }).catch((err: unknown) => {
        log.warn(
          { err, pluginId, action: "plugin.config_egress_would_deny_harvest_failed" },
          "failed to persist plugin config-egress would-deny observation (non-fatal)",
        );
      });
    }
    return;
  }

  if (!decision.allow) {
    log.warn(
      { pluginId, reason: decision.reason, action: "plugin.config_egress_denied" },
      "denied plugin ctx.http.fetch egress (config-key allowlist)",
    );
    throw new PluginConfigEgressDeniedError(decision.reason);
  }
}

// ---------------------------------------------------------------------------
// Operator review + set-allowlist + enforce-flip surface (mirrors the
// per-binding secret allowlist pattern in secrets.ts). Routed
// through `routes/plugin-config-egress.ts`, which gates every one of these
// with `assertBoard` (no agent/worker-invokable path) + `assertCompanyAccess`
// (BOLA).
//
// IMPORTANT — A2 asymmetry the routes/docs must surface to the operator: the
// write paths below are company-scoped (they touch ONE company's row), but
// the runtime deny decision they feed is NOT (`enforcePluginConfigEgress`
// above unions every company's row for the plugin — see A2). Flipping any
// single company's row to enforcing makes the WHOLE PLUGIN enforce.
// ---------------------------------------------------------------------------

/**
 * Guards the two write paths below. Throws if:
 *  - `pluginId` doesn't exist (404), or
 *  - `companyId` does not run the plugin — no `enabled = true`
 *    `plugin_company_settings` row (403, least-privilege), or
 *  - `configKey` isn't a declared `format:"uri"` instance-config key (400).
 *
 * The enabled check narrows the set of principals who can seed/flip a
 * `plugin_config_egress_allowlist` row. Per A2 the runtime deny decision is
 * plugin-wide (unions/ORs every enabled company's row), so without this a
 * board operator of a company that doesn't even run the plugin could still
 * influence the shared worker's egress allowlist and plugin-wide enforcement.
 * "Enabled" is deliberately the SAME notion the runtime union uses
 * (`listEnabledCompanySettings` — an explicit `enabled = true` row), so the
 * only companies allowed to write are exactly those whose config already
 * participates in the union. Read (review) stays ungated: an operator must be
 * able to see the plugin-wide posture even for a company that isn't running
 * the plugin.
 */
async function assertUriConfigKey(
  db: Db,
  companyId: string,
  pluginId: string,
  configKey: string,
): Promise<void> {
  const registry = pluginRegistryService(db);
  const plugin = await registry.getById(pluginId);
  if (!plugin) throw notFound(`Plugin ${pluginId} not found`);
  const settings = await registry.getCompanySettings(pluginId, companyId);
  if (!settings?.enabled) {
    throw forbidden(`Plugin ${pluginId} is not enabled for company ${companyId}`);
  }
  const schema = (plugin.manifestJson as { instanceConfigSchema?: unknown } | null | undefined)
    ?.instanceConfigSchema as Record<string, unknown> | null | undefined;
  if (!collectUriConfigPaths(schema).has(configKey)) {
    throw badRequest(`"${configKey}" is not a format:"uri" instance-config key for plugin ${pluginId}`);
  }
}

export interface PluginConfigEgressReviewRow {
  configKey: string;
  /**
   * This company's own declared value for `configKey`, origin-normalized —
   * context only. Always implicitly part of the effective allowlist (it's the
   * whole reason this mechanism exists), regardless of `allowedEgress` /
   * `egressAllowlistEnforced` below. Null if this company hasn't set the key,
   * or the value doesn't parse to a determinable origin.
   */
  declaredOrigin: string | null;
  /** Operator-added EXTRA destinations on THIS company's row. */
  allowedEgress: string[];
  /** THIS company's row's own enforcement flag (may lag the effective plugin-wide posture — see `pluginWideEnforced`). */
  egressAllowlistEnforced: boolean;
  /** Effective enforcement for the WHOLE PLUGIN — OR across every company's row (A2). This is what `enforcePluginConfigEgress` actually applies at the `ctx.http.fetch` chokepoint. */
  pluginWideEnforced: boolean;
  updatedAt: Date | null;
}

/**
 * Operator-only: company-scoped review surface. Returns every `format:"uri"`
 * config key the plugin declares, this company's own row (allowlist extras +
 * posture) where one exists, and the plugin-WIDE would-deny suggestions
 * (harvested observations have no per-key attribution — see A2 / the harvest
 * table shape). Suggestions are returned unselected; nothing is pre-applied
 * (same allowlist-poisoning guard as the per-binding secret surface).
 */
export async function listPluginConfigEgressReview(
  db: Db,
  params: { companyId: string; pluginId: string },
): Promise<{
  rows: PluginConfigEgressReviewRow[];
  suggestions: PluginConfigEgressWouldDenyObservationRow[];
}> {
  const registry = pluginRegistryService(db);
  const plugin = await registry.getById(params.pluginId);
  if (!plugin) throw notFound(`Plugin ${params.pluginId} not found`);
  const schema = (plugin.manifestJson as { instanceConfigSchema?: unknown } | null | undefined)
    ?.instanceConfigSchema as Record<string, unknown> | null | undefined;
  const uriPaths = collectUriConfigPaths(schema);

  const [companySettings, companyRows, allRowsForPlugin, suggestions] = await Promise.all([
    registry.getCompanySettings(params.pluginId, params.companyId),
    db
      .select()
      .from(pluginConfigEgressAllowlist)
      .where(
        and(
          eq(pluginConfigEgressAllowlist.companyId, params.companyId),
          eq(pluginConfigEgressAllowlist.pluginId, params.pluginId),
        ),
      ),
    db
      .select({ egressAllowlistEnforced: pluginConfigEgressAllowlist.egressAllowlistEnforced })
      .from(pluginConfigEgressAllowlist)
      .where(eq(pluginConfigEgressAllowlist.pluginId, params.pluginId)),
    listPluginConfigEgressWouldDeny(db, { pluginId: params.pluginId }),
  ]);

  const pluginWideEnforced = allRowsForPlugin.some((row) => row.egressAllowlistEnforced);
  const config = (companySettings?.settingsJson as Record<string, unknown> | null | undefined) ?? {};
  const byKey = new Map(companyRows.map((row) => [row.configKey, row]));

  const rows: PluginConfigEgressReviewRow[] = [...uriPaths].sort().map((configKey) => {
    const raw = readConfigValueAtPath(config, configKey);
    const declaredOrigin =
      typeof raw === "string" && raw.length > 0 ? formatOrigin(normalizeDestination("url", raw)) : null;
    const row = byKey.get(configKey);
    return {
      configKey,
      declaredOrigin,
      allowedEgress: row?.allowedEgress ?? [],
      egressAllowlistEnforced: row?.egressAllowlistEnforced ?? false,
      pluginWideEnforced,
      updatedAt: row?.updatedAt ?? null,
    };
  });

  return { rows, suggestions };
}

/**
 * Operator-only: set/replace one company's operator-added extra destinations
 * for `configKey`. Never touches `egressAllowlistEnforced` on an existing row
 * (mirrors `setBindingEgressAllowlist` leaving enforcement to the separate
 * enforce route) — a brand-new row is explicitly born `false` here rather
 * than inheriting the column's `DEFAULT true` (A3's backfill precedent is
 * "already-configured instances get a review grace period"; this route
 * extends the same grace period to the ongoing set-then-enforce operator
 * flow, so merely curating an allowlist can never silently flip the WHOLE
 * PLUGIN to enforcing — see A2).
 */
export async function setPluginConfigEgressAllowlist(
  db: Db,
  params: { companyId: string; pluginId: string; configKey: string; allowedEgress: string[] },
): Promise<{ configKey: string; allowedEgress: string[]; egressAllowlistEnforced: boolean }> {
  await assertUriConfigKey(db, params.companyId, params.pluginId, params.configKey);

  const cleaned = [...new Set(params.allowedEgress.map((e) => e.trim()).filter((e) => e.length > 0))];
  for (const entry of cleaned) {
    if (!isValidAllowlistEntry(entry)) {
      throw badRequest(`Invalid egress allowlist entry: ${entry}`);
    }
  }

  const updated = await db
    .insert(pluginConfigEgressAllowlist)
    .values({
      companyId: params.companyId,
      pluginId: params.pluginId,
      configKey: params.configKey,
      allowedEgress: cleaned,
      egressAllowlistEnforced: false,
    })
    .onConflictDoUpdate({
      target: [
        pluginConfigEgressAllowlist.companyId,
        pluginConfigEgressAllowlist.pluginId,
        pluginConfigEgressAllowlist.configKey,
      ],
      set: { allowedEgress: cleaned, updatedAt: new Date() },
    })
    .returning()
    .then((rows) => rows[0]);

  return updated;
}

/**
 * Operator-only: flip ONE company's row for `configKey` to enforcing.
 *
 * Per A2 this is NOT a per-tenant action even though it is a company-scoped
 * write: `enforcePluginConfigEgress` unions `egressAllowlistEnforced` across
 * EVERY company's row for the plugin (OR semantics), so this flip makes the
 * WHOLE PLUGIN start enforcing — including for companies that never reviewed
 * their own would-deny suggestions. Callers (route layer + docs) must not
 * present this as scoped to `companyId`.
 *
 * Idempotent: re-flipping an already-enforcing row is a no-op flip.
 */
export async function enforcePluginConfigEgressAllowlist(
  db: Db,
  params: { companyId: string; pluginId: string; configKey: string },
): Promise<{ configKey: string; allowedEgress: string[]; egressAllowlistEnforced: boolean }> {
  await assertUriConfigKey(db, params.companyId, params.pluginId, params.configKey);

  const updated = await db
    .insert(pluginConfigEgressAllowlist)
    .values({
      companyId: params.companyId,
      pluginId: params.pluginId,
      configKey: params.configKey,
      allowedEgress: [],
      egressAllowlistEnforced: true,
    })
    .onConflictDoUpdate({
      target: [
        pluginConfigEgressAllowlist.companyId,
        pluginConfigEgressAllowlist.pluginId,
        pluginConfigEgressAllowlist.configKey,
      ],
      set: { egressAllowlistEnforced: true, updatedAt: new Date() },
    })
    .returning()
    .then((rows) => rows[0]);

  log.info(
    { companyId: params.companyId, pluginId: params.pluginId, configKey: params.configKey, action: "plugin.config_egress_allowlist_enforced" },
    "flipped plugin config-key egress allowlist row to enforcing — PLUGIN-WIDE effect per amendment A2",
  );

  return updated;
}
