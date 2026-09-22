import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import { HTTP_LOG_REDACT_PATHS } from "./http-log-redaction.js";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import {
  isPrivateChatWebhookHttpRequest,
  isSecretSensitiveHttpRequest,
  shouldSilenceHttpSuccessLog,
} from "./http-log-policy.js";
import { redactSecretsForLog, redactSecretsDeepForLog } from "../secret-patterns.js";
import {
  redactSensitive,
  stripSecretBearingUrlParts,
} from "./redact-sensitive.js";
import { redactWorkspaceHandoffTicket } from "../auth/workspace-login-handoff.js";


/**
 * Censor used by pino `redact` to scrub secret patterns from the serialised
 * request fields (`req.url`, `req.query.*`, `req.headers.*`). The matched
 * substring is replaced with its class marker via the shared module so this
 * surface cannot drift from the write-block denylist. Headers that are
 * credentials regardless of shape (`authorization`, `proxy-authorization`,
 * `cookie`, `set-cookie`, CSRF/X-API-key headers — the upstream
 * HTTP_LOG_REDACT_PATHS set) are special-cased to a full `[Redacted]`.
 *
 * SECURITY-CRITICAL: The log surface uses the `...ForLog` variant: the
 * Option A issuer-allowlist applies ONLY to the write-block (free-text bodies);
 * a live `iss=paperclip` run JWT must never be persisted to `server.log`, so
 * here every JWT shape is redacted regardless of issuer.
 */
const FULLY_REDACTED_HEADER_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-csrf-token",
  "x-xsrf-token",
  "x-api-key",
]);

