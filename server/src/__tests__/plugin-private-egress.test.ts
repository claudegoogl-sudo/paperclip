/**
 * Instance-admin private-origin opt-in for plugin ctx.http.fetch.
 * Pure parsing + runtime decision (injected DNS/interfaces, no network).
 * One test per review item: write-time validation (R2/R3 + CGNAT amendment),
 * exact match (AC3/R4a/R5), host-local denial (R3), audit log (R6),
 * redirect not followed (R4b).
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  normalizeStoredPrivateEgressOrigins,
  parsePrivateEgressEntry,
} from "../services/plugin-private-egress.js";
import {
  executePinnedHttpRequest,
  validateAndResolveFetchUrl,
} from "../services/plugin-host-services.js";

const HOST_TAILSCALE = "100.100.7.7";
const HOST_DOCKER = "172.17.0.1";
const interfaces = () =>
  ({
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    tailscale0: [{ address: HOST_TAILSCALE, family: "IPv4", internal: false }],
    docker0: [{ address: HOST_DOCKER, family: "IPv4", internal: false }],
  }) as never;

const echoDns = async (hostname: string) => {
  const { isIP } = await import("node:net");
  const fam = isIP(hostname);
  if (fam) return [{ address: hostname, family: fam }];
  if (hostname === "printer.lan") return [{ address: "192.168.2.86", family: 4 }];
  throw new Error(`ENOTFOUND ${hostname}`);
};

const PRINTER = "http://192.168.2.86:8898";

function run(url: string, stored: Record<string, string[]>, pluginId = "klipper", extra: Record<string, unknown> = {}) {
  const log = { info: vi.fn(), warn: vi.fn() };
  const loader = vi.fn(async () => stored[pluginId] ?? []);
  const promise = validateAndResolveFetchUrl(url, undefined, {
    pluginId,
    dnsLookup: echoDns,
    interfaces,
    env: {},
    log: log as never,
    loadPrivateEgressOrigins: loader,
    ...extra,
  });
  return { promise, log, loader };
}

const DENY = /All resolved IPs for .* are in private\/reserved ranges/;

describe("private-egress entry validation (write time)", () => {
  const ok = (entry: string, origin = entry) =>
    expect(parsePrivateEgressEntry(entry, { interfaces })).toEqual({ ok: true, origin });
  const bad = (entry: string) =>
    expect(parsePrivateEgressEntry(entry, { interfaces }).ok, entry).toBe(false);

  it("accepts RFC1918, IPv6 ULA and CGNAT with explicit port", () => {
    ok(PRINTER);
    ok("https://10.1.2.3:443");
    ok("http://172.20.0.9:7125");
    ok("http://100.64.1.2:7125");
    ok("http://[fd00::1]:8080", "http://[fd00:0:0:0:0:0:0:1]:8080");
  });

  it("rejects the host's own tailscale and docker addresses (own_host)", () => {
    expect(parsePrivateEgressEntry(`http://${HOST_TAILSCALE}:7125`, { interfaces })).toEqual({ ok: false, reason: "own_host_address" });
    expect(parsePrivateEgressEntry(`http://${HOST_DOCKER}:80`, { interfaces })).toEqual({ ok: false, reason: "own_host_address" });
  });

  it("rejects metadata, loopback, link-local, unspecified, multicast and public", () => {
    for (const e of [
      "http://169.254.169.254:80",
      "http://127.0.0.1:3100",
      "http://127.8.8.8:80",
      "http://[::1]:80",
      "http://[fe80::1]:80",
      "http://0.0.0.0:80",
      "http://[::]:80",
      "http://224.0.0.1:80",
      "http://8.8.8.8:80",
    ]) bad(e);
  });

  it("rejects IPv4-embedding IPv6 forms (mapped hex+dotted, compatible, NAT64)", () => {
    for (const e of [
      "http://[::ffff:7f00:1]:80",
      "http://[::ffff:a9fe:a9fe]:80",
      "http://[::ffff:c0a8:256]:8898",
      "http://[::ffff:192.168.2.86]:8898",
      "http://[::c0a8:256]:8898",
      "http://[64:ff9b::c0a8:256]:8898",
      "http://[2002:c0a8:256::1]:8898",
    ]) bad(e);
  });

  it("rejects non-canonical syntax: hostname, missing port, path, query, userinfo, fragment, odd IPv4", () => {
    for (const e of [
      "http://printer.lan:8898",
      "http://192.168.2.86",
      "http://192.168.2.86:8898/",
      "http://192.168.2.86:8898/api",
      "http://192.168.2.86:8898?x=1",
      "http://u:p@192.168.2.86:8898",
      "http://192.168.2.86:8898#f",
      "http://0xc0.168.2.86:8898",
      "http://3232236118:8898",
      "http://192.168.002.086:8898",
      "http://192.168.2.86:08898",
      "http://192.168.2.86:0",
      "http://192.168.2.86:70000",
      "ftp://192.168.2.86:21",
      "http://fd00::1:80",
    ]) bad(e);
  });

  it("drops stored entries that are no longer valid on read (never widened)", () => {
    expect(normalizeStoredPrivateEgressOrigins([PRINTER, `http://${HOST_TAILSCALE}:1`, "junk"], { interfaces })).toEqual([PRINTER]);
  });
});

describe("private-egress runtime decision", () => {
  it("allows the exact opted-in origin, pinned to the literal, with an allow log", async () => {
    const { promise, log } = run(`${PRINTER}/api/upload?token=secret`, { klipper: [PRINTER] });
    const target = await promise;
    expect(target.resolvedAddress).toBe("192.168.2.86");
    expect(log.info).toHaveBeenCalledTimes(1);
    const [fields, msg] = log.info.mock.calls[0]!;
    expect(msg).toBe("plugin.http_fetch.private_allowed");
    expect(fields).toMatchObject({ event: "plugin.http_fetch.private_egress", decision: "allow", pluginId: "klipper", origin: PRINTER, matchedEntry: PRINTER });
    expect(JSON.stringify(fields)).not.toMatch(/upload|token|secret/);
  });

  it("without any opt-in: denied with today's error, loader-less path unchanged", async () => {
    await expect(run(`${PRINTER}/`, {}).promise).rejects.toThrow(DENY);
    await expect(
      validateAndResolveFetchUrl(`${PRINTER}/`, undefined, { dnsLookup: echoDns, interfaces, env: {} }),
    ).rejects.toThrow("All resolved IPs for 192.168.2.86 are in private/reserved ranges");
  });

  it("non-opted private origin is denied with a deny log", async () => {
    const { promise, log } = run("http://192.168.2.87:8898/", { klipper: [PRINTER] });
    await expect(promise).rejects.toThrow(DENY);
    expect(log.info.mock.calls[0]![0]).toMatchObject({ decision: "deny", matchedEntry: null });
  });

  it("different port or scheme is denied", async () => {
    await expect(run("http://192.168.2.86:8899/", { klipper: [PRINTER] }).promise).rejects.toThrow(DENY);
    await expect(run("https://192.168.2.86:8898/", { klipper: [PRINTER] }).promise).rejects.toThrow(DENY);
  });

  it("another plugin's opt-in does not apply", async () => {
    await expect(run(`${PRINTER}/`, { klipper: [PRINTER] }, "other.plugin").promise).rejects.toThrow(DENY);
  });

  it("a hostname resolving to the opted-in IP is denied and never consults the list", async () => {
    const { promise, loader } = run("http://printer.lan:8898/", { klipper: [PRINTER] });
    await expect(promise).rejects.toThrow(/All resolved IPs for printer.lan/);
    expect(loader).not.toHaveBeenCalled();
  });

  it("IPv4-mapped spelling of the opted-in IP does not match", async () => {
    await expect(run("http://[::ffff:c0a8:256]:8898/", { klipper: [PRINTER] }).promise).rejects.toThrow(DENY);
  });

  it("host-interface addresses stay denied even if stored as opted in", async () => {
    for (const ip of [HOST_TAILSCALE, HOST_DOCKER, "127.0.0.1", "169.254.169.254"]) {
      await expect(run(`http://${ip}:80/`, { klipper: [`http://${ip}:80`] }).promise, ip).rejects.toThrow(DENY);
    }
  });

  it("effective port normalisation: :80 entry matches the implicit port and vice versa", async () => {
    await expect(run("http://10.0.0.5/", { klipper: ["http://10.0.0.5:80"] }).promise).resolves.toMatchObject({ resolvedAddress: "10.0.0.5" });
    await expect(run("http://10.0.0.5:80/", { klipper: ["http://10.0.0.5:80"] }).promise).resolves.toMatchObject({ resolvedAddress: "10.0.0.5" });
    await expect(run("https://10.0.0.5/", { klipper: ["http://10.0.0.5:80"] }).promise).rejects.toThrow(DENY);
  });

  it("CGNAT opt-in works when CGNAT is switched to deny; host's own 100.x stays denied", async () => {
    const env = { PAPERCLIP_PLUGIN_FETCH_CGNAT: "deny" };
    await expect(run("http://100.64.1.2:7125/", { klipper: [] }, "klipper", { env }).promise).rejects.toThrow(DENY);
    await expect(run("http://100.64.1.2:7125/", { klipper: ["http://100.64.1.2:7125"] }, "klipper", { env }).promise)
      .resolves.toMatchObject({ resolvedAddress: "100.64.1.2" });
    await expect(run(`http://${HOST_TAILSCALE}:7125/`, { klipper: [`http://${HOST_TAILSCALE}:7125`] }, "klipper", { env }).promise)
      .rejects.toThrow(DENY);
  });

  it("config-egress check runs first and can still deny an opted-in origin", async () => {
    const { promise, loader } = run(`${PRINTER}/`, { klipper: [PRINTER] }, "klipper", {});
    await promise;
    const check = vi.fn(async () => {
      throw new Error("config egress denied");
    });
    const loader2 = vi.fn(async () => [PRINTER]);
    await expect(
      validateAndResolveFetchUrl(`${PRINTER}/`, check, { pluginId: "klipper", dnsLookup: echoDns, interfaces, env: {}, loadPrivateEgressOrigins: loader2 }),
    ).rejects.toThrow("config egress denied");
    expect(loader2).not.toHaveBeenCalled();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the opt-in lookup throws", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    await expect(
      validateAndResolveFetchUrl(`${PRINTER}/`, undefined, {
        pluginId: "klipper", dnsLookup: echoDns, interfaces, env: {}, log: log as never,
        loadPrivateEgressOrigins: async () => { throw new Error("db down"); },
      }),
    ).rejects.toThrow(DENY);
    expect(log.warn.mock.calls[0]![0]).toMatchObject({ decision: "deny", reason: "lookup_failed" });
  });
});

describe("private-egress redirects (R4b)", () => {
  it("a 30x from the opted origin is returned to the worker, not followed", async () => {
    const target = await run(`${PRINTER}/start`, { klipper: [PRINTER] }).promise;
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(302, { location: "http://192.168.2.99:80/elsewhere" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      // Same validated target; only the socket address is swapped to the local
      // test server so the pinned request path is exercised end to end.
      const parsedUrl = new URL(target.parsedUrl.toString());
      parsedUrl.port = String(port);
      const res = await executePinnedHttpRequest(
        { ...target, parsedUrl, resolvedAddress: "127.0.0.1" },
        undefined,
        new AbortController().signal,
        false,
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("http://192.168.2.99:80/elsewhere");
      expect(hits).toBe(1);
    } finally {
      server.close();
    }
  });
});
