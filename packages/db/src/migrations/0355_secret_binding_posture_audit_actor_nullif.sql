-- Record the request actor in company_secret_binding_posture_audit.actor.
--
-- The app now sets `paperclip.actor` with set_config(..., true) (transaction
-- local) on every authenticated binding write. Once a custom GUC has been set
-- on a connection, current_setting(..., true) returns '' (not NULL) in later
-- transactions on that pooled connection. NULLIF maps that back to NULL so a
-- write with no actor (boot, migration, background) still records NULL.
-- Only the function body changes; the trigger and table are untouched.
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
		NULLIF(current_setting('paperclip.actor', true), '')
	);

	RETURN NULL;
END;
$fn$;
