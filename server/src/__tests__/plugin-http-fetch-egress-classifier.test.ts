import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stubbed DNS + interface list. The DNS stub echoes IP literals (as the real
// resolver does) and serves a fixed table for hostnames.
const stubs = vi.hoisted(() => ({
  dns: {} as Record<string, Array<{ address: string; family: number }>>,
  ifaces: {} as Record<string, Array<{ address: string; family: string; internal: boolean }>>,
}));

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  const lookup = async (hostname: string) => {
    const { isIP } = await import("node:net");
    const fam = isIP(hostname);
    if (fam) return [{ address: hostname, family: fam }];
    const hit = stubs.dns[hostname];
    if (!hit) throw new Error(`ENOTFOUND ${hostname}`);
    return hit;
  };
  return { ...actual, lookup, default: { ...actual, lookup } };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const networkInterfaces = () => stubs.ifaces;
  return { ...actual, networkInterfaces, default: { ...actual, networkInterfaces } };
});

import * as hostServices from "../services/plugin-host-services.js";
import { logger } from "../middleware/logger.js";

const validate = (hostServices as unknown as {
  validateAndResolveFetchUrl: (
    url: string,
    check?: (u: string) => Promise<void>,
    opts?: Record<string, unknown>,
  ) => Promise<{ resolvedAddress: string }>;
}).validateAndResolveFetchUrl;

const denied = (url: string) => expect(validate(url)).rejects.toThrow(/private\/reserved/);
const pinned = async (url: string, ip: string) =>
  expect((await validate(url)).resolvedAddress).toBe(ip);

beforeEach(() => {
  stubs.dns = {};
  stubs.ifaces = { lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }] };
  delete process.env.PAPERCLIP_PLUGIN_FETCH_CGNAT;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PAPERCLIP_PLUGIN_FETCH_CGNAT;
});

