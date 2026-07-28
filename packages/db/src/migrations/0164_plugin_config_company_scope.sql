-- Scope plugin configuration rows by company before re-enabling plugin secret
-- refs. Legacy rows were instance-global, so every one of them fans out to
-- every company.
--
-- FORK-LOCAL DIVERGENCE from upstream v2026.722.0 (PLA-1833). Upstream resolves
-- each legacy row to a single owning company -- first by unique
-- company_secret_bindings owner, then single-company instance, then fan-out but
-- only for plugins with no bindings at all -- and RAISEs when a row is still
-- unresolved. On a multi-tenant instance that fails twice over:
--   * a plugin bound in two or more companies matches no pass, so the guard
--     fires and the whole upgrade transaction aborts; and
--   * a row that does resolve collapses an instance-global config down to one
--     company, so configService.getForCompany() returns {} for every other
--     tenant that is using the plugin today.
-- company_secret_bindings answers "which companies hold a secret for this
-- plugin", which is both over- and under-inclusive as a stand-in for "which
-- companies is this plugin configured for". A legacy row had no owner because
-- it applied to the whole instance, so fan-out is the faithful conversion and
-- the only rule that preserves current behaviour for every tenant.
--
-- Secret refs are the one thing that does NOT fan out (PLA-1843). A field a
-- manifest annotates `format: "secret-ref"` names a secret owned by exactly one
-- company, so copying it verbatim would leave every other tenant's row pointing
-- at a foreign secret. POST /api/plugins/:pluginId/config rejects that with 422
-- ("Plugin config references a secret outside the selected company"), which
-- wedges the GET -> edit -> POST round trip for every non-owning company. Those
-- paths are therefore dropped from the copies; all other config
-- (topicMap, catchAllIssueMap, companyPolicies, ...) travels verbatim, because
-- a global worker still needs the whole map. Runtime resolution is unaffected
-- either way: it reads company_secret_bindings, never plugin_config.
--
-- The fan-out only covers the companies that exist when this runs. A company
-- created afterwards gets no plugin_config row, so configService.getForCompany()
-- reads {} for it and the plugin has to be configured explicitly for that
-- tenant. That degrades to "unconfigured", not "unauthenticated" -- config.get
-- denies rather than fails open (PLA-1819) -- but new tenants need provisioning.
--
-- Run `pnpm db:plugin-config-report [db-url]` before upgrading for the exact
-- row-by-row plan, including which secret-ref path is kept for which company.

ALTER TABLE "plugin_config"
  ADD COLUMN IF NOT EXISTS "company_id" uuid;--> statement-breakpoint

-- Unique on ("plugin_id") alone, so it has to go before the fan-out inserts.
DROP INDEX IF EXISTS "plugin_config_plugin_id_idx";--> statement-breakpoint

-- Same body as 0185's pla660_collect_secret_ref_paths, itself a port of
-- server/src/services/json-schema-secret-refs.ts collectSecretRefPaths. Kept
-- under a distinct name so 0185's CREATE OR REPLACE cannot silently redefine
-- the function this migration is reading.
CREATE OR REPLACE FUNCTION pg_temp.pla1843_collect_secret_ref_paths(schema jsonb, prefix text)
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
      RETURN QUERY SELECT * FROM pg_temp.pla1843_collect_secret_ref_paths(branch, prefix);
    END IF;
  END LOOP;

  IF jsonb_typeof(schema -> 'properties') = 'object' THEN
    FOR kv IN SELECT key, value FROM jsonb_each(schema -> 'properties') LOOP
      IF jsonb_typeof(kv.value) = 'object' THEN
        child_path := CASE WHEN prefix = '' THEN kv.key ELSE prefix || '.' || kv.key END;
        IF (kv.value ->> 'format') = 'secret-ref' THEN
          RETURN NEXT child_path;
        END IF;
        RETURN QUERY SELECT * FROM pg_temp.pla1843_collect_secret_ref_paths(kv.value, child_path);
      END IF;
    END LOOP;
  END IF;

  RETURN;
END
$fn$;--> statement-breakpoint

