import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import { logger } from "./logger.js";
import { redactSecretsForLog } from "../secret-patterns.js";
import { COMPANY_IMPORT_API_PATH } from "../routes/company-import-paths.js";

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

function attachErrorContext(
  req: Request,
  res: Response,
  payload: ErrorContext["error"],
  rawError?: Error,
) {
  (res as any).__errorContext = {
    error: payload,
    method: req.method,
    url: req.originalUrl,
    reqBody: req.body,
    reqParams: req.params,
    reqQuery: req.query,
  } satisfies ErrorContext;
  if (rawError) {
    (res as any).err = rawError;
  }
}

function extractNumericStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const anyErr = err as { status?: unknown; statusCode?: unknown };
  if (typeof anyErr.status === "number" && Number.isFinite(anyErr.status)) {
    return anyErr.status;
  }
  if (typeof anyErr.statusCode === "number" && Number.isFinite(anyErr.statusCode)) {
    return anyErr.statusCode;
  }
  return undefined;
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    if (err.status >= 500) {
      attachErrorContext(
        req,
        res,
        { message: err.message, stack: err.stack, name: err.name, details: err.details },
        err,
      );
      const tc = getTelemetryClient();
      if (tc) trackErrorHandlerCrash(tc, { errorCode: err.name });
    }
    res.status(err.status).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation error", details: err.errors });
    return;
  }

  // Surface generic errors (e.g. body-parser PayloadTooLargeError) that carry
  // a numeric status in the 4xx range with that status instead of flattening
  // to 500. 5xx numerics fall through to the telemetry/attach branch below.
  const numericStatus = extractNumericStatus(err);
  if (typeof numericStatus === "number" && numericStatus >= 400 && numericStatus < 500) {
    const errLike = err as Error & {
      status?: number;
      statusCode?: number;
      type?: string;
      limit?: number;
    };
    const contentLengthHeader = req.headers["content-length"];
    const contentLength =
      typeof contentLengthHeader === "string" ? Number(contentLengthHeader) : undefined;

    if (numericStatus === 413) {
      logger.warn(
        {
          // Direct logger.* call: NOT covered by pino-http `redact.paths`
          // (those only cover req.url/req.query/req.headers), so scrub the URL
          // here — a `?token=<secret>` on an oversized request would otherwise
          // land in server.log cleartext (PLA-842 Finding 2).
          route: redactSecretsForLog(req.originalUrl),
          method: req.method,
          contentLength: Number.isFinite(contentLength) ? contentLength : null,
          limit: typeof errLike.limit === "number" ? errLike.limit : null,
          type: errLike.type ?? null,
        },
        "request entity too large",
      );
      res.status(413).json({
        error: "Request entity too large",
        code: errLike.type ?? "entity.too.large",
        ...(typeof errLike.limit === "number" ? { limit: errLike.limit } : {}),
      });
      return;
    }

    res.status(numericStatus).json({
      error: errLike.message || `HTTP ${numericStatus}`,
      ...(errLike.type ? { code: errLike.type } : {}),
    });
    return;
  }

  const rootError = err instanceof Error ? err : new Error(String(err));
  attachErrorContext(
    req,
    res,
    err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name }
      : { message: String(err), raw: err, stack: rootError.stack, name: rootError.name },
    rootError,
  );

  const tc = getTelemetryClient();
  if (tc) trackErrorHandlerCrash(tc, { errorCode: rootError.name });

  res.status(500).json({
    error: "Internal server error",
    ...(shouldExposeTrustedCloudTenantImportError(req) ? { message: rootError.message } : {}),
  });
}

function shouldExposeTrustedCloudTenantImportError(req: Request) {
  return req.actor?.source === "cloud_tenant"
    && req.method === "POST"
    && req.originalUrl.split("?")[0] === COMPANY_IMPORT_API_PATH;
}
