-- Append-only authentication-event log for board API key bearer auth
-- (server/src/middleware/auth.ts / services/board-auth.ts). Follow-up from a
-- security review: `board_api_keys.last_used_at` is a single
-- mutable high-water mark with no history, source, or outcome, and
-- `activity_log.actor_key_id` only exists from 2026-08-07 onward and never
-- records a FAILED authentication at all. A repeat brute-force / revoked-key
-- retry investigation hit the same wall every time. This table closes that
-- gap going forward (it does not and cannot backfill the unattributable
-- 2026-05-01..2026-08-07 window -- that history was never captured).
--
-- One row per bearer-token authentication attempt on the board-key path:
-- both successes and failures (expired / revoked / bad_key). key_id is
-- nullable because a bad/unknown token matches no row. No secret material
-- is stored -- never the token, never the key hash, key id only.
--
-- Volume: the board-key bearer path is a low-QPS, operator/agent-tooling
-- surface (CLI + a handful of board-scoped agent callers), not a per-request
-- hot path shared with normal traffic -- see 226 total board_api_key rows in
-- activity_log across 3+ months on the live instance.
-- Expect low hundreds of rows/day even under heavy CLI use. Retention is
-- bounded the same way plugin_webhook_deliveries is (see 0147): a companion
-- age-based prune service is expected before this table would approach
-- activity_log's scale; until that lands, the created_at index below keeps
-- both the write path and any age-bounded prune query cheap.
--
-- Idempotent: IF NOT EXISTS / CREATE INDEX IF NOT EXISTS throughout.
CREATE TABLE IF NOT EXISTS "board_api_key_auth_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "key_id" uuid REFERENCES "board_api_keys"("id") ON DELETE SET NULL,
  "outcome" text NOT NULL,
  "source_ip" text,
  "user_agent" text,
  "method" text NOT NULL,
  "route" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "board_api_key_auth_events_key_id_created_at_idx"
  ON "board_api_key_auth_events" USING btree ("key_id", "created_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "board_api_key_auth_events_created_at_idx"
  ON "board_api_key_auth_events" USING btree ("created_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "board_api_key_auth_events_outcome_idx"
  ON "board_api_key_auth_events" USING btree ("outcome");
