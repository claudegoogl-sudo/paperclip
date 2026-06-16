import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * PLA-317 AC §4 / PLA-319 §1: verification reads the ACTUAL log file produced
 * by the prod pino transport — not a mocked logger, not an in-process capture
 * stream. We point PAPERCLIP_LOG_DIR at a temp dir, import the real logger
 * module, drive a request through the real `httpLogger`, then read
 * `server.log` off disk and assert the secret was replaced by its class
 * marker (never a partial value).
 *
 * All fixtures are synthetic, shape-valid, non-live values.
 */

const GITHUB_PAT = `github_pat_${"A".repeat(82)}`;

/**
 * A synthetic JWT whose payload decodes to `iss: "paperclip"` — a Paperclip
 * run/API bearer credential. Option A lets the WRITE-BLOCK surface keep this in
 * free-text bodies, but the LOG surface must scrub it regardless of issuer
 * (PLA-842 Finding 1). Built programmatically so the payload claim is exact;
 * the signature segment is synthetic filler (no live key material).
 */
const PAPERCLIP_JWT = (() => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "paperclip", sub: "run-abc" })).toString("base64url");
  return `${header}.${payload}.${"S".repeat(43)}`;
})();

const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pla842-httplog-"));
const logFile = path.join(logDir, "server.log");

let httpLogger: import("express").RequestHandler;
let logger: { flush?: () => void };
let errorHandler: import("express").ErrorRequestHandler;

beforeAll(async () => {
  // Must be set BEFORE the logger module is first imported (it resolves the
  // log dir at module-eval time). Dynamic import guarantees ordering.
  process.env.PAPERCLIP_LOG_DIR = logDir;
  const mod = await import("../middleware/logger.js");
  httpLogger = mod.httpLogger as unknown as import("express").RequestHandler;
  logger = mod.logger as unknown as { flush?: () => void };
  const ehMod = await import("../middleware/error-handler.js");
  errorHandler = ehMod.errorHandler as unknown as import("express").ErrorRequestHandler;
});

afterAll(() => {
  try {
    fs.rmSync(logDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(httpLogger);
  app.post("/echo/:id", (_req, res) => {
    // Respond 4xx so pino-http's customProps attaches reqBody/reqQuery.
    res.status(400).json({ ok: false });
  });
  app.get("/search", (_req, res) => {
    res.status(400).json({ ok: false });
  });
  return app;
}

function build413App() {
  const app = express();
  app.use(httpLogger);
  // 100-byte cap so a modest JSON body trips the body-parser 413 path, which
  // routes to error-handler.ts and its direct `logger.warn({ route })` call.
  app.use(express.json({ limit: 100 }));
  app.post("/upload", (_req, res) => res.status(200).json({ ok: true }));
  app.use(errorHandler);
  return app;
}

async function readLogWhen(predicate: (content: string) => boolean, timeoutMs = 5000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    logger.flush?.();
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, "utf8");
      if (predicate(content)) return content;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
}

describe("HTTP logger redaction (real log file)", () => {
  it("redacts a github_pat in the POST body, URL query, and message line", async () => {
    const app = buildApp();
    await request(app)
      .post(`/echo/42?q=${GITHUB_PAT}`)
      .set("authorization", `Bearer ${GITHUB_PAT}`)
      .send({ description: `here is ${GITHUB_PAT}`, nested: { token: GITHUB_PAT } });

    const content = await readLogWhen((c) => c.includes("POST /echo/42"));

    // The marker is present (class name, not a partial value).
    expect(content).toContain("<redacted github_pat>");
    // The raw secret never reaches disk anywhere in the file.
    expect(content).not.toContain(GITHUB_PAT);
    // No long run of the fixture filler survived (defends against partial echo).
    expect(content).not.toMatch(/A{20,}/);
  });

  it("redacts a github_pat in a GET URL query string", async () => {
    const app = buildApp();
    await request(app).get(`/search?q=${GITHUB_PAT}`);

    const content = await readLogWhen((c) => c.includes("GET /search"));
    expect(content).toContain("<redacted github_pat>");
    expect(content).not.toContain(GITHUB_PAT);
  });

  // PLA-1175 regression: an off-length fine-grained PAT (90-char body, not the
  // historical 82) must still be scrubbed from the real log file. Fails against
  // the old exact `{82}` regex, passes against `{36,}`. Synthetic filler only.
  it("redacts an off-length (90-char body) github_pat in the body and URL query", async () => {
    const offLenPat = `github_pat_${"B".repeat(90)}`;
    const app = buildApp();
    await request(app)
      .post(`/echo/99?q=${offLenPat}`)
      .send({ description: `off-length ${offLenPat}`, nested: { token: offLenPat } });

    const content = await readLogWhen((c) => c.includes("POST /echo/99"));
    expect(content).toContain("<redacted github_pat>");
    expect(content).not.toContain(offLenPat);
    expect(content).not.toMatch(/B{20,}/);
  });

  // PLA-842 Finding 1 regression: Option A allows an iss=paperclip run JWT in a
  // write-block body, but the LOG surface must still scrub it. A paperclip JWT
  // outside the (force-redacted) authorization header — body leaf + URL query —
  // must not reach disk. Fails on pre-fix code (log path inherited Option A).
  it("redacts an iss=paperclip run JWT in the body and URL query (log path ignores Option A)", async () => {
    const app = buildApp();
    await request(app)
      .post(`/echo/7?token=${PAPERCLIP_JWT}`)
      .send({ note: `run jwt is ${PAPERCLIP_JWT}`, nested: { jwt: PAPERCLIP_JWT } });

    const content = await readLogWhen((c) => c.includes("POST /echo/7"));
    expect(content).toContain("<redacted jwt>");
    expect(content).not.toContain(PAPERCLIP_JWT);
  });
});

describe("error-handler 413 path redaction (real log file)", () => {
  // PLA-842 Finding 2 regression: the 413 branch logs `req.originalUrl` under
  // key `route`, outside pino `redact.paths`, so a `?token=<secret>` on an
  // oversized request lands in server.log cleartext. Fails on pre-fix code.
  it("redacts a secret in the URL query of an oversized (413) request", async () => {
    const app = build413App();
    await request(app)
      .post(`/upload?token=${GITHUB_PAT}`)
      .set("content-type", "application/json")
      .send({ blob: "x".repeat(5000) });

    const content = await readLogWhen((c) => c.includes("request entity too large"));
    expect(content).toContain("request entity too large");
    expect(content).toContain("<redacted github_pat>");
    expect(content).not.toContain(GITHUB_PAT);
  });
});
