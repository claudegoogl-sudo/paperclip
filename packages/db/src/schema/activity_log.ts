import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    actorType: text("actor_type").notNull().default("system"),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    agentId: uuid("agent_id").references(() => agents.id),
    // fork-only divergence (migration 0090): runId FK uses ON DELETE SET NULL so
    // deleting a heartbeat_runs row doesn't violate the FK constraint;
    // re-submit upstream once the fork PR freeze lifts.
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("activity_log_company_created_idx").on(table.companyId, table.createdAt),
    runIdIdx: index("activity_log_run_id_idx").on(table.runId),
    entityIdx: index("activity_log_entity_type_id_idx").on(table.entityType, table.entityId),
    // Serves the per-issue MAX(created_at) lookup behind issue-list ordering as a single
    // index seek. Without the trailing created_at the planner instead scans
    // activity_log_company_created_idx backwards across the whole company per row.
    companyEntityCreatedIdx: index("activity_log_company_entity_created_idx")
      .on(table.companyId, table.entityType, table.entityId, table.createdAt),
  }),
);
