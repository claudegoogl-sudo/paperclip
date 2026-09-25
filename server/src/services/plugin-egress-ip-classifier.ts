/**
 * Parsed-address, deny-by-default IP classifier for plugin egress
 * (`ctx.http.fetch`).
 *
 * Replaces the old string-prefix private-IP predicate, which only unwrapped
 * IPv4-mapped IPv6 in dotted form (`::ffff:127.0.0.1`) and so classed the
 * WHATWG-normalised hex form (`::ffff:7f00:1`) as public.
 *
 * Rules:
 *  - Anything that does not parse as an IP literal is denied.
 *  - IPv6 forms that embed an IPv4 address (IPv4-mapped `::ffff:0:0/96`,
 *    SIIT `::ffff:0:0:0/96`, IPv4-compatible `::/96`, well-known NAT64
 *    `64:ff9b::/96`) are unwrapped and the inner IPv4 is classified.
 *  - Transition prefixes whose embedding we do not unwrap are denied
 *    wholesale: local-use NAT64 `64:ff9b:1::/48`, 6to4 `2002::/16`,
 *    Teredo `2001::/32`.
 *  - IPv4 is allowed only outside the reserved/special-purpose ranges.
 *    `100.64.0.0/10` (CGNAT, e.g. tailnet) is its own category `cgnat`; the
 *    caller decides via {@link resolveCgnatMode}.
 *  - IPv6 is allowed only inside global unicast `2000::/3` minus the
 *    special-purpose blocks listed below.
 *  - Addresses bound to this host's own interfaces (`os.networkInterfaces()`,
 *    read at check time) are denied unconditionally — public or CGNAT.
 *
 * Shared by plugin http.fetch and the private-origin opt-in work, so keep the
 * exported surface small and stable.
 */
import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";

export type EgressIpCategory =
  | "public"
  | "cgnat"
  | "own_host"
  | "reserved"
  | "invalid";

export interface EgressIpClassification {
  category: EgressIpCategory;
  /** Canonical form that was classified (inner IPv4 when embedded). */
  canonical: string | null;
  /** Human-readable reason for non-public categories. */
  reason?: string;
}

export type CgnatMode = "allow-legacy" | "deny";

export const CGNAT_MODE_ENV = "PAPERCLIP_PLUGIN_FETCH_CGNAT";

/** Read the CGNAT switch. Unknown/empty values fall back to `allow-legacy`. */
export function resolveCgnatMode(env: NodeJS.ProcessEnv = process.env): CgnatMode {
  const raw = env[CGNAT_MODE_ENV]?.trim().toLowerCase();
  return raw === "deny" ? "deny" : "allow-legacy";
}

type InterfaceSource = () => ReturnType<typeof networkInterfaces>;

