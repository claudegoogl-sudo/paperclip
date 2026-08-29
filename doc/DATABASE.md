# Database

Paperclip uses PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/). There are three ways to run the database, from simplest to most production-ready.

## 1. Embedded PostgreSQL — zero config

If you don't set `DATABASE_URL`, the server automatically starts an embedded PostgreSQL instance and manages a local data directory.

```sh
pnpm dev
```

That's it. On first start the server:

1. Creates a `~/.paperclip/instances/default/db/` directory for storage
2. Ensures the `paperclip` database exists
3. Runs migrations automatically for empty databases
4. Starts serving requests

Data persists across restarts in `~/.paperclip/instances/default/db/`. To reset local dev data, delete that directory.

If you need to apply pending migrations manually, run:

```sh
pnpm db:migrate
```

When `DATABASE_URL` is unset, this command targets the current embedded PostgreSQL instance for your active Paperclip config/instance.

Issue reference mentions follow the normal migration path: the schema migration creates the tracking table, but it does not backfill historical issue titles, descriptions, comments, or documents automatically.

To backfill existing content manually after migrating, run:

```sh
pnpm issue-references:backfill
# optional: limit to one company
pnpm issue-references:backfill -- --company <company-id>
```

Future issue, comment, and document writes sync references automatically without running the backfill command.

This mode is ideal for local development and one-command installs.

Docker note: the Docker quickstart image also uses embedded PostgreSQL by default. Persist `/paperclip` to keep DB state across container restarts (see `doc/DOCKER.md`).

## 2. Local PostgreSQL (Docker)

For a full PostgreSQL server locally, use the included Docker Compose setup.
The compose file lives under `docker/`, so run the command from the repository
root:

```sh
docker compose -f docker/docker-compose.yml up -d
```

