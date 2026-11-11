CREATE TABLE "plugin_tool_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"tool_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reviewed_by" text NOT NULL,
	"review_due" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plugin_tool_grants" ADD CONSTRAINT "plugin_tool_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_tool_grants" ADD CONSTRAINT "plugin_tool_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_tool_grants_company_agent_tool_uq" ON "plugin_tool_grants" USING btree ("company_id","agent_id","tool_key");--> statement-breakpoint
CREATE INDEX "plugin_tool_grants_expires_idx" ON "plugin_tool_grants" USING btree ("expires_at");