const IPV4_RESERVED: Array<[string, number, string]> = [
  ["0.0.0.0", 8, "this-network"],
  ["10.0.0.0", 8, "rfc1918"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"],
  ["172.16.0.0", 12, "rfc1918"],
  ["192.0.0.0", 24, "ietf-protocol-assignments"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "6to4-relay-anycast"],
  ["192.168.0.0", 16, "rfc1918"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

const IPV6_RESERVED: Array<[string, number, string]> = [
  ["64:ff9b:1::", 48, "nat64-local-use"],
  ["100::", 64, "discard"],
  ["2001::", 32, "teredo"],
  ["2001:2::", 48, "benchmarking"],
  ["2001:10::", 28, "orchid"],
  ["2001:20::", 28, "orchid-v2"],
  ["2001:db8::", 32, "documentation"],
  ["2002::", 16, "6to4"],
  ["3fff::", 20, "documentation"],
  ["fc00::", 7, "ula"],
  ["fe80::", 10, "link-local"],
  ["ff00::", 8, "multicast"],
];

function buildList(entries: Array<[string, number, string]>, type: "ipv4" | "ipv6") {
  return entries.map(([net, prefix, reason]) => {
    const list = new BlockList();
    list.addSubnet(net, prefix, type);
    return { list, reason };
  });
}

const V4_LISTS = buildList(IPV4_RESERVED, "ipv4");
const V6_LISTS = buildList(IPV6_RESERVED, "ipv6");
const CGNAT = new BlockList();
CGNAT.addSubnet("100.64.0.0", 10, "ipv4");
const GLOBAL_UNICAST_V6 = new BlockList();
GLOBAL_UNICAST_V6.addSubnet("2000::", 3, "ipv6");

/** Expand an IPv6 literal (no zone id) into 8 16-bit groups; null if malformed. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  // Dotted IPv4 tail -> two hex groups.
  const dotted = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const octets = dotted[2]!.split(".").map(Number);
    if (octets.some((o) => o > 255)) return null;
    text = `${dotted[1]}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === "" ? [] : s.split(":"));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill("0"), ...tail];
  if (all.length !== 8) return null;
  const groups = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.some(Number.isNaN) ? null : groups;
}

function groupsToV4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function groupsToV6(groups: number[]): string {
  return groups.map((g) => g.toString(16)).join(":");
}

/**
 * Canonicalise an IP literal: embedded-IPv4 IPv6 forms become the inner
 * dotted IPv4, other IPv6 becomes the fully expanded lowercase form, IPv4 is
 * returned as-is. Returns null for anything that is not an IP literal
 * (including zone-scoped IPv6).
 */
export function canonicalizeIp(input: string): { family: 4 | 6; canonical: string; embedded?: string } | null {
  const ip = input.trim().replace(/^\[|\]$/g, "");
  if (ip.includes("%")) return null;
  const fam = isIP(ip);
  if (fam === 4) return { family: 4, canonical: ip };
  if (fam !== 6) return null;
  const g = ipv6Groups(ip);
  if (!g) return null;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // IPv4-mapped ::ffff:a.b.c.d
  if (zero(0, 5) && g[5] === 0xffff) return { family: 4, canonical: groupsToV4(g[6]!, g[7]!), embedded: "ipv4-mapped" };
  // SIIT ::ffff:0:a.b.c.d
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return { family: 4, canonical: groupsToV4(g[6]!, g[7]!), embedded: "ipv4-translated" };
  // IPv4-compatible ::a.b.c.d (includes :: and ::1 -> 0.0.0.0 / 0.0.0.1, both denied)
  if (zero(0, 6)) return { family: 4, canonical: groupsToV4(g[6]!, g[7]!), embedded: "ipv4-compatible" };
  // Well-known NAT64 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return { family: 4, canonical: groupsToV4(g[6]!, g[7]!), embedded: "nat64" };
  return { family: 6, canonical: groupsToV6(g) };
}

function ownHostAddresses(source: InterfaceSource): Set<string> {
  const out = new Set<string>();
  let ifaces: ReturnType<typeof networkInterfaces>;
  try {
    ifaces = source();
  } catch {
    return out;
  }
  for (const list of Object.values(ifaces)) {
    for (const entry of list ?? []) {
      const c = canonicalizeIp(entry.address.split("%")[0]!);
      if (c) out.add(c.canonical);
    }
  }
  return out;
}

export interface ClassifyOptions {
  /** Injectable interface source (tests); defaults to `os.networkInterfaces`. */
  interfaces?: InterfaceSource;
}

/** Classify an IP literal for plugin egress. Never throws. */
export function classifyEgressIp(input: string, options: ClassifyOptions = {}): EgressIpClassification {
  const c = canonicalizeIp(input);
  if (!c) return { category: "invalid", canonical: null, reason: "not an IP literal" };

  if (ownHostAddresses(options.interfaces ?? networkInterfaces).has(c.canonical)) {
    return { category: "own_host", canonical: c.canonical, reason: "own host interface address" };
  }

  if (c.family === 4) {
    for (const { list, reason } of V4_LISTS) {
      if (list.check(c.canonical, "ipv4")) return { category: "reserved", canonical: c.canonical, reason };
    }
    if (CGNAT.check(c.canonical, "ipv4")) return { category: "cgnat", canonical: c.canonical, reason: "cgnat" };
    return { category: "public", canonical: c.canonical };
  }

  for (const { list, reason } of V6_LISTS) {
    if (list.check(c.canonical, "ipv6")) return { category: "reserved", canonical: c.canonical, reason };
  }
  if (!GLOBAL_UNICAST_V6.check(c.canonical, "ipv6")) {
    return { category: "reserved", canonical: c.canonical, reason: "outside global unicast" };
  }
  return { category: "public", canonical: c.canonical };
}

/** Whether a classification may be connected to under the given CGNAT mode. */
export function isEgressAllowed(classification: EgressIpClassification, cgnatMode: CgnatMode): boolean {
  if (classification.category === "public") return true;
  if (classification.category === "cgnat") return cgnatMode === "allow-legacy";
  return false;
}
