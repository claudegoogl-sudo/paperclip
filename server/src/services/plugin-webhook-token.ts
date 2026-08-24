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
 * Token entropy in bytes. 16 bytes = 128 bits, exactly the floor.
 */
const TOKEN_ENTROPY_BYTES = 16;

/**
 * Canonical rendered length: base62 of a 128-bit value needs at most
 * ceil(128 / log2(62)) = 22 characters. Every token is left-padded to exactly
 * this width so the string is fixed-width and so the length-ceiling check
 * (`maxTokenEntropyBits`) never *under*-counts a legitimately generated token —
 * a 22-char string over base62 has a ceiling of 22·log2(62) ≈ 131 bits, above
 * the floor. Padding is with the zero digit and is a bijection, so it preserves
 * the full 128 bits of entropy.
 */
const TOKEN_BASE62_LENGTH = 22;

/**
 * Salt entropy in bytes. The salt is not a secret (it only defeats precomputed
 * tables and cross-plugin digest sharing), but it must not be operator-chosen —
 * a chosen salt is one an attacker can precompute against. 12 bytes = 24 hex
 * chars, past the 16-char minimum plugin-webhook-auth.ts enforces.
 */
const SALT_ENTROPY_BYTES = 12;

const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Big-endian base62 encoding of a byte buffer. Leading zero bytes are preserved. */
function encodeBase62(bytes: Buffer): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let out = "";
  if (value === 0n) {
    out = BASE62_ALPHABET[0];
  } else {
    while (value > 0n) {
      const rem = Number(value % 62n);
      out = BASE62_ALPHABET[rem] + out;
      value /= 62n;
    }
  }

  // Each leading 0x00 byte is an information-bearing high-order zero that the
  // numeric conversion drops; re-add one alphabet-zero per leading zero byte so
  // distinct buffers never collide to the same string.
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte === 0) leadingZeros++;
    else break;
  }
  return BASE62_ALPHABET[0].repeat(leadingZeros) + out;
}

/** Generates a fresh 128-bit token, base62-encoded, left-padded to a fixed width. */
export function generateWebhookTokenSecret(): string {
  return encodeBase62(randomBytes(TOKEN_ENTROPY_BYTES)).padStart(
    TOKEN_BASE62_LENGTH,
    BASE62_ALPHABET[0],
  );
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
 * True when a stored config value is already a webhook token digest pair. Used
 * by the mint route to refuse overwriting a config key that holds anything else
 * (e.g. a secret-ref), which would be destructive.
 */
export function isWebhookTokenDigestConfig(
  value: unknown,
): value is WebhookTokenDigestConfig {
  return (
    typeof value === "object"
    && value !== null
    && typeof (value as Record<string, unknown>).salt === "string"
    && typeof (value as Record<string, unknown>).digest === "string"
  );
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
