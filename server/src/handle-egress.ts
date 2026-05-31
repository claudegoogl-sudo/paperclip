/**
 * Per-binding egress destination allowlist (PLA-723 / PLA-703 Control-2 residual).
 *
 * Control 2 ({@link ./handle-vault.ts}) resolves a borrowed handle back to its
 * plaintext at the single worker-dispatch chokepoint
 * ({@link ./services/plugin-tool-registry.ts}) **regardless of where the call is
 * going**. This module gates *where* a resolved handle may egress to, per
 * binding, and is consulted at that same chokepoint BEFORE any substitution.
 *
 * Design: PLA-703 comment `a0a84764`, as amended by the SecurityEngineer
 * APPROVE-WITH-CHANGES verdict on PLA-720 (gating amendments EG1–EG6). The
 * amendments win on any divergence.
 *
 *  - EG1 — the trust axis is **host-mediated vs plugin-controlled**, not
 *    exec-class vs structured. A tool whose egress the host does not itself
 *    perform is unfalsifiable by the host: it can declare a `destinationParam`
 *    that has no causal relationship to where the bytes actually go. Handle
 *    resolution is therefore permitted by default ONLY for tools the host has
 *    classified as host-mediated. A plugin manifest may NEVER self-assert
 *    host-mediated status; the classification lives here, host-side.
 *  - EG2 — destination matching is origin-canonical and fail-closed on any
 *    parse failure or ambiguity. Every bypass vector (userinfo-host confusion,
 *    IP-literal encodings, IDN/punycode/NFKC/homoglyph, port stripping, scheme
 *    downgrade, no implicit subdomain wildcard, git transport-helper RCE,
 *    parser differential) denies.
 *  - EG5 — the destination decision runs ahead of all substitution; every
 *    undeterminable-destination path aborts before a handle is resolved to
 *    plaintext. Per-handle: each handle's own captured allowlist must permit
 *    the single call destination, else the whole call aborts.
 *
 * This module is pure (no DB / no IO); the chokepoint orchestrates it against
 * the {@link ./handle-vault.ts} records and the host-mediated registry.
 */

/** The kind of destination a tool's egress descriptor points at. */
export type EgressKind = "url" | "host" | "gitRemote";

/**
 * A tool's egress descriptor. `destinationParam` is a **flat** top-level
 * parameter key (EG6) — NOT a dotted path — naming the parameter that carries
 * the egress destination. A descriptor is only a sound trust anchor for a
 * host-mediated tool (EG1).
 */
export interface EgressDescriptor {
  destinationParam: string;
  kind: EgressKind;
}

/**
 * The host-mediated tool registry (EG1). Maps a fully-namespaced tool name
 * (`<pluginId>:<toolName>`) to the descriptor the HOST trusts for that tool.
 * Membership here is the assertion "the host itself performs this tool's egress
 * against the declared, validated destination" — it is host-controlled and can
 * never be set by a plugin manifest.
 *
 * Built-ins are registered at startup; tests register their own. Empty by
 * default: a tool absent from this map is NOT host-mediated.
 */
const hostMediatedTools = new Map<string, EgressDescriptor>();

/**
 * Register a tool as host-mediated with its trusted egress descriptor. Host-only
 * call site — never reachable from a plugin manifest. Idempotent.
 *
 * @throws if `destinationParam` is empty or a dotted path (EG6: flat key only).
 */
export function registerHostMediatedTool(
  namespacedName: string,
  descriptor: EgressDescriptor,
): void {
  if (!descriptor.destinationParam || descriptor.destinationParam.includes(".")) {
    throw new Error(
      `registerHostMediatedTool: destinationParam must be a non-empty flat key, got "${descriptor.destinationParam}"`,
    );
  }
  hostMediatedTools.set(namespacedName, { ...descriptor });
}

/** Test/diagnostic helper: clear the host-mediated registry. */
export function clearHostMediatedTools(): void {
  hostMediatedTools.clear();
}

/**
 * The host-mediated egress descriptor for `namespacedName`, or `undefined` if
 * the tool is NOT host-mediated (the deny-by-default case, EG1).
 */
export function getHostMediatedEgress(namespacedName: string): EgressDescriptor | undefined {
  return hostMediatedTools.get(namespacedName);
}

/**
 * Raised when a resolved handle is not permitted to egress to the call's
 * destination, or the destination is undeterminable. The chokepoint MUST treat
 * this as fail-closed: abort the dispatch BEFORE any plaintext substitution
 * (EG5). The message is value-free (no secret, no handle plaintext); the
 * `destination` it names is attacker-influenced and must be escaped on render
 * (EG6) — never `eval`'d, never interpolated into a shell.
 */
