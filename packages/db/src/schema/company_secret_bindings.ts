import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { BindingAutoRenewPolicy } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

export const companySecretBindings = pgTable(
  "company_secret_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    secretId: uuid("secret_id").notNull().references(() => companySecrets.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    configPath: text("config_path").notNull(),
    versionSelector: text("version_selector").notNull().default("latest"),
    required: boolean("required").notNull().default(true),
    // Operator-set egress destination allowlist for handles minted
    // under this binding. `allowedEgress` is operator-only — there is no
    // agent/worker-passable path that can set or extend it (EG1-provenance).
    // NEW bindings are born enforcing (EG4 secure-by-default); pre-existing
    // rows were migrated to log-only by 0092.
    allowedEgress: text("allowed_egress").array().notNull().default([]),
    egressAllowlistEnforced: boolean("egress_allowlist_enforced").notNull().default(true),
    // Operator opt-in for the server-internal task_bridge key auto-renewer.
    // NULL = default-deny: the renewal sweep never touches this binding, even
    // at expiry. Set/changed/cleared ONLY via the board-gated policy route
    // (same provenance pattern as `allowedEgress`); the renewer itself never
    // writes this column. The opt-in carries the exact pinned minimum scope
    // the renewer may mint — the operator's approval and the scope snapshot
    // are one authorization object.
    autoRenewPolicy: jsonb("auto_renew_policy").$type<BindingAutoRenewPolicy | null>(),
    label: text("label"),
    projectionClass: text("projection_class").notNull().default("unclassified"),
    projectionAllowlistKey: text("projection_allowlist_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_secret_bindings_company_idx").on(table.companyId),
    secretIdx: index("company_secret_bindings_secret_idx").on(table.secretId),
    targetIdx: index("company_secret_bindings_target_idx").on(table.companyId, table.targetType, table.targetId),
    targetPathUq: uniqueIndex("company_secret_bindings_target_path_uq").on(
      table.companyId,
      table.targetType,
      table.targetId,
      table.configPath,
    ),
  }),
);
