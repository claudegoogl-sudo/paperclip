import os from "node:os";
import { classifyEgressIp } from "./services/plugin-egress-ip-classifier.js";
import type { Server } from "node:http";
import { isIP } from "node:net";

const runtimeApiListeners = new Set<Server>();
const registeredRuntimeApiListeners = new WeakSet<Server>();
let runtimeApiListenerClosed = false;

/**
 * The process had a runtime API listener and has since closed it, which only
 * happens while it shuts down. Work that needs a callback origin must hand off
 * to the next controller instead of failing as a provider or startup error.
 */
export class LocalRuntimeApiListenerClosedError extends Error {
  constructor() {
    // Keep the established failure code for classifiers and persisted rows.
    super("local_runtime_api_listener_unavailable");
    this.name = "LocalRuntimeApiListenerClosedError";
  }
}

/** Track listener ownership without treating configured or advertised URLs as authority. */
export function registerLocalRuntimeApiServer(server: Server): void {
  if (!registeredRuntimeApiListeners.has(server)) {
    registeredRuntimeApiListeners.add(server);
    server.on("listening", () => {
      runtimeApiListeners.add(server);
      runtimeApiListenerClosed = false;
    });
    server.on("close", () => {
      if (runtimeApiListeners.delete(server)) runtimeApiListenerClosed = true;
    });
  }
  if (server.listening) {
    runtimeApiListeners.add(server);
    runtimeApiListenerClosed = false;
  }
}

function normalizeHost(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host).toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function isWildcardHost(host: string): boolean {
  const normalized = normalizeHost(host).toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::";
}

function isLinkLocalHost(host: string): boolean {
  // Range check on the canonical form (shared classifier) instead of string
  // prefixes, so embedded-IPv4 forms (::ffff:a9fe:a14) are caught too.
  // 169.254.0.0/16 and fe80::/10. Empty interface source: ranges only.
  const c = classifyEgressIp(normalizeHost(host), { interfaces: () => ({}) });
  return c.reason === "link-local";
}

function formatOrigin(protocol: string, host: string, port: number): string {
  const normalizedHost = host.includes(":") && !host.startsWith("[") && !host.endsWith("]")
    ? `[${host}]`
    : host;
  return `${protocol}//${normalizedHost}:${port}`;
}

function pushCandidate(
  candidates: string[],
  seen: Set<string>,
  rawUrl: string | null | undefined,
): void {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return;
  try {
    const normalized = new URL(trimmed).origin;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  } catch {
    // Ignore malformed candidates.
  }
}

// A base URL written as `host:port` (no `//`) is a VALID URL with an opaque
// scheme, and the origin of an opaque-scheme URL serializes to the *string*
// "null". That string is truthy, so it escapes every `if (origin)` guard and is
// then handed to `new URL(origin)`, which throws `TypeError: Invalid URL`.
// Treat it as absent config, exactly like input that fails to parse at all.
function parsePublicOrigin(rawUrl: string | null | undefined): string | null {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return null;
  let origin: string;
  try {
    origin = new URL(trimmed).origin;
  } catch {
    return null;
  }
  return origin === "null" ? null : origin;
}

export function chooseLocalRuntimeApiUrl(input: {
  bindHost: string;
  port: number;
}): string {
  const bindHost = normalizeHost(input.bindHost).replace(/^\[([^\]]+)\]$/, "$1");
  if (isIP(bindHost) === 0 || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error("local_runtime_api_listener_address_invalid");
  }
  const connectHost = bindHost === "::" ? "::1"
    : bindHost === "0.0.0.0" ? "127.0.0.1"
    : bindHost;
  return formatOrigin("http:", connectHost, input.port);
}

export function resolveLocalRuntimeApiUrl(): string {
  const listeners = [...runtimeApiListeners].filter(server => server.listening);
  // `server.close()` clears `listening` at once; its close event waits for
  // admitted requests. Either state means this process stopped serving.
  if (listeners.length === 0 && (runtimeApiListenerClosed || runtimeApiListeners.size > 0)) {
    throw new LocalRuntimeApiListenerClosedError();
  }
  if (listeners.length !== 1) {
    throw new Error(listeners.length ? "local_runtime_api_listener_ambiguous" : "local_runtime_api_listener_unavailable");
  }
  const address = listeners[0]!.address();
  if (!address || typeof address === "string") throw new Error("local_runtime_api_listener_unavailable");
  return chooseLocalRuntimeApiUrl({ bindHost: address.address, port: address.port });
}

export const runtimeApiInternals = {
  resetForTests(): void {
    runtimeApiListeners.clear();
    runtimeApiListenerClosed = false;
  },
};

