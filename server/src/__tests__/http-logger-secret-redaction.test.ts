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
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pla842-httplog-"));
const logFile = path.join(logDir, "server.log");

let httpLogger: import("express").RequestHandler;
let logger: { flush?: () => void };

beforeAll(async () => {
  // Must be set BEFORE the logger module is first imported (it resolves the
  // log dir at module-eval time). Dynamic import guarantees ordering.
  process.env.PAPERCLIP_LOG_DIR = logDir;
  const mod = await import("../middleware/logger.js");
  httpLogger = mod.httpLogger as unknown as import("express").RequestHandler;
  logger = mod.logger as unknown as { flush?: () => void };
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
});
