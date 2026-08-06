import { pgTable, uuid, text, timestamp, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import type { BoardApiKeyScope } from "@paperclipai/shared";
import { authUsers } from "./auth.js";

export const boardApiKeys = pgTable(
  "board_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    // Scope of this key. Null/absent means unscoped (the key inherits its
    // user's full authority) and is the column default, so existing keys keep
    // their current behaviour on deploy. { kind: "plugin_ops" } restricts the
    // key to plugin install/enable/disable/upgrade/config + issue read/comment.
    // See enforceBoardKeyScopeMiddleware in server/src/middleware/auth.ts.
    scopeConfig: jsonb("scope_config").$type<BoardApiKeyScope | null>(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyHashIdx: uniqueIndex("board_api_keys_key_hash_idx").on(table.keyHash),
    userIdx: index("board_api_keys_user_idx").on(table.userId),
  }),
);
