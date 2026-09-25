/**
 * Instance-admin opt-in for exact private-origin plugin `ctx.http.fetch`
 * egress.
 *
 * The http.fetch SSRF guard (`validateAndResolveFetchUrl`) denies every
 * non-public address. Some plugins must reach one LAN device (for example a
 * printer on a routed LAN). An instance admin can list exact origins for one
 * plugin; the guard then allows exactly those origins and nothing else.
 *
 * Rules (all enforced here, at write time AND again at runtime):
 *  - Entry syntax is `http(s)://<IP literal>:<port>` — explicit port, no
 *    hostname (no DNS, so no rebinding), no userinfo/path/query/fragment, no
 *    non-canonical IPv4 (`0xc0.168.2.86`, `3232236118`, leading zeros), no
 *    IPv6 forms that embed IPv4 (mapped, compatible, NAT64).
 *  - Eligible addresses: RFC1918, IPv6 ULA (fc00::/7), CGNAT (100.64/10).
 *    Everything else the shared classifier flags (loopback, link-local incl.
 *    169.254.169.254, this-network, multicast, reserved, ...) is rejected.
 *  - Any address bound to a local interface of this host (docker bridges,
 *    tailscale0, ...) is rejected — read from `os.networkInterfaces()` at the
 *    moment of the check, via the shared classifier's `own_host` category.
 *  - Ports: both sides are normalised to the EFFECTIVE port, so an entry
 *    `http://10.0.0.5:80` matches `http://10.0.0.5/` and vice versa.
 *
 * Classification comes from `plugin-egress-ip-classifier.ts`; this module
 * does not classify addresses itself.
 */
import type { Db } from "@paperclipai/db";
import { plugins } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  canonicalizeIp,
  classifyEgressIp,
  type ClassifyOptions,
  type EgressIpClassification,
} from "./plugin-egress-ip-classifier.js";

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };
const ELIGIBLE_RESERVED_REASONS = new Set(["rfc1918", "ula"]);

export const MAX_PRIVATE_EGRESS_ORIGINS = 20;

export type PrivateEgressEntryResult =
  | { ok: true; origin: string }
  | { ok: false; reason: string };

/** Build the comparison key `scheme://ip:port` (IPv6 bracketed, classifier-canonical). */
function originKey(protocol: string, canonical: string, family: 4 | 6, port: string): string {
  return `${protocol}//${family === 6 ? `[${canonical}]` : canonical}:${port}`;
}

/**
 * Whether a classified address may be the target of a private-egress opt-in.
 * `own_host` is never eligible (the classifier checks host interfaces first).
 */
export function isPrivateEgressEligible(cls: EgressIpClassification): boolean {
  if (cls.category === "cgnat") return true;
  return cls.category === "reserved" && ELIGIBLE_RESERVED_REASONS.has(cls.reason ?? "");
}

/**
 * Validate one instance-admin entry. Returns the canonical origin key to store,
 * or a precise rejection reason (the route answers 400 with it).
 */
