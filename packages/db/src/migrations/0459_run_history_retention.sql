-- Make terminal run history prunable for heartbeat_runs and agent_wakeup_requests.
--
-- Neither table has ever had retention. Measured on a live-shaped database:
-- heartbeat_runs held 22,877 rows going back four months at 451 MB total (42 MB
-- heap, ~385 MB TOAST from context_snapshot averaging ~17 KB/row), and
-- agent_wakeup_requests held ~264,000 rows at 158 MB. Only 17 heartbeat_runs
-- rows and 18 agent_wakeup_requests rows were non-terminal, so >99.9% of both
-- tables is finished history that nothing reads. It is also the TOAST volume
-- that made the previously-unindexed checkout predicate (fixed in 0142) so
-- expensive, and it inflates every database dump.
--
-- Two things block a prune today. Both are fixed here; no rows are deleted by
-- this migration, it only makes deletion possible and cheap.
--
-- 1. Blocking foreign keys. On the same live-shaped database, 16,093 of 16,114
--    prunable runs were referenced by heartbeat_run_events, 11,668 by
--    cost_events and 4,137 by agent_task_sessions. All three were declared
--    ON DELETE no action, so a plain DELETE raises 23503 for essentially every
--    row. heartbeat_run_events.run_id is NOT NULL and is per-run detail with no
--    meaning once its run is gone, so it cascades. cost_events, finance_events
--    and agent_task_sessions keep their rows and lose only the run
--    back-reference -- the same ON DELETE set null treatment every other run
--    reference in this schema already uses (see 0136 for activity_log.run_id).
--    heartbeat_runs.wakeup_request_id stays ON DELETE no action on purpose: the
--    prune excludes still-referenced wakeup rows itself, and leaving the
--    constraint strict means a bug there fails loudly instead of silently
--    severing a live run's attribution.
--
-- 2. Unindexed predicates. EXPLAIN on the prune predicate returned a Seq Scan +
--    Sort on both tables -- the same class of mistake 0142 exists to fix. The
--    partial indexes below cover exactly the terminal status sets the prune
--    uses, so the scan is index-served and the batch LIMIT stops it early. The
--    status lists here are asserted against the shared
--    TERMINAL_HEARTBEAT_RUN_STATUSES / TERMINAL_WAKEUP_REQUEST_STATUSES
--    constants by a test, so the SQL and the code cannot drift apart and
--    silently fall back to a Seq Scan.
--
-- Everything below is idempotent: CREATE INDEX IF NOT EXISTS, and
-- DROP CONSTRAINT IF EXISTS before each ADD CONSTRAINT.

-- Support the ON DELETE set null / cascade referential-integrity probes. Without
-- these, every deleted run seq-scans each child table once. cost_events and
-- finance_events only have composite (company_id, heartbeat_run_id) indexes,
-- which the RI probe cannot use because it filters on the run column alone.
CREATE INDEX IF NOT EXISTS "cost_events_heartbeat_run_idx" ON "cost_events" USING btree ("heartbeat_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_events_heartbeat_run_idx" ON "finance_events" USING btree ("heartbeat_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_task_sessions_last_run_idx" ON "agent_task_sessions" USING btree ("last_run_id");--> statement-breakpoint

-- Support the anti-join that keeps the wakeup prune from deleting a request a
-- surviving heartbeat_run still points at.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_wakeup_request_idx" ON "heartbeat_runs" USING btree ("wakeup_request_id") WHERE "wakeup_request_id" IS NOT NULL;--> statement-breakpoint

-- Retention scan indexes. Partial on the terminal status set so they stay small
-- and so the planner can prove the prune predicate implies the index predicate.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_retention_idx" ON "heartbeat_runs" USING btree ("created_at") WHERE "status" IN ('succeeded', 'succeeded_dirty', 'failed', 'cancelled', 'timed_out');--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: CONCURRENTLY cannot run inside the migration runner's transaction (applyPendingMigrations wraps every migration file in an explicit BEGIN/COMMIT; CREATE INDEX CONCURRENTLY fails with SQLSTATE 25001 in that shape, same constraint documented on 0140 and 0142). Accepting the plain build: it takes a SHARE lock that blocks writes to agent_wakeup_requests (reads are unaffected) for the build duration. Migrations run at startup before the server serves traffic, so the lock window does not overlap live writes.
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_retention_idx" ON "agent_wakeup_requests" USING btree ("requested_at") WHERE "status" IN ('coalesced', 'skipped', 'completed', 'failed', 'cancelled');--> statement-breakpoint

ALTER TABLE "heartbeat_run_events" DROP CONSTRAINT IF EXISTS "heartbeat_run_events_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD CONSTRAINT "heartbeat_run_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "cost_events" DROP CONSTRAINT IF EXISTS "cost_events_heartbeat_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "finance_events" DROP CONSTRAINT IF EXISTS "finance_events_heartbeat_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "agent_task_sessions" DROP CONSTRAINT IF EXISTS "agent_task_sessions_last_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD CONSTRAINT "agent_task_sessions_last_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