function redactRequestField(value: unknown, path: string[]): unknown {
  const key = path[path.length - 1];
  if (FULLY_REDACTED_HEADER_KEYS.has(key)) return "[Redacted]";
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

const isProduction = process.env.NODE_ENV === "production";

// Union of the upstream credential-header paths and the fork's serialised
// request-field paths, all funnelled through the pattern-aware censor above
// (credential headers → full `[Redacted]`, everything else → pattern redact).
const LOG_REDACT_PATHS = [...new Set([...HTTP_LOG_REDACT_PATHS, "req.url", "req.query.*", "req.headers.*"])];

export const logger = pino({
  level: process.env.PAPERCLIP_LOG_LEVEL?.trim() || (isProduction ? "info" : "debug"),
  // Pattern-redact the serialised request fields that pino-http logs. pino-http
  // overrides any req/res serializers we pass it, so log-time `redact` (which
  // runs after serialization) is the reliable hook for these paths:
  //   - req.url        → the `?q=<token>` URL-query case
  //   - req.query.*    → the same query parsed into fields
  //   - req.headers.*  → header values; credential headers → full `[Redacted]`
  // reqBody.* / reqParams / reqQuery and the `msg` line are redacted at their
  // source in the pino-http callbacks below.
  redact: {
    paths: LOG_REDACT_PATHS,
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

function requestClassificationUrl(req: {
  originalUrl?: unknown;
  url?: unknown;
}): string | undefined {
  return typeof req.originalUrl === "string"
    ? req.originalUrl
    : typeof req.url === "string"
      ? req.url
      : undefined;
}

function isPrivateWebhook(req: { method?: string; originalUrl?: unknown; url?: unknown }) {
  return isPrivateChatWebhookHttpRequest(req.method, requestClassificationUrl(req));
}

function requestLogUrl(req: { method?: string; originalUrl?: unknown; url?: unknown }) {
  return isPrivateWebhook(req)
    ? "/api/chat-webhooks/:publicId/:provider"
    : stripSecretBearingUrlParts(typeof req.url === "string" ? req.url : "");
}

/**
 * Factory form of the HTTP logger (upstream contract): mount the fork's
 * redacting middleware against a caller-supplied base logger, so tests and
 * embedders can observe exactly what would be written. The singletons below
 * use the shared `logger`. Combines upstream's private-webhook closed
 * projections with the fork's secret-pattern redaction.
 */
export function createHttpLogger(baseLogger: pino.Logger) {
  return pinoHttp({
    logger: baseLogger,
  // SECURITY-CRITICAL: Log-time secret-pattern redaction (§1–§2). The matched substring
  // in any logged value is replaced with its class marker (e.g.
  // `<redacted github_pat>`) before the line is serialised — never a partial
  // value. The pattern set is imported from ../secret-patterns.js, the single
  // source shared with the write-block denylist so the two cannot drift.
  //
  // Coverage map:
  //  - `req.url` / `req.query` / `req.headers`  → pino `redact` on the base logger
  //  - `reqBody.*` (every leaf), reqParams, reqQuery, errorContext
  //                                            → customProps below
  //  - `msg` (embeds method + url + error msg) → custom*Message below
  //  - `req.headers.authorization`             → pino `redact` (full censor),
  //    in addition to pattern redaction, because the auth header is always a
  //    credential regardless of shape (an `iss=paperclip` run JWT there must
  //    still be censored).
  //  - `res.body`: response bodies are NOT logged anywhere in this server (the
  //    res serializer emits status only), so there is nothing to scrub there.
    serializers: {
      req(req: Record<string, unknown> & { url?: unknown; method?: unknown; id?: unknown }) {
        if (
          isPrivateWebhook({
            method: typeof req.method === "string" ? req.method : undefined,
            url: req.url,
          })
        ) {
          // Closed projection: no params, arbitrary headers, or parser/SDK
          // body copies (including Buffer numeric byte keys) may leak a
          // provider payload.
          return {
            id: req.id,
            method: req.method,
            url: "/api/chat-webhooks/:publicId/:provider",
          };
        }
        return {
          ...req,
          url: typeof req.url === "string" ? stripSecretBearingUrlParts(req.url) : req.url,
          query: undefined,
        };
      },
      res(
        res: Record<string, unknown> & {
          raw?: { req?: { method?: string; originalUrl?: unknown; url?: unknown } };
        },
      ) {
        return res.raw?.req && isPrivateWebhook(res.raw.req)
          ? { statusCode: res.statusCode }
          : res;
      },
    },
  customLogLevel(_req, res, err) {
    if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
      return "silent";
    }
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    // The request line keeps the webhook placeholder for private webhook
    // routes and drops secret-bearing URL parts otherwise; the fork's
    // pattern redaction wraps both (a workspace login handoff ticket is a
    // bearer credential that rides in the query string).
    return redactSecretsForLog(`${req.method} ${requestLogUrl(req)} ${res.statusCode}`);
  },
  customErrorMessage(req, res, err) {
    if (isSecretSensitiveHttpRequest(req.method, requestClassificationUrl(req))) {
      return redactSecretsForLog(`${req.method} ${requestLogUrl(req)} ${res.statusCode} — request failed`);
    }
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return redactSecretsForLog(`${req.method} ${requestLogUrl(req)} ${res.statusCode} — ${errMsg}`);
  },
  customErrorObject(req, _res, _err, value) {
    // pino-http serializes res.err independently of customProps/errorContext.
    // Do not rely on a particular error handler having sanitized an SDK Error.
    return isPrivateWebhook(req)
      ? {
          ...value,
          err: { type: "Error", message: "Chat webhook request failed" },
        }
      : value;
  },
  customProps(req, res) {
    if (res.statusCode >= 400 && isPrivateWebhook(req)) {
      // Omit, rather than recursively redact, the entire provider payload —
      // before/after parsing, with or without error context.
      return {
        reqBody: "[REDACTED]",
        ...((res as any).__errorContext || (res as any).err ? { errorContext: { name: "Error" } } : {}),
      };
    }
    return redactSecretsDeepForLog(buildHttpLogProps(req, res));
  },
  });
}

export const httpLogger = createHttpLogger(logger);

// Two redaction layers apply to the request fields below (defense in depth):
//  1. `redactSensitive` here scrubs values by *key name* (password, *_token,
//     api_key, …) so a credential whose value doesn't match a known secret
//     pattern still never lands on disk (upstream v2026.618.0).
//  2. the outer `redactSecretsDeepForLog` in `customProps` then scrubs by
//     *value pattern* (live JWTs, provider keys) anywhere in the tree.
function buildHttpLogProps(req: any, res: any): Record<string, unknown> {
  if (res.statusCode >= 400) {
    const ctx = (res as any).__errorContext;
    if (ctx) {
      const secretSensitiveRoute = isSecretSensitiveHttpRequest(
        req.method,
        requestClassificationUrl(req),
      );
      return {
        // Provider SDK and validation errors sometimes echo the supplied
        // credential in their prose. Keep only a non-sensitive type marker for
        // secret-sensitive routes; the status, route, and redacted body remain.
        errorContext: secretSensitiveRoute
          ? { name: "Error" }
          : ctx.error,
        reqBody: redactSensitive(ctx.reqBody),
        reqParams: redactSensitive(ctx.reqParams),
        // Query strings stay out entirely on secret-sensitive routes (one-shot
        // OAuth codes and handoff tickets ride there); elsewhere they are
        // key-redacted like the body.
        ...(secretSensitiveRoute
          ? {}
          : { reqQuery: redactSensitive(ctx.reqQuery) }),
      };
    }
    const props: Record<string, unknown> = {};
    // Query strings are never copied into the structured request log: OAuth
    // callback codes and handoff tickets ride there, and key/pattern redaction
    // cannot vouch for an opaque one-time value.
    const { body, params } = req as any;
    if (body && typeof body === "object" && Object.keys(body).length > 0) {
      props.reqBody = redactSensitive(body);
    }
    if (params && typeof params === "object" && Object.keys(params).length > 0) {
      props.reqParams = redactSensitive(params);
    }
    if ((req as any).route?.path) {
      props.routePath = (req as any).route.path;
    }
    return props;
  }
  return {};
}
