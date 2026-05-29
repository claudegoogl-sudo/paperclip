ALTER TABLE "activity_log" DROP CONSTRAINT IF EXISTS "activity_log_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
