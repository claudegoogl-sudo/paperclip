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
-- Run `node scripts/plugin-config-company-scope-report.mjs <db-url>` before
-- upgrading for the exact row-by-row plan.

ALTER TABLE "plugin_config"
  ADD COLUMN IF NOT EXISTS "company_id" uuid;--> statement-breakpoint

-- Unique on ("plugin_id") alone, so it has to go before the fan-out inserts.
DROP INDEX IF EXISTS "plugin_config_plugin_id_idx";--> statement-breakpoint

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
  lc."config_json",
  lc."last_error",
  lc."created_at",
  lc."updated_at"
FROM legacy_config lc
CROSS JOIN "companies" c
CROSS JOIN primary_company pc
WHERE c."id" <> pc."company_id";--> statement-breakpoint

WITH primary_company AS (
  SELECT min("id"::text)::uuid AS company_id
  FROM "companies"
)
UPDATE "plugin_config" pc
SET "company_id" = primary_company."company_id"
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
