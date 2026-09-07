import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "pi_local";
export const label = "Pi";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent@0.74.0";

export const models: Array<{ id: string; label: string }> = [];

export const modelProfiles: AdapterModelProfileDefinition[] = [];

export const agentConfigurationDoc = `# pi_local agent configuration

Adapter: pi_local

Use when:
- You want Paperclip to run Pi (the AI coding agent) locally as the agent runtime
- You want provider/model routing in Pi format (--provider <name> --model <id>)
- You want Pi session resume across heartbeats via --session
- You need Pi's tool set (read, bash, edit, write, grep, find, ls)

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- Pi CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file appended to system prompt via --append-system-prompt
- promptTemplate (string, optional): user prompt template passed via -p flag
- model (string, required): Pi model id in provider/model format (for example xai/grok-4)
- thinking (string, optional): thinking level (off, minimal, low, medium, high, xhigh)
- command (string, optional): defaults to "pi"
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
- providerWaitGuard (object, optional): bounds silent provider waits. When the CLI produces no output at all (for example while blocked on the provider), the guard emits a one-time stderr diagnostic naming the best-effort wait class (auth, rate_limit, network, or unknown), periodic progress lines while the silence lasts, and after maxWaitSec of total silence terminates the stalled CLI process so the run fails with the distinct provider_wait_timeout error code. Fields: enabled (bool, default false), idleDiagnosticSec (number, default 900), progressSec (number, default 300), maxWaitSec (number, default 3600; 0 makes the guard observe-only: diagnostics without termination). Environment overrides: PAPERCLIP_PI_WAIT_GUARD, PAPERCLIP_PI_WAIT_IDLE_DIAGNOSTIC_SEC, PAPERCLIP_PI_WAIT_PROGRESS_SEC, PAPERCLIP_PI_WAIT_MAX_SEC (config values win over env). Not armed for sandbox execution targets, which already carry their own wall-clock backstop.

Notes:
- Pi supports multiple providers and models. Use \`pi --list-models\` to list available options.
- Paperclip requires an explicit \`model\` value for \`pi_local\` agents.
- Sessions are stored in ~/.pi/paperclips/ and resumed with --session.
- All tools (read, bash, edit, write, grep, find, ls) are enabled by default.
- Agent instructions are appended to Pi's system prompt via --append-system-prompt, while the user task is sent via -p.
- The providerWaitGuard watchdog is off by default. Enable it when runs may block silently on the provider; tune maxWaitSec above your longest legitimate silent stretch (a long in-agent tool run streams no output until the tool finishes).
`;