export class EgressNotAllowedError extends Error {
  readonly reason: string;
  readonly destination: string | null;
  constructor(reason: string, destination: string | null) {
    super(`egress not allowed (${reason})`);
    this.name = "EgressNotAllowedError";
    this.reason = reason;
    this.destination = destination;
  }
}

// ---------------------------------------------------------------------------
// Destination normalization (EG2) — origin-canonical, fail-closed.
// ---------------------------------------------------------------------------

/** A canonicalized destination origin, or a fail-closed reason. */
export type NormalizedOrigin =
  | { ok: true; scheme: string | null; host: string; port: number | null; isIp: boolean }
  | { ok: false; reason: string };

const URL_SCHEMES = new Set(["http", "https"]);
const GIT_URL_SCHEMES = new Set(["https", "ssh", "git"]);

/** Whitespace + ASCII control chars (covers space, tab, CR, LF, DEL). */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS_RE = /[\u0000-\u0020\u007f]/;
/** Any non-ASCII char — a host must be pure-ASCII after IDNA → punycode. */
const NON_ASCII_RE = /[^\u0021-\u007e]/;

/** Default ports we strip so explicit-vs-implicit ports compare equal. */
function defaultPortFor(scheme: string | null): number | null {
  switch (scheme) {
    case "http":
      return 80;
    case "https":
      return 443;
    case "ssh":
      return 22;
    case "git":
      return 9418;
    default:
      return null;
  }
}

/**
 * Whitespace / control chars are a header-injection / parser-differential
 * surface; their presence denies fail-closed (EG2.5).
 */
function hasUnsafeChars(s: string): boolean {
  return UNSAFE_CHARS_RE.test(s);
}

/** True if `host` is a borrowed-handle fragment in the host position (EG5.2). */
function hostHoldsHandle(host: string): boolean {
  return host.includes("vault-handle");
}

/**
 * Classify a (already URL-canonicalized) host literal. The WHATWG URL parser
 * canonicalizes IPv4 decimal/octal/hex (`2130706433`, `0x7f.0.0.1`) to
 * dotted-decimal and brackets IPv6 before we see it, so the IP-literal-deny
 * check runs AFTER normalization (EG2.4).
 */
function classifyHost(host: string): "not_ip" | "ip_ok" | "forbidden" {
  // IPv6 literal (URL keeps the brackets in hostname).
  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1).toLowerCase();
    if (
      inner === "::1" || // loopback
      inner === "::" || // unspecified
      inner.startsWith("fe80:") || // link-local
      inner.startsWith("fc") || // unique-local
      inner.startsWith("fd") ||
      inner.includes("127.0.0.1") || // ::ffff:127.0.0.1 mapped
      inner.endsWith(":0.0.0.0")
    ) {
      return "forbidden";
    }
    return "ip_ok";
  }
  // IPv4 dotted literal.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((n) => n > 255)) return "forbidden"; // malformed octet
    const [a, b] = o;
    if (a === 127) return "forbidden"; // loopback
    if (a === 0) return "forbidden"; // unspecified / 0.0.0.0
    if (a === 169 && b === 254) return "forbidden"; // link-local + 169.254.169.254 metadata
    return "ip_ok";
  }
  return "not_ip";
}

/**
 * Canonicalize a host through the WHATWG URL parser so we inherit its IDNA
 * (UTS-46) processing — NFC/NFKC mapping, fullwidth/homoglyph folding, and
 * IDN→punycode (EG2.5) — and IPv4 normalization (EG2.4). Returns the lowercase,
 * trailing-dot-stripped host, or a fail reason.
 */
function canonicalizeHost(rawHost: string): { ok: true; host: string } | { ok: false; reason: string } {
  if (!rawHost || hasUnsafeChars(rawHost)) return { ok: false, reason: "unsafe_or_empty_host" };
  let host: string;
  try {
    // A throwaway URL lets the parser do IDNA + IPv4 canonicalization. A bare
    // host with no authority chars yields hostname === canonical host.
    host = new URL(`http://${rawHost}`).hostname;
  } catch {
    return { ok: false, reason: "host_parse_failed" };
  }
  host = host.toLowerCase().replace(/\.$/, ""); // trailing-dot FQDN ambiguity (EG2.5)
  if (host.length === 0) return { ok: false, reason: "empty_host" };
  if (NON_ASCII_RE.test(host)) return { ok: false, reason: "non_ascii_host" };
  if (hostHoldsHandle(host)) return { ok: false, reason: "handle_in_host" };
  return { ok: true, host };
}

