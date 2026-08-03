---
title: Docker
summary: Docker Compose quickstart
---

Run Paperclip in Docker without installing Node or pnpm locally.

## Compose Quickstart (Recommended)

```sh
docker compose -f docker/docker-compose.quickstart.yml up --build
```

Open [http://localhost:3100](http://localhost:3100).

Defaults:

- Host port: `3100`
- Published bind address: `127.0.0.1` (host-only)
- Data directory: `./data/docker-paperclip`

Override with environment variables:

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=../data/pc \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

**Note:** `PAPERCLIP_DATA_DIR` is resolved relative to the compose file (`docker/`), so `../data/pc` maps to `data/pc` in the project root.

## Published Ports Bind to Loopback

All ports published by the shipped Compose files bind to `127.0.0.1`, so a default `docker compose up` is reachable from the host only. Set the bind address explicitly when you want off-host access:

| Variable | Default | Applies to |
|----------|---------|------------|
| `PAPERCLIP_BIND_ADDR` | `127.0.0.1` | Paperclip server port in `docker-compose.yml` and `docker-compose.quickstart.yml` |
| `PAPERCLIP_DB_BIND_ADDR` | `127.0.0.1` | PostgreSQL port in `docker-compose.yml` |
| `REVIEW_BIND_ADDR` | `127.0.0.1` | both ports in `docker-compose.untrusted-review.yml` |

```sh
PAPERCLIP_BIND_ADDR=0.0.0.0 PAPERCLIP_PUBLIC_URL=http://<host>:3100 \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

The database bind address is separate so that exposing the UI does not implicitly expose PostgreSQL, which `docker-compose.yml` starts with the well-known development password `paperclip`. Change `POSTGRES_PASSWORD` and the matching `DATABASE_URL` before widening `PAPERCLIP_DB_BIND_ADDR`.

> **UFW does not filter Docker-published ports.** Docker publishes via DNAT in `nat/PREROUTING` and filters container traffic in the `DOCKER` chain off `FORWARD`, so published ports never traverse the `INPUT` chain that UFW's default-deny policy governs. A `ufw deny 5432` rule is accepted, appears in `ufw status`, and silently has no effect. The bind address is the effective control; for firewall enforcement as well, use the `DOCKER-USER` chain.

## Manual Docker Build

```sh
docker build -t paperclip-local .
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

## Data Persistence

All data is persisted under the bind mount (`./data/docker-paperclip`):

- Embedded PostgreSQL data
- Uploaded assets
- Local secrets key
- Agent workspace data

## Local Adapter CLIs in Docker

The Docker image pre-installs these agent CLIs so their `*_local` adapters can run inside the container:

- `claude` (Anthropic Claude Code CLI) — `claude_local`
- `codex` (OpenAI Codex CLI) — `codex_local`
- `opencode` (OpenCode multi-provider CLI) — `opencode_local`
- `gemini` (Google Gemini CLI) — `gemini_local` (experimental)

Pass API keys to enable local adapter runs inside the container:

```sh
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e OPENAI_API_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-... \
  -e GEMINI_API_KEY=... \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Each adapter reads its provider's standard credentials — for example `ANTHROPIC_API_KEY` (Claude), `OPENAI_API_KEY` (Codex), and `GEMINI_API_KEY` or `GOOGLE_API_KEY` (Gemini). OpenCode is multi-provider and uses whichever provider key you supply.

> **Gemini key restrictions:** Google requires Gemini API keys to be *restricted* to the Gemini API (scoped in the Google Cloud console); unrestricted keys are blocked and `gemini_local` runs will fail with an auth error. Create a restricted key, or authenticate with `gemini auth login` (OAuth) and persist `~/.gemini` via the data volume so the credential survives container restarts.

The image sets `GEMINI_SANDBOX=false` so the Gemini CLI does not try to launch its own (Docker-in-Docker) sandbox inside the container. The `gemini_local` adapter already passes `--sandbox=none` per run, so this env var only matters if you invoke `gemini` manually inside the container; override it if you have nested-container support and want CLI-level sandboxing.

Without API keys, the app runs normally — adapter environment checks will surface missing prerequisites.
