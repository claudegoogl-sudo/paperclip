// Single source of truth for keeping signing-capable server secrets out of
// every child process adapter-utils starts, local or remote.

/**
 * Signing-capable server secrets that must never reach any child process.
 * Holding one of these lets a process mint agent JWTs, decrypt stored secrets,
 * or sign privileged server artifacts. The list is explicit on purpose: it does
 * not depend on the PAPERCLIP_* prefix rule, so a later allowlist change to
 * that rule cannot re-admit these names. `BETTER_AUTH_SECRET` is the server's
 * JWT-secret fallback. These names are removed from the inherited server env
 * AND from caller-supplied env (adapterConfig.env, secret bindings).
 */
export const CHILD_ENV_SIGNING_KEY_DENYLIST = [
  "PAPERCLIP_AGENT_JWT_SECRET",
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_SECRETS_MASTER_KEY",
  "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
  "PAPERCLIP_DECISION_SIGNING_SECRET",
  "PAPERCLIP_WORKSPACE_HANDOFF_SECRET",
  "PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN",
  "PAPERCLIP_DEV_SERVER_STATUS_TOKEN",
  "PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET",
  "PAPERCLIP_TELEMETRY_BACKEND_TOKEN",
] as const;

/**
 * Server credentials removed from the INHERITED server env only. A caller may
 * still pass its own value (e.g. a project agent's own `DATABASE_URL` via
 * adapterConfig.env); the server's own credential must not leak through.
 */
/** Deletes every signing-capable name from `env` in place. */
export function deleteSigningKeys(env: Record<string, unknown>): void {
  for (const key of CHILD_ENV_SIGNING_KEY_DENYLIST) {
    delete env[key];
  }
}

/** Returns a copy of `env` with every signing-capable name removed. */
export function scrubSigningKeys<T extends Record<string, string | undefined>>(env: T): T {
  const out = { ...env };
  deleteSigningKeys(out as Record<string, unknown>);
  return out;
}

/**
 * The env for a child that would otherwise inherit `process.env` implicitly:
 * the server env plus `extra`, with every signing-capable name removed.
 * Use this for every `spawn`/`execFile` call that does not build its env
 * through `buildChildEnv`.
 */
export function scrubbedProcessEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return scrubSigningKeys({ ...process.env, ...extra });
}

/**
 * JavaScript source that deletes every signing-capable name from the object
 * named `envVar`. Generated wrapper scripts (sandbox proxy, remote process
 * session) run where adapter-utils cannot be imported, so they embed this.
 */
export function signingKeyScrubSource(envVar: string): string {
  return `for (const key of ${JSON.stringify(CHILD_ENV_SIGNING_KEY_DENYLIST)}) delete ${envVar}[key];`;
}
