/**
 * Merge a single opted-in origin into the binding's CURRENT allowlist, returning
 * the full new list to send via `setEgressAllowlist`.
 *
 * `setBindingEgressAllowlist` is REPLACE, not append (server/src/services/secrets.ts).
 * Posting only `{ origin }` would silently collapse an `enforcing` binding's
 * allowlist to one entry — a silent narrowing class the operator surface
 * exists to prevent. Always send the full merged list.
 *
 * - Trim + drop empty so a whitespace origin can't sneak through.
 * - De-dup case-sensitively against the current allowlist (origins are opaque
 *   matcher strings, not human input).
 * - Idempotent: re-allowing an origin already on the list is a no-op.
 * - Preserves input order; the new entry is appended last so the operator can
 *   see "what they just added" at the bottom of the allowlist UI.
 */
export function mergeOriginIntoAllowlist(
  currentAllowed: readonly string[],
  originToAdd: string,
): string[] {
  const trimmed = originToAdd.trim();
  if (trimmed.length === 0) return [...currentAllowed];
  if (currentAllowed.includes(trimmed)) return [...currentAllowed];
  return [...currentAllowed, trimmed];
}
