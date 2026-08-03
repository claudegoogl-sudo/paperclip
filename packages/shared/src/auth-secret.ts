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
