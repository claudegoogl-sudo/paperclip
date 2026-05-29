-- Backfill company_secret_bindings from existing plugin secret-ref config
-- (PLA-660 model-C, ships with PLA-657).
--
-- Derives per-company secret bindings from the secret-ref values operators have
-- already placed in plugin config, so the PLA-657 company-scoped resolver can
-- authorize them with no manual per-tenant insert. This runs at DB level, so it
-- sees every tenant (including secret owners the company-scoped agent JWT cannot).
--
-- Path detection mirrors server/src/services/json-schema-secret-refs.ts
-- collectSecretRefPaths: a binding is created ONLY for config fields a plugin
-- manifest annotates `format: "secret-ref"`. A plugin with no such field gets no
-- bindings -- the collect-all-UUID fallback in extractSecretRefPathsFromConfig is
-- intentionally NOT replicated here (it would bind unannotated UUID-shaped values).
--
-- Each row keys company_id off the secret's TRUE owner (company_secrets.company_id),
-- so it can never create an unresolvable cross-company binding, and uses
-- target_id = plugins.id (the plugin install UUID) to match the resolver lookup
-- (companySecretBindings.targetId === pluginDbId).
--
-- Idempotent: ON CONFLICT (company_id, target_type, target_id, config_path)
-- DO NOTHING preserves any operator/DPR-set binding and makes re-runs a no-op
-- (the unique key excludes secret_id, so a pre-existing row at the same key is
-- kept -- intended). Orphan refs (a UUID with no company_secrets row) and
-- non-UUID values are skipped silently; no raw ref or secret value is emitted.
CREATE OR REPLACE FUNCTION pg_temp.pla660_collect_secret_ref_paths(schema jsonb, prefix text)
  RETURNS SETOF text
  LANGUAGE plpgsql
AS $fn$
DECLARE
  branch jsonb;
  kv record;
  child_path text;
BEGIN
  -- Combinator branches (allOf/anyOf/oneOf) are walked at the SAME prefix.
  FOR branch IN
    SELECT value FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(schema -> 'allOf') = 'array' THEN schema -> 'allOf' ELSE '[]'::jsonb END)
    UNION ALL
    SELECT value FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(schema -> 'anyOf') = 'array' THEN schema -> 'anyOf' ELSE '[]'::jsonb END)
    UNION ALL
    SELECT value FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(schema -> 'oneOf') = 'array' THEN schema -> 'oneOf' ELSE '[]'::jsonb END)
  LOOP
    IF jsonb_typeof(branch) = 'object' THEN
      RETURN QUERY SELECT * FROM pg_temp.pla660_collect_secret_ref_paths(branch, prefix);
    END IF;
  END LOOP;

  -- Object properties: a property annotated `secret-ref` yields a path; every
  -- property schema is recursed into (matching collectSecretRefPaths).
  IF jsonb_typeof(schema -> 'properties') = 'object' THEN
    FOR kv IN SELECT key, value FROM jsonb_each(schema -> 'properties') LOOP
      IF jsonb_typeof(kv.value) = 'object' THEN
        child_path := CASE WHEN prefix = '' THEN kv.key ELSE prefix || '.' || kv.key END;
        IF (kv.value ->> 'format') = 'secret-ref' THEN
          RETURN NEXT child_path;
        END IF;
        RETURN QUERY SELECT * FROM pg_temp.pla660_collect_secret_ref_paths(kv.value, child_path);
      END IF;
    END LOOP;
  END IF;

  RETURN;
END
$fn$;
--> statement-breakpoint
INSERT INTO "company_secret_bindings" (
  "company_id", "secret_id", "target_type", "target_id",
  "config_path", "version_selector", "required", "label",
  "created_at", "updated_at"
)
SELECT DISTINCT ON (cs.company_id, srp.plugin_id, srp.config_path)
  cs.company_id,
  cs.id,
  'plugin',
  srp.plugin_id::text,
  srp.config_path,
  'latest',
  true,
  'backfill PLA-660',
  now(),
  now()
FROM (
  SELECT p.id AS plugin_id, refpath AS config_path
  FROM "plugins" p
  CROSS JOIN LATERAL pg_temp.pla660_collect_secret_ref_paths(
    p.manifest_json -> 'instanceConfigSchema', ''
  ) AS refpath
  WHERE jsonb_typeof(p.manifest_json -> 'instanceConfigSchema') = 'object'
) srp
JOIN LATERAL (
  SELECT (pc.config_json #>> string_to_array(srp.config_path, '.')) AS ref, 0 AS src
  FROM "plugin_config" pc
  WHERE pc.plugin_id = srp.plugin_id
  UNION ALL
  SELECT (pcs.settings_json #>> string_to_array(srp.config_path, '.')) AS ref, 1 AS src
  FROM "plugin_company_settings" pcs
  WHERE pcs.plugin_id = srp.plugin_id
) cand ON true
JOIN "company_secrets" cs ON cs.id::text = lower(cand.ref)
WHERE cand.ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ORDER BY cs.company_id, srp.plugin_id, srp.config_path, cand.src, cs.id
ON CONFLICT ("company_id", "target_type", "target_id", "config_path") DO NOTHING;