export function choosePrimaryRuntimeApiUrl(input: {
  authPublicBaseUrl?: string | null;
  allowedHostnames: string[];
  bindHost: string;
  port: number;
}): string {
  const explicitOrigin = parsePublicOrigin(input.authPublicBaseUrl);
  if (explicitOrigin) return explicitOrigin;

  const bindHost = normalizeHost(input.bindHost);
  if (bindHost && !isWildcardHost(bindHost) && isLoopbackHost(bindHost)) {
    return formatOrigin("http:", bindHost, input.port);
  }

  const allowedHostname = input.allowedHostnames
    .map((value) => value.trim())
    .find(Boolean);
  if (allowedHostname) {
    return formatOrigin("http:", allowedHostname, input.port);
  }

  if (bindHost && !isWildcardHost(bindHost)) {
    return formatOrigin("http:", bindHost, input.port);
  }

  return formatOrigin("http:", "localhost", input.port);
}

/**
 * Base URL handed to agent runs as PAPERCLIP_API_URL.
 *
 * Separate from the runtime/public base on purpose: the public base
 * (authPublicBaseUrl) is for browsers and off-host clients and may sit behind
 * an interactive access proxy that answers API calls with an HTML login page.
 * Local agent runs execute on the same host as the server, so they default to
 * the loopback listen origin whenever the server binds loopback or a wildcard.
 *
 * Precedence: explicit PAPERCLIP_AGENT_API_URL > loopback listen origin (bind
 * host loopback or wildcard) > fallbackApiUrl (the runtime/public base).
 */
export function chooseAgentApiUrl(input: {
  explicitAgentApiUrl?: string | null;
  bindHost: string;
  port: number;
  fallbackApiUrl: string;
}): string {
  const explicit = input.explicitAgentApiUrl?.trim();
  if (explicit) {
    try {
      const parsed = new URL(explicit);
      // Only http(s) origins are usable API bases ("file:" etc. yield "null").
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
    } catch {
      // Malformed override: fall through to the derived default.
    }
  }
  const bindHost = normalizeHost(input.bindHost).toLowerCase();
  if (!bindHost || bindHost === "0.0.0.0" || bindHost === "localhost" || bindHost === "127.0.0.1") {
    return formatOrigin("http:", "127.0.0.1", input.port);
  }
  if (bindHost === "::" || bindHost === "::1") {
    return formatOrigin("http:", "::1", input.port);
  }
  return input.fallbackApiUrl;
}

/** True when an agent API base is cleartext http to a non-loopback host. */
export function isInsecureNonLoopbackApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:") return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return !(host === "localhost" || host === "::1" || /^127\./.test(host));
  } catch {
    return false;
  }
}

export function collectReachableInterfaceHosts(input: {
  networkInterfacesMap?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
} = {}): string[] {
  const interfaces = input.networkInterfacesMap ?? os.networkInterfaces();
  const rankedHosts: Array<{ host: string; rank: number; index: number }> = [];
  const seen = new Set<string>();
  let index = 0;

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const host = normalizeHost(entry.address);
      if (!host || isLoopbackHost(host) || isWildcardHost(host) || isLinkLocalHost(host)) continue;
      if (seen.has(host)) continue;
      seen.add(host);
      rankedHosts.push({
        host,
        rank: entry.family === "IPv4" ? 0 : 1,
        index: index++,
      });
    }
  }

  return rankedHosts
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.host);
}

export function buildRuntimeApiCandidateUrls(input: {
  preferredApiUrl?: string | null;
  authPublicBaseUrl?: string | null;
  allowedHostnames: string[];
  bindHost: string;
  port: number;
  networkInterfacesMap?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const explicitOrigin = parsePublicOrigin(input.authPublicBaseUrl);
  const protocol = explicitOrigin ? new URL(explicitOrigin).protocol : "http:";

  pushCandidate(candidates, seen, input.preferredApiUrl);
  pushCandidate(candidates, seen, explicitOrigin);

  for (const rawHost of input.allowedHostnames) {
    const host = normalizeHost(rawHost);
    if (!host) continue;
    pushCandidate(candidates, seen, formatOrigin(protocol, host, input.port));
  }

  const bindHost = normalizeHost(input.bindHost);
  if (bindHost && !isWildcardHost(bindHost)) {
    pushCandidate(candidates, seen, formatOrigin(protocol, bindHost, input.port));
  }

  if (explicitOrigin) {
    const hostname = new URL(explicitOrigin).hostname;
    if (isLoopbackHost(hostname)) {
      pushCandidate(candidates, seen, formatOrigin(protocol, "host.docker.internal", input.port));
    }
  }

  for (const host of collectReachableInterfaceHosts({ networkInterfacesMap: input.networkInterfacesMap })) {
    pushCandidate(candidates, seen, formatOrigin(protocol, host, input.port));
  }

  if (candidates.length === 0) {
    pushCandidate(
      candidates,
      seen,
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: input.authPublicBaseUrl,
        allowedHostnames: input.allowedHostnames,
        bindHost: input.bindHost,
        port: input.port,
      }),
    );
  }

  return candidates;
}
