import { pgTable, uuid, text, timestamp, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentWakeupRequests = pgTable(
  "agent_wakeup_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    source: text("source").notNull(),
    triggerDetail: text("trigger_detail"),
    reason: text("reason"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("queued"),
    coalescedCount: integer("coalesced_count").notNull().default(0),
    requestedByActorType: text("requested_by_actor_type"),
    requestedByActorId: text("requested_by_actor_id"),
    idempotencyKey: text("idempotency_key"),
    runId: uuid("run_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentStatusIdx: index("agent_wakeup_requests_company_agent_status_idx").on(
      table.companyId,
      table.agentId,
      table.status,
    ),
    companyRequestedIdx: index("agent_wakeup_requests_company_requested_idx").on(
      table.companyId,
      table.requestedAt,
    ),
    agentRequestedIdx: index("agent_wakeup_requests_agent_requested_idx").on(table.agentId, table.requestedAt),
    reviewPathRecoveryIdempotencyUq: uniqueIndex("agent_wakeup_requests_review_path_recovery_idempotency_uq")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} LIKE 'issue_review_path_lost:%' AND ${table.status} <> 'skipped'`),
    companyPayloadIssueIdx: index("agent_wakeup_requests_company_payload_issue_idx").on(
      table.companyId,
      sql`(${table.payload} ->> 'issueId')`,
    ),
    // Serves the retention prune scan. The partial predicate must stay in sync
    // with TERMINAL_WAKEUP_REQUEST_STATUSES or the prune falls back to a Seq
    // Scan; a test asserts the two match. See migration 0230.
    retentionIdx: index("agent_wakeup_requests_retention_idx")
      .on(table.requestedAt)
      .where(sql`${table.status} IN ('coalesced', 'skipped', 'completed', 'failed', 'cancelled')`),
  }),
);