This starts PostgreSQL 17 on `localhost:5432`. The stack requires an explicit
`POSTGRES_PASSWORD` and refuses to start without one; see
[PostgreSQL password](DOCKER.md#postgresql-password) for the recipe.

Copy the example env and set `DATABASE_URL` to a connection string that uses
the password you just generated:

```sh
cp .env.example .env
# Edit .env and set DATABASE_URL, e.g.:
# DATABASE_URL=postgres://paperclip:YOUR_PASSWORD@localhost:5432/paperclip
```

Run migrations:

```sh
DATABASE_URL=postgres://paperclip:YOUR_PASSWORD@localhost:5432/paperclip \
  pnpm db:migrate
```

Start the server:

```sh
pnpm dev
```

## 3. Hosted PostgreSQL (Supabase)

For production, use a hosted PostgreSQL provider. [Supabase](https://supabase.com/) is a good option with a free tier.

### Setup

1. Create a project at [database.new](https://database.new)
2. Go to **Project Settings > Database > Connection string**
3. Copy the URI and replace the password placeholder with your database password

### Connection string

Supabase offers two connection modes:

**Direct connection** (port 5432) — use for migrations and one-off scripts:

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

**Connection pooling via Supavisor** (port 6543) — use for the application:

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

### Configure

For the application runtime, use a direct PostgreSQL connection unless the database client has explicit prepared-statement configuration for your pooling mode:

```sh
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

If you later run the app with a pooled runtime URL, set `DATABASE_MIGRATION_URL` to the direct connection URL. Paperclip uses it for startup schema checks/migrations and plugin namespace migrations, while the app continues to use `DATABASE_URL` for runtime queries:

```sh
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
DATABASE_MIGRATION_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

If your hosted database requires transaction-pooling-only connections (pgbouncer transaction mode, Supavisor port 6543, Neon `-pooler` endpoints), set `DATABASE_PREPARED_STATEMENTS=false` so the client does not rely on session-scoped prepared statements, and keep `DATABASE_MIGRATION_URL` on a direct connection. Do not edit database client source files as part of deployment setup.

### Client tuning (optional)

All of these are optional; when unset, the driver defaults apply and behavior is unchanged — typical self-hosted setups need none of them:

```sh
DATABASE_PREPARED_STATEMENTS=false   # required for transaction-mode poolers; default: enabled
DATABASE_POOL_MAX=25                 # connection pool size; default: 10
DATABASE_IDLE_TIMEOUT_SECONDS=60     # close idle pooled connections; default: keep open
DATABASE_CONNECT_TIMEOUT_SECONDS=10  # default: 30
```

### Push the schema

```sh
# Use the direct connection (port 5432) for schema changes
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@...5432/postgres \
  pnpm db:migrate
```

### Free tier limits

- 500 MB database storage
- 200 concurrent connections
- Projects pause after 1 week of inactivity

See [Supabase pricing](https://supabase.com/pricing) for current details.

## Switching between modes

The database mode is controlled by `DATABASE_URL`:

| `DATABASE_URL` | Mode |
|---|---|
| Not set | Embedded PostgreSQL (`~/.paperclip/instances/default/db/`) |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

Your Drizzle schema (`packages/db/src/schema/`) stays the same regardless of mode.

## Migration integrity guardrails

Boot-time and `pnpm db:migrate` runs guard against an out-of-band content swap —
a migration file whose contents changed while its version string stayed the same,
which would otherwise be silently re-applied. Three mechanisms cooperate:

- **File-identity drift detection.** When a migration is applied, its file name is
  bound to the content hash it carried, in a dedicated `drizzle.migration_file_identity`
  table (separate from the Drizzle journal and outside the dedup path). Before
  applying, any pending file whose recorded identity hash differs from the file now
  on disk is reported as **drift** and logged as a warning. Because the check is an
  exact per-name lookup, it survives a scrubbed or renumbered Drizzle journal.
  A pending, previously-applied file on a cluster that predates identity tracking
  cannot be checked; it is reported separately as **unverifiable** ("no drift" there
  means undecided, not clean) rather than silently treated as clean. On a cluster
  with no identity table at all, *every* pending file is unverifiable — nothing there
  is attributable yet. Once tracking starts, the journal row count at that instant is
  frozen in `drizzle.migration_identity_watermark` and is what separates a legacy
  file from a genuinely new one; a live row count would shrink when a journal row is
  deleted and would report the newest applied file as clean.
- **Dry run.** `pnpm db:migrate --dry-run` (or `--check`) reports pending migrations,
  drift, and unverifiable files without applying anything, exiting non-zero if any
  migration is pending. `pnpm db:status` is likewise read-only. Neither is gated.
- **Source-tree production guard.** `pnpm db:migrate` only *applies* against the
  local embedded dev cluster without ceremony. An explicitly configured external
  Postgres target that already holds application tables is refused and fails closed,
  unless `PAPERCLIP_ALLOW_PROD_MIGRATE` names that exact database:

  ```sh
  # refused: external cluster "app_prod" already has tables
  DATABASE_URL=postgres://.../app_prod pnpm db:migrate
  # allowed: opt-in names the target database explicitly
  PAPERCLIP_ALLOW_PROD_MIGRATE=app_prod DATABASE_URL=postgres://.../app_prod pnpm db:migrate
  ```

  The opt-in must match the resolved database name; a bare truthy value does not
  authorise migrating an arbitrary cluster.

Every applied batch also writes a durable audit row (per-file hash, count, package
version, and any `PAPERCLIP_VERSION` env override) to `drizzle.migration_apply_audit`,
best-effort so a failed audit write never crashes an otherwise-migrated server.

## Connection pool behavior

The application pool is sized by `PAPERCLIP_DB_POOL_MAX` and every statement runs under `PAPERCLIP_DB_STATEMENT_TIMEOUT_MS` (see [environment variables](../docs/deploy/environment-variables.md)). Both are backstops. The pool is a fixed resource, so the thing that turns a slow query into an outage is a query holding a connection longer than anyone needs its result.

That is what happens when an HTTP client gives up: the driver runs a query to completion whether or not the request is still there. Paperclip closes that gap with a request-scoped cancellation scope:

- `server/src/middleware/request-query-cancellation.ts` opens a scope per request and aborts it when the socket closes before the response started.
- `packages/db/src/query-cancellation.ts` tracks the queries issued inside that scope and cancels them on abort, which returns their connections to the pool immediately instead of at `statement_timeout`.
- A cancelled query fails with SQLSTATE `57014`, and the middleware logs one `warn` per abandoned request with the route and a `cancelledQueries` count — the signal to watch if pool pressure returns.

Three deliberate exclusions:

- **`GET`/`HEAD` only.** Cancelling a mutation partway through would leave the database in a state nobody asked for, so an abandoned write is allowed to finish.
- **Nothing is cancelled once the response has started.** A streaming response (SSE) sends headers first and keeps querying afterwards; its own close handling owns that teardown.
- **Transactions are not covered.** `sql.begin` runs on its own reserved connection, and cancelling one statement mid-transaction would abort work the caller may still be committing.

One caveat when writing handlers: a Drizzle query builder does not touch the database until it is awaited, so only queries **awaited** inside the request scope are cancellable. Returning a builder from a request handler and awaiting it elsewhere silently opts that query out.

## Migration authoring checklist

The 0126 issue comment attribution backfill showed the failure mode this checklist is meant to prevent: each batch looked for the next rows with an unindexed predicate, so PostgreSQL repeatedly scanned the same table and the migration became O(n²) as the table grew.

When authoring migrations or one-time backfills:

- Create the supporting index for the batch predicate before the backfill loop runs.
- Bound batches by an indexed key, such as an id range or keyset pagination cursor. Do not use `OFFSET` pagination or a query shape that re-scans already-visited rows each batch.
- Avoid unbounded full-table `UPDATE` or `DELETE` statements. Add a selective predicate and process rows in bounded batches when table size can be large.
- Use `CREATE INDEX CONCURRENTLY` for large existing tables when the migration can run outside a transaction and must avoid long write locks.
- Split schema changes, index creation, and data backfill into separate phases so each step has clear locking and rollback behavior.
- Treat the `check:migrations` CI gate as the enforcement backstop for these rules. If it flags a migration, rewrite the migration or add a suppression comment with the indexed predicate, batch bound, and reason the remaining scan is safe.

## Resource membership tables

Paperclip stores current-user sidebar membership state in:

- `project_memberships`
- `agent_memberships`

These rows are company-scoped and user-scoped. A missing row means the user is joined, so existing users keep seeing projects and agents in the sidebar until they explicitly leave them. Rows only control sidebar visibility; they do not affect project/agent detail access, all-pages, selectors, assignment flows, or existing company permissions.

Both tables use a unique key on `(company_id, user_id, resource_id)` and keep `state` as `joined` or `left`. Join/leave mutations are idempotent board-user `/me` operations and write activity entries when the effective state changes.

## Decision training snapshot retention

`decision_training_examples` stores a point-in-time copy of an issue, its comments, relevant runs, and the selected decision. Each row carries the `scrub_deleted_comments_v1` retention policy marker, and JSONL exports include that marker alongside the snapshot.

- Deleting a captured source comment transactionally replaces that comment in every affected snapshot with a content-free redaction tombstone. The original body, presentation, and metadata are not retained in the training record.
- Deleting an issue deletes its decision-training examples through the `issue_id` foreign-key cascade.
- Deleting a training example deletes only that example and does not mutate the source issue.

This policy makes training exports self-describing while keeping the decision record usable after a comment deletion without retaining content the author removed.

## Decision queues and triage provenance

The decisions desk stores queue membership, decide-by/snooze state, and retention state in `decision_queues`, `decision_queue_items`, `decision_triage`, and `decision_retention`. These sidecars use the stable attention identity `(source_kind, source_id)` so all attention source kinds can participate without copying source titles, bodies, projects, or other visibility-sensitive data.

`decision_triage_events` is append-only history for queue and triage changes. Current rows and history both carry server-derived user/agent, heartbeat run, API-key, and responsible-user attribution where applicable. Queue reads must resolve and authorize their source rows at read time; a sidecar row is never a visibility grant.

Triage writes serialize on the company and attention-source identity so concurrent partial updates preserve both fields and produce monotonic history versions.

`decision_retention` tracks the last observed source `activityAt`, Keep, reversible archive provenance, and monotonic source/archive versions. `decision_archive_notification_outbox` has a unique key over company, source identity, archive version, and immutable origin agent so repeated sweeps cannot enqueue duplicate notifications; delivery claims are retryable and coalesced per agent.

## Plugin database namespaces

The plugin runtime tracks plugin-owned database namespaces and migrations in `plugin_database_namespaces` and `plugin_migrations`. Hosted deployments that separate runtime and migration connections should set `DATABASE_MIGRATION_URL`; plugin namespace migration work uses the migration connection when present.

## Backups

Paperclip supports automatic and manual logical database backups. These dumps include
non-system database schemas such as `public`, the Drizzle migration journal, and
plugin-owned database schemas. See `doc/DEVELOPING.md` for the current
`paperclipai db:backup` / `pnpm db:backup` commands and backup retention
configuration.

Database backups do not include non-database instance files such as local-disk
uploads, workspace files, or the local encrypted secrets master key. Back those paths
up separately when you need full instance disaster recovery.

## Secret storage

Paperclip stores secret metadata and versions in:

- `user_secret_definitions`
- `user_secret_declarations`
- `company_secrets`
- `company_secret_versions`
- `company_secret_bindings`
- `secret_access_events`

Company secrets use `company_secrets.scope = 'company'` and are bound directly
through `company_secret_bindings`. User-specific secrets reuse the same provider
and version storage, but each value is a `company_secrets.scope = 'user'` row
with `owner_user_id` and `user_secret_definition_id` set. Definitions describe
the reusable company-level slot, declarations record where `user_secret_ref`
bindings are required, and the concrete value is selected later for the
responsible user.

Secret-aware env bindings are supported by agents, projects, and routines. Routine env lives in `routines.env`, is captured in `routine_revisions.snapshot`, and routine dispatches store `routine_runs.routine_revision_id` so runtime secret resolution uses the env snapshot that existed when the run was created. Routine secret refs bind with `target_type = 'routine'`, `target_id = routines.id`, and `config_path` values under `env.*`.

For local/default installs, the active provider is `local_encrypted`:

- Secret material is encrypted at rest with a local master key.
- Default key file: `~/.paperclip/instances/default/secrets/master.key` (auto-created if missing).
- CLI config location: `~/.paperclip/instances/default/config.json` under `secrets.localEncrypted.keyFilePath`.
- Backup/restore requires both the database metadata and the local master key file; either artifact alone is insufficient.
- The server best-effort enforces `0600` key file permissions and provider health reports permission warnings.
- User-scoped values use the same local encrypted provider path. Database
  backups preserve definitions, declarations, owner metadata, version metadata,
  and access events, but restored user-scoped values are decryptable only when
  the matching local master key is restored with the database.

Optional overrides:

- `PAPERCLIP_SECRETS_MASTER_KEY` (32-byte key as base64, hex, or raw 32-char string)
- `PAPERCLIP_SECRETS_MASTER_KEY_FILE` (custom key file path)

Strict mode to block new inline sensitive env values:

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

You can set strict mode and provider defaults via:

```sh
pnpm paperclipai configure --section secrets
```

Inline secret migration command:

```sh
npx paperclipai secrets migrate-inline-env --company-id <company-id> --apply

# direct database maintenance fallback
pnpm secrets:migrate-inline-env --apply
```

Hosted AWS provider notes live in [SECRETS-AWS-PROVIDER.md](./SECRETS-AWS-PROVIDER.md).
