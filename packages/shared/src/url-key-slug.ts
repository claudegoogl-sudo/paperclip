const URL_KEY_DELIM_RE = /[^a-z0-9]+/g;
const URL_KEY_TRIM_RE = /^-+|-+$/g;

/** Lowercase, collapse non-alphanumeric runs to a single "-", and trim leading/trailing "-". */
export function normalizeUrlKeySlug(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(URL_KEY_DELIM_RE, "-")
    .replace(URL_KEY_TRIM_RE, "");
  return normalized.length > 0 ? normalized : null;
}
