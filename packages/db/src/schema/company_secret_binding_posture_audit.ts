import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Append-only history of borrowed-handle egress posture changes.
 *
 * Rows are written by the `company_secret_binding_posture_audit_trg` trigger on
 * `company_secret_bindings` (migration 0144), NOT by application code — a
 * migration or a `psql` session must leave a trace too, and application-level
 * instrumentation cannot see writes that never pass through it.
 *
 * Deliberately has no foreign key to `company_secret_bindings` or `companies`:
 * the deletion of a binding is the event whose history matters most.
 *
 * UPDATE, DELETE and TRUNCATE are rejected by guard triggers. Treat this table
 * as insert-only from the application side; there is no retention prune.
 */
export const companySecretBindingPostureAudit = pgTable(
  "company_secret_binding_posture_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bindingId: uuid("binding_id").notNull(),
    companyId: uuid("company_id").notNull(),
    secretId: uuid("secret_id"),
    /** `insert` | `update` | `delete` | `baseline` */
    op: text("op").notNull(),
    oldEnforced: boolean("old_enforced"),
    newEnforced: boolean("new_enforced"),
    oldAllowedEgress: text("old_allowed_egress").array(),
    newAllowedEgress: text("new_allowed_egress").array(),
    txid: text("txid").notNull(),
    dbUser: text("db_user").notNull(),
    applicationName: text("application_name").notNull(),
    actor: text("actor"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    bindingIdx: index("csb_posture_audit_binding_changed_idx").on(table.bindingId, table.changedAt),
    companyIdx: index("csb_posture_audit_company_changed_idx").on(table.companyId, table.changedAt),
  }),
);
