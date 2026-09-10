// Generation of webhook shared tokens for credential-tiered rate limiting
// (PLUGIN_SPEC §18.1).
//
// Why generation, not validation
// ------------------------------
// The host stores `HMAC-SHA256(key = salt, message = token)` in plain instance
// config, deliberately without key stretching — the digest is on the hot path
// of every delivery (see plugin-webhook-auth.ts). That makes the stored digest
// offline-brute-forceable at full GPU rate by anyone in the config reader set.
//
// A 128-bit random token is immune to that. A low-entropy operator-chosen one
// (`paperclip-webhook-2026`, ~40 bits) falls in a fraction of a second. The host
// cannot measure a token's real entropy from a digest — that is information-
// theoretic, no verification-time check fixes it. So the floor is enforced where
// it can be: at generation. The secure path is made the only convenient path —
// the host mints the token so the operator never has to choose one.
//
// `computeWebhookTokenDigest` (from plugin-webhook-auth.ts) is the single source
// of the construction; this module never reimplements the HMAC.

import { randomBytes } from "node:crypto";

import { computeWebhookTokenDigest } from "./plugin-webhook-auth.js";

/** §18.1 floor. A token must carry at least this many bits of entropy. */
export const WEBHOOK_TOKEN_ENTROPY_FLOOR_BITS = 128;

/**
 * Fixed token width, in base62 characters. 22 uniform base62 symbols carry
 * 22·log2(62) ≈ 131 bits, clearing the 128-bit floor — the "22+ chars of base62"
 * the spec cites. The width is fixed (not the variable length a base62-of-a-
 * bignum encoding produces) so {@link maxTokenEntropyBits}, which infers the
 * charset from the classes a token actually uses, always sees a full-width token.
 */
const TOKEN_CHARS = 22;

/**
 * Salt entropy in bytes. The salt is not a secret (it only defeats precomputed
 * tables and cross-plugin digest sharing), but it must not be operator-chosen —
 * a chosen salt is one an attacker can precompute against. 12 bytes = 24 hex
 * chars, past the 16-char minimum plugin-webhook-auth.ts enforces.
 */
const SALT_ENTROPY_BYTES = 12;

const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * One uniformly-random base62 character. Rejection-samples the raw byte to avoid
 * the modulo bias `byte % 62` would introduce: 62·4 = 248, so bytes ≥ 248 are
 * discarded and every accepted byte maps to an equiprobable symbol.
 */
function randomBase62Char(): string {
  for (;;) {
    const byte = randomBytes(1)[0];
    if (byte < 248) return BASE62_ALPHABET[byte % 62];
  }
}

/**
 * Generates a fresh fixed-width base62 token that clears the 128-bit floor.
 *
 * The token is {@link TOKEN_CHARS} uniform base62 symbols and is guaranteed to
 * contain at least one lowercase letter, one uppercase letter and one digit.
 * That coverage is load-bearing, not cosmetic: {@link maxTokenEntropyBits} infers
 * a token's charset from the classes it actually uses, so a token that happened
 * to omit a class would score below the floor and be rejected by
 * {@link assertWebhookTokenMeetsFloor} — the generator would emit a token its own
 * escape hatch refuses. Forcing full class coverage makes the estimator always
 * see the 62-symbol alphabet, so every generated token clears the same floor a
 * caller-supplied token must. The reroll costs ~5% expected extra draws and the
 * accepted set still carries ≥ 130 bits, comfortably above the floor.
 */
export function generateWebhookTokenSecret(): string {
  for (;;) {
    let token = "";
    for (let i = 0; i < TOKEN_CHARS; i++) token += randomBase62Char();
    if (/[a-z]/.test(token) && /[A-Z]/.test(token) && /[0-9]/.test(token)) {
      return token;
    }
  }
}

/** Generates a fresh salt, hex-encoded, that the operator does not get to pick. */
export function generateWebhookSalt(): string {
  return randomBytes(SALT_ENTROPY_BYTES).toString("hex");
}

/**
 * Upper bound on a token's entropy, in bits: `length * log2(charset size)`,
 * where the charset is inferred from the character classes the token actually
 * uses. This is a *ceiling*, not a measurement — `paperclip-webhook-2026`
 * scores its length times log2(64) even though its real entropy is far lower.
 *
 * That is the fundamental limit the spec calls out: the host cannot know how a
 * token was chosen. What the ceiling *can* do is reject tokens too short to
 * possibly reach the floor. It is a necessary, not sufficient, condition — the
 * real protection is that the default path never asks the operator to choose.
 */
export function maxTokenEntropyBits(token: string): number {
  if (token.length === 0) return 0;
  let charset = 0;
  if (/[a-z]/.test(token)) charset += 26;
  if (/[A-Z]/.test(token)) charset += 26;
  if (/[0-9]/.test(token)) charset += 10;
  // Everything else (symbols, unicode) counts as one modest bucket; do not
  // inflate the ceiling by rewarding exotic characters.
  if (/[^A-Za-z0-9]/.test(token)) charset += 32;
  if (charset <= 1) return 0;
  return token.length * Math.log2(charset);
}

/**
 * Error thrown when a caller-supplied token cannot possibly meet the floor.
 * Distinct type so route/CLI code can map it to a clear 400 rather than a 500.
 */
export class WebhookTokenEntropyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookTokenEntropyError";
  }
}

/**
 * The explicit escape hatch: a caller may bring their own token, but only if it
 * is at least long enough to carry the floor. Throws {@link WebhookTokenEntropyError}
 * otherwise. This exists so the floor is a floor, not a wish — but it is the
 * weaker guarantee (a ceiling check); prefer {@link generateWebhookTokenSecret}.
 */
export function assertWebhookTokenMeetsFloor(token: string): void {
  const bits = maxTokenEntropyBits(token);
  if (bits < WEBHOOK_TOKEN_ENTROPY_FLOOR_BITS) {
    throw new WebhookTokenEntropyError(
      `Webhook token is too short to carry ${WEBHOOK_TOKEN_ENTROPY_FLOOR_BITS} bits of entropy ` +
        `(ceiling for this token is ~${Math.floor(bits)} bits over a ${token.length}-char string). ` +
        `Use a host-generated token instead of choosing your own.`,
    );
  }
}

/** The `{ salt, digest }` shape stored in plugin config under the endpoint's key. */
export interface WebhookTokenDigestConfig {
  salt: string;
  digest: string;
}

/**
 * A minted token plus the config value that recognises it. `token` is returned
 * once for the operator to paste into the provider and must never be persisted.
 */
export interface GeneratedWebhookToken {
  token: string;
  digestConfig: WebhookTokenDigestConfig;
}

/**
 * Mints a token (or accepts a floor-passing supplied one), a fresh salt, and the
 * digest that verifies it. The salt is always host-generated; only the token may
 * be caller-supplied.
 */
export function generateWebhookToken(
  suppliedToken?: string,
): GeneratedWebhookToken {
  let token: string;
  if (suppliedToken !== undefined) {
    assertWebhookTokenMeetsFloor(suppliedToken);
    token = suppliedToken;
  } else {
    token = generateWebhookTokenSecret();
  }
  const salt = generateWebhookSalt();
  const digest = computeWebhookTokenDigest(salt, token);
  return { token, digestConfig: { salt, digest } };
}
