-- Append-only audit history for borrowed-handle egress posture.
--
-- `company_secret_bindings.egress_allowlist_enforced` gates whether a borrowed
-- handle may egress to a non-allowlisted destination. Before this migration the
-- column had no history: the only write path that recorded anything was the
-- operator `/enforce` route (activity_log `secret.egress_allowlist_enforced`).
-- A migration, a repair script, or a `psql` session could change it and leave no
-- trace at all — which is exactly what happened when `0138` was re-applied and
-- flattened the flag on every row. That was reconstructable only from `xmin`,
-- which is destroyed by VACUUM/freeze.
--
-- The mechanism here is a trigger rather than application-level instrumentation
-- BECAUSE the change that motivated it did not come from application code.
-- Instrumenting write paths is a denylist of the writers you thought of; a
-- trigger sits below every writer that reaches the Postgres executor
-- (Complete Mediation). This was an explicit design decision rather than a
-- default: auditing at each write path was considered and rejected, because the
-- writer that caused the incident was not a write path anyone had enumerated.
--
-- Idempotent by construction: re-running this file creates nothing new and
-- rewrites nothing. Given that a non-idempotent migration re-run is the reason
-- this table exists, that property is load-bearing, not incidental.

-- History rows deliberately carry NO foreign key to company_secret_bindings.
-- An FK would couple the audit trail's survival to the audited row, and the
-- deletion of a binding is precisely the event whose history matters most.
CREATE TABLE IF NOT EXISTS "company_secret_binding_posture_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"secret_id" uuid,
	"op" text NOT NULL,
	"old_enforced" boolean,
	"new_enforced" boolean,
	"old_allowed_egress" text[],
	"new_allowed_egress" text[],
	"txid" text NOT NULL,
	"db_user" text NOT NULL,
	"application_name" text NOT NULL,
	"actor" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "csb_posture_audit_binding_changed_idx"
	ON "company_secret_binding_posture_audit" ("binding_id", "changed_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "csb_posture_audit_company_changed_idx"
	ON "company_secret_binding_posture_audit" ("company_id", "changed_at");--> statement-breakpoint

-- Records a row whenever the posture PAIR changes. `enforced` and
-- `allowed_egress` are recorded together because either one alone is
-- uninterpretable: `enforced = true` means "deny everything" or "allow these
-- origins" depending entirely on the other column.
CREATE OR REPLACE FUNCTION "company_secret_binding_posture_audit_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
	IF TG_OP = 'UPDATE'
		AND NEW."egress_allowlist_enforced" IS NOT DISTINCT FROM OLD."egress_allowlist_enforced"
		AND NEW."allowed_egress" IS NOT DISTINCT FROM OLD."allowed_egress"
	THEN
		RETURN NULL;
	END IF;

	INSERT INTO "company_secret_binding_posture_audit" (
		"binding_id", "company_id", "secret_id", "op",
		"old_enforced", "new_enforced", "old_allowed_egress", "new_allowed_egress",
		"txid", "db_user", "application_name", "actor"
	) VALUES (
		COALESCE(NEW."id", OLD."id"),
		COALESCE(NEW."company_id", OLD."company_id"),
		COALESCE(NEW."secret_id", OLD."secret_id"),
		lower(TG_OP),
		OLD."egress_allowlist_enforced",
		NEW."egress_allowlist_enforced",
		OLD."allowed_egress",
		NEW."allowed_egress",
		pg_current_xact_id()::text,
		current_user,
		COALESCE(current_setting('application_name', true), ''),
		current_setting('paperclip.actor', true)
	);

	RETURN NULL;
END;
$fn$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "company_secret_binding_posture_audit_trg" ON "company_secret_bindings";--> statement-breakpoint

CREATE TRIGGER "company_secret_binding_posture_audit_trg"
	AFTER INSERT OR UPDATE OR DELETE ON "company_secret_bindings"
	FOR EACH ROW EXECUTE FUNCTION "company_secret_binding_posture_audit_fn"();--> statement-breakpoint

-- Append-only is enforced in the database, not by convention. REVOKE alone
-- would be theatre: the deployed app connects as the table owner and an owner
-- can re-GRANT itself. A guard trigger holds regardless of role.
CREATE OR REPLACE FUNCTION "company_secret_binding_posture_audit_immutable_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
	RAISE EXCEPTION
		'company_secret_binding_posture_audit is append-only (attempted %)', TG_OP
		USING ERRCODE = 'raise_exception';
END;
$guard$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "csb_posture_audit_no_update_delete_trg" ON "company_secret_binding_posture_audit";--> statement-breakpoint

CREATE TRIGGER "csb_posture_audit_no_update_delete_trg"
	BEFORE UPDATE OR DELETE ON "company_secret_binding_posture_audit"
	FOR EACH ROW EXECUTE FUNCTION "company_secret_binding_posture_audit_immutable_fn"();--> statement-breakpoint

DROP TRIGGER IF EXISTS "csb_posture_audit_no_truncate_trg" ON "company_secret_binding_posture_audit";--> statement-breakpoint

CREATE TRIGGER "csb_posture_audit_no_truncate_trg"
	BEFORE TRUNCATE ON "company_secret_binding_posture_audit"
	FOR EACH STATEMENT EXECUTE FUNCTION "company_secret_binding_posture_audit_immutable_fn"();--> statement-breakpoint

-- Baseline row per pre-existing binding. Without it the current value of every
-- binding that predates this migration has no recorded origin, and the table's
-- first rows would silently mean "history starts here" with nothing saying so.
-- `op = 'baseline'` marks these as a snapshot, not an observed transition.
INSERT INTO "company_secret_binding_posture_audit" (
	"binding_id", "company_id", "secret_id", "op",
	"old_enforced", "new_enforced", "old_allowed_egress", "new_allowed_egress",
	"txid", "db_user", "application_name", "actor"
)
SELECT
	b."id", b."company_id", b."secret_id", 'baseline',
	NULL, b."egress_allowlist_enforced", NULL, b."allowed_egress",
	pg_current_xact_id()::text, current_user,
	current_setting('application_name', true), NULL
FROM "company_secret_bindings" b
WHERE NOT EXISTS (
	SELECT 1 FROM "company_secret_binding_posture_audit" a WHERE a."binding_id" = b."id"
);
