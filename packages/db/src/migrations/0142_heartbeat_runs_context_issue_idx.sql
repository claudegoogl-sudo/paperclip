-- ~20 call sites across services/heartbeat.ts and services/recovery/service.ts filter
-- heartbeat_runs and agent_wakeup_requests on the run-checkout predicate
-- `context_snapshot ->> 'issueId'` / `payload ->> 'issueId'`. Neither expression was
-- indexed, so every checkout did a Seq Scan and Postgres detoasted context_snapshot
-- (~17 KB/row average, 385 MB TOAST table) for every row to evaluate the predicate.
--
-- Measured on the live DB with EXPLAIN (ANALYZE, BUFFERS): 63,345 buffers (~495 MB)
-- touched to return 0 rows, 59s wall clock, for a single execution of the recovery
-- checkout query. pg_stat_user_tables showed 578 seq scans / 12.58M tuples read in
-- 71 minutes -- ~3 GB/min of sustained pglz decompression, 1-2 of 4 vCPU on an
-- otherwise idle fleet. Full diagnosis in PLA-2024/PLA-2026.
--
-- Both indexes lead with company_id (every call site filters by company first) and
-- are idempotent: re-running creates nothing new. Use these exact names -- they may
-- already exist on the live DB from a hand-applied CREATE INDEX CONCURRENTLY run as
-- an immediate mitigation, and this migration must be a no-op in that case.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_context_issue_idx" ON "heartbeat_runs" USING btree ("company_id", (("context_snapshot"->>'issueId')));
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: CONCURRENTLY cannot run inside the migration runner's transaction (applyPendingMigrations wraps every migration file in an explicit BEGIN/COMMIT; CREATE INDEX CONCURRENTLY fails with SQLSTATE 25001 in that shape, same constraint documented on 0140). Accepting the plain build: it takes a SHARE lock that blocks writes to agent_wakeup_requests (reads are unaffected) for the build duration. Migrations run at startup before the server serves traffic, so the lock window does not overlap live writes.
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_company_payload_issue_idx" ON "agent_wakeup_requests" USING btree ("company_id", (("payload"->>'issueId')));
