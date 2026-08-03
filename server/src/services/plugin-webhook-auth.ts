// Credential recognition for the *unauthenticated* plugin webhook ingestion
// route (POST /api/plugins/:pluginId/webhooks/:endpointKey).
//
// This is not authentication in the usual sense: a failed check never rejects a
// request. It only answers "did this caller present the shared token?", and the
// answer selects which rate-limit budget the delivery is billed to (see
// plugin-webhook-rate-limit.ts). Everything else about the request is unchanged.
//
// Why a digest and not the token
// ------------------------------
// The route is anonymous and pre-company, and plugins are global — one row, one
// worker, every tenant. `plugin-secrets-handler.ts` resolves a `secretRef`
// through `company_secret_bindings` and needs both a company scope and a runId,
// neither of which exists here. So the host cannot read the plugin's webhook
// secret on this path, and any design that assumes it can is dead on arrival.
//
// What the host holds instead is `HMAC-SHA256(key = salt, message = token)` in
// instance config. It is preimage-resistant with a *known* key — recovering the
// token still reduces to a SHA-256 preimage — so it is not itself a secret and
// needs no binding row. It is not, however, world-readable: `GET
// /api/plugins/:pluginId/config` is board/org-gated, so the reader set is
// board/org principals, the plugin's own worker (which already holds its own
// token), and anyone with direct DB or backup access — not anonymous callers
// and not other tenants' agents. The reason the digest is held here rather than
// as a `secretRef` is that the host must read it on this anonymous, pre-company
// route, where `plugin-secrets-handler.ts` cannot resolve a binding at all. So
// the host can recognise the token without ever being able to produce it.
//
// HMAC, not the bare `sha256(salt || token)` the ADR sketched. Two reasons:
//
//  * Bare concatenation is not a canonical encoding: `(salt="ab", token="cd")`
//    and `(salt="abc", token="d")` hash identically, so the salt/token boundary
//    is not pinned and two different endpoint configurations can collide. HMAC
//    keys the salt instead of concatenating it, which removes the ambiguity.
//  * HMAC is the standard, reviewed keyed-hash construction, so no one has to
//    re-derive which of the prefix-secret and suffix-secret SHA-256 pitfalls
//    apply to this particular byte order — a question that is easy to get
//    backwards. (Length extension, the usual worry, does *not* apply here: it
//    breaks `H(secret || msg)` where the secret is the *prefix*, whereas here
//    the salt is the public prefix and the token is the secret suffix. But
//    rather than rely on that being reasoned out correctly every time, we use
//    HMAC and stop having the argument.)
//
// Note the orientation is inverted from conventional HMAC: the *public* salt is
// the key and the *secret* token is the message. That is deliberate and safe
// here — the salt is the per-endpoint public value and the token is what we are
// recognising — but it will read as a mistake to a reviewer who does not expect
// it, hence this note.
//
// Why a mismatch falls through instead of rejecting
// -------------------------------------------------
// Hard-rejecting on mismatch would turn every stale or mistyped digest into a
// total ingestion outage for every tenant sharing the plugin — a one-way door
// dressed as a hardening win. Falling through to the anonymous budget means the
// worst case of a misconfiguration is exactly today's behaviour.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import type { PluginWebhookAuthDeclaration } from "@paperclipai/shared";

import { logger } from "../middleware/logger.js";

/** HMAC-SHA256 hex digest length. A stored digest of any other length is malformed. */
const DIGEST_HEX_LENGTH = 64;

/**
 * Minimum salt length. The salt is not a secret — it exists so that the stored
 * digest is useless against a table precomputed for common tokens, and so that
 * two plugins sharing a token do not share a digest. 16 characters is past the
 * point where such a table is worth building.
 */
const MIN_SALT_LENGTH = 16;

const HEX_ONLY = /^[0-9a-f]+$/;

/**
 * Misconfiguration is reported once per (plugin, endpoint, reason) rather than
 * per request. This code path runs *before* the rate limiter, so a per-request
 * warn would be an attacker-controlled log amplifier. The key space is bounded
 * by real plugins and manifest-declared endpoints, the same bound the limiter
 * relies on.
 */
const warnedConfigProblems = new Set<string>();

function warnOnce(key: string, fields: Record<string, unknown>, message: string): void {
  if (warnedConfigProblems.has(key)) return;
  warnedConfigProblems.add(key);
  logger.warn(fields, message);
}

/** Test seam: the once-per-problem warn state is module-global by design. */
export function resetPluginWebhookAuthWarnings(): void {
  warnedConfigProblems.clear();
}

type ParsedDigest = { salt: string; digest: Buffer };

/**
 * Reads `{ salt, digest }` out of the plugin's instance config.
 *
 * Returns null for anything malformed. Callers treat null as "not verified",
 * never as an error — see the fall-through rationale above.
 */
function parseTokenDigest(value: unknown): ParsedDigest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { salt, digest } = value as { salt?: unknown; digest?: unknown };
  if (typeof salt !== "string" || salt.length < MIN_SALT_LENGTH) return null;
  if (typeof digest !== "string" || digest.length !== DIGEST_HEX_LENGTH) return null;
  const normalized = digest.toLowerCase();
  if (!HEX_ONLY.test(normalized)) return null;
  return { salt, digest: Buffer.from(normalized, "hex") };
}

/**
 * Extracts the single header value the declaration names.
 *
 * A repeated header arrives as an array. That is ambiguous — there is no
 * principled way to pick which copy the provider signed, and accepting any of
 * them would let a caller staple a guess onto a legitimate request — so a
 * repeated header is treated as absent.
 */
function readSingleHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers[name.toLowerCase()];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Decides whether a webhook delivery presented the endpoint's shared token.
 *
 * Ordering is deliberate and load-bearing for the "identical to today" promise:
 * an endpoint with no `auth`, or a request with no token header, returns false
 * without the caller ever needing to read plugin config. Only a request that
 * actually carries the named header costs the extra config lookup.
 *
 * The comparison is over fixed-width SHA-256 outputs via `timingSafeEqual`, so
 * it leaks nothing about how much of a guessed token was correct.
 *
 * Never logs the header value, the token, or the digest.
 */
export function isVerifiedWebhookDelivery(args: {
  auth: PluginWebhookAuthDeclaration | undefined;
  headers: IncomingHttpHeaders;
  /** `plugin_config.config_json` for this plugin, or null when unset. */
  config: Record<string, unknown> | null | undefined;
  /** Identifiers for misconfiguration warnings only — never values. */
  pluginId: string;
  endpointKey: string;
}): boolean {
  const { auth, headers, config, pluginId, endpointKey } = args;
  if (!auth || auth.type !== "header-token") return false;

  const presented = readSingleHeader(headers, auth.header);
  if (presented === null) return false;

  const parsed = parseTokenDigest(config?.[auth.tokenDigestConfigKey]);
  if (!parsed) {
    warnOnce(
      `${pluginId}:${endpointKey}:digest`,
      { pluginId, endpointKey, configKey: auth.tokenDigestConfigKey },
      "plugin webhook auth is declared but its token digest config is missing or malformed; deliveries stay on the anonymous budget",
    );
    return false;
  }

  const candidate = createHmac("sha256", parsed.salt).update(presented, "utf8").digest();
  return timingSafeEqual(candidate, parsed.digest);
}

/**
 * Computes the value an operator stores in plugin config for a given token.
 * Exported so plugin authors and tests derive the digest exactly the way the
 * host verifies it, rather than reimplementing the construction.
 */
export function computeWebhookTokenDigest(salt: string, token: string): string {
  return createHmac("sha256", salt).update(token, "utf8").digest("hex");
}
