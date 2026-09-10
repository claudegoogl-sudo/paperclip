import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * PLA-1930: a singleton row gating dispatch admission instance-wide when a
 * Claude run reports a usage/rate-limit hit with zero real work done. The
 * underlying quota is one shared account, not per-agent, so the park applies
 * to every agent in every company until `parkedUntil` passes.
 */
export const usageLimitPark = pgTable(
  "usage_limit_park",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    singletonKey: text("singleton_key").notNull().default("default"),
    parkedUntil: timestamp("parked_until", { withTimezone: true }),
    reason: text("reason"),
    rawText: text("raw_text"),
    sourceRunId: uuid("source_run_id"),
    sourceAgentId: uuid("source_agent_id"),
    sourceCompanyId: uuid("source_company_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singletonKeyIdx: uniqueIndex("usage_limit_park_singleton_key_idx").on(table.singletonKey),
  }),
);
