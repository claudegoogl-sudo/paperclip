-- Single instance-wide singleton row recording whether the Claude
-- account is currently parked after a usage-limit hit. Every wake source
-- (issue-comment wake, sweep, routine trigger, scheduled-retry promotion)
-- must consult this row via `startNextQueuedRunForAgent` before dispatching a
-- run for ANY agent in ANY company. Idempotent: re-running creates nothing new.
CREATE TABLE IF NOT EXISTS "usage_limit_parks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" text DEFAULT 'default' NOT NULL,
	"parked_until" timestamp with time zone,
	"reason" text,
	"raw_limit_text" text,
	"source_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_limit_parks_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_limit_parks_singleton_key_idx" ON "usage_limit_parks" ("singleton_key");
