-- Per-binding egress allowlist for borrowed-handle destinations.
-- `allowed_egress`: operator-set destination allowlist (origin entries / *.host).
-- `egress_allowlist_enforced`: EG4 secure-by-default. NEW bindings are born
-- enforcing (column DEFAULT true), so any binding inserted after this migration
-- denies egress to a non-allowlisted destination. Rows that already exist at
-- migration time are flipped to log-only ("would-deny" audit, no block) so the
-- rollout is a time-boxed migration rather than an instant breakage of live
-- bindings.
--
-- The rollout UPDATE is gated on this migration having actually ADDED the
-- column. The runner identifies a migration by the sha256 of the whole file
-- with comments included, so ANY edit here -- a comment-only edit included --
-- gives the file a new identity and re-applies it against databases that
-- already ran it. An unconditional UPDATE would then reset every operator's
-- enforcement flag on re-apply. Gating on "did this run create the column"
-- makes re-application a no-op while keeping the first-install rollout intact.
ALTER TABLE "company_secret_bindings" ADD COLUMN IF NOT EXISTS "allowed_egress" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
DO $$
DECLARE
  column_existed boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = to_regclass('"company_secret_bindings"')
      AND attname = 'egress_allowlist_enforced'
      AND attnum > 0
      AND NOT attisdropped
  ) INTO column_existed;

  ALTER TABLE "company_secret_bindings"
    ADD COLUMN IF NOT EXISTS "egress_allowlist_enforced" boolean DEFAULT true NOT NULL;

  IF NOT column_existed THEN
    UPDATE "company_secret_bindings" SET "egress_allowlist_enforced" = false;
  END IF;
END
$$;
