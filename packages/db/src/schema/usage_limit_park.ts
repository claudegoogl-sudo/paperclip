import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { heartbeatRuns } from "./heartbeat_runs.js";

// Single instance-wide row: while `parkedUntil` is in the future, dispatch
// admission refuses to start a new run for ANY agent in ANY company. Set
// when a zero-work Claude usage-limit hit lands; cleared on the first
// successful dispatch after the reset (or once `parkedUntil` passes).
export const usageLimitPark = pgTable(
  "usage_limit_park",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    singletonKey: text("singleton_key").notNull().default("default"),
    parkedUntil: timestamp("parked_until", { withTimezone: true }),
    reason: text("reason"),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    rawLimitText: text("raw_limit_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singletonKeyIdx: uniqueIndex("usage_limit_park_singleton_key_idx").on(table.singletonKey),
  }),
);