-- Returns `config` with every manifest-annotated secret-ref path removed whose
-- secret is owned by a company other than `target_company`.
--
-- Deliberately narrow: a path is dropped ONLY when the ref resolves to a real
-- secret owned by someone else. A value that is not a resolvable secret id --
-- absent, non-UUID, or a UUID with no company_secrets row -- is left alone on
-- every row. Those are pre-existing dangling pointers that the fan-out neither
-- creates nor repairs, and an operator re-pointing one wants to still see it.
CREATE OR REPLACE FUNCTION pg_temp.pla1843_drop_foreign_secret_refs(
  config jsonb,
  manifest jsonb,
  target_company uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
AS $fn$
DECLARE
  result jsonb := config;
  ref_path text;
  path_parts text[];
  node jsonb;
  ref text;
  owner_company uuid;
BEGIN
  IF result IS NULL OR jsonb_typeof(manifest -> 'instanceConfigSchema') IS DISTINCT FROM 'object' THEN
    RETURN result;
  END IF;

  FOR ref_path IN
    SELECT * FROM pg_temp.pla1843_collect_secret_ref_paths(manifest -> 'instanceConfigSchema', '')
  LOOP
    path_parts := string_to_array(ref_path, '.');
    node := result #> path_parts;
    CONTINUE WHEN node IS NULL;

    -- Both shapes extractSecretRefBindingsFromConfig accepts at an annotated
    -- path: the bare UUID every shipped manifest writes today, and the
    -- { "type": "secret_ref", "secretId": ... } object form.
    ref := CASE
      WHEN jsonb_typeof(node) = 'string' THEN node #>> '{}'::text[]
      WHEN jsonb_typeof(node) = 'object' AND node ->> 'type' = 'secret_ref' THEN node ->> 'secretId'
      ELSE NULL
    END;
    CONTINUE WHEN ref IS NULL
      OR ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

    SELECT cs."company_id" INTO owner_company
    FROM "company_secrets" cs
    WHERE cs."id" = ref::uuid;

    IF owner_company IS NOT NULL AND owner_company <> target_company THEN
      result := result #- path_parts;
    END IF;
  END LOOP;

  RETURN result;
END
$fn$;--> statement-breakpoint

WITH legacy_config AS (
  SELECT pc.*
  FROM "plugin_config" pc
  WHERE pc."company_id" IS NULL
), primary_company AS (
  SELECT min("id"::text)::uuid AS company_id
  FROM "companies"
)
INSERT INTO "plugin_config" (
  "plugin_id",
  "company_id",
  "config_json",
  "last_error",
  "created_at",
  "updated_at"
)
SELECT
  lc."plugin_id",
  c."id",
  pg_temp.pla1843_drop_foreign_secret_refs(lc."config_json", p."manifest_json", c."id"),
  lc."last_error",
  lc."created_at",
  lc."updated_at"
FROM legacy_config lc
LEFT JOIN "plugins" p ON p."id" = lc."plugin_id"
CROSS JOIN "companies" c
CROSS JOIN primary_company pc
WHERE c."id" <> pc."company_id";--> statement-breakpoint

-- The primary company keeps the original row, and gets the same scrub: it is
-- just as likely as any other tenant to be the non-owner of a referenced secret.
WITH primary_company AS (
  SELECT min("id"::text)::uuid AS company_id
  FROM "companies"
)
UPDATE "plugin_config" pc
SET "company_id" = primary_company."company_id",
    "config_json" = pg_temp.pla1843_drop_foreign_secret_refs(
      pc."config_json",
      (SELECT p."manifest_json" FROM "plugins" p WHERE p."id" = pc."plugin_id"),
      primary_company."company_id"
    )
FROM primary_company
WHERE pc."company_id" IS NULL;--> statement-breakpoint

DO $$
DECLARE
  unresolved_count integer;
BEGIN
  SELECT count(*) INTO unresolved_count
  FROM "plugin_config"
  WHERE "company_id" IS NULL;

  IF unresolved_count > 0 THEN
    RAISE EXCEPTION 'Cannot assign company_id for % plugin_config row(s); the instance has no companies to fan legacy plugin config out to', unresolved_count;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "plugin_config"
  ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plugin_config_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "plugin_config"
      ADD CONSTRAINT "plugin_config_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "plugin_config_plugin_company_idx"
  ON "plugin_config" USING btree ("plugin_id", "company_id");