describe("plugin http.fetch egress IP classification", () => {
  it("AC1: hex IPv4-mapped IPv6 is denied (literal + URL forms)", async () => {
    await denied("http://[::ffff:7f00:1]:3100/");
    await denied("http://[::ffff:a9fe:a9fe]/latest/meta-data");
    await denied("http://[::ffff:127.0.0.1]/");
    await denied("http://[::ffff:7f00:1]/");
    stubs.dns["mapped.example"] = [{ address: "::ffff:7f00:1", family: 6 }];
    await denied("http://mapped.example/");
  });

  it("AC2: dotted IPv4-mapped still denied via DNS", async () => {
    stubs.dns["dotted.example"] = [{ address: "::ffff:127.0.0.1", family: 6 }];
    await denied("http://dotted.example/");
  });

  it("AC3: IPv4-compatible IPv6 is denied", async () => {
    await denied("http://[::127.0.0.1]/");
    await denied("http://[::7f00:1]/");
  });

  it("AC4: NAT64 embedding private IPv4 and local-use NAT64 are denied", async () => {
    await denied("http://[64:ff9b::7f00:1]/");
    await denied("http://[64:ff9b::a9fe:a9fe]/");
    await denied("http://[64:ff9b:1::808:808]/");
    await pinned("http://[64:ff9b::808:808]/", "64:ff9b::808:808");
  });

  it("AC5: CGNAT allow-legacy (default) pins + warns without path/query/headers", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    await pinned("http://100.100.1.2:7125/printer/objects?secret=1", "100.100.1.2");
    await pinned("https://[::ffff:6464:102]/x?y=z", "::ffff:6464:102");
    const calls = warn.mock.calls.filter((c) => JSON.stringify(c).includes("cgnat_legacy_allowed"));
    expect(calls).toHaveLength(2);
    const [meta] = calls[0]! as [Record<string, unknown>];
    expect(meta).toMatchObject({ event: "plugin.http_fetch.cgnat_legacy_allowed", scheme: "http", ip: "100.100.1.2", port: 7125 });
    expect(Object.keys(meta).sort()).toEqual(["event", "ip", "pluginId", "port", "scheme"]);
    expect(JSON.stringify(calls)).not.toMatch(/printer|secret|objects|y=z/);
    expect((calls[1]![0] as Record<string, unknown>).port).toBe(443);
  });

  it("AC5: CGNAT deny mode denies CGNAT and embedded CGNAT", async () => {
    process.env.PAPERCLIP_PLUGIN_FETCH_CGNAT = "deny";
    await denied("http://100.64.0.1/");
    await denied("http://[::ffff:6440:1]/");
    await denied("http://[64:ff9b::6440:1]/");
  });

  it("AC6: 6to4 and Teredo are denied", async () => {
    await denied("http://[2002:7f00:1::]/");
    await denied("http://[2002:808:808::1]/");
    await denied("http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/");
  });

  it.each([
    "0.1.2.3", "127.0.0.2", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "192.0.0.8", "192.0.2.1", "198.18.0.1", "198.19.255.1",
    "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
  ])("AC7: IPv4 reserved %s denied", async (ip) => {
    await denied(`http://${ip}/`);
  });

  it.each(["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "100::1", "2001:db8::1"])(
    "AC8: IPv6 reserved %s denied",
    async (ip) => {
      await denied(`http://[${ip}]/`);
    },
  );

  it("AC9: own-host interface addresses are denied unconditionally", async () => {
    stubs.ifaces = {
      eth0: [
        { address: "93.184.216.34", family: "IPv4", internal: false },
        { address: "2a01:4f8:1:2::5", family: "IPv6", internal: false },
      ],
      tailscale0: [{ address: "100.101.102.103", family: "IPv4", internal: false }],
    };
    await denied("http://93.184.216.34/");
    await denied("http://[::ffff:5db8:d822]/");
    await denied("http://[2a01:4f8:1:2:0:0:0:5]/");
    await denied("http://100.101.102.103/"); // allow-legacy is the default mode
    stubs.dns["self.example"] = [{ address: "93.184.216.34", family: 4 }];
    await denied("http://self.example/");
  });

  it("AC10: non-canonical IPv4 literals are normalised then denied", async () => {
    expect(new URL("http://0x7f.1/").hostname).toBe("127.0.0.1");
    await denied("http://0x7f.1/");
    await denied("http://2130706433/");
    await denied("http://0177.0.0.1/");
  });

  it("AC11: DNS mixes keep only public; all-private keeps today's error; mapped AAAA denied", async () => {
    stubs.dns["mixed.example"] = [
      { address: "10.0.0.1", family: 4 },
      { address: "::ffff:7f00:1", family: 6 },
      { address: "8.8.4.4", family: 4 },
    ];
    await pinned("http://mixed.example/", "8.8.4.4");
    stubs.dns["aaaa.example"] = [
      { address: "::ffff:a9fe:a9fe", family: 6 },
      { address: "::7f00:1", family: 6 },
      { address: "64:ff9b::a00:1", family: 6 },
    ];
    await expect(validate("http://aaaa.example/")).rejects.toThrow(
      "All resolved IPs for aaaa.example are in private/reserved ranges",
    );
  });

  it("AC12: public traffic unchanged", async () => {
    await pinned("http://8.8.8.8/", "8.8.8.8");
    await pinned("https://1.1.1.1/", "1.1.1.1");
    await pinned("https://[2606:4700:4700::1111]/", "2606:4700:4700::1111");
    stubs.dns["public.example"] = [{ address: "93.184.216.34", family: 4 }];
    await pinned("https://public.example/", "93.184.216.34");
  });
});

describe("plugin http.fetch redirects", () => {
  it("AC13: a 30x is returned to the worker, not followed", async () => {
    let hits = 0;
    const server = createServer((req, res) => {
      hits += 1;
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const url = new URL(`http://public.example:${port}/start`);
      const res = await hostServices.executePinnedHttpRequest(
        { parsedUrl: url, resolvedAddress: "127.0.0.1", hostHeader: url.host, useTls: false },
        undefined,
        new AbortController().signal,
        false,
      );
      expect(res.status).toBe(302);
      expect(hits).toBe(1);
    } finally {
      server.close();
    }
  });
});
