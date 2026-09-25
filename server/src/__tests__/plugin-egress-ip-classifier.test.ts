import { describe, expect, it } from "vitest";
import {
  canonicalizeIp,
  classifyEgressIp,
  isEgressAllowed,
  resolveCgnatMode,
} from "../services/plugin-egress-ip-classifier.js";

const none = () => ({});

describe("plugin-egress-ip-classifier", () => {
  it("canonicalises embedded IPv4 forms to the inner IPv4", () => {
    for (const f of ["::ffff:7f00:1", "::ffff:127.0.0.1", "::7f00:1", "::127.0.0.1", "64:ff9b::7f00:1", "::ffff:0:7f00:1", "[::FFFF:7F00:1]"]) {
      expect(canonicalizeIp(f)?.canonical).toBe("127.0.0.1");
    }
    expect(canonicalizeIp("2606:4700:4700::1111")?.canonical).toBe("2606:4700:4700:0:0:0:0:1111");
  });

  it("denies anything that does not parse", () => {
    for (const bad of ["", "localhost", "example.com", "fe80::1%eth0", "1.2.3", "::ffff:999.0.0.1"]) {
      expect(classifyEgressIp(bad, { interfaces: none }).category).toBe("invalid");
      expect(isEgressAllowed(classifyEgressIp(bad, { interfaces: none }), "allow-legacy")).toBe(false);
    }
  });

  it("categorises cgnat separately and applies the mode switch", () => {
    const c = classifyEgressIp("100.127.255.255", { interfaces: none });
    expect(c.category).toBe("cgnat");
    expect(isEgressAllowed(c, "allow-legacy")).toBe(true);
    expect(isEgressAllowed(c, "deny")).toBe(false);
    expect(classifyEgressIp("100.128.0.1", { interfaces: none }).category).toBe("public");
    expect(classifyEgressIp("100.63.255.255", { interfaces: none }).category).toBe("public");
  });

  it("only allows IPv6 inside global unicast", () => {
    expect(classifyEgressIp("4000::1", { interfaces: none }).category).toBe("reserved");
    expect(classifyEgressIp("2a00:1450::1", { interfaces: none }).category).toBe("public");
  });

  it("own-host beats public and cgnat, and a failing interface source does not throw", () => {
    const ifaces = () => ({ eth0: [{ address: "8.8.8.8" }], ts: [{ address: "100.64.0.9" }] }) as never;
    expect(classifyEgressIp("8.8.8.8", { interfaces: ifaces }).category).toBe("own_host");
    expect(classifyEgressIp("::ffff:6440:9", { interfaces: ifaces }).category).toBe("own_host");
    const boom = () => { throw new Error("x"); };
    expect(classifyEgressIp("8.8.8.8", { interfaces: boom }).category).toBe("public");
  });

  it("reads the CGNAT switch with allow-legacy default", () => {
    expect(resolveCgnatMode({})).toBe("allow-legacy");
    expect(resolveCgnatMode({ PAPERCLIP_PLUGIN_FETCH_CGNAT: "deny" })).toBe("deny");
    expect(resolveCgnatMode({ PAPERCLIP_PLUGIN_FETCH_CGNAT: "bogus" })).toBe("allow-legacy");
  });
});
