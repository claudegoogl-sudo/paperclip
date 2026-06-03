import { describe, expect, it } from "vitest";
import {
  SECRET_PATTERNS,
  findSecretMatches,
  firstSecretMatch,
  redactSecrets,
  redactSecretsDeep,
  secretMarker,
} from "../secret-patterns.js";

// All fixtures are synthetic, shape-valid, non-live values (PLA-177 / PLA-319
// constraint: zero live secret bytes). The bodies below are deterministic
// filler that matches each pattern's shape.
const GITHUB_PAT = `github_pat_${"A".repeat(82)}`;
const GHP = `ghp_${"a".repeat(36)}`;
const GHO = `gho_${"b".repeat(36)}`;
const GHU = `ghu_${"c".repeat(36)}`;
const GHS = `ghs_${"d".repeat(36)}`;
const GHR = `ghr_${"e".repeat(76)}`;
// Deliberately NOT shaped like a real Slack token (no numeric workspace/config
// groups): matches our loose `xoxb-`/`xoxp-` class regex while staying clear of
// GitHub push-protection's stricter Slack detector. Synthetic, non-live.
const SLACK_BOT = "xoxb-EXAMPLE-PLACEHOLDER-NOTAREALTOKEN";
const SLACK_USER = "xoxp-EXAMPLE-PLACEHOLDER-NOTAREALTOKEN";
const AWS_KEY = "AKIAABCDEFGHIJKLMNOP";
const AWS_TEMP = "ASIAABCDEFGHIJKLMNOP";
const PEM = "-----BEGIN RSA PRIVATE KEY-----";

function b64url(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function makeJwt(claims: Record<string, unknown>): string {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const payload = b64url(claims);
  return `${header}.${payload}.c2lnbmF0dXJl`;
}

describe("secret-patterns shared module", () => {
  it("detects each documented class with its stable label", () => {
    const cases: Array<[string, string]> = [
      [GITHUB_PAT, "github_pat"],
      [GHP, "github_classic_pat"],
      [GHO, "github_oauth"],
      [GHU, "github_user_to_server"],
      [GHS, "github_server_to_server"],
      [GHR, "github_refresh"],
      [SLACK_BOT, "slack_bot"],
      [SLACK_USER, "slack_user"],
      [AWS_KEY, "aws_access_key"],
      [AWS_TEMP, "aws_temp_key"],
      [PEM, "pem_private_key"],
    ];
    for (const [value, label] of cases) {
      expect(firstSecretMatch(`prefix ${value} suffix`)?.label).toBe(label);
    }
  });

  it("returns null / empty for clean content", () => {
    expect(firstSecretMatch("a perfectly ordinary issue description")).toBeNull();
    expect(findSecretMatches("nothing secret here")).toEqual([]);
    expect(firstSecretMatch(undefined)).toBeNull();
    expect(firstSecretMatch(12345 as unknown)).toBeNull();
  });

  it("blocks third-party JWTs but allows Paperclip run JWTs (Option A)", () => {
    const thirdParty = makeJwt({ iss: "https://login.auth0.example/", sub: "u1" });
    expect(firstSecretMatch(thirdParty)?.label).toBe("jwt");

    const paperclip = makeJwt({ iss: "paperclip", sub: "run-1" });
    expect(firstSecretMatch(paperclip)).toBeNull();

    // Malformed / undecodable JWT shape is treated conservatively as a secret.
    const malformed = "eyJ!!!.eyJ!!!.";
    // (Does not match the strict charset, so it is simply not a JWT match.)
    expect(firstSecretMatch(malformed)).toBeNull();
  });

  it("redacts matched substrings with the class marker, never a partial value", () => {
    const redacted = redactSecrets(`token=${GITHUB_PAT} done`);
    expect(redacted).toBe(`token=${secretMarker("github_pat")} done`);
    expect(redacted).not.toContain(GITHUB_PAT);
    // No fragment of the original secret survives.
    expect(redacted).not.toMatch(/A{10,}/);
  });

  it("redacts the full JWT including the signature segment (no trailing fragment)", () => {
    const thirdParty = makeJwt({ iss: "okta" });
    const redacted = redactSecrets(`Authorization: Bearer ${thirdParty}`);
    expect(redacted).toBe("Authorization: Bearer <redacted jwt>");
    expect(redacted).not.toContain("c2lnbmF0dXJl");
  });

  it("leaves Paperclip run JWTs intact during redaction", () => {
    const paperclip = makeJwt({ iss: "paperclip" });
    expect(redactSecrets(`x ${paperclip} y`)).toBe(`x ${paperclip} y`);
  });

  it("redacts every string leaf of a nested structure", () => {
    const input = {
      title: "ok",
      nested: { key: `secret ${AWS_KEY}`, list: [`pat ${GHP}`, "clean", 7, null] },
    };
    const out = redactSecretsDeep(input);
    expect(out.nested.key).toBe(`secret ${secretMarker("aws_access_key")}`);
    expect(out.nested.list[0]).toBe(`pat ${secretMarker("github_classic_pat")}`);
    expect(out.nested.list[1]).toBe("clean");
    expect(out.nested.list[2]).toBe(7);
    expect(out.nested.list[3]).toBeNull();
    expect(out.title).toBe("ok");
  });

  it("orders the JWT shape last so literal classes are never preempted", () => {
    const labels = SECRET_PATTERNS.map((p) => p.label);
    expect(labels[labels.length - 1]).toBe("jwt");
    expect(labels.indexOf("github_pat")).toBeLessThan(labels.indexOf("jwt"));
  });
});
