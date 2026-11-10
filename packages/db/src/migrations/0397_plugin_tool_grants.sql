-- Per-agent grants for plugin tools flagged requiresGrant (PLA-12427).
-- Reversible: see the DOWN block at the end (run by hand; drizzle is forward-only).
CREATE TABLE IF NOT EXISTS "plugin_tool_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
	"agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
	"tool_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reviewed_by" text NOT NULL,
	"review_due" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_tool_grants_company_agent_tool_uq" ON "plugin_tool_grants" ("company_id","agent_id","tool_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_tool_grants_expires_idx" ON "plugin_tool_grants" ("expires_at");
-- DOWN (manual rollback): DROP TABLE IF EXISTS "plugin_tool_grants";
