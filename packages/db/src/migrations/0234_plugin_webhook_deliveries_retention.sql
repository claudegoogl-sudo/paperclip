-- Make plugin_webhook_deliveries prunable on an age + max-rows basis.
--
-- Background: the anonymous webhook ingestion path
-- (POST /api/plugins/:pluginId/webhooks/:endpointKey) is unauthenticated and
-- was not rate-limited until recently, so a determined caller could grow this
-- table without bound. The request-rate and body-size gap is now closed, but
-- the cumulative row count still grows ~forever on a busy host: each delivery
-- persists its full JSON payload + headers as JSONB, and nothing deletes them.
--
-- The companion service in
-- server/src/services/plugin-webhook-delivery-retention.ts ships an
-- age-bounded + size-bounded batched prune. This migration makes that prune
-- cheap. No rows are deleted by the migration itself.
--
-- What this migration adds:
--
-- 1. A partial index covering the success-row age prune AND the success-row
--    size-prune. Success deliveries have no debugging value once delivered
--    and are pruned on a short clock (default 3 days, see config); they are
--    also the first rows evicted when the table exceeds the max-rows cap.
--    Every per-status prune predicate the service emits is of the shape
--    `WHERE status = 'success' AND created_at <op> <cutoff> ORDER BY
--    created_at LIMIT n`, which this index serves index-only.
--
-- 2. A partial index covering the failed-row age prune AND the failed-row
--    size-prune. Failed deliveries are the incident audit trail for
--    investigating delivery / signature / dispatch failures and are pruned
--    on a much longer clock (default 30 days); they are only evicted by the
--    size sweep after every in-window success row has been reclaimed.
--    Separate index because the predicate differs and because the failed-row
--    count is the smaller set.
--
-- `pending` rows are in-flight deliveries and must never be pruned; they are
-- excluded from every partial predicate below. The retention service asserts
-- this allowlist explicitly. The existing plugin_webhook_deliveries_status_idx
-- (status alone) does not help any ORDER BY created_at LIMIT n prune, which is
-- why the partial indexes below are required.
--
-- Everything below is idempotent: CREATE INDEX IF NOT EXISTS.
--
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: CONCURRENTLY cannot run inside the migration runner's transaction (applyPendingMigrations wraps every migration file in an explicit BEGIN/COMMIT; CREATE INDEX CONCURRENTLY fails with SQLSTATE 25001 in that shape, same constraint documented on 0140, 0142, 0143). Accepting the plain build: each CREATE INDEX takes a SHARE lock that blocks writes to plugin_webhook_deliveries (reads are unaffected) for the build duration. Migrations run at startup before the server serves traffic, so the lock window does not overlap live writes.

-- Success prune scan: age + size, ordered by created_at.
CREATE INDEX IF NOT EXISTS "plugin_webhook_deliveries_success_retention_idx"
  ON "plugin_webhook_deliveries" USING btree ("created_at")
  WHERE "status" = 'success';--> statement-breakpoint

-- Failed prune scan: age + size, ordered by created_at. Kept separate from
-- the success index because the typical prune reads only success rows (the
-- shorter retention) and a combined partial index would force the planner to
-- scan and filter on every tick.
CREATE INDEX IF NOT EXISTS "plugin_webhook_deliveries_failed_retention_idx"
  ON "plugin_webhook_deliveries" USING btree ("created_at")
  WHERE "status" = 'failed';
