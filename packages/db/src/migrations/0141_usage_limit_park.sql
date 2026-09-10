CREATE TABLE "usage_limit_park" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" text DEFAULT 'default' NOT NULL,
	"parked_until" timestamp with time zone,
	"reason" text,
	"raw_text" text,
	"source_run_id" uuid,
	"source_agent_id" uuid,
	"source_company_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_limit_park_singleton_key_idx" ON "usage_limit_park" USING btree ("singleton_key");
