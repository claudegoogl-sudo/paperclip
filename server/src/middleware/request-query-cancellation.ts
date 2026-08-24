import type { NextFunction, Request, Response } from "express";
import { createQueryCancellationScope } from "@paperclipai/db";
import { logger } from "./logger.js";
import { redactSecretsForLog } from "../secret-patterns.js";

/**
 * Releases the pool connection of a request the client walked away from.
 *
 * postgres.js keeps running a query nobody is waiting for, so a client that
 * timed out after 30s used to leave its query holding a connection until
 * `statement_timeout` (default 60s) fired. This middleware wraps the
 * handler chain in a database cancellation scope and aborts it when the socket
 * closes early, which cancels the request's in-flight queries.
 *
 * Two deliberate limits:
 *   - Safe methods only. Cancelling a mutation halfway through would leave the
 *     database in a state nobody asked for, and our writes are not all a single
 *     statement — letting an abandoned write finish is the lesser evil.
 *   - Nothing is cancelled once the response has started. A streaming response
 *     (SSE) sends headers first and keeps querying afterwards, and its own
 *     close handling already owns that teardown.
 *
 * The scope follows async continuations, so work a handler starts and does not
 * await is inside it too. That is fine while only safe methods are covered — our
 * fire-and-forget calls all hang off mutations — but it is the thing to check
 * before adding a method here.
 */
const CANCELLABLE_METHODS = new Set(["GET", "HEAD"]);

export function requestQueryCancellation(req: Request, res: Response, next: NextFunction) {
  if (!CANCELLABLE_METHODS.has(req.method)) return next();

  const abortController = new AbortController();
  const scope = createQueryCancellationScope(abortController.signal);

  res.on("close", () => {
    if (res.writableEnded || res.headersSent) return;
    abortController.abort();
    if (scope.cancelledQueryCount === 0) return;
    logger.warn(
      {
        method: req.method,
        // Direct logger.* call: not covered by pino-http `redact.paths`, so
        // scrub a `?token=<secret>` out of the URL here.
        route: redactSecretsForLog(req.originalUrl),
        cancelledQueries: scope.cancelledQueryCount,
      },
      "client disconnected before the response started; cancelled in-flight database queries",
    );
  });

  scope.run(next);
}
