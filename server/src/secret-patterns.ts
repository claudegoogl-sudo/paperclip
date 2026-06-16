/**
 * Single source of truth for secret-shape detection on the control plane.
 *
 * Two surfaces import this module so they cannot drift (PLA-841 / locked
 * specs PLA-302 + PLA-319):
 *
 *  1. The write-side pre-submit denylist on issue/comment routes (PLA-177)
 *     — a body that matches blocks the write with a structured 422 naming
 *     the matched pattern class.
 *  2. The HTTP request logger redactor (PLA-317) — a matched substring in a
 *     logged value is replaced with the pattern's class marker before the
 *     line is persisted.
 *
 * The pattern set, the class labels, and the JWT issuer-allowlist decision
 * therefore live here and only here. Adding/removing a class updates both
 * surfaces at once.
 */

export interface SecretPatternDef {
  /**
   * Stable class label for the pattern. Returned verbatim in the write-block
   * 422 (`blockedPattern`) and used to build the logger redaction marker
   * (`<redacted <label>>`). Treat as a public, stable identifier.
   */
  label: string;
  /**
   * Source matcher. Authored WITHOUT the global flag; scanning helpers add
   * `g` internally so a single shared `lastIndex` is never mutated across
   * callers.
   */
  regex: RegExp;
  /**
   * Optional gate. When present, a raw regex match is only treated as a
   * secret if this returns true. Used for the JWT/`PAPERCLIP_API_KEY`
   * overlap (Option A): decode the issuer claim and allow Paperclip's own
   * run JWTs while still blocking third-party (Auth0/Cognito/Firebase) ones.
   */
  isSecret?: (match: string) => boolean;
}

/**
 * Decode a JWT-shaped string and decide whether it is a *third-party* token
 * (a real leak risk) versus Paperclip's own run JWT (legitimately pasted in
 * `gh auth status`-style debug output). Option A from PLA-177's known
 * overlap: allow `iss === "paperclip"`, block everything else.
 *
 * Conservative on ambiguity: an undecodable / malformed JWT is treated as a
 * secret (false positives on a denylist are cheaper than a true negative).
 */
function isThirdPartyJwt(match: string): boolean {
  const segments = match.split(".");
  const payloadSegment = segments[1];
  if (!payloadSegment) return true;
  try {
    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const claims = JSON.parse(json) as Record<string, unknown>;
    return claims.iss !== "paperclip";
  } catch {
    return true;
  }
}

/**
 * Ordered pattern set. Order is load-bearing: specific literal-prefixed
 * classes come before the generic JWT shape so a literal class is never
 * preempted by the broader matcher (PLA-319 §6). The text of each pattern
 * mirrors PLA-177's locked table; the JWT matcher additionally consumes the
 * optional signature segment so a trailing signature fragment never survives
 * redaction (serves PLA-317 §2 / PLA-319 §4 — no partial value left behind).
 */
export const SECRET_PATTERNS: readonly SecretPatternDef[] = [
  // Fine-grained PAT body length is NOT contractually fixed; an exact `{82}`
  // silently misses off-length variants (81/83-body, future format changes, a
  // truncated copy). Match a min length instead so the class — not one instance
  // length — is redacted/blocked (PLA-1175). The classic `gh[poust]_` classes
  // below stay exact because GitHub documents them at a stable 40-total length.
  { label: "github_pat", regex: /github_pat_[A-Za-z0-9_]{36,}/ },
  { label: "github_classic_pat", regex: /ghp_[A-Za-z0-9]{36}/ },
  { label: "github_oauth", regex: /gho_[A-Za-z0-9]{36}/ },
  { label: "github_user_to_server", regex: /ghu_[A-Za-z0-9]{36}/ },
  { label: "github_server_to_server", regex: /ghs_[A-Za-z0-9]{36}/ },
  { label: "github_refresh", regex: /ghr_[A-Za-z0-9]{76}/ },
  { label: "slack_bot", regex: /xoxb-[A-Za-z0-9-]+/ },
  { label: "slack_user", regex: /xoxp-[A-Za-z0-9-]+/ },
  { label: "aws_access_key", regex: /AKIA[0-9A-Z]{16}/ },
  { label: "aws_temp_key", regex: /ASIA[0-9A-Z]{16}/ },
  { label: "pem_private_key", regex: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/ },
  { label: "jwt", regex: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/, isSecret: isThirdPartyJwt },
] as const;

