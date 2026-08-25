import { describe, expect, it } from "vitest";
import {
  CROSS_COMPANY_AGENT_KEY_MAX_TTL_SECONDS,
  agentApiKeyScopeIsCrossCompany,
  computeAgentKeyExpiresAt,
  createAgentKeySchema,
  formatBridgeKeyRefusalLine,
  isAgentApiKeyExpired,
  type AgentApiKeyScope,
} from "./agent.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const nowMs = NOW.getTime();

const STANDARD: AgentApiKeyScope = { kind: "standard" };
const CROSS_COMPANY: AgentApiKeyScope = {
  kind: "task_bridge",
  projectId: "11111111-1111-1111-1111-111111111111",
};

describe("agentApiKeyScopeIsCrossCompany", () => {
  it("treats task_bridge scopes as cross-company and standard/nullish as same-company", () => {
    expect(agentApiKeyScopeIsCrossCompany(CROSS_COMPANY)).toBe(true);
    expect(agentApiKeyScopeIsCrossCompany(STANDARD)).toBe(false);
    expect(agentApiKeyScopeIsCrossCompany(null)).toBe(false);
    expect(agentApiKeyScopeIsCrossCompany(undefined)).toBe(false);
  });
});

describe("computeAgentKeyExpiresAt", () => {
  it("(b) clamps a cross-company mint with no TTL to the ceiling", () => {
    const result = computeAgentKeyExpiresAt({ scope: CROSS_COMPANY, now: NOW });
    expect(result).not.toBeNull();
    expect(result!.getTime()).toBe(nowMs + CROSS_COMPANY_AGENT_KEY_MAX_TTL_SECONDS * 1000);
  });

  it("(c) clamps a cross-company TTL over the ceiling instead of accepting it verbatim", () => {
    const oversized = CROSS_COMPANY_AGENT_KEY_MAX_TTL_SECONDS * 10;
    const result = computeAgentKeyExpiresAt({ scope: CROSS_COMPANY, ttlSeconds: oversized, now: NOW });
    expect(result!.getTime()).toBe(nowMs + CROSS_COMPANY_AGENT_KEY_MAX_TTL_SECONDS * 1000);
  });

  it("clamps a far-future cross-company expiresAt to the ceiling", () => {
    const farFuture = new Date(nowMs + CROSS_COMPANY_AGENT_KEY_MAX_TTL_SECONDS * 1000 * 30);
    const result = computeAgentKeyExpiresAt({ scope: CROSS_COMPANY, expiresAt: farFuture, now: NOW });
    expect(result!.getTime()).toBe(nowMs + CROSS_COMPANY_AGENT_KEY_MAX_TTL_SECONDS * 1000);
  });

  it("honours a cross-company TTL shorter than the ceiling (shorter is always allowed)", () => {
    const result = computeAgentKeyExpiresAt({ scope: CROSS_COMPANY, ttlSeconds: 3600, now: NOW });
    expect(result!.getTime()).toBe(nowMs + 3600 * 1000);
  });

  it("leaves same-company keys non-expiring when no TTL is requested (unchanged behaviour)", () => {
    expect(computeAgentKeyExpiresAt({ scope: STANDARD, now: NOW })).toBeNull();
    expect(computeAgentKeyExpiresAt({ now: NOW })).toBeNull();
  });

  it("honours an explicit same-company TTL without clamping to the cross-company ceiling", () => {
    const wide = CROSS_COMPANY_AGENT_KEY_MAX_TTL_SECONDS * 5;
    const result = computeAgentKeyExpiresAt({ scope: STANDARD, ttlSeconds: wide, now: NOW });
    expect(result!.getTime()).toBe(nowMs + wide * 1000);
  });

  it("prefers an explicit expiresAt over ttlSeconds when both are supplied", () => {
    const explicit = new Date(nowMs + 120_000);
    const result = computeAgentKeyExpiresAt({
      scope: STANDARD,
      ttlSeconds: 999_999,
      expiresAt: explicit,
      now: NOW,
    });
    expect(result!.getTime()).toBe(explicit.getTime());
  });
});

describe("isAgentApiKeyExpired", () => {
  it("(a) reports a key past its expiresAt as expired", () => {
    expect(isAgentApiKeyExpired(new Date(nowMs - 1000), NOW)).toBe(true);
  });

  it("treats a future or null expiry as not expired", () => {
    expect(isAgentApiKeyExpired(new Date(nowMs + 1000), NOW)).toBe(false);
    expect(isAgentApiKeyExpired(null, NOW)).toBe(false);
    expect(isAgentApiKeyExpired(undefined, NOW)).toBe(false);
  });

  it("fails closed on an unparseable expiry value", () => {
    expect(isAgentApiKeyExpired("not-a-date", NOW)).toBe(true);
  });
});

describe("createAgentKeySchema", () => {
  it("accepts ttlSeconds and coerces an ISO expiresAt string to a Date", () => {
    const parsed = createAgentKeySchema.parse({
      name: "ci",
      ttlSeconds: 3600,
      expiresAt: "2026-02-01T00:00:00.000Z",
    });
    expect(parsed.ttlSeconds).toBe(3600);
    expect(parsed.expiresAt).toBeInstanceOf(Date);
    expect(parsed.expiresAt!.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("rejects a non-positive ttlSeconds", () => {
    expect(createAgentKeySchema.safeParse({ ttlSeconds: 0 }).success).toBe(false);
    expect(createAgentKeySchema.safeParse({ ttlSeconds: -5 }).success).toBe(false);
  });

  it("defaults to a non-expiring standard-scope key when TTL fields are omitted", () => {
    const parsed = createAgentKeySchema.parse({});
    expect(parsed.scope).toEqual({ kind: "standard" });
    expect(parsed.ttlSeconds).toBeUndefined();
    expect(parsed.expiresAt).toBeUndefined();
  });
});

describe("formatBridgeKeyRefusalLine", () => {
  it("renders each refusal code with a distinct, greppable prefix", () => {
    const lines = [
      formatBridgeKeyRefusalLine({ code: "key_expired", keyId: "k1", expiresAt: "2026-08-25T08:09:00.000Z" }),
      formatBridgeKeyRefusalLine({ code: "key_revoked", keyId: "k2" }),
      formatBridgeKeyRefusalLine({ code: "key_missing" }),
      formatBridgeKeyRefusalLine({ code: "key_scope_mismatch", keyId: "k3", actualScopeKind: "standard" }),
      formatBridgeKeyRefusalLine({ code: "binding_absent" }),
      formatBridgeKeyRefusalLine({ code: "binding_malformed" }),
      formatBridgeKeyRefusalLine({ code: "binding_not_secret_ref" }),
      formatBridgeKeyRefusalLine({ code: "secret_unresolved" }),
      formatBridgeKeyRefusalLine({ code: "verifier_unavailable" }),
    ];
    const prefixes = lines.map((line) => line.split(":")[0]);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(lines[0]).toContain("TASK_BRIDGE_KEY_EXPIRED: bridge key k1 expired 2026-08-25T08:09:00.000Z");
  });

  it("never renders key plaintext or hashes", () => {
    const line = formatBridgeKeyRefusalLine({
      code: "key_expired",
      keyId: "key-id-only",
      expiresAt: "2026-08-25T08:09:00.000Z",
    });
    expect(line).not.toContain("sha256");
    expect(line).not.toContain("pat-");
  });
});
