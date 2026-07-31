import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";

/**
 * `plugin_config_egress_allowlist` — PLA-1889: extends the per-binding egress
 * allowlist mechanism (PLA-723/731, {@link ../../../server/src/handle-egress.ts})
 * onto a second keying axis: a plugin's own `format: "uri"` instance-config
 * keys (e.g. klipper's `moonrakerBaseUrl`), enforced at `ctx.http.fetch`
 * instead of at borrowed-handle resolution.
 *
 * The row's implicit allowlist is the config key's OWN declared value(s) —
 * `allowedEgress` here holds only OPERATOR-ADDED extra destinations layered on
 * top (e.g. a secondary printer host), mirroring `company_secret_bindings`.
 *
 * CTO decision on PLA-1885 (amendment A2): the runtime deny decision is
 * company-agnostic — keyed on `plugin_id` against a host-derived UNION of this
 * config key's value across every company with the plugin enabled. `company_id`
 * stays on the row for operator display, audit, and as the unit an operator
 * flips, but flipping one company's row to enforcing affects egress for the
 * whole plugin (see the operator-egress-allowlists doc). NOT a per-tenant
 * boundary.
 *
 * Amendment A3: rows backfilled for already-installed plugin instances are
 * born `egress_allowlist_enforced = false` (log-only) — see migration 0141.
 * `DEFAULT true` applies only to rows created after this ships (new installs /
 * new config keys), matching the 0138 precedent.
 */
export const pluginConfigEgressAllowlist = pgTable(
  "plugin_config_egress_allowlist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    // Dot-path of the `format: "uri"` field in the plugin's instanceConfigSchema.
    configKey: text("config_key").notNull(),
    allowedEgress: text("allowed_egress").array().notNull().default([]),
    egressAllowlistEnforced: boolean("egress_allowlist_enforced").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("plugin_config_egress_allowlist_company_idx").on(table.companyId),
    pluginIdx: index("plugin_config_egress_allowlist_plugin_idx").on(table.pluginId),
    companyPluginKeyUq: uniqueIndex("plugin_config_egress_allowlist_company_plugin_key_uq").on(
      table.companyId,
      table.pluginId,
      table.configKey,
    ),
  }),
);
