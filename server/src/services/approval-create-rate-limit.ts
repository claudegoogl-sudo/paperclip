// Per-agent rate limiting for the approval-card creation route
// (POST /companies/:companyId/approvals). Two caps, both enforced at the
// route boundary for agent actors only — board/user callers are a trusted
// origin and exempt from both:
//
//   1. A sliding-window burst cap: how many cards one agent may create per
//      window. Bounds how fast a looping or compromised agent can flood the
//      board (and every reviewer wake attached to a card) with new asks.
//      Built on the shared sliding-window store (see
//      sliding-window-rate-limit-store.ts) — same primitive as the plugin
//      webhook limiter, no new dependency, sweep-on-write, bounded live keys.
//
//   2. A pending-card cap: how many simultaneously open (status "pending")
//      cards one agent may hold. Unlike the burst window this is stateful
//      against the approvals table, so a slow drip (one card per window,
//      forever) still converges to a hard ceiling. Resolving or withdrawing
//      a card frees budget.
//
// The inspect/record split matters here: the route inspects the burst bucket
// before doing any work and records the hit only after the row is actually
// created, so a request rejected by any guard (spoofed attribution, pending
// cap, validation) never spends burst budget — a retry after a transient
// failure is not double-billed (there is no other idempotency/dedupe path on
// this route; see the route comment).

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals } from "@paperclipai/db";
import {
  APPROVAL_CREATE_RATE_LIMIT_MAX_PER_AGENT,
  APPROVAL_CREATE_RATE_LIMIT_WINDOW_MS,
} from "@paperclipai/shared";
import {
  DEFAULT_SLIDING_WINDOW_MAX_KEYS,
  createSlidingWindowRateLimitStore,
} from "./sliding-window-rate-limit-store.js";

export type ApprovalCreateRateLimitDecision = {
  allowed: boolean;
  /** The configured cap the decision was measured against. */
  limit: number;
  /** Hits remaining in the window before the create, clamped at 0. */
  remaining: number;
  /** Whole seconds until the oldest hit slides out; 0 when not blocked. */
  retryAfterSeconds: number;
};

export type ApprovalCreateRateLimiter = {
  /** Check whether the agent may create a card now. Does NOT record a hit. */
  inspect(agentId: string): ApprovalCreateRateLimitDecision;
  /** Commit one hit after the create succeeded. */
  record(agentId: string): void;
};

export function createApprovalCreateRateLimiter(options: {
  windowMs?: number;
  maxPerAgent?: number;
  /** Per-bucket ceiling on live keys; override is for tests. */
  maxKeys?: number;
  now?: () => number;
} = {}): ApprovalCreateRateLimiter {
  const windowMs = options.windowMs ?? APPROVAL_CREATE_RATE_LIMIT_WINDOW_MS;
  const maxPerAgent = options.maxPerAgent ?? APPROVAL_CREATE_RATE_LIMIT_MAX_PER_AGENT;
  const maxKeys = options.maxKeys ?? DEFAULT_SLIDING_WINDOW_MAX_KEYS;
  const now = options.now ?? Date.now;
  const store = createSlidingWindowRateLimitStore({
    windowMs,
    max: maxPerAgent,
    maxKeys,
  });

  return {
    inspect(agentId) {
      const state = store.inspect(agentId, now());
      return {
        allowed: !state.blocked,
        limit: maxPerAgent,
        remaining: state.remaining,
        retryAfterSeconds: state.retryAfterSeconds,
      };
    },
    record(agentId) {
      store.record(agentId, now());
    },
  };
}

/**
 * Process-wide default limiter. Module scope (not per-route-registration)
 * so re-registering routers cannot reset the ceiling — same reasoning as
 * the plugin webhook limiter. Route tests inject a fresh limiter through
 * `approvalRoutes(db, { approvalCreateRateLimiter })`.
 */
export const defaultApprovalCreateRateLimiter = createApprovalCreateRateLimiter();

/**
 * Count the agent's open approval cards in the company. This is the
 * pending-cap budget check; every resolved/withdrawn card immediately frees
 * a slot because the count reads live status.
 */
export async function countPendingApprovalsForAgent(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<number> {
  const rows = await db
    .select({ pending: sql<number>`count(*)::int` })
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, companyId),
        eq(approvals.requestedByAgentId, agentId),
        eq(approvals.status, "pending"),
      ),
    );
  return rows[0]?.pending ?? 0;
}
