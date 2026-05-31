import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecretBindings } from "./company_secret_bindings.js";

/**
 * PLA-734 — queryable would-deny egress observations (CTO decision PLA-733,
 * option (b)). The egress chokepoint records, per binding, the normalized
 * destinations a borrowed-handle call WOULD have been denied for under
 * enforcement (the binding is still in log-only / migration mode). Operators
 * read this table to seed per-binding allowlists from real traffic before the
 * enforce-flip.
 *
 * SecurityEngineer constraints baked into the shape:
 *  - `origin` is the egress-parser-NORMALIZED destination ONLY (scheme+host+port).
 *    The raw URL — which can carry tokens/PII in its path/query — is never
 *    persisted. The chokepoint drops any destination that does not parse.
 *  - One row per `(binding_id, origin)` (upsert-dedupe), NOT row-per-request:
 *    `count` is bumped and `last_seen` advanced on repeat. Cardinality is capped
 *    per binding at the writer to bound table growth / suggestion-flooding DoS.
 *  - Rows are UNTRUSTED suggestions. Nothing here is ever auto-applied to a
 *    binding's `allowed_egress`; an operator-review surface must opt each in.
 *  - `company_id` is denormalized for a company-scoped (BOLA-safe) read path.
 *  - `binding_id` cascades on binding delete so observations are purged with the
 *    binding they describe (EG3 purge correlation).
 */
export const egressWouldDenyObservations = pgTable(
  "egress_would_deny_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => companySecretBindings.id, { onDelete: "cascade" }),
    // Normalized origin only — scheme+host+port, allowlist-shaped. NEVER a raw
    // path/query-bearing URL.
    origin: text("origin").notNull(),
    count: integer("count").notNull().default(1),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Upsert-dedupe target: one row per (binding, normalized origin).
    bindingOriginUq: uniqueIndex("egress_would_deny_binding_origin_uq").on(
      table.bindingId,
      table.origin,
    ),
    // Company-scoped read path (BOLA): operators list observations for their company.
    companyIdx: index("egress_would_deny_company_idx").on(table.companyId),
    // Per-binding cap pruning + per-binding review ordering.
    bindingCountIdx: index("egress_would_deny_binding_count_idx").on(
      table.bindingId,
      table.count,
    ),
  }),
);
