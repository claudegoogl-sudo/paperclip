-- Sibling of 0139_egress_would_deny_observations.sql for the
-- config-key egress allowlist. Records, per PLUGIN (not per company — the
-- enforcement decision is company-agnostic per operator amendment A2), the
-- egress-parser-NORMALIZED destinations (scheme+host+port
-- only — NEVER a raw path/query-bearing URL, which is attacker-influenced and
-- frequently carries secrets) a `ctx.http.fetch` call would have been denied
-- for while the plugin's config-key allowlist is in log-only mode.
--
-- Same upsert-dedupe + no-DDL-cardinality-cap discipline as 0139: one row per
-- (plugin_id, origin); the chokepoint writer caps cardinality, not this DDL.
CREATE TABLE IF NOT EXISTS "plugin_config_egress_would_deny_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_config_egress_would_deny_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "plugins"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_config_egress_would_deny_plugin_origin_uq" ON "plugin_config_egress_would_deny_observations" ("plugin_id","origin");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_config_egress_would_deny_plugin_count_idx" ON "plugin_config_egress_would_deny_observations" ("plugin_id","count");