export function parsePrivateEgressEntry(
  raw: unknown,
  options: ClassifyOptions = {},
): PrivateEgressEntryResult {
  if (typeof raw !== "string") return { ok: false, reason: "not_a_string" };
  const entry = raw.trim();
  const match = entry.match(/^(https?):\/\/(\[[0-9a-fA-F:]+\]|[^/:?#@[\]]+):(\d{1,5})$/);
  if (!match) return { ok: false, reason: "must_be_scheme_ip_port" };
  const protocol = `${match[1]!.toLowerCase()}:`;
  const hostText = match[2]!;
  const portText = match[3]!;
  const port = Number(portText);
  if (String(port) !== portText || port < 1 || port > 65535) {
    return { ok: false, reason: "invalid_port" };
  }
  const bare = hostText.replace(/^\[|\]$/g, "");
  const ip = canonicalizeIp(bare);
  if (!ip) return { ok: false, reason: "hostname_not_allowed" };
  if (ip.embedded) return { ok: false, reason: "embedded_ipv4_form_not_allowed" };
  const bracketed = hostText.startsWith("[");
  if ((ip.family === 6) !== bracketed) return { ok: false, reason: "must_be_scheme_ip_port" };
  if (ip.family === 4 && ip.canonical.split(".").some((o) => String(Number(o)) !== o)) {
    return { ok: false, reason: "non_canonical_ipv4" };
  }
  const cls = classifyEgressIp(ip.canonical, options);
  if (cls.category === "own_host") return { ok: false, reason: "own_host_address" };
  if (!isPrivateEgressEligible(cls)) {
    return {
      ok: false,
      reason: cls.category === "public" ? "public_address_needs_no_opt_in" : `address_not_eligible:${cls.reason ?? cls.category}`,
    };
  }
  return { ok: true, origin: originKey(protocol, ip.canonical, ip.family, portText) };
}

/**
 * Comparison key for a fetch URL, or null when the host is not a plain IP
 * literal. A hostname can therefore never match an entry, even when it
 * resolves to an opted-in address.
 */
export function privateEgressRequestOrigin(url: URL): string | null {
  const defaultPort = DEFAULT_PORTS[url.protocol];
  if (!defaultPort) return null;
  const ip = canonicalizeIp(url.hostname);
  if (!ip || ip.embedded) return null;
  return originKey(url.protocol, ip.canonical, ip.family, url.port || defaultPort);
}

/**
 * Re-validate stored entries on read. Invalid rows (for example an address
 * that became a host interface after it was added) are dropped, never widened.
 */
export function normalizeStoredPrivateEgressOrigins(
  stored: readonly string[] | null | undefined,
  options: ClassifyOptions = {},
): string[] {
  const out = new Set<string>();
  for (const value of stored ?? []) {
    const parsed = parsePrivateEgressEntry(value, options);
    if (parsed.ok) out.add(parsed.origin);
  }
  return [...out];
}

/** Stored opt-in origins for one plugin (raw; the runtime re-validates). */
export async function loadPluginPrivateEgressOrigins(db: Db, pluginId: string): Promise<string[]> {
  const rows = await db
    .select({ origins: plugins.privateEgressOrigins })
    .from(plugins)
    .where(eq(plugins.id, pluginId))
    .limit(1);
  return rows[0]?.origins ?? [];
}

export type SetPrivateEgressResult =
  | { ok: true; origins: string[]; added: string[]; removed: string[] }
  | { ok: false; status: 400 | 404; error: string; entry?: string };

/**
 * Replace a plugin's opt-in list (idempotent: the same input converges to the
 * same row). Every entry is validated; one bad entry rejects the whole write.
 * An empty list is the rollback.
 */
export async function setPluginPrivateEgressOrigins(
  db: Db,
  pluginId: string,
  entries: readonly unknown[],
  options: ClassifyOptions = {},
): Promise<SetPrivateEgressResult> {
  if (entries.length > MAX_PRIVATE_EGRESS_ORIGINS) {
    return { ok: false, status: 400, error: `at most ${MAX_PRIVATE_EGRESS_ORIGINS} entries` };
  }
  const next: string[] = [];
  for (const entry of entries) {
    const parsed = parsePrivateEgressEntry(entry, options);
    if (!parsed.ok) {
      return { ok: false, status: 400, error: parsed.reason, entry: typeof entry === "string" ? entry : undefined };
    }
    if (!next.includes(parsed.origin)) next.push(parsed.origin);
  }
  const rows = await db
    .select({ origins: plugins.privateEgressOrigins })
    .from(plugins)
    .where(eq(plugins.id, pluginId))
    .limit(1);
  if (rows.length === 0) return { ok: false, status: 404, error: "Plugin not found" };
  const previous = rows[0]!.origins ?? [];
  await db
    .update(plugins)
    .set({ privateEgressOrigins: next, updatedAt: new Date() })
    .where(eq(plugins.id, pluginId));
  return {
    ok: true,
    origins: next,
    added: next.filter((o) => !previous.includes(o)),
    removed: previous.filter((o) => !next.includes(o)),
  };
}
