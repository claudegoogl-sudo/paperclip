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
  /**
   * `<actorType>:<actorId>` of the authenticated request actor (e.g.
   * `user:<userId>`, `agent:<agentId>`), or absent. Type + id only — never a
   * token, email, or request body. Consumed by the secret-binding posture audit
   * trigger via the transaction-local `paperclip.actor` GUC. Never persisted:
   * `captureActorProvenance` strips it.
   */
  auditActor?: string | null;
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
      auditActor: auditActorFromRequestActor(req.actor),
    };
    runWithActorProvenance(provenance, () => next());
  };
}

/**
 * Reduces a request actor to `<actorType>:<actorId>`, or `null` when the actor
 * is unauthenticated or has no id. Only the type and id leave this function.
 */
export function auditActorFromRequestActor(
  actor: { type?: string; userId?: string | null; agentId?: string | null } | undefined | null,
): string | null {
  if (!actor) return null;
  if (actor.type === "agent" && actor.agentId) return `agent:${actor.agentId}`;
  if (actor.type === "board" && actor.userId) return `user:${actor.userId}`;
  return null;
}

/** The current request's audit actor (`<type>:<id>`), or `null` outside a request. */
export function getAuditActor(): string | null {
  return getActorProvenance()?.auditActor ?? null;
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
 * key id (a UUID); the token value is never here. Also used to re-enter the
 * originating request's provenance across async boundaries AsyncLocalStorage
 * cannot follow on its own (e.g. plugin worker→host RPC).
 */
export function runWithActorProvenance<T>(p: ActorProvenance | null, fn: () => T): T {
  if (!p) return fn();
  return actorProvenanceStore.run(p, fn);
}

/**
 * Provenance objects bound by `runWithRestoredActorProvenance`. They are visible to
 * readers (`logActivity`) but `captureActorProvenance` ignores them, so a restored
 * scope never propagates attribution to wakes it enqueues (positive-evidence-only).
 */
const restoredProvenance = new WeakSet<ActorProvenance>();

/**
 * Runs `fn` with provenance restored from a persisted wakeup payload. With
 * `p === null` the ambient context is explicitly CLEARED (not inherited), so a
 * run chained from a board-key run does not inherit its attribution. Restored
 * provenance is never re-captured into new wakeup payloads.
 */
export function runWithRestoredActorProvenance<T>(p: ActorProvenance | null, fn: () => T): T {
  if (!p) return runWithoutActorProvenance(fn);
  const bound: ActorProvenance = { source: p.source, keyId: p.keyId };
  restoredProvenance.add(bound);
  return actorProvenanceStore.run(bound, fn);
}

/**
 * Runs `fn` with NO actor provenance bound, regardless of the ambient context.
 * Event-emitter callbacks (e.g. a plugin worker's stdout listener) inherit the
 * async context in which the emitter was created, so a worker spawned during a
 * request would otherwise stamp that request's credential on unrelated writes.
 */
export function runWithoutActorProvenance<T>(fn: () => T): T {
  return actorProvenanceStore.exit(fn);
}

/**
 * Snapshot of the current REQUEST-ORIGIN provenance reduced to exactly
 * `{source, keyId}`, or `null` when there is no request context, it carries no
 * credential class, or it was restored by `runWithRestoredActorProvenance`.
 */
export function captureActorProvenance(): ActorProvenance | null {
  const p = getActorProvenance();
  if (!p || restoredProvenance.has(p) || (!p.source && !p.keyId)) return null;
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
