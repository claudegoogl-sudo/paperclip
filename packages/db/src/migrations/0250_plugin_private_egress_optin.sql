-- Instance-admin opt-in for exact private-origin plugin ctx.http.fetch egress.
-- Stored per plugin (not per company): http.fetch carries no company scope, so
-- LAN reach is an instance-level grant. Default empty: no plugin gains private
-- reach until an instance admin adds an exact `http(s)://<ip>:<port>` origin.
-- Additive, no backfill. Rollback = set the list back to '{}'.
ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "private_egress_origins" text[] DEFAULT '{}' NOT NULL;
