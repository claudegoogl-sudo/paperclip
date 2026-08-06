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
 * All environment variables that can hold auth secrets.
 * Better-auth prefers BETTER_AUTH_SECRET; agent JWT signing prefers PAPERCLIP_AGENT_JWT_SECRET.
 * BOTH must be strong in authenticated mode — either can be used to sign forgeable tokens.
 */
export const AUTH_SECRET_ENV_KEYS = [
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_AGENT_JWT_SECRET",
] as const;

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
 * Check if ANY set (non-empty after trim) auth secret is weak.
 *
 * This prevents a mirror bypass where BETTER_AUTH_SECRET is strong (satisfying
 * better-auth's validation) but PAPERCLIP_AGENT_JWT_SECRET is weak (used to sign
 * agent JWTs). Both keys must be strong in authenticated mode.
 *
 * @param env - Process environment containing the secret variables
 * @param deploymentMode - The current deployment mode
 * @returns null if all set secrets are valid, or an error string describing the first weak secret found
 */
export function weakAuthSecretEnvReason(
  env: Record<string, string | undefined>,
  deploymentMode: string,
): string | null {
  // Only enforce in authenticated mode
  if (deploymentMode !== "authenticated") {
    return null;
  }

  for (const key of AUTH_SECRET_ENV_KEYS) {
    const rawValue = env[key];
    if (!rawValue) continue; // Skip unset keys (AC2 fallthrough)

    const value = rawValue.trim();
    if (value === "") continue; // Skip empty keys (AC2 fallthrough)

    // Check this specific key
    const error = validateAuthSecretStrength(value, deploymentMode);
    if (error) {
      // Add the key name to the error message for clarity
      return `${key}: ${error}`;
    }
  }

  return null;
}

/**
 * The denylist of known-weak secrets for testing purposes.
 */
export { WEAK_SECRET_DENYLIST, MIN_SECRET_LENGTH };