function normalizeUrl(raw: string, allowedSchemes: Set<string>): NormalizedOrigin {
  if (hasUnsafeChars(raw)) return { ok: false, reason: "unsafe_chars" };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "parse_failed" };
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (!allowedSchemes.has(scheme)) return { ok: false, reason: `scheme_not_allowed:${scheme}` };
  // u.hostname already excludes userinfo (parsed into username/password), so the
  // `https://allowed@attacker.com` confusion resolves to host=attacker.com (EG5.2).
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return { ok: false, reason: "empty_host" };
  if (NON_ASCII_RE.test(host)) return { ok: false, reason: "non_ascii_host" };
  if (hostHoldsHandle(host)) return { ok: false, reason: "handle_in_host" };
  const ip = classifyHost(host);
  if (ip === "forbidden") return { ok: false, reason: "forbidden_ip" };
  const explicitPort = u.port === "" ? null : Number(u.port);
  const port = explicitPort === defaultPortFor(scheme) ? null : explicitPort;
  return { ok: true, scheme, host, port, isIp: ip === "ip_ok" };
}

/**
 * Normalize a `gitRemote` destination (EG2.1). Git remotes are not URLs:
 *  - transport helpers (`ext::`, `fd::`, any `<helper>::`) → RCE / egress
 *    bypass, rejected outright;
 *  - `file://` rejected;
 *  - explicit `https://` / `ssh://` / `git://` parsed as URLs;
 *  - scp-like `[user@]host:path` (no scheme) parsed for host, scheme ssh.
 */
function normalizeGitRemote(raw: string): NormalizedOrigin {
  if (hasUnsafeChars(raw)) return { ok: false, reason: "unsafe_chars" };
  // Transport helper: a scheme immediately followed by `::` (ext::, fd::, …).
  if (/^[a-z][a-z0-9+.-]*::/i.test(raw)) return { ok: false, reason: "transport_helper" };
  const schemeMatch = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === "file") return { ok: false, reason: "file_scheme" };
    if (!GIT_URL_SCHEMES.has(scheme)) return { ok: false, reason: `scheme_not_allowed:${scheme}` };
    return normalizeUrl(raw, GIT_URL_SCHEMES);
  }
  // scp-like: optional user@, then host, then a ':' NOT followed by '/'.
  const scp = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)/);
  if (!scp) return { ok: false, reason: "unparseable_git_remote" };
  const canon = canonicalizeHost(scp[1]);
  if (!canon.ok) return canon;
  const ip = classifyHost(canon.host);
  if (ip === "forbidden") return { ok: false, reason: "forbidden_ip" };
  return { ok: true, scheme: "ssh", host: canon.host, port: null, isIp: ip === "ip_ok" };
}

/**
 * Normalize a bare `host` (optionally `host:port`) destination. No scheme is
 * implied; matching against a scheme-bound allowlist entry will deny unless the
 * entry is scheme-agnostic.
 */
function normalizeHost(raw: string): NormalizedOrigin {
  if (hasUnsafeChars(raw)) return { ok: false, reason: "unsafe_chars" };
  if (raw.includes("://")) return { ok: false, reason: "scheme_in_host_destination" };
  let hostPart = raw;
  let port: number | null = null;
  // Split a trailing :port (but not inside an IPv6 literal).
  if (!raw.startsWith("[")) {
    const idx = raw.lastIndexOf(":");
    if (idx !== -1) {
      const maybePort = raw.slice(idx + 1);
      if (!/^\d+$/.test(maybePort)) return { ok: false, reason: "bad_port" };
      port = Number(maybePort);
      hostPart = raw.slice(0, idx);
    }
  }
  const canon = canonicalizeHost(hostPart);
  if (!canon.ok) return canon;
  const ip = classifyHost(canon.host);
  if (ip === "forbidden") return { ok: false, reason: "forbidden_ip" };
  return { ok: true, scheme: null, host: canon.host, port, isIp: ip === "ip_ok" };
}

/**
 * Normalize a destination value extracted from a tool param, per the tool's
 * declared `kind`. Returns an origin-canonical result, or a fail-closed reason
 * on any parse failure / disallowed scheme / forbidden literal (EG2).
 */
