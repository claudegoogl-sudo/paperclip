import { isUuidLike } from "./agent-url-key.js";
import { normalizeUrlKeySlug } from "./url-key-slug.js";

const NON_ASCII_RE = /[^\x00-\x7F]/;

export function normalizeProjectUrlKey(value: string | null | undefined): string | null {
  return normalizeUrlKeySlug(value);
}

/** Check whether a string contains non-ASCII characters that normalization would strip. */
export function hasNonAsciiContent(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  return NON_ASCII_RE.test(value);
}

/** Extract the first 8 hex chars from a valid UUID, or null. */
function shortIdFromUuid(value: string | null | undefined): string | null {
  if (!isUuidLike(value)) return null;
  return (value as string).trim().replace(/-/g, "").slice(0, 8).toLowerCase();
}

export function deriveProjectUrlKey(name: string | null | undefined, fallback?: string | null): string {
  const base = normalizeProjectUrlKey(name);
  if (base && !hasNonAsciiContent(name)) return base;
  // Non-ASCII content was stripped — append short UUID suffix for uniqueness.
  const shortId = shortIdFromUuid(fallback);
  if (base && shortId) return `${base}-${shortId}`;
  if (shortId) return shortId;
  return base ?? normalizeProjectUrlKey(fallback) ?? "project";
}
