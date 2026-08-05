/**
 * Known-weak auth secret denylist (case-insensitive).
 * These values are commonly used as defaults or placeholders and must not be used
 * in authenticated mode where they sign forgeable JWTs.
 */
const WEAK_SECRET_DENYLIST = new Set([
  "paperclip-dev-secret",
  "changeme",
  "secret",
  "test-secret",
]);

/**
 * Minimum required length for an auth secret in authenticated mode.
 * 32 bytes = 256 bits of entropy when hex-encoded.
 */
const MIN_SECRET_LENGTH = 32;

/**
 * Check if an auth secret is known-weak or too short.
 * Returns null if the secret passes validation, or an error message describing the problem.
 *
 * This check applies ONLY in authenticated mode. Local mode intentionally permits weak
 * secrets for development convenience.
 *
 * @param secret - The resolved auth secret value (after fallback from BETTER_AUTH_SECRET to PAPERCLIP_AGENT_JWT_SECRET)
 * @param deploymentMode - The current deployment mode ("authenticated" | "local_trusted" | ...)
 * @returns null if valid, or an error string if invalid
 */
export function validateAuthSecretStrength(
  secret: string,
  deploymentMode: string,
): string | null {
  // Only enforce in authenticated mode
  if (deploymentMode !== "authenticated") {
    return null;
  }

  // Check minimum length
  if (secret.length < MIN_SECRET_LENGTH) {
    return `Auth secret must be at least ${MIN_SECRET_LENGTH} characters in authenticated mode (got ${secret.length}). Generate one with: openssl rand -hex 32`;
  }

  // Check denylist (case-insensitive)
  const normalized = secret.toLowerCase();
  if (WEAK_SECRET_DENYLIST.has(normalized)) {
    return `Auth secret "${secret}" is known-weak and must not be used in authenticated mode. Generate one with: openssl rand -hex 32`;
  }

  return null;
}

/**
 * The denylist of known-weak secrets for testing purposes.
 */
export { WEAK_SECRET_DENYLIST, MIN_SECRET_LENGTH };
