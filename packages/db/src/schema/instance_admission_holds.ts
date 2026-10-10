import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Single instance-wide singleton row for an operator-set admission hold.
 *
 * While `hold_until` is in the future, the heartbeat scheduler does not START
 * any queued run (same admission choke points as `usage_limit_parks`). It is
 * admission-only: queued runs stay queued, running runs are never touched, and
 * wakes keep creating queued runs. It self-expires at `hold_until`.
 *
 * Deliberately separate from `usage_limit_parks`: a successful run clears the
 * usage-limit park, but must never clear an operator hold (the installer sets
 * it to drain running work before a service stop).
 */
export const instanceAdmissionHolds = pgTable(
  "instance_admission_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    singletonKey: text("singleton_key").notNull().default("default"),
    holdUntil: timestamp("hold_until", { withTimezone: true }),
    reason: text("reason"),
    setByActorType: text("set_by_actor_type"),
    setByActorId: text("set_by_actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singletonKeyIdx: uniqueIndex("instance_admission_holds_singleton_key_idx").on(table.singletonKey),
  }),
);
