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
| `PAPERCLIP_HOME` | `~/.paperclip` | Base directory for all Paperclip data |
| `PAPERCLIP_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | Exposure policy when deployment mode is `authenticated` |
| `PAPERCLIP_API_URL` | (auto-derived) | Paperclip API base URL. When set externally (e.g., via Kubernetes ConfigMap, load balancer, or reverse proxy), the server preserves the value instead of deriving it from the listen host and port. Useful for deployments where the public-facing URL differs from the local bind address. |
| `PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL` | (board public origin) | Optional HTTPS origin for native chat provider webhooks when ingress and the board use different hosts. Must have no credentials, path, query, or fragment; invalid configuration refuses startup. Used only for provider callback URLs, not board links, authentication, trusted hosts, or identity confirmation. |
| `PAPERCLIP_RUNNER_PUBLIC_URL` | (unset) | Explicit `wss://` base URL used only when a remote `paperclip_runner` target dials Paperclip directly. Paperclip appends `/api/runner/v1/connect/<runId>`; the reverse proxy must forward WebSocket upgrades for that route. This value is never inferred from request headers. Daytona ignores it and uses provider ingress. |
| `PAPERCLIP_RUNNER_CA_BUNDLE_PATH` | (unset) | Optional PEM CA bundle for direct runner WSS. Platform roots remain enabled. There is no insecure TLS bypass. |
| `PAPERCLIP_RUNNER_REMOTE_BINARY_PATH` | (host build) | Host-local path to a `paperclip-runnerd` artifact built for the remote target OS and architecture. Required when Paperclip and the remote sandbox do not share a compatible platform; build metadata and the required transport mode are verified before launch. |
| `PAPERCLIP_RUNNER_REMOTE_CODEX_PATH` | (unset) | Optional host-local path to a Codex executable built for the remote target OS and architecture. For remote Codex-backed runners, Paperclip stages and verifies this executable beside `paperclip-runnerd`. |
| `PAPERCLIP_RUNNER_REMOTE_CODEX_NPM_SPEC` | (unset) | Optional pinned npm package spec (for example, `@openai/codex@0.153.4`) installed inside each fresh remote lease when its Codex harness is not baked into the sandbox image. Mutually exclusive with `PAPERCLIP_RUNNER_REMOTE_CODEX_PATH`; Paperclip verifies the installed executable before starting `runnerd`. |
| `PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH` | (unset) | Host-local path to the immutable provider pack built by `pnpm --filter @paperclipai/paperclip-runner build:provider-pack`. The pack includes its target-built Node 24.11 runtime, locked production dependencies, OpenCode proxy/executable, and ACPX sidecar. Remote OpenCode and ACPX fail closed without it. A preinstalled pack is accepted only when its complete digested manifest matches this build-owned pack; otherwise Paperclip stages this pack into the sandbox. |
| `PAPERCLIP_AGENT_API_URL` | loopback listen origin (`http://127.0.0.1:<port>`, or `http://[::1]:<port>` for IPv6) when the server binds loopback or a wildcard; otherwise `PAPERCLIP_API_URL` | Base URL injected into local agent runs as their `PAPERCLIP_API_URL`. Kept separate from the public base so agents on the server host never send API calls (and their credentials) through a public access proxy that may answer with an HTML login page. Set it to override, e.g. `http://host.docker.internal:3100` for containerised agents. Invite/join links, board UI links and routine webhook URLs keep using the public base. Sandbox callback bridges are unaffected. |
| `PAPERCLIP_MAX_CONCURRENT_RUNS_HOST` | `ceil(vCPU / 2)` | Host-wide ceiling on concurrently executing agent runs — see [Host-wide run concurrency](#host-wide-run-concurrency). |
| `PAPERCLIP_RUN_ADMISSION_MEMORY_PCT` | `90` | Defer new run admission once the service cgroup's memory usage reaches this percentage of its effective soft limit (`memory.high`, or `memory.max` when no soft limit is set) — see [Memory-pressure run admission](#memory-pressure-run-admission). |
| `PAPERCLIP_RECOVERY_REPLAY_MAX_CONCURRENT` | `ceil(PAPERCLIP_MAX_CONCURRENT_RUNS_HOST / 2)` | Cap on concurrently in-flight boot/recovery replay dispatches, with a jittered `>= 2s` spacing between dispatch starts — see [Staggered boot recovery replay](#staggered-boot-recovery-replay). |
| `PAPERCLIP_HIDDEN_SETTINGS` | (unset) | Comma-separated settings surfaces to hide from the UI and floor at the API, for operators hosting Paperclip for others (managed cloud, internal shared server). See [Hiding settings surfaces](#hiding-settings-surfaces). |
| `PAPERCLIP_SETTING_DEFAULTS` | (unset) | JSON object replacing the schema default of selected instance settings, for hosting operators. See [Operator setting defaults](#operator-setting-defaults). |

Daytona connectivity for `paperclip_runner` uses authenticated provider
WebSocket ingress and follows the instance experimental setting
`enableNativeRunner` (default `false`). There is no separate ingress opt-in.
Disabling Paperclip Runner blocks fresh native starts while persisted native
runs retain their recovery path. The deprecated `enableRunnerPreviewIngress`
key remains accepted in stored and managed configuration for version-skew
compatibility, but it has no runtime effect. The setting has no effect on
legacy adapters or callback bridges.

### Webhook-only chat ingress

Keep `PAPERCLIP_PUBLIC_URL` (or the explicit authentication public URL) pointed
at the actual board. If the board is private, set
`PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL=https://chat-ingress.example.com` and forward
only `POST /api/chat-webhooks/*` from that host. Provider signatures still gate
ingress; this variable does not expose routes or grant provider access.
Never forward the private `local_trusted` board through a public tunnel.

Task links in external messages require an externally safe HTTPS board URL.
Local/private board URLs are omitted with instructions to open the task in
Paperclip; the public webhook host is never substituted for the board. Identity
confirmation stays on the board and requires the user to be able to reach it.

### Preinstalled remote runner images

Remote sandbox images may preinstall `paperclip-runnerd`, `codex`, and the
provider pack at `/opt/paperclip-runner/provider-pack` instead of
paying the upload and npm-install cost on every fresh lease. Put both executable
names on the sandbox user's `PATH`; `$HOME/.local/bin` is checked explicitly
before `PATH`. Paperclip verifies runner build metadata, the selected PRP
transport capability, Codex startup, the provider-pack digest, exact harness
pins, Node compatibility, and packaged bridge digests before linking artifacts
into the run-specific runtime directory. A missing or incompatible executable falls back
to `PAPERCLIP_RUNNER_REMOTE_BINARY_PATH` and
`PAPERCLIP_RUNNER_REMOTE_CODEX_NPM_SPEC` (or
`PAPERCLIP_RUNNER_REMOTE_CODEX_PATH`) without changing the selected transport.
OpenCode and ACPX instead fall back only to
`PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH`; they never start a provider
process on the Paperclip host for a remote target.
The Daytona environment editor's **Configure image** action can create this
image without a separate container registry: install the executables in its
setup sandbox, finish setup, and Paperclip captures and promotes the resulting
Daytona snapshot for future leases.

### Hiding settings surfaces

`PAPERCLIP_HIDDEN_SETTINGS` takes keys from the registry in
`packages/shared/src/settings-visibility.ts`:

- Any instance settings page: `instance.profile`, `instance.environments`,
  `instance.access`, `instance.experimental`,
  `instance.plugins`, `instance.adapters` — removed from navigation and
  routing (the General page is the settings root and stays visible). Hiding
  `instance.access`, `instance.plugins`, or `instance.adapters` also floors
  their management endpoints with `403 settings_operator_managed`; hiding
  `instance.experimental` floors every experimental toggle write.
- Any Instance → General section: `instance.general.censorUsernameInLogs`,
  `instance.general.keyboardShortcuts`, `instance.general.backupRetention`,
  `instance.general.feedbackDataSharingPreference` (each also rejects
  value-changing writes via `PATCH /api/instance/settings/general`), plus the
  UI-only `instance.general.deploymentStatus` and `instance.general.signOut`.
- Any experimental toggle: `instance.experimental.<flagKey>` (e.g.
  `instance.experimental.enableSmokeLab`) — the card disappears and
  value-changing writes are rejected.
- Any top-level company settings page: `company.members`, `company.invites`,
  `company.secrets`, `company.export`, `company.import` — removed from the
  settings sidebar, tab bar, and routing (the company General page is the
  settings root and stays visible). These are UI-visibility keys: the
  membership, invite, secret, and export APIs stay live for agents and
  integrations. `company.import` is the exception — hiding it also floors
  every company-import route with `403 settings_operator_managed`. On
  cloud-managed instances import is floored unconditionally with
  `403 cloud_managed`, independent of this variable.
- A single tab of the Secrets page: `company.secrets.vaults` (Provider
  vaults) and `company.secrets.proposals` (Proposals) — the tab disappears
  while the rest of the page stays up. UI-visibility only; the secret
  provider-config and proposal APIs stay live for agents and integrations.

Unknown keys are logged and ignored, so one list can be rolled across a fleet
of mixed app versions, and retired keys (like `instance.heartbeats`, whose
page was removed) can stay in an operator list without breaking older or
newer releases. With the variable unset nothing is hidden and behavior
is identical to earlier releases. Hiding a toggle does not change its value;
pair hiding with the desired default where it matters (for general settings,
see [Operator setting defaults](#operator-setting-defaults)).

### Operator setting defaults

`PAPERCLIP_SETTING_DEFAULTS` takes a JSON object whose fields come from the
registry in `packages/shared/src/setting-defaults.ts` (currently
`feedbackDataSharingPreference`). The operator value substitutes for the
schema default at read time: any field whose effective value is still the
schema default resolves to the operator value, while an explicit non-default
user choice always wins. The overlay is never persisted, so unsetting the
variable restores stock behavior wherever a user has not chosen otherwise.
A client that writes back the full settings object it read does not persist
the operator value either: writing the operator value over a still-unchosen
field is treated as an echo of the overlay and the field stays unchosen.

Example: `PAPERCLIP_SETTING_DEFAULTS='{"feedbackDataSharingPreference":"allowed"}'`
defaults AI feedback sharing to allowed; pairing it with
`instance.general.feedbackDataSharingPreference` in `PAPERCLIP_HIDDEN_SETTINGS`
also hides the control and floors value-changing writes.

Unknown field names are logged and ignored (mixed-version fleet safe).
Malformed JSON or an invalid value for a known field refuses startup — policy
configuration fails closed.

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



## Host-wide run concurrency

An agent's `heartbeat.maxConcurrentRuns` is a **per-agent** limit. Because every
agent has its own, the sum across an instance can be far larger than the host can
actually execute — 38 agents at the default of 20 each is 760 theoretical
concurrent runs regardless of how many cores the box has.

`PAPERCLIP_MAX_CONCURRENT_RUNS_HOST` is a second, **host-wide** ceiling checked
before every dispatch, across all agents and all companies:

- **Default:** `ceil(vCPU / 2)`, where vCPU is Node's `availableParallelism()`.
  That is quota-aware, so on a host whose cgroup limits it to 4 cores of an
  8-core machine the default resolves to `2`, not `4`. Set the variable
  explicitly to pin a value.
- **Range:** clamped to `1`–`50`. A value below `1`, a non-number, or an empty
  string is ignored and the default is used.
- **Counted statuses:** only runs in the `running` status count. `queued` and
  `scheduled_retry` runs hold an issue execution lock but no adapter process, and
  counting `scheduled_retry` would deadlock the scheduler, because such a run can
  only leave that status by being promoted through this same gate.
- **Liveness:** a `running` run only counts if a process is actually behind it —
  it is executing in-process or its child pid / process group is still alive. A
  `running` row left behind by a crashed or restarted process (an orphan the
  reaper cleans up on its next tick) does not consume the budget, so a few orphans
  cannot stall every agent. Freshly claimed runs, which are `running` before their
  process registers, are held by an in-flight admission reservation in the
  meantime, so they are never double-counted or missed.

The resolved value is logged once at startup as `resolved host-wide concurrent
run ceiling`, with `source` (`env` or `default`) and the detected `vcpuCount`.

Runs refused by the ceiling **stay queued** — they are never cancelled or failed —
and are re-offered a slot as soon as a running run finishes. Each refusal logs
`heartbeat dispatch deferred by host concurrent-run ceiling` at `warn` with the
current host count and ceiling, so throttling is distinguishable from idleness.

When the ceiling is the scarce resource, a single agent may claim at most
`ceil / (agents with queued work)` runs per dispatch pass, so one busy agent
cannot take the whole host budget. The per-agent `maxConcurrentRuns` still
applies as a secondary gate.

## Memory-pressure run admission

`PAPERCLIP_MAX_CONCURRENT_RUNS_HOST` bounds how many agent runs execute at
once, but it cannot see the cgroup memory budget those runs fill. After a
crash-loop restart, boot recovery replays continuations for every stranded
`in_progress` issue, and the ceiling happily admits a full house of heavy
adapter processes — refilling the service cgroup to `memory.high`/`memory.max`
and converting a recoverable restart into another OOM.

`PAPERCLIP_RUN_ADMISSION_MEMORY_PCT` adds a memory-pressure backoff to the same
admission gate:

- **What is read:** the server's own cgroup v2 memory files (`memory.current`,
  `memory.high`, `memory.max`, `memory.events`), discovered via
  `/proc/self/cgroup` and `/proc/self/mountinfo`.
- **Threshold:** the variable is a percentage of the *effective soft limit* —
  `memory.high` when set, `memory.max` otherwise, and the smaller of the two
  when both are set (so a unit with inverted limits — `MemoryHigh` ≥
  `MemoryMax` — defers before the hard limit, not after the OOM killer has
  fired). Range `1`–`100`, default `90`. Unusable values are ignored and the
  default is used.
- **Behavior:** a run whose admission would start at or above the threshold is
  deferred through the exact same deferral/drain machinery a ceiling refusal
  uses — one more deferral reason, not a new queue. Deferred runs stay queued
  and are re-offered a slot as running work finishes and memory drains.
- **No-op off Linux:** on hosts without cgroup v2 memory files (macOS, Windows,
  minimal CI containers) or with no limit set, the check detects this and
  changes nothing.
- **Observability:** each refusal logs
  `heartbeat dispatch deferred by cgroup memory pressure` at `warn` with the
  pressure percentage, threshold, current bytes, effective limit, and the
  cumulative `memory.events` `high` counter; the run-ceiling state surface
  reports `memoryPressurePct` and `deferralsByMemory`.

Happy path — a host whose service unit sets `MemoryHigh=10G` and
`MemoryMax=12G` wants admission to back off once anonymous memory passes
~8.5G:

```bash
# systemd override
[Service]
Environment=PAPERCLIP_RUN_ADMISSION_MEMORY_PCT=85
```

On restart, boot replay still queues every stranded continuation, but
admission defers while the cgroup is hot and drains the backlog as memory
falls back under the threshold.

## Staggered boot recovery replay

The recovery sweep requeues continuations for stranded `in_progress` issues in
one pass, and the queued-run drain dispatches a queued run per agent — together
they can spawn a full house of adapter processes seconds after a restart.
Replay dispatches (recovery-driven wakes and the boot queued-run drain) are
therefore paced:

- **Cap:** at most `PAPERCLIP_RECOVERY_REPLAY_MAX_CONCURRENT` replay dispatches
  in flight at once. Default `ceil(hostCeiling / 2)`, clamped to the host
  ceiling; values below `1` or non-numbers fall back to the default.
- **Spacing:** a jittered delay of at least 2s (plus up to 4s of jitter)
  between dispatch starts, so processes respawn spread out instead of in one
  burst. An isolated dispatch (nothing else replaying) still starts
  immediately — the spacing only binds during bursts.
- **Not a queue:** every paced wake still runs, still goes through the normal
  admission gate (`reserveHostRunSlot`), and a failed dispatch releases its
  slot immediately.
- **Observability:** each genuinely delayed replay dispatch logs
  `recovery replay dispatch staggered` at `info` with the wait, cap, and
  in-flight counts.

Happy path — a host with a ceiling of 8 wants boot replay to admit at most 2
continuations at a time:

```bash
# systemd override
[Service]
Environment=PAPERCLIP_RECOVERY_REPLAY_MAX_CONCURRENT=2
```

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