export function normalizeDestination(kind: EgressKind, raw: unknown): NormalizedOrigin {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "non_string_or_empty" };
  }
  switch (kind) {
    case "url":
      return normalizeUrl(raw, URL_SCHEMES);
    case "gitRemote":
      return normalizeGitRemote(raw);
    case "host":
      return normalizeHost(raw);
    default:
      return { ok: false, reason: "unknown_kind" };
  }
}

/**
 * Render a normalized origin to a canonical, persistable, allowlist-shaped
 * string: `scheme://host:port` (scheme omitted for bare-`host` destinations,
 * port omitted when it is the scheme default / unset). This is the ONLY form of
 * a destination that may be stored (PLA-734): it is derived purely from parser
 * output (scheme+host+port), so it can never carry a path, query, fragment, or
 * userinfo — the components that leak tokens/PII. Returns `null` for a
 * fail-closed / non-`ok` origin so callers drop unparseable destinations rather
 * than persist a placeholder.
 */
export function formatOrigin(origin: NormalizedOrigin | null): string | null {
  if (!origin || !origin.ok) return null;
  const authority = origin.port === null ? origin.host : `${origin.host}:${origin.port}`;
  return origin.scheme === null ? authority : `${origin.scheme}://${authority}`;
}

// ---------------------------------------------------------------------------
// Allowlist matching (EG2) — exact origin, explicit wildcard only.
// ---------------------------------------------------------------------------

interface AllowlistMatcher {
  scheme: string | null; // null = scheme-agnostic
  baseHost: string;
  wildcard: boolean;
  port: number | null;
}

/** Parse one operator-authored allowlist entry. Invalid/single-label wildcard → null (ignored). */
function parseEntry(entry: string): AllowlistMatcher | null {
  if (typeof entry !== "string" || entry.length === 0 || hasUnsafeChars(entry)) return null;
  let scheme: string | null = null;
  let rest = entry.trim();
  const schemeMatch = rest.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    rest = rest.slice(schemeMatch[0].length);
  }
  let port: number | null = null;
  if (!rest.startsWith("[")) {
    const idx = rest.lastIndexOf(":");
    if (idx !== -1) {
      const maybePort = rest.slice(idx + 1);
      if (!/^\d+$/.test(maybePort)) return null;
      port = Number(maybePort);
      rest = rest.slice(0, idx);
    }
  }
  let wildcard = false;
  let baseHost = rest.toLowerCase().replace(/\.$/, "");
  if (baseHost.startsWith("*.")) {
    wildcard = true;
    baseHost = baseHost.slice(2);
    // Single-label / bare wildcard (`*`, `*.`, `*.com`) is too broad — reject.
    if (baseHost.length === 0 || !baseHost.includes(".")) return null;
  } else if (baseHost.includes("*")) {
    return null; // mid-label wildcard unsupported
  }
  if (baseHost.length === 0) return null;
  if (port !== null && port === defaultPortFor(scheme)) port = null;
  return { scheme, baseHost, wildcard, port };
}

/**
 * True if `origin` is permitted by `allowlist`. Match is exact origin
 * (scheme + host + port, post-normalization). No implicit subdomain wildcard:
 * `*.host` matches a strict subdomain only; a bare `host` never matches a
 * subdomain. A scheme-bound entry denies a scheme-downgraded destination.
 */
