import { describe, expect, it } from "vitest";
import { resolveAuthEventSourceIp } from "./auth-event-source-ip.js";

// The board-key auth-event log must answer "from where" with an address the
// CLIENT cannot choose. These tests pin the contract:
//   - without an operator allowlist, X-Forwarded-For is never trusted;
//   - a spoofed XFF from a non-allowlisted peer never reaches source_ip;
//   - with an allowlisted peer, the chain is walked rightmost-first and
//     allowlisted hops are skipped (express trust-proxy semantics, scoped to
//     this log only and independent of the global TRUST_PROXY setting).

function req(headers: Record<string, string>, remoteAddress = "203.0.113.7") {
  return { headers, socket: { remoteAddress } };
}

describe("resolveAuthEventSourceIp", () => {
  it("records the socket peer and ignores XFF when no allowlist is configured", () => {
    const ip = resolveAuthEventSourceIp(req({ "x-forwarded-for": "9.9.9.9" }), []);
    expect(ip).toBe("203.0.113.7");
  });

  it("never records a spoofed XFF from a non-allowlisted peer", () => {
    const allowlist = ["10.0.0.0/8"];
    const ip = resolveAuthEventSourceIp(
      req({ "x-forwarded-for": "9.9.9.9, 10.1.1.1" }, "203.0.113.7"),
      allowlist,
    );
    expect(ip).toBe("203.0.113.7");
  });

  it("walks the chain rightmost-first when the peer is an allowlisted proxy", () => {
    const allowlist = ["10.0.0.0/8"];
    const ip = resolveAuthEventSourceIp(
      req({ "x-forwarded-for": "9.9.9.9, 10.1.1.1" }, "10.1.1.1"),
      allowlist,
    );
    expect(ip).toBe("9.9.9.9");
  });

  it("falls back to the socket peer when every reported hop is itself allowlisted", () => {
    const allowlist = ["10.0.0.0/8"];
    const ip = resolveAuthEventSourceIp(
      req({ "x-forwarded-for": "10.1.1.1, 10.2.2.2" }, "10.1.1.1"),
      allowlist,
    );
    expect(ip).toBe("10.1.1.1");
  });

  it("normalizes IPv4-mapped IPv6 peers before matching the allowlist", () => {
    const allowlist = ["127.0.0.1"];
    const ip = resolveAuthEventSourceIp(
      req({ "x-forwarded-for": "9.9.9.9" }, "::ffff:127.0.0.1"),
      allowlist,
    );
    expect(ip).toBe("9.9.9.9");
  });

  it("returns null when the socket has no peer address", () => {
    expect(resolveAuthEventSourceIp({ headers: {}, socket: {} }, [])).toBeNull();
  });
});
