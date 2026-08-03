import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";

/**
 * Provenance of the credential that authenticated the current request. Captured
 * from `req.actor` so downstream writes (notably `logActivity`) can record which
 * credential class acted without every call site having to thread the actor
 * through. `keyId` is a board API key id (a UUID); the token value is never here.
 */
export interface ActorProvenance {
  source: string | null;
  keyId: string | null;
}

const actorProvenanceStore = new AsyncLocalStorage<ActorProvenance>();

/**
 * Reads the provenance bound to the current async context, or `null` when there
 * is none — e.g. background work (heartbeats, plugin workers, migrations) that
 * runs outside any HTTP request. A `null` here is itself meaningful: the write
 * was not authenticated by a request-scoped credential.
 */
export function getActorProvenance(): ActorProvenance | null {
  return actorProvenanceStore.getStore() ?? null;
}

/**
 * Runs `fn` with `provenance` bound to AsyncLocalStorage. Exposed so tests and
 * non-Express entry points can establish context the same way the middleware does.
 */
export function runWithActorProvenance<T>(provenance: ActorProvenance, fn: () => T): T {
  return actorProvenanceStore.run(provenance, fn);
}

/**
 * Express middleware that captures `req.actor`'s credential provenance into
 * AsyncLocalStorage for the remainder of the request. Must be registered AFTER
 * `actorMiddleware`, which is what populates `req.actor`.
 */
export function actorProvenanceMiddleware(): RequestHandler {
  return (req, _res, next) => {
    const provenance: ActorProvenance = {
      source: req.actor?.source ?? null,
      keyId: req.actor?.keyId ?? null,
    };
    actorProvenanceStore.run(provenance, () => next());
  };
}
