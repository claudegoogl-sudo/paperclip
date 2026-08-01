-- PLA-734: queryable would-deny egress observation table (CTO decision PLA-733,
-- option (b)). The egress chokepoint records, per binding, the egress-parser-
-- NORMALIZED destinations (scheme+host+port only — never a raw path/query URL) a
-- borrowed-handle call would have been denied for while the binding is in
-- log-only / migration mode. Operators read this to seed per-binding allowlists.
--
-- Upsert-dedupe: one row per (binding_id, origin); `count`/`last_seen` advance on
-- repeat (the unique index below is the ON CONFLICT target). Cardinality is
-- capped per binding by the chokepoint writer, not by DDL. Rows cascade-delete
-- with their binding (EG3 purge correlation). Idempotent: re-running creates
-- nothing new.
CREATE TABLE IF NOT EXISTS "egress_would_deny_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "egress_would_deny_observations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "egress_would_deny_observations_binding_id_company_secret_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "company_secret_bindings"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "egress_would_deny_binding_origin_uq" ON "egress_would_deny_observations" ("binding_id","origin");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "egress_would_deny_company_idx" ON "egress_would_deny_observations" ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "egress_would_deny_binding_count_idx" ON "egress_would_deny_observations" ("binding_id","count");
