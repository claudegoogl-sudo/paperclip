-- Phase 1 of the plugin_config operator/tenant split. Additive only:
-- nothing is deleted from plugin_config. Rollback = drop this table.
CREATE TABLE IF NOT EXISTS "plugin_operator_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "plugin_id" uuid NOT NULL REFERENCES "plugins"("id") ON DELETE CASCADE,
  "config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_operator_config_plugin_idx" ON "plugin_operator_config" ("plugin_id");
--> statement-breakpoint
-- Copy operator-plane keys (any key the host manifest does not mark
-- "x-paperclip-scope": "tenant") from the oldest plugin_config row per plugin.
-- Per-company rows are identical copies of one pre-fan-out source, so one
-- row per plugin is lossless. ON CONFLICT DO NOTHING makes re-runs no-ops.
INSERT INTO "plugin_operator_config" ("plugin_id", "config_json")
SELECT src.plugin_id,
       COALESCE((
         SELECT jsonb_object_agg(kv.key, kv.value)
         FROM jsonb_each(src.config_json) kv
         WHERE COALESCE(p.manifest_json #>> ARRAY['instanceConfigSchema','properties',kv.key,'x-paperclip-scope'], '') <> 'tenant'
       ), '{}'::jsonb)
FROM (
  SELECT DISTINCT ON (plugin_id) plugin_id, config_json
  FROM "plugin_config"
  ORDER BY plugin_id, created_at, id
) src
JOIN "plugins" p ON p.id = src.plugin_id
ON CONFLICT ("plugin_id") DO NOTHING;
