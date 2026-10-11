import { pgTable, uuid, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { plugins } from "./plugins.js";

/**
 * `plugin_operator_config` — instance-wide (operator-plane) plugin config,
 * one row per plugin, no company scope. Readable/writable by instance admins
 * only. Merged UNDER tenant-scoped keys from `plugin_config` and
 * `configOverrides`; tenant layers can never shadow an operator key.
 */
export const pluginOperatorConfig = pgTable(
  "plugin_operator_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    configJson: jsonb("config_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginIdx: uniqueIndex("plugin_operator_config_plugin_idx").on(table.pluginId),
  }),
);
