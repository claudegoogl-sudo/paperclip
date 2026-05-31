/**
 * PLA-723 — egress destination allowlist enforcement engine.
 *
 * Covers the EG2 origin-canonical normalization bypass set (each fail-closed),
 * the matcher (exact origin, explicit wildcard only, no scheme downgrade), the
 * EG1 host-mediated registry, and the EG5 per-call decision (per-handle
 * allowlist, undeterminable-destination abort, log-only would-deny).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  EgressNotAllowedError,
  clearHostMediatedTools,
  decideEgress,
  getHostMediatedEgress,
  matchesAllowlist,
  normalizeDestination,
  registerHostMediatedTool,
  type HandleEgressCapture,
} from "../handle-egress.js";

afterEach(() => clearHostMediatedTools());

/** Convenience: normalize then assert allow/deny against an allowlist. */
function allows(kind: "url" | "host" | "gitRemote", raw: string, allowlist: string[]): boolean {
  return matchesAllowlist(allowlist, normalizeDestination(kind, raw));
}

describe("EG2 — normalization bypass set (each fails closed)", () => {
  const GH = ["https://api.github.com"];

  it("userinfo-host confusion resolves to the real host (denies)", () => {
    expect(allows("url", "https://api.github.com@attacker.com/x", GH)).toBe(false);
    // and the real allowed host still passes
    expect(allows("url", "https://api.github.com/x", GH)).toBe(true);
  });

  it("IP-literal hosts deny (decimal / octal / hex / loopback / 0.0.0.0 / link-local)", () => {
    for (const dest of [
      "http://2130706433/", // 127.0.0.1 decimal
      "http://0x7f.0.0.1/", // hex
      "http://0177.0.0.1/", // octal
      "http://127.0.0.1/",
      "http://0.0.0.0/",
      "http://169.254.169.254/latest/meta-data/", // cloud metadata
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      const n = normalizeDestination("url", dest);
      // Either it normalized to a forbidden IP, or matching denies anyway.
      expect(matchesAllowlist(GH, n)).toBe(false);
    }
  });

  it("a forbidden IP normalizes to a fail-closed result", () => {
    expect(normalizeDestination("url", "http://127.0.0.1/").ok).toBe(false);
    expect(normalizeDestination("url", "http://169.254.169.254/").ok).toBe(false);
    expect(normalizeDestination("url", "http://[::1]/").ok).toBe(false);
  });

  it("IDN/punycode/homoglyph + trailing-dot FQDN deny", () => {
    // Cyrillic 'а' homoglyph in apple.com → punycode host, not the ASCII host.
    expect(allows("url", "https://аpple.com/", ["https://apple.com"])).toBe(false);
    // Trailing-dot FQDN must not bypass exact match in either direction.
    expect(allows("url", "https://api.github.com./x", GH)).toBe(true);
    expect(normalizeDestination("url", "https://exämple.com/")).toMatchObject({
      ok: true,
      host: "xn--exmple-cua.com",
    });
  });

  it("port stripping: explicit default port equals implicit", () => {
    expect(allows("url", "https://api.github.com:443/x", GH)).toBe(true);
    // explicit non-default port must NOT match a portless entry
    expect(allows("url", "https://api.github.com:8443/x", GH)).toBe(false);
    // explicit port entry matches explicit port
    expect(allows("url", "https://api.github.com:8443/x", ["https://api.github.com:8443"])).toBe(true);
  });

  it("scheme allowlist + scheme downgrade deny", () => {
    expect(normalizeDestination("url", "data:text/html,evil").ok).toBe(false);
    expect(normalizeDestination("url", "file:///etc/passwd").ok).toBe(false);
    expect(normalizeDestination("url", "gopher://x/").ok).toBe(false);
    // downgrade: allowlist is https, destination http → deny
    expect(allows("url", "http://api.github.com/x", GH)).toBe(false);
  });

  it("no implicit subdomain wildcard; explicit *.host matches strict subdomains only", () => {
    expect(allows("url", "https://evil.api.github.com/x", GH)).toBe(false); // bare entry, no wildcard
    const wc = ["https://*.github.com"];
    expect(allows("url", "https://api.github.com/x", wc)).toBe(true);
    expect(allows("url", "https://github.com/x", wc)).toBe(false); // apex not matched by *.
    expect(allows("url", "https://evilgithub.com/x", wc)).toBe(false); // suffix confusion
  });

  it("gitRemote: scp-like parsed for host; transport helpers + file:// rejected", () => {
    const allow = ["ssh://github.com"];
    expect(allows("gitRemote", "git@github.com:org/repo.git", allow)).toBe(true);
    expect(allows("gitRemote", "git@attacker.com:org/repo.git", allow)).toBe(false);
    // RCE / bypass transport helpers → fail closed regardless of allowlist
    expect(normalizeDestination("gitRemote", "ext::sh -c 'curl evil'").ok).toBe(false);
    expect(normalizeDestination("gitRemote", "fd::17").ok).toBe(false);
    expect(normalizeDestination("gitRemote", "file:///tmp/repo").ok).toBe(false);
    // explicit ssh URL ok
    expect(allows("gitRemote", "ssh://git@github.com:22/org/repo", allow)).toBe(true);
  });

  it("parser-differential / control-char injection denies", () => {
    expect(normalizeDestination("url", "https://api.github.com\r\nHost: evil.com").ok).toBe(false);
    expect(normalizeDestination("url", "https://api.github.com\t/x").ok).toBe(false);
    expect(normalizeDestination("host", "api.github.com ").ok).toBe(false);
  });

  it("host-kind: scheme-agnostic entry matches; scheme-bound entry does not", () => {
    expect(allows("host", "api.github.com", ["api.github.com"])).toBe(true);
    expect(allows("host", "api.github.com", ["https://api.github.com"])).toBe(false);
    expect(allows("host", "api.github.com:8443", ["api.github.com:8443"])).toBe(true);
  });

  it("single-label / bare wildcard allowlist entries are rejected (ignored)", () => {
    expect(allows("url", "https://api.github.com/x", ["https://*"])).toBe(false);
    expect(allows("url", "https://api.github.com/x", ["https://*.com"])).toBe(false);
  });
});

describe("EG1 — host-mediated registry is host-controlled", () => {
  it("registers + reads back a descriptor; unknown tool is undefined", () => {
    registerHostMediatedTool("platform.http:fetch", { destinationParam: "url", kind: "url" });
    expect(getHostMediatedEgress("platform.http:fetch")).toEqual({
      destinationParam: "url",
      kind: "url",
    });
    expect(getHostMediatedEgress("acme.plugin:doThing")).toBeUndefined();
  });

  it("rejects a dotted-path destinationParam (EG6 flat key only)", () => {
    expect(() =>
      registerHostMediatedTool("x:y", { destinationParam: "nested.url", kind: "url" }),
    ).toThrow();
  });
});

describe("EG5 — per-call decision", () => {
  const cap = (over: Partial<HandleEgressCapture>): HandleEgressCapture => ({
    handle: "vault-handle://run/abc",
    allowedEgress: ["https://api.github.com"],
    enforced: true,
    bindingId: "bind-1",
    ...over,
  });

  it("allows when no handles present", () => {
    const d = decideEgress({
      namespacedName: "platform.http:fetch",
      descriptor: { destinationParam: "url", kind: "url" },
      rawParameters: { url: "https://anywhere.com" },
      handles: [],
    });
    expect(d.allow).toBe(true);
  });

  it("host-mediated + allowlisted destination → allow", () => {
    const d = decideEgress({
      namespacedName: "platform.http:fetch",
      descriptor: { destinationParam: "url", kind: "url" },
      rawParameters: { url: "https://api.github.com/repos", auth: "vault-handle://run/abc" },
      handles: [cap({})],
    });
    expect(d.allow).toBe(true);
  });

  it("host-mediated + non-allowlisted destination → deny (enforced)", () => {
    const d = decideEgress({
      namespacedName: "platform.http:fetch",
      descriptor: { destinationParam: "url", kind: "url" },
      rawParameters: { url: "https://attacker.com", auth: "vault-handle://run/abc" },
      handles: [cap({})],
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("destination_not_allowlisted");
  });

  it("EG1 — non-host-mediated tool denies by default with handles present", () => {
    const d = decideEgress({
      namespacedName: "acme.plugin:push",
      descriptor: undefined,
      rawParameters: { header: "Bearer vault-handle://run/abc" },
      handles: [cap({})],
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("tool_not_host_mediated");
  });

  it("EG1 — per-binding opt-in permits a non-host-mediated tool", () => {
    const d = decideEgress({
      namespacedName: "acme.plugin:push",
      descriptor: undefined,
      rawParameters: { header: "Bearer vault-handle://run/abc" },
      handles: [cap({ unmediatedOptInTools: ["acme.plugin:push"] })],
    });
    expect(d.allow).toBe(true);
  });

  it("EG5 — undeterminable destination (missing param) aborts when enforced", () => {
    const d = decideEgress({
      namespacedName: "platform.http:fetch",
      descriptor: { destinationParam: "url", kind: "url" },
      rawParameters: { auth: "vault-handle://run/abc" }, // no `url`
      handles: [cap({})],
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("undeterminable_destination");
  });

  it("EG5.2 — handle in the host position is undeterminable → deny", () => {
    const d = decideEgress({
      namespacedName: "platform.http:fetch",
      descriptor: { destinationParam: "url", kind: "url" },
      rawParameters: { url: "https://vault-handle://run/abc/", auth: "vault-handle://run/abc" },
      handles: [cap({})],
    });
    expect(d.allow).toBe(false);
  });

  it("EG5.3 — per-handle: any enforced handle excluding the dest aborts the whole call", () => {
    const d = decideEgress({
      namespacedName: "platform.http:fetch",
      descriptor: { destinationParam: "url", kind: "url" },
      rawParameters: { url: "https://api.github.com/x", a: "vault-handle://run/a", b: "vault-handle://run/b" },
      handles: [
        cap({ handle: "vault-handle://run/a", allowedEgress: ["https://api.github.com"] }),
        cap({ handle: "vault-handle://run/b", allowedEgress: ["https://gitlab.com"] }), // excludes dest
      ],
    });
    expect(d.allow).toBe(false);
  });

  it("EG4 — log-only handle records would-deny but allows substitution", () => {
    const d = decideEgress({
      namespacedName: "platform.http:fetch",
      descriptor: { destinationParam: "url", kind: "url" },
      rawParameters: { url: "https://attacker.com", auth: "vault-handle://run/abc" },
      handles: [cap({ enforced: false })],
    });
    expect(d.allow).toBe(true);
    expect(d.wouldDeny).toHaveLength(1);
  });
});

describe("EgressNotAllowedError", () => {
  it("is value-free and carries reason + destination", () => {
    const e = new EgressNotAllowedError("destination_not_allowlisted", "https://attacker.com");
    expect(e.message).not.toContain("secret");
    expect(e.reason).toBe("destination_not_allowlisted");
    expect(e.destination).toBe("https://attacker.com");
  });
});
