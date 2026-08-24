import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * Single instance-wide singleton row recording whether the Claude
 * account is currently parked after a usage-limit hit. The quota this guards
 * is account-wide (not per-agent or per-company), so every wake source
 * (issue-comment wake, sweep, routine trigger, scheduled-retry promotion)
 * must consult this row before dispatching a run for ANY agent in ANY
 * company — see `startNextQueuedRunForAgent` in heartbeat.ts, the single
 * choke point all of those funnel through.
 */
export const usageLimitParks = pgTable(
  "usage_limit_parks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    singletonKey: text("singleton_key").notNull().default("default"),
    parkedUntil: timestamp("parked_until", { withTimezone: true }),
    reason: text("reason"),
    rawLimitText: text("raw_limit_text"),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singletonKeyIdx: uniqueIndex("usage_limit_parks_singleton_key_idx").on(table.singletonKey),
  }),
);
