import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";
import { redactSecretsForLog, redactSecretsDeepForLog } from "../secret-patterns.js";

/**
 * Censor used by pino `redact` to scrub secret patterns from the serialised
 * request fields (`req.url`, `req.query.*`, `req.headers.*`). The matched
 * substring is replaced with its class marker via the shared module so this
 * surface cannot drift from the write-block denylist. The `authorization`
 * header is special-cased to a full `[Redacted]` because it is always a
 * credential regardless of shape.
 *
 * The log surface uses the `...ForLog` variant (PLA-842 Finding 1): the
 * Option A issuer-allowlist applies ONLY to the write-block (free-text bodies);
 * a live `iss=paperclip` run JWT must never be persisted to `server.log`, so
 * here every JWT shape is redacted regardless of issuer.
 */
function redactRequestField(value: unknown, path: string[]): unknown {
  const key = path[path.length - 1];
  if (key === "authorization") return "[Redacted]";
  return typeof value === "string" ? redactSecretsForLog(value) : value;
}

function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

export const logger = pino({
  level: "debug",
  // Pattern-redact the serialised request fields that pino-http logs. pino-http
  // overrides any req/res serializers we pass it, so log-time `redact` (which
  // runs after serialization) is the reliable hook for these paths:
  //   - req.url        → the `?q=<token>` URL-query case (PLA-199)
  //   - req.query.*    → the same query parsed into fields
  //   - req.headers.*  → header values; `authorization` → full `[Redacted]`
  // reqBody.* / reqParams / reqQuery and the `msg` line are redacted at their
  // source in the pino-http callbacks below.
  redact: {
    paths: ["req.url", "req.query.*", "req.headers.*"],
    censor: redactRequestField,
  },
}, pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      level: "info",
    },
    {
      target: "pino-pretty",
      options: { ...sharedOpts, colorize: false, destination: logFile, mkdir: true },
      level: "debug",
    },
  ],
}));

export const httpLogger = pinoHttp({
  logger,
  // Log-time secret-pattern redaction (PLA-317 §1–§2). The matched substring
  // in any logged value is replaced with its class marker (e.g.
  // `<redacted github_pat>`) before the line is serialised — never a partial
  // value. The pattern set is imported from ../secret-patterns.js, the single
  // source shared with the write-block denylist so the two cannot drift.
  //
  // Coverage map:
  //  - `req.url` / `req.query` / `req.headers`  → serializers.req below
  //  - `reqBody.*` (every leaf), reqParams, reqQuery, errorContext
  //                                            → customProps below
  //  - `msg` (embeds method + url + error msg) → custom*Message below
  //  - `req.headers.authorization`             → pino `redact` (full censor),
  //    in addition to pattern redaction, because the auth header is always a
  //    credential regardless of shape (an `iss=paperclip` run JWT there must
  //    still be censored).
  //  - `res.body`: response bodies are NOT logged anywhere in this server (the
  //    res serializer emits status only), so there is nothing to scrub there.
  // (req/res serializers are configured on the base `logger` instance above —
  // pino-http ignores `serializers` passed in its own options.)
  customLogLevel(_req, res, err) {
    if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
      return "silent";
    }
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    return redactSecretsForLog(`${req.method} ${req.url} ${res.statusCode}`);
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return redactSecretsForLog(`${req.method} ${req.url} ${res.statusCode} — ${errMsg}`);
  },
  customProps(req, res) {
    return redactSecretsDeepForLog(buildHttpLogProps(req, res));
  },
});

function buildHttpLogProps(req: any, res: any): Record<string, unknown> {
  if (res.statusCode >= 400) {
    const ctx = (res as any).__errorContext;
    if (ctx) {
      return {
        errorContext: ctx.error,
        reqBody: ctx.reqBody,
        reqParams: ctx.reqParams,
        reqQuery: ctx.reqQuery,
      };
    }
    const props: Record<string, unknown> = {};
    const { body, params, query } = req as any;
    if (body && typeof body === "object" && Object.keys(body).length > 0) {
      props.reqBody = body;
    }
    if (params && typeof params === "object" && Object.keys(params).length > 0) {
      props.reqParams = params;
    }
    if (query && typeof query === "object" && Object.keys(query).length > 0) {
      props.reqQuery = query;
    }
    if ((req as any).route?.path) {
      props.routePath = (req as any).route.path;
    }
    return props;
  }
  return {};
}
