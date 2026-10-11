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

/**
 * Reserved key under which the enqueuing request's provenance is persisted in
 * `agent_wakeup_requests.payload`, so a run dispatched later by a timer drain
 * (outside any HTTP request) can restore it. Holds only `{source, keyId}`.
 */
export const ACTOR_PROVENANCE_PAYLOAD_KEY = "_paperclipActorProvenance";

/**
 * Runs `fn` with `p` bound as the current actor provenance. With `p === null`
 * it runs `fn()` unchanged (inheriting whatever context is ambient), so genuine
 * background work keeps writing `actor_source = NULL`. `keyId` is a board API
 * key id (a UUID); the token value is never here.
 */
export function runWithActorProvenance<T>(p: ActorProvenance | null, fn: () => T): T {
  if (!p) return fn();
  return actorProvenanceStore.run(p, fn);
}

/**
 * Snapshot of the current provenance reduced to exactly `{source, keyId}`, or
 * `null` when there is no request context or it carries no credential class.
 */
export function captureActorProvenance(): ActorProvenance | null {
  const p = getActorProvenance();
  if (!p || (!p.source && !p.keyId)) return null;
  return { source: p.source ?? null, keyId: p.keyId ?? null };
}

/**
 * Parses a persisted provenance value back into `{source, keyId}`; anything
 * malformed yields `null` (fail closed to "no provenance").
 */
export function parseActorProvenance(value: unknown): ActorProvenance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const source = typeof v.source === "string" ? v.source : null;
  const keyId = typeof v.keyId === "string" ? v.keyId : null;
  if (!source && !keyId) return null;
  return { source, keyId };
}
