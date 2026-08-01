-- PLA-723: per-binding egress allowlist for borrowed-handle destinations.
-- `allowed_egress`: operator-set destination allowlist (origin entries / *.host).
-- `egress_allowlist_enforced`: EG4 secure-by-default. NEW bindings are born
-- enforcing (column DEFAULT true), so any binding inserted after this migration
-- denies egress to a non-allowlisted destination. Rows that already exist at
-- migration time are flipped to log-only ("would-deny" audit, no block) so the
-- rollout is a time-boxed migration rather than an instant breakage of live
-- bindings. The UPDATE runs once (drizzle journal-gated); new rows are untouched.
ALTER TABLE "company_secret_bindings" ADD COLUMN IF NOT EXISTS "allowed_egress" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_secret_bindings" ADD COLUMN IF NOT EXISTS "egress_allowlist_enforced" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "company_secret_bindings" SET "egress_allowlist_enforced" = false;
