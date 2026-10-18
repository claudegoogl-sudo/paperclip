import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { issueListClientIdentity } from "../routes/issues.js";

// Forged left-most entry; the real client is appended by the edge proxy.
const FORGED_XFF = "203.0.113.9, 198.51.100.20";

function app(trustProxy: string[] | false): express.Express {
  const a = express();
  a.set("trust proxy", trustProxy);
  a.get("/id", (req, res) => {
    res.json(issueListClientIdentity(req));
  });
  return a;
}

describe("issueListClientIdentity uses req.ip, never raw X-Forwarded-For", () => {
  it("trust=loopback, loopback peer: keys on the right-most untrusted hop, not the forged left-most", async () => {
    const res = await request(app(["loopback"]))
      .get("/id")
      .set("X-Forwarded-For", FORGED_XFF)
      .set("User-Agent", "ua-test");
    expect(res.body.key).toBe("198.51.100.20:ua-test");
    expect(res.body.key).not.toContain("203.0.113.9");
  });

  it("no trust proxy: keys on the socket address and ignores X-Forwarded-For", async () => {
    const res = await request(app(false))
      .get("/id")
      .set("X-Forwarded-For", FORGED_XFF)
      .set("User-Agent", "ua-test");
    expect(res.body.key).toMatch(/^(::ffff:)?127\.0\.0\.1:ua-test$|^::1:ua-test$/);
    expect(res.body.key).not.toContain("203.0.113.9");
    expect(res.body.key).not.toContain("198.51.100.20");
  });
});