export function matchesAllowlist(allowlist: readonly string[], origin: NormalizedOrigin): boolean {
  if (!origin.ok) return false;
  for (const raw of allowlist) {
    const m = parseEntry(raw);
    if (!m) continue;
    // Scheme: scheme-agnostic entry matches any; scheme-bound must equal.
    if (m.scheme !== null && m.scheme !== origin.scheme) continue;
    // Port: an entry without a port matches only the (stripped) default port.
    if (m.port !== origin.port) continue;
    // Host: exact, or strict-subdomain wildcard.
    if (m.wildcard) {
      if (origin.host !== m.baseHost && origin.host.endsWith(`.${m.baseHost}`)) return true;
    } else if (origin.host === m.baseHost) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The per-call egress decision (EG5).
// ---------------------------------------------------------------------------

/** Per-handle capture, as stored in the vault at mint time. */
export interface HandleEgressCapture {
  /** Opaque handle token (for value-free audit / diagnostics). */
  handle: string;
  /** Operator-set allowlist captured at mint. */
  allowedEgress: readonly string[];
  /** Enforce (deny on no-match) vs log-only "would-deny" migration mode (EG4). */
  enforced: boolean;
  /** Binding this handle was minted under (audit + EG3 purge correlation). */
  bindingId: string | null;
  /**
   * Tool names the operator explicitly opted in for this binding despite the
   * host being unable to enforce their destination (EG1 escape hatch). A handle
   * is resolvable in a non-host-mediated tool only if that exact tool is here.
   */
  unmediatedOptInTools?: readonly string[];
}

export interface EgressDecisionInput {
  /** Fully namespaced tool name being dispatched. */
  namespacedName: string;
  /** Host-mediated descriptor for this tool, or undefined if not host-mediated (EG1). */
  descriptor: EgressDescriptor | undefined;
  /** The RAW, pre-substitution parameters object. */
  rawParameters: unknown;
  /** Every borrowed handle present in the parameters, with its capture. */
  handles: readonly HandleEgressCapture[];
}

export interface EgressDecision {
  allow: boolean;
  /** Value-free reason code (for audit + the thrown error). */
  reason: string;
  /** The extracted destination string (attacker-influenced; escape on render — EG6). */
  destination: string | null;
  /**
   * The destination AFTER egress-parser normalization (scheme+host+port only —
   * NO path/query/fragment). This is the only destination representation safe to
   * persist (PLA-734 harvest): the raw `destination` above can carry tokens/PII
   * in its path/query. `null` when the call is not host-mediated or the
   * destination is undeterminable; `{ ok: false }` when it failed to parse.
   */
  origin: NormalizedOrigin | null;
  /** Handles that would be denied under enforcement but are in log-only mode (EG4 audit). */
  wouldDeny: HandleEgressCapture[];
}

/** Extract the destination from a flat (EG6) top-level param key. */
function extractDestination(rawParameters: unknown, key: string): unknown {
  if (rawParameters === null || typeof rawParameters !== "object" || Array.isArray(rawParameters)) {
    return undefined;
  }
  return (rawParameters as Record<string, unknown>)[key];
}

/**
 * Decide whether the resolved handles in a call may egress to the call's
 * destination. The destination is computed ONCE from the raw parameters and
 * checked per-handle against each handle's own captured allowlist; the decision
 * is fully made here, BEFORE the caller performs any substitution (EG5).
 *
 * Rules:
 *  - No handles present → allow (nothing to gate; caller substitutes nothing).
 *  - Tool not host-mediated (EG1): a handle is permitted only if its binding
 *    opted that exact tool in (`unmediatedOptInTools`); otherwise an enforced
 *    handle denies the whole call, a log-only handle records would-deny.
 *  - Host-mediated: extract + normalize the destination; an undeterminable
 *    destination (missing/parse-fail/handle-in-host) is a deny for any enforced
 *    handle. Each enforced handle must have the destination in its allowlist.
 *  - ANY enforced handle that is not permitted → the WHOLE call is denied; no
 *    partial substitution.
 */
export function decideEgress(input: EgressDecisionInput): EgressDecision {
  const { namespacedName, descriptor, rawParameters, handles } = input;
  if (handles.length === 0) {
    return { allow: true, reason: "no_handles", destination: null, origin: null, wouldDeny: [] };
  }

  // Compute the destination once (host-mediated path only).
  let destination: string | null = null;
  let origin: NormalizedOrigin | null = null;
  if (descriptor) {
    const rawDest = extractDestination(rawParameters, descriptor.destinationParam);
    destination = typeof rawDest === "string" ? rawDest : null;
    origin = normalizeDestination(descriptor.kind, rawDest);
  }

  const wouldDeny: HandleEgressCapture[] = [];
  for (const h of handles) {
    let permitted: boolean;
    if (!descriptor) {
      // Not host-mediated: only an explicit per-binding opt-in of this exact
      // tool permits resolution; the host cannot enforce the destination.
      permitted = (h.unmediatedOptInTools ?? []).includes(namespacedName);
    } else {
      permitted = origin!.ok && matchesAllowlist(h.allowedEgress, origin!);
    }
    if (!permitted) {
      if (h.enforced) {
        return {
          allow: false,
          reason: !descriptor
            ? "tool_not_host_mediated"
            : origin && !origin.ok
              ? `undeterminable_destination:${origin.reason}`
              : "destination_not_allowlisted",
          destination,
          origin,
          wouldDeny,
        };
      }
      wouldDeny.push(h); // log-only migration binding — record, do not block (EG4)
    }
  }
  return { allow: true, reason: "allowed", destination, origin, wouldDeny };
}
