import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { plugins } from "./plugins.js";

/**
 * `plugin_config_egress_would_deny_observations` — sibling of
 * `egress_would_deny_observations` for the config-key egress
 * allowlist. Records, per PLUGIN (not per company — the enforcement decision
 * is company-agnostic per operator amendment A2), the normalized
 * destinations a `ctx.http.fetch` call would have been denied for while the
 * plugin's config-key allowlist is in log-only / migration mode.
 *
 * Same persistence discipline as 0139: `origin` is the egress-parser-
 * NORMALIZED destination ONLY (scheme+host+port) — never a raw path/query URL,
 * which is attacker-influenced and frequently carries secrets.
 */
export const pluginConfigEgressWouldDenyObservations = pgTable(
  "plugin_config_egress_would_deny_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    // Normalized origin only — scheme+host+port. NEVER a raw path/query-bearing URL.
    origin: text("origin").notNull(),
    count: integer("count").notNull().default(1),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginOriginUq: uniqueIndex("plugin_config_egress_would_deny_plugin_origin_uq").on(
      table.pluginId,
      table.origin,
    ),
    pluginCountIdx: index("plugin_config_egress_would_deny_plugin_count_idx").on(
      table.pluginId,
      table.count,
    ),
  }),
);
