-- Scope plugin configuration rows by company before re-enabling plugin secret
-- refs. Legacy rows were instance-global; preserve only rows with an
-- unambiguous company owner and fail closed when a row is ambiguous.

ALTER TABLE "plugin_config"
  ADD COLUMN IF NOT EXISTS "company_id" uuid;--> statement-breakpoint

WITH binding_owner AS (
  SELECT
    pc."id" AS config_id,
    min(csb."company_id"::text)::uuid AS company_id,
    count(DISTINCT csb."company_id") AS company_count
  FROM "plugin_config" pc
  JOIN "company_secret_bindings" csb
    ON csb."target_type" = 'plugin'
   AND csb."target_id" = pc."plugin_id"::text
  GROUP BY pc."id"
)
UPDATE "plugin_config" pc
SET "company_id" = bo."company_id"
FROM binding_owner bo
WHERE pc."company_id" IS NULL
  AND bo."config_id" = pc."id"
  AND bo."company_count" = 1;--> statement-breakpoint

WITH single_company AS (
  SELECT min("id"::text)::uuid AS company_id, count(*) AS company_count
  FROM "companies"
)
UPDATE "plugin_config" pc
SET "company_id" = sc."company_id"
FROM single_company sc
WHERE pc."company_id" IS NULL
  AND sc."company_count" = 1;--> statement-breakpoint

DROP INDEX IF EXISTS "plugin_config_plugin_id_idx";--> statement-breakpoint

WITH unbound_config AS (
  SELECT pc.*
  FROM "plugin_config" pc
  WHERE pc."company_id" IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "company_secret_bindings" csb
      WHERE csb."target_type" = 'plugin'
        AND csb."target_id" = pc."plugin_id"::text
    )
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
  uc."plugin_id",
  c."id",
  uc."config_json",
  uc."last_error",
  uc."created_at",
  uc."updated_at"
FROM unbound_config uc
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
WHERE pc."company_id" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "company_secret_bindings" csb
    WHERE csb."target_type" = 'plugin'
      AND csb."target_id" = pc."plugin_id"::text
  );--> statement-breakpoint

--> statement-breakpoint

-- FORK DELTA (sync/upstream-v2026.824.1): upstream fails closed when a legacy
-- instance-global config row belongs to a plugin bound by MORE THAN ONE company
-- (the single-company assignment above skips it, and it is not unbound either).
-- This instance has two such rows (platform.cad, platform.vault). Reuse
-- upstream's own per-company split semantics from the unbound-row path above:
-- keep the original row for the lowest binding company id and clone one
-- identical config row per additional binding company. Information-preserving;
-- keeps the operator boot free of manual intervention.
WITH ambiguous AS (
  SELECT
    pc."id" AS config_id,
    min(csb."company_id"::text)::uuid AS primary_company
  FROM "plugin_config" pc
  JOIN "company_secret_bindings" csb
    ON csb."target_type" = 'plugin'
   AND csb."target_id" = pc."plugin_id"::text
  GROUP BY pc."id"
  HAVING count(DISTINCT csb."company_id") > 1
)
UPDATE "plugin_config" pc
SET "company_id" = a."primary_company"
FROM ambiguous a
WHERE pc."company_id" IS NULL
  AND pc."id" = a."config_id";--> statement-breakpoint

WITH ambiguous AS (
  SELECT
    pc."id" AS config_id,
    pc."plugin_id",
    pc."config_json",
    pc."last_error",
    pc."created_at",
    pc."updated_at",
    min(csb."company_id"::text)::uuid AS primary_company
  FROM "plugin_config" pc
  JOIN "company_secret_bindings" csb
    ON csb."target_type" = 'plugin'
   AND csb."target_id" = pc."plugin_id"::text
  GROUP BY pc."id", pc."plugin_id", pc."config_json", pc."last_error", pc."created_at", pc."updated_at"
  HAVING count(DISTINCT csb."company_id") > 1
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
  a."plugin_id",
  other."company_id",
  a."config_json",
  a."last_error",
  a."created_at",
  a."updated_at"
FROM ambiguous a
CROSS JOIN LATERAL (
  SELECT DISTINCT csb."company_id"
  FROM "company_secret_bindings" csb
  WHERE csb."target_type" = 'plugin'
    AND csb."target_id" = a."plugin_id"::text
    AND csb."company_id" <> a."primary_company"
) other;--> statement-breakpoint

DO $$
DECLARE
  unresolved_count integer;
BEGIN
  SELECT count(*) INTO unresolved_count
  FROM "plugin_config"
  WHERE "company_id" IS NULL;

  IF unresolved_count > 0 THEN
    RAISE EXCEPTION 'Cannot assign company_id for % plugin_config row(s); resolve ambiguous plugin secret bindings before applying migration 0164', unresolved_count;
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
