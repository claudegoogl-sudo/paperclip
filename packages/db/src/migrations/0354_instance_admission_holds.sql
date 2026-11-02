-- Single instance-wide singleton row for an operator-set admission hold.
-- While hold_until is in the future the scheduler starts no queued run; queued
-- runs stay queued, running runs are untouched, and the hold self-expires.
-- Additive, no backfill. Idempotent: re-running creates nothing new.
-- Rollback = DROP TABLE "instance_admission_holds".
CREATE TABLE IF NOT EXISTS "instance_admission_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" text DEFAULT 'default' NOT NULL,
	"hold_until" timestamp with time zone,
	"reason" text,
	"set_by_actor_type" text,
	"set_by_actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "instance_admission_holds_singleton_key_idx" ON "instance_admission_holds" ("singleton_key");
