export const MIN_AUTH_SECRET_LENGTH = 32;

// Case-insensitive; entries are stored lowercase so callers compare against a
// lowercased secret. These are the well-known placeholder values that must
// never sign sessions or agent JWTs in authenticated mode.
export const WEAK_AUTH_SECRET_DENYLIST: readonly string[] = [
  "paperclip-dev-secret",
  "changeme",
  "secret",
  "test-secret",
];

// Returns a human-readable reason when the secret is known-weak, or null when
// it is acceptable. Operates on the effective (post-fallback) secret so that a
// weak PAPERCLIP_AGENT_JWT_SECRET cannot slip through a BETTER_AUTH_SECRET-only
// check — that variable is what actually signs agent JWTs.
export function weakAuthSecretReason(secret: string): string | null {
  const value = secret.trim();
  if (WEAK_AUTH_SECRET_DENYLIST.includes(value.toLowerCase())) {
    return "matches a well-known default/placeholder value";
  }
  if (value.length < MIN_AUTH_SECRET_LENGTH) {
    return `is shorter than ${MIN_AUTH_SECRET_LENGTH} characters`;
  }
  return null;
}

export function isWeakAuthSecret(secret: string): boolean {
  return weakAuthSecretReason(secret) !== null;
}

// Every environment variable that can end up signing sessions or agent JWTs.
// The session resolver (better-auth) prefers BETTER_AUTH_SECRET while the
// agent-JWT resolver (agent-auth-jwt) prefers PAPERCLIP_AGENT_JWT_SECRET, so
// when both are set they can select different values.
export const AUTH_SECRET_ENV_KEYS = ["BETTER_AUTH_SECRET", "PAPERCLIP_AGENT_JWT_SECRET"] as const;

// Returns "<VAR> <reason>" for the first weak secret among all signing-capable
// variables, or null. Checks every set variable because the two resolvers have
// opposite precedence — checking only the one better-auth happens to pick can
// miss the value that actually signs agent tokens.
export function weakAuthSecretEnvReason(env: Record<string, string | undefined>): string | null {
  for (const key of AUTH_SECRET_ENV_KEYS) {
    const value = env[key]?.trim();
    if (!value) continue; // unset/empty is the fallback case, not a weak value
    const reason = weakAuthSecretReason(value);
    if (reason) return `${key} ${reason}`;
  }
  return null;
}
