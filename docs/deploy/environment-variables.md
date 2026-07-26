---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that Paperclip uses for server configuration.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `PAPERCLIP_BIND` | `loopback` | Reachability preset: `loopback`, `lan`, `tailnet`, or `custom` |
| `PAPERCLIP_BIND_HOST` | (unset) | Required when `PAPERCLIP_BIND=custom` |
| `HOST` | `127.0.0.1` | Legacy host override; prefer `PAPERCLIP_BIND` for new setups |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `PAPERCLIP_ALLOW_EMBEDDED_POSTGRES_PUBLIC` | `true` | When `false`, an `authenticated` + `public` deployment with no `DATABASE_URL` refuses to boot instead of falling back to embedded PostgreSQL. Default (`true`, or unset) warns and continues on embedded PostgreSQL. Set `false` to require an external managed Postgres in production. |
| `PAPERCLIP_DB_POOL_MAX` | `20` | Maximum connections in the application's PostgreSQL pool. Raise it for busier instances, but keep the total across all processes under the server's `max_connections` (commonly `100`). Values below `1` or non-integers fall back to the default. |
| `PAPERCLIP_DB_STATEMENT_TIMEOUT_MS` | `60000` | Per-query `statement_timeout` for the application pool, in milliseconds. A query exceeding it is cancelled and its pool connection released, so one slow query cannot starve the pool. Set `0` to disable (not recommended). Non-integers and negative values fall back to the default. Database migrations run on a separate connection and are not affected. |
| `PAPERCLIP_HOME` | `~/.paperclip` | Base directory for all Paperclip data |
| `PAPERCLIP_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | Exposure policy when deployment mode is `authenticated` |
| `PAPERCLIP_API_URL` | (auto-derived) | Paperclip API base URL. When set externally (e.g., via Kubernetes ConfigMap, load balancer, or reverse proxy), the server preserves the value instead of deriving it from the listen host and port. Useful for deployments where the public-facing URL differs from the local bind address. |

## Run-path Integrity

Optional boot-time self-checks for `paperclipai run`. They guard against a
service unit silently launching the wrong binary — e.g. `ExecStart=/usr/bin/npx
paperclipai run` resolving an upstream release from the public npm registry
instead of the locally installed build. On every boot `paperclipai run` logs the
detected build channel (`fork`/`upstream`) and version; these variables let an
operator turn a mismatch into a fast, loud abort instead of a silent crash loop.

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_REQUIRE_FORK_BUILD` | (unset) | When truthy (`1`/`true`/`yes`/`on`), abort at boot unless the running build carries a `-fork.<n>` version marker |
| `PAPERCLIP_EXPECTED_VERSION` | (unset) | When set, abort at boot unless the running CLI version matches this value exactly |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `~/.paperclip/.../secrets/master.key` | Path to key file |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

## Agent Runtime (Injected into agent processes)

These are set automatically by the server when invoking agents:

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` | Agent's unique ID |
| `PAPERCLIP_COMPANY_ID` | Company ID |
| `PAPERCLIP_API_URL` | Paperclip API base URL (inherits the server-level value; see Server Configuration above) |
| `PAPERCLIP_API_KEY` | Short-lived JWT for API auth |
| `PAPERCLIP_RUN_ID` | Current heartbeat run ID |
| `PAPERCLIP_TASK_ID` | Issue that triggered this wake |
| `PAPERCLIP_WAKE_REASON` | Wake trigger reason |
| `PAPERCLIP_WAKE_COMMENT_ID` | Comment that triggered this wake |
| `PAPERCLIP_APPROVAL_ID` | Resolved approval ID |
| `PAPERCLIP_APPROVAL_STATUS` | Approval decision |
| `PAPERCLIP_LINKED_ISSUE_IDS` | Comma-separated linked issue IDs |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Code adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex adapter) |
