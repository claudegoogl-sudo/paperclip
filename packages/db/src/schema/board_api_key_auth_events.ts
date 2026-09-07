import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { boardApiKeys } from "./board_api_keys.js";

// Append-only authentication-event log for the board API key bearer path
// (server/src/middleware/auth.ts). One row per bearer-token authentication
// attempt against a board key, success or failure. This is intentionally
// separate from board_api_keys.last_used_at (a single mutable high-water
// mark with no history) and from activity_log (which only records
// successful, attributed business actions from 2026-08-07 onward and never
// records failed authentication at all).
//
// key_id is nullable: a bad/unknown token authenticates against no row, so
// there is no key to attribute it to. Never store the token or any hash of
// it here beyond what is needed to identify the key (key_id only) -- no
// secret material.
export const boardApiKeyAuthEvents = pgTable(
  "board_api_key_auth_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    keyId: uuid("key_id").references(() => boardApiKeys.id, { onDelete: "set null" }),
    outcome: text("outcome").notNull(), // success | expired | revoked | bad_key
    sourceIp: text("source_ip"),
    userAgent: text("user_agent"),
    method: text("method").notNull(),
    route: text("route").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyIdCreatedAtIdx: index("board_api_key_auth_events_key_id_created_at_idx").on(
      table.keyId,
      table.createdAt,
    ),
    createdAtIdx: index("board_api_key_auth_events_created_at_idx").on(table.createdAt),
    outcomeIdx: index("board_api_key_auth_events_outcome_idx").on(table.outcome),
  }),
);
