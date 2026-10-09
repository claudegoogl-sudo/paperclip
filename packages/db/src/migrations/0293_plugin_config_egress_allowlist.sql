-- Host-side plugin config-key egress gate: extends the existing per-binding
-- egress allowlist mechanism onto a second keying axis, a plugin's own
-- `format:"uri"` instance-config keys (e.g. klipper's `moonrakerBaseUrl`),
-- keyed by (company_id, plugin_id, config_key) instead of (company_id,
-- plugin_id, secret_id).
--
-- `allowed_egress`: operator-added EXTRA destinations layered on top of the
-- config key's own declared value (e.g. a secondary printer host) — mirrors
-- `company_secret_bindings.allowed_egress`.
-- `egress_allowlist_enforced`: EG4 secure-by-default for rows created AFTER
-- this ships (column DEFAULT true).
--
-- Backfill amendment (operator decision): unlike 0138 — which flipped
-- pre-EXISTING rows on an already-live table — this table is brand new, so
-- there are no pre-existing rows to flip. Instead this migration BACKFILLS
-- rows for plugin instances that are already configured today, explicitly
-- born `egress_allowlist_enforced = false` (log-only), so shipping this
-- migration is not a live-traffic change for any host currently running a
-- plugin with a `format:"uri"` config key (klipper-0.1.7 on this host).
-- `DEFAULT true` only takes effect for rows created after this migration —
-- new installs, newly-set config keys, or an operator's own allowlist edit.
--
-- The backfill covers TOP-LEVEL `format:"uri"` properties of
-- `instanceConfigSchema` only (no `allOf`/`anyOf`/nested-object walk). Every
-- currently-installed plugin's uri config key (klipper's `moonrakerBaseUrl`;
-- vault's `serverUrl`, out of scope for this change but harmless to backfill) is
-- top-level, so this covers every real instance at migration time. The
-- runtime chokepoint (`plugin-config-egress.ts`) uses the full recursive
-- walker (`collectUriConfigPaths`) for config keys declared after this ships,
-- so a future nested-schema plugin is still gated correctly going forward —
-- it just would not have gotten a log-only backfill row here (a row for a
-- brand-new config key is born enforcing=true by DEFAULT anyway, which is
-- consistent with the backfill amendment: only ALREADY-CONFIGURED instances get the log-only
-- grace period).
CREATE TABLE IF NOT EXISTS "plugin_config_egress_allowlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"config_key" text NOT NULL,
	"allowed_egress" text[] DEFAULT '{}' NOT NULL,
	"egress_allowlist_enforced" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_config_egress_allowlist_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "plugin_config_egress_allowlist_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "plugins"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_config_egress_allowlist_company_idx" ON "plugin_config_egress_allowlist" ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_config_egress_allowlist_plugin_idx" ON "plugin_config_egress_allowlist" ("plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_config_egress_allowlist_company_plugin_key_uq" ON "plugin_config_egress_allowlist" ("company_id","plugin_id","config_key");--> statement-breakpoint
INSERT INTO "plugin_config_egress_allowlist" ("company_id", "plugin_id", "config_key", "allowed_egress", "egress_allowlist_enforced")
SELECT pcs."company_id", pcs."plugin_id", prop.key, '{}', false
FROM "plugin_company_settings" pcs
JOIN "plugins" p ON p."id" = pcs."plugin_id"
CROSS JOIN LATERAL jsonb_each(
	COALESCE(p."manifest_json"->'instanceConfigSchema'->'properties', '{}'::jsonb)
) AS prop(key, value)
WHERE pcs."enabled" = true
	AND prop.value->>'format' = 'uri'
	AND pcs."settings_json" ? prop.key
	AND COALESCE(pcs."settings_json"->>prop.key, '') <> ''
ON CONFLICT ("company_id", "plugin_id", "config_key") DO NOTHING;