export interface SecretMatch {
  /** Class label of the matched pattern. */
  label: string;
  /** The matched substring (kept in-process only — never echoed to clients). */
  value: string;
  /** Start index of the match within the scanned string. */
  index: number;
}

/** Redaction marker for a pattern class, e.g. `<redacted github_pat>`. */
export function secretMarker(label: string): string {
  return `<redacted ${label}>`;
}

export interface RedactOptions {
  /**
   * When true, the per-pattern `isSecret` gate is bypassed so EVERY shape match
   * is redacted — including Paperclip's own `iss=paperclip` run JWTs. This is
   * the correct posture for the LOG surface (PLA-842 Finding 1): a run/API JWT
   * is a live bearer credential and must never be persisted to `server.log`,
   * even though the write-block denylist (Option A) legitimately allows it in
   * free-text bodies (an agent pasting `gh auth status`-style debug output).
   *
   * The pattern SET stays shared either way, so the two surfaces still cannot
   * drift; only the issuer-allowlist decision differs per surface.
   */
  ignoreIssuerAllowlist?: boolean;
}

function globalCopy(regex: RegExp): RegExp {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  return new RegExp(regex.source, flags);
}

/**
 * Return every secret match in `text`, ordered by start index. A pattern with
 * an `isSecret` gate only contributes matches it confirms (e.g. third-party
 * JWTs). Non-string input yields no matches.
 */
export function findSecretMatches(text: unknown): SecretMatch[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const matches: SecretMatch[] = [];
  for (const pattern of SECRET_PATTERNS) {
    const scanner = globalCopy(pattern.regex);
    let m: RegExpExecArray | null;
    while ((m = scanner.exec(text)) !== null) {
      const value = m[0];
      if (value.length === 0) {
        scanner.lastIndex += 1;
        continue;
      }
      if (pattern.isSecret && !pattern.isSecret(value)) continue;
      matches.push({ label: pattern.label, value, index: m.index });
    }
  }
  return matches.sort((a, b) => a.index - b.index);
}

/**
 * First secret match in `text`, or null. Used by the write-block denylist to
 * name the offending class in the 422 without echoing the value.
 */
export function firstSecretMatch(text: unknown): SecretMatch | null {
  const matches = findSecretMatches(text);
  return matches.length > 0 ? matches[0] : null;
}

/**
 * Replace every secret substring in `text` with its class marker. Each
 * pattern is applied in set order. By default the `isSecret` gate is honoured
 * so Paperclip's own run JWTs are left intact (Option A — for the write-block
 * surface). Pass `{ ignoreIssuerAllowlist: true }` on the LOG surface so every
 * credential shape is scrubbed regardless of issuer (PLA-842 Finding 1).
 */
export function redactSecrets(text: string, opts: RedactOptions = {}): string {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    const scanner = globalCopy(pattern.regex);
    out = out.replace(scanner, (match) => {
      if (!opts.ignoreIssuerAllowlist && pattern.isSecret && !pattern.isSecret(match)) return match;
      return secretMarker(pattern.label);
    });
  }
  return out;
}

/**
 * Recursively redact secret substrings from every string leaf of an arbitrary
 * value (objects, arrays, nested). Object keys are preserved; only string
 * values are scrubbed. Used by the HTTP logger to cover `reqBody.*` (every
 * leaf), serialized request fields, and any other logged structure. `opts` is
 * threaded through to every leaf.
 */
export function redactSecretsDeep<T>(value: T, opts: RedactOptions = {}): T {
  if (typeof value === "string") return redactSecrets(value, opts) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactSecretsDeep(v, opts)) as unknown as T;
  if (value && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      // Non-plain objects (Buffers, Dates, class instances) are left as-is;
      // the logger serialises them to their own representation.
      return value;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactSecretsDeep(v, opts);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Log-surface variants. The HTTP logger and any direct `logger.*` call that
 * embeds a request URL / body / error message MUST use these so that a live
 * `iss=paperclip` run JWT appearing outside the force-redacted `authorization`
 * header (e.g. in a `?token=` query, a body leaf, or an error string) is still
 * scrubbed from `server.log`. The write-block surface keeps the gated variants
 * above (Option A). Same shared pattern set → no drift (PLA-842 Finding 1).
 */
export function redactSecretsForLog(text: string): string {
  return redactSecrets(text, { ignoreIssuerAllowlist: true });
}

export function redactSecretsDeepForLog<T>(value: T): T {
  return redactSecretsDeep(value, { ignoreIssuerAllowlist: true });
}
