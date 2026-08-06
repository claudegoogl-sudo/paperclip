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
    // Provenance of the credential that authenticated the write (migration 0145).
    // actorSource is the resolved credential class from actorMiddleware
    // ("session", "board_key", "agent_key", etc.); actorKeyId is the API key id
    // qualified by actorSource: the board API key id when actor_source = 'board_key',
    // the agent API key id when actor_source = 'agent_key', null for sources that
    // carry no key (session, agent_jwt, local_implicit, none). Populated centrally
    // by logActivity from AsyncLocalStorage — never carries the token value itself.
    actorSource: text("actor_source"),
    actorKeyId: uuid("actor_key_id"),
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
