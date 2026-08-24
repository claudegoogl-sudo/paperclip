import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(function child() {
    return this;
  }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: loggerMock,
}));

const { errorHandler } = await import("../middleware/error-handler.js");

function makeApp(jsonLimit: string) {
  const app = express();
  app.use(express.json({ limit: jsonLimit }));
  app.post("/api/echo", (req, res) => {
    res.json({ ok: true, received: req.body });
  });
  app.use(errorHandler);
  return app;
}

describe("errorHandler 413 integration", () => {
  beforeEach(() => {
    loggerMock.warn.mockClear();
  });

  it("returns 413 with structured shape and emits a warn log when body exceeds express.json limit", async () => {
    const app = makeApp("1kb");
    // Build a payload that comfortably exceeds 1kb (~2KB string field).
    const payload = { blob: "a".repeat(2048) };

    const res = await request(app)
      .post("/api/echo")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      error: "Request entity too large",
      code: "entity.too.large",
      limit: 1024,
    });

    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    const [logFields, logMsg] = loggerMock.warn.mock.calls[0];
    expect(logMsg).toBe("request entity too large");
    expect(logFields).toMatchObject({
      route: "/api/echo",
      method: "POST",
      limit: 1024,
      type: "entity.too.large",
    });
    expect(typeof logFields.contentLength).toBe("number");
    expect(logFields.contentLength).toBeGreaterThan(1024);
  });

  it("still serves normal requests under the limit", async () => {
    const app = makeApp("10kb");
    const res = await request(app)
      .post("/api/echo")
      .send({ hello: "world" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, received: { hello: "world" } });
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});
