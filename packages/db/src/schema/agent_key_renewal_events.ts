import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companySecretBindings } from "./company_secret_bindings.js";

/**
 * Append-only audit trail for the server-internal task_bridge key
 * auto-renewer. Every renewal attempt — success, per-stage failure,
 * suspension, recovery, and reconciliation cleanup — writes a row, so no
 * rotation can be silent. Volume is trivial (<= 2 rows/day/policy), so
 * retention is indefinite.
 *
 * NEVER store key plaintext, key hashes, or secret material here: key ids,
 * timestamps, and the (non-secret) pinned scope snapshot only. Key ids carry
 * no FK to `agent_api_keys` on purpose — events outlive the ephemeral key
 * rows they describe.
 */
export const agentKeyRenewalEvents = pgTable(
  "agent_key_renewal_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    bindingId: uuid("binding_id").notNull().references(() => companySecretBindings.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    /** scheduled | recovery | rollback | reconcile */
    trigger: text("trigger").notNull(),
    /** success | failed:<stage> | suspended:<reason> */
    outcome: text("outcome").notNull(),
    oldKeyId: uuid("old_key_id"),
    newKeyId: uuid("new_key_id"),
    newExpiresAt: timestamp("new_expires_at", { withTimezone: true }),
    scopeSnapshot: jsonb("scope_snapshot"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("agent_key_renewal_events_company_idx").on(table.companyId),
    bindingCreatedIdx: index("agent_key_renewal_events_binding_created_idx").on(table.bindingId, table.createdAt),
  }),
);
