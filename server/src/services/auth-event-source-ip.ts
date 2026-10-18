import { addressMatchesEntry, peerMatchesAllowlist } from "./setup-token-session.js";

/**
 * The per-request signals the auth-event source-ip derivation reads. Structural
 * (not the express Request type) so the function is unit-testable without an
 * HTTP round-trip and so middleware code can pass `req` directly.
 */
export type AuthEventSourceIpRequest = {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string | undefined };
};

/** Bound on how much of a forwarded header we will even parse. */
const MAX_FORWARDED_FOR_LENGTH = 2048;

function firstHeader(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw.length > MAX_FORWARDED_FOR_LENGTH ? raw.slice(0, MAX_FORWARDED_FOR_LENGTH) : raw;
}

function normalizePeer(address: string | undefined): string | null {
  if (!address) return null;
  const trimmed = address.trim();
  if (trimmed.length === 0) return null;
  // Normalize an IPv4-mapped IPv6 peer to its IPv4 form so allowlist entries
  // written as plain IPv4 match the socket value node reports.
  return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
}

/**
 * Derives the client address recorded in board_api_key_auth_events.source_ip.
 *
 * This deliberately mirrors the confidential-transport guard's dedicated proxy
 * allowlist (setup-token-session.ts, SR-7) and never reads the global
 * `trust proxy` setting:
 *
 *  - When the immediate socket peer is NOT on the operator's allowlist, the
 *    X-Forwarded-For header is attacker-controlled text and is ignored
 *    entirely; the socket peer address is recorded. A spoofed XFF from a
 *    non-allowlisted peer therefore cannot land in the security log.
 *  - When the peer IS an allowlisted proxy, the chain is walked from the
 *    rightmost entry backwards (the address our own edge appended closest to
 *    us), skipping allowlisted proxies, and the first non-allowlisted address
 *    is taken -- the same semantics as express `trust proxy` with an explicit
 *    IP allowlist, but scoped to this log only.
 *  - With no allowlist configured the socket peer is recorded as-is: honest
 *    (it names the front-door that actually connected), stable, and never
 *    spoofable. Per-client attribution then requires the operator to declare
 *    the real edge addresses via CLAUDE_LOGIN_TRUSTED_PROXIES.
 */
export function resolveAuthEventSourceIp(
  req: AuthEventSourceIpRequest,
  trustedProxies: readonly string[],
): string | null {
  const peer = normalizePeer(req.socket?.remoteAddress);
  if (!peer) return null;
  if (trustedProxies.length === 0 || !peerMatchesAllowlist(peer, trustedProxies as string[])) {
    return peer;
  }

  const forwarded = firstHeader(req.headers["x-forwarded-for"]);
  if (!forwarded) return peer;
  const hops = forwarded
    .split(",")
    .map((hop) => normalizePeer(hop))
    .filter((hop): hop is string => hop !== null);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (!trustedProxies.some((entry) => addressMatchesEntry(hop, entry))) {
      return hop;
    }
  }
  // Every reported hop is itself an allowlisted proxy; record the proxy chain
  // entry we actually saw rather than inventing a client address.
  return peer;
}
