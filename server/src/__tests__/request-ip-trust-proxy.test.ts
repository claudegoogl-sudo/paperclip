import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { requestIp } from "../routes/access.js";

const SPOOFED_XFF = "1.1.1.1, 203.0.113.5";

function appWithPeer(peer?: string): express.Express {
  const app = express();
  app.set("trust proxy", ["loopback"]);
  if (peer) {
    // supertest always connects over loopback; fake the socket peer.
    app.use((req, _res, next) => {
      Object.defineProperty(req, "socket", {
        value: { ...req.socket, remoteAddress: peer },
        configurable: true,
      });
      Object.defineProperty(req, "connection", { value: req.socket, configurable: true });
      next();
    });
  }
  app.get("/ip", (req, res) => {
    res.json({ ip: requestIp(req) });
  });
  return app;
}

describe("requestIp honours trust proxy", () => {
  it("loopback peer, trust=loopback: returns the rightmost untrusted XFF hop, not the caller-chosen leftmost", async () => {
    const res = await request(appWithPeer()).get("/ip").set("X-Forwarded-For", SPOOFED_XFF);
    expect(res.body.ip).toBe("203.0.113.5");
    expect(res.body.ip).not.toBe("1.1.1.1");
  });

  it("non-loopback peer, trust=loopback: returns the true socket address, ignoring XFF", async () => {
    const res = await request(appWithPeer("203.0.113.9")).get("/ip").set("X-Forwarded-For", SPOOFED_XFF);
    expect(res.body.ip).toBe("203.0.113.9");
  });
});
