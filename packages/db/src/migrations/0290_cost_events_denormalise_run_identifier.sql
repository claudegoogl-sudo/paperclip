-- Denormalise run identifier onto cost_events so run counts survive the run-history prune.
--
-- Migration 0143 relaxed cost_events.heartbeat_run_id to ON DELETE set null, which
-- silently degrades cost reporting:
-- 1. byAgent computes run counts as count(distinct heartbeat_run_id) → NULL reads zero
-- 2. byProject joins on heartbeat_run_id to find project_id → NULL drops the row
--
-- This migration adds a stable run_identifier column (TEXT, nullable) that persists
-- the run ID independently of the FK. It also ensures projectId is populated at
-- write time via the backfill, fixing both degradations without changing the queries
-- (a subsequent commit will update the queries to use run_identifier).
--
-- run_identifier is nullable to accommodate:
-- - Historical rows where heartbeat_run_id was already NULL (runs already pruned)
-- - Edge cases where cost events are created outside the normal heartbeat flow

-- Add the run_identifier column, nullable
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "run_identifier" text;

-- Backfill: copy heartbeat_run_id::text to run_identifier where heartbeat_run_id is NOT NULL
-- Rows whose runs were already pruned (heartbeat_run_id IS NULL) cannot be recovered
UPDATE "cost_events"
SET "run_identifier" = "heartbeat_run_id"::text
WHERE "heartbeat_run_id" IS NOT NULL;

-- Backfill projectId where it's NULL but we can still resolve it via activity_log
-- This fixes the byProject degradation (rows with NULL run_id would be dropped)
WITH project_attribution AS (
  SELECT DISTINCT
    ce."id" AS cost_event_id,
    i."project_id"
  FROM "cost_events" ce
  INNER JOIN "activity_log" al ON al."run_id" = ce."heartbeat_run_id"
  INNER JOIN "issues" i ON i."id"::text = al."entity_id"
  WHERE ce."project_id" IS NULL
    AND ce."heartbeat_run_id" IS NOT NULL
    AND al."entity_type" = 'issue'
    AND i."project_id" IS NOT NULL
)
UPDATE "cost_events" ce
SET "project_id" = pa."project_id"
FROM "project_attribution" pa
WHERE ce."id" = pa."cost_event_id";
