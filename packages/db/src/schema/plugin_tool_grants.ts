import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * `plugin_tool_grants` — per-agent grants for plugin tools flagged
 * `requiresGrant`. `tool_key` is the FULL namespaced key
 * (`<pluginKey>:<tool>`), compared by exact equality (no glob/prefix).
 * A grant is valid only while `expires_at > now()` (UTC). Revoke = delete the row.
 */
export const pluginToolGrants = pgTable(
  "plugin_tool_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    toolKey: text("tool_key").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    reviewedBy: text("reviewed_by").notNull(),
    reviewDue: timestamp("review_due", { withTimezone: true }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentToolUq: uniqueIndex("plugin_tool_grants_company_agent_tool_uq").on(
      table.companyId,
      table.agentId,
      table.toolKey,
    ),
    expiryIdx: index("plugin_tool_grants_expires_idx").on(table.expiresAt),
  }),
);
