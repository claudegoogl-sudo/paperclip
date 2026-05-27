import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";

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

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    method: "GET",
    originalUrl: "/api/test",
    body: { a: 1 },
    params: { id: "123" },
    query: { q: "x" },
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function makeRes(): Response {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;
  (res.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe("errorHandler", () => {
  beforeEach(() => {
    loggerMock.warn.mockClear();
    loggerMock.info.mockClear();
    loggerMock.error.mockClear();
    loggerMock.debug.mockClear();
  });

  it("attaches the original Error to res.err for 500s", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error("boom");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("boom");
  });

  it("attaches HttpError instances for 500 responses", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(500, "db exploded");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "db exploded" });
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("db exploded");
  });

  it("surfaces body-parser PayloadTooLargeError as 413 with structured warn log", () => {
    const req = makeReq({
      method: "POST",
      originalUrl: "/api/plugins/tools/execute",
      headers: { "content-length": "20000000" },
    });
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    // Shape mirrors body-parser's PayloadTooLargeError: a plain Error with
    // numeric status, a `type` discriminator, and a `limit` in bytes.
    const err = Object.assign(new Error("request entity too large"), {
      status: 413,
      statusCode: 413,
      type: "entity.too.large",
      expected: 20000000,
      length: 20000000,
      limit: 10485760,
    });

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({
      error: "Request entity too large",
      code: "entity.too.large",
      limit: 10485760,
    });
    // 4xx pass-through must NOT attach the 500-only error context / telemetry.
    expect(res.err).toBeUndefined();
    expect(res.__errorContext).toBeUndefined();

    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      {
        route: "/api/plugins/tools/execute",
        method: "POST",
        contentLength: 20000000,
        limit: 10485760,
        type: "entity.too.large",
      },
      "request entity too large",
    );
  });

  it("surfaces a 4xx-tagged generic error without a body-parser type/limit", () => {
    const req = makeReq({ method: "POST", originalUrl: "/api/echo" });
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    // Some upstream libs (e.g. multer, type-is) tag generic Errors with
    // statusCode but no type/limit — we still want to honour the status code.
    const err = Object.assign(new Error("Unsupported media type"), {
      statusCode: 415,
    });

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(415);
    expect(res.json).toHaveBeenCalledWith({
      error: "Unsupported media type",
    });
    expect(res.err).toBeUndefined();
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("falls through to 500 telemetry path when a generic error has a 5xx numeric status", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = Object.assign(new Error("upstream blew up"), { status: 502 });

    errorHandler(err, req, res, next);

    // 5xx numerics are NOT short-circuited — preserves existing telemetry
    // attach behaviour for any non-HttpError 5xx surface.
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("upstream blew up");
  });
});
