-- Server-internal task_bridge key auto-renewer (Option 1a) support.
--
-- `company_secret_bindings.auto_renew_policy` is the operator opt-in for
-- automatic renewal of the binding's task_bridge agent key. NULL = default
-- deny: the renewal sweep never touches the binding, even at expiry. It is
-- operator-only by construction — the only write path is a board-gated route
-- (assertBoard), mirroring the provenance pattern of `allowed_egress`
-- (migration 0092 / EG1). The operator's opt-in IS the scope approval: the
-- policy stores the exact pinned minimum scope the renewer may mint, and the
-- sweep re-checks it against the live key on every pass (drift suspends, it
-- never propagates).
--
-- `agent_key_renewal_events` is the append-only audit trail: every renewal
-- attempt — success, per-stage failure, suspension, recovery, reconciliation
-- cleanup — writes a row. Retention is indefinite (volume is trivial:
-- <= 2 rows/day/policy). NEVER store key plaintext or key hashes here: ids,
-- timestamps, and the (non-secret) scope snapshot only.
--
-- Idempotent: re-running creates nothing new. Additive and nullable, so it is
-- safe against a populated table and needs no backfill — NULL is the safe
-- default.
ALTER TABLE "company_secret_bindings" ADD COLUMN IF NOT EXISTS "auto_renew_policy" jsonb;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_key_renewal_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"outcome" text NOT NULL,
	"old_key_id" uuid,
	"new_key_id" uuid,
	"new_expires_at" timestamp with time zone,
	"scope_snapshot" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_key_renewal_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "agent_key_renewal_events_binding_id_company_secret_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "company_secret_bindings"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "agent_key_renewal_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_key_renewal_events_company_idx" ON "agent_key_renewal_events" ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_key_renewal_events_binding_created_idx" ON "agent_key_renewal_events" ("binding_id","created_at");
