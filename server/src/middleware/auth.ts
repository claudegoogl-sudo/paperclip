import { createHash, timingSafeEqual } from "node:crypto";
import type { Application, Request, RequestHandler } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  boardApiKeyAuthEvents,
  companies,
  companyMemberships,
  heartbeatRuns,
  instanceUserRoles,
} from "@paperclipai/db";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import {
  isAgentApiKeyExpired,
  isUuidLike,
  normalizeAgentApiKeyScope,
  normalizeBoardApiKeyScope,
  type DeploymentMode,
} from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { actorProvenanceMiddleware } from "./actor-context.js";
import { logger } from "./logger.js";
import { boardAuthService } from "../services/board-auth.js";
import { resolveAuthEventSourceIp } from "../services/auth-event-source-ip.js";

const CLOUD_TENANT_WRITE_DEBOUNCE_MS = 5_000;
const CLOUD_TENANT_WRITE_DEBOUNCE_MAX = 1_000;
const cloudTenantWriteDebounces = new WeakMap<Db, Map<string, { fingerprint: string; syncedAt: number }>>();

function cloudTenantWriteDebounceFor(db: Db) {
  let debounce = cloudTenantWriteDebounces.get(db);
  if (!debounce) {
    debounce = new Map();
    cloudTenantWriteDebounces.set(db, debounce);
  }
  return debounce;
}

function pruneCloudTenantWriteDebounce(
  debounce: Map<string, { fingerprint: string; syncedAt: number }>,
  nowMs: number,
) {
  for (const [subject, entry] of debounce) {
    if (entry.syncedAt <= nowMs - CLOUD_TENANT_WRITE_DEBOUNCE_MS) debounce.delete(subject);
  }
  while (debounce.size > CLOUD_TENANT_WRITE_DEBOUNCE_MAX) {
    const oldestSubject = debounce.keys().next().value;
    if (!oldestSubject) break;
    debounce.delete(oldestSubject);
  }
}
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { forbidden, unprocessable } from "../errors.js";

export { isCloudManagedInstance } from "../services/cloud-instance.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeOptionalString(value: string | null | undefined) {
  return value?.trim() || null;
}

async function resolveLegacyRunResponsibleUserId(
  db: Db,
  input: { companyId: string; agentId: string; runId: string },
) {
  if (!isUuidLike(input.runId)) return null;
  const run = await db
    .select({ responsibleUserId: heartbeatRuns.responsibleUserId })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  return normalizeOptionalString(run?.responsibleUserId);
}

async function loadResponsibleUserMemberships(
  db: Db,
  input: { companyId: string; userId: string | null },
) {
  if (!input.userId) return [];
  const [user, memberships] = await Promise.all([
    db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, input.userId))
      .then((rows) => rows[0] ?? null),
    db
      .select({
        companyId: companyMemberships.companyId,
        membershipRole: companyMemberships.membershipRole,
        status: companyMemberships.status,
      })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, input.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, input.userId),
          eq(companyMemberships.status, "active"),
        ),
      ),
  ]);
  return user ? memberships : [];
}

/**
 * The user's own active company memberships — the exact company scope a
 * locally authenticated session actor carries. Shared by the session path
 * and the Cloud trusted-header path so both resolve the same access set.
 */
async function loadActiveUserCompanyMemberships(db: Db, userId: string) {
  return db
    .select({
      companyId: companyMemberships.companyId,
      membershipRole: companyMemberships.membershipRole,
      status: companyMemberships.status,
    })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
      ),
    );
}

async function auditAgentJwtRunHeaderMismatch(
  db: Db,
  input: { companyId: string; agentId: string; claimRunId: string; headerRunId: string; method: string; url: string },
) {
  try {
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      action: "auth.agent_jwt_run_header_mismatch",
      entityType: "heartbeat_run",
      entityId: input.claimRunId,
      ...(isUuidLike(input.agentId) ? { agentId: input.agentId } : {}),
      ...(isUuidLike(input.claimRunId) ? { runId: input.claimRunId } : {}),
      details: {
        claimRunId: input.claimRunId,
        headerRunId: input.headerRunId,
        method: input.method,
        url: input.url,
      },
    });
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId, agentId: input.agentId, claimRunId: input.claimRunId },
      "Failed to audit rejected agent JWT run header mismatch",
    );
  }
}

// Append-only authentication-event log for the board API key bearer path.
// Records every attempt -- success, expired, revoked, or an
// unrecognised token -- so a future investigation of "was this key abused"
// does not hit the same telemetry gap again: last_used_at is a single mutable
// high-water mark, and activity_log only carries successful, attributed
// business actions from 2026-08-07 onward. Never logs the token or key
// hash, only the key id (nullable for an unrecognised token).
//
// Every attacker-influenced field is length-capped at insert so the log
// cannot be used for write amplification, and UNATTRIBUTED bad_key rows are
// throttled per source: at most one row per source per
// BOARD_KEY_AUTH_EVENT_BAD_KEY_WINDOW_MS, with further attempts in the window
// counted and carried as suppressed_count on that source's NEXT row (the
// table stays append-only -- nothing is patched in place). Attributed
// outcomes (success / expired / revoked / owned bad_key) stay unthrottled:
// they are already bounded by the number of live keys.
const BOARD_KEY_AUTH_EVENT_BAD_KEY_WINDOW_MS = 60_000;
// Upper bounds for the in-memory throttle map. Sources age out after
// BOARD_KEY_AUTH_EVENT_THROTTLE_TTL_MS of silence; the hard cap bounds memory
// even if an allowlisted proxy funnels a very large number of real addresses.
const BOARD_KEY_AUTH_EVENT_THROTTLE_TTL_MS = 10 * 60_000;
const BOARD_KEY_AUTH_EVENT_THROTTLE_MAX_SOURCES = 10_000;
// Field caps. A User-Agent is attacker-chosen bytes; 256 keeps identity
// signals (curl/8.x, node, papapclip CLI) and drops banner padding. A route
// is server-defined plus a path suffix, so 512 is generous. An IP is <= 45
// chars; 64 leaves headroom for bracketed IPv6 forms.
const AUTH_EVENT_USER_AGENT_MAX = 256;
const AUTH_EVENT_ROUTE_MAX = 512;
const AUTH_EVENT_SOURCE_IP_MAX = 64;
const AUTH_EVENT_METHOD_MAX = 16;

const boardKeyAuthEventThrottle = new Map<
  string,
  { lastWriteAt: number; suppressed: number }
>();

function pruneBoardKeyAuthEventThrottle(nowMs: number) {
  for (const [source, entry] of boardKeyAuthEventThrottle) {
    if (nowMs - entry.lastWriteAt > BOARD_KEY_AUTH_EVENT_THROTTLE_TTL_MS) {
      boardKeyAuthEventThrottle.delete(source);
    }
  }
  while (boardKeyAuthEventThrottle.size > BOARD_KEY_AUTH_EVENT_THROTTLE_MAX_SOURCES) {
    // Evict the oldest window; losing the oldest suppression counter under a
    // flood is preferable to unbounded memory on the hot auth path.
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [source, entry] of boardKeyAuthEventThrottle) {
      if (entry.lastWriteAt < oldestAt) {
        oldestAt = entry.lastWriteAt;
        oldestKey = source;
      }
    }
    if (!oldestKey) break;
    boardKeyAuthEventThrottle.delete(oldestKey);
  }
}

/**
 * Decides whether an unattributed bad_key row may be written for this source
 * right now. Returns { write: true, suppressedCount } for the one row a
 * window, where suppressedCount carries the attempts suppressed since the
 * source's previous row; { write: false } inside an open window.
 */
export function admitBoardKeyAuthEventBadKey(
  source: string,
  nowMs: number,
): { write: boolean; suppressedCount: number } {
  pruneBoardKeyAuthEventThrottle(nowMs);
  const entry = boardKeyAuthEventThrottle.get(source);
  if (!entry || nowMs - entry.lastWriteAt >= BOARD_KEY_AUTH_EVENT_BAD_KEY_WINDOW_MS) {
    const suppressedCount = entry?.suppressed ?? 0;
    boardKeyAuthEventThrottle.set(source, { lastWriteAt: nowMs, suppressed: 0 });
    return { write: true, suppressedCount };
  }
  entry.suppressed += 1;
  return { write: false, suppressedCount: 0 };
}

/** Test hook: clears the module-scoped bad-key throttle state between tests. */
export function resetBoardKeyAuthEventThrottleForTests() {
  boardKeyAuthEventThrottle.clear();
}

async function recordBoardApiKeyAuthEvent(
  db: Db,
  input: {
    keyId: string | null;
    outcome: "success" | "expired" | "revoked" | "bad_key";
    req: Request;
    trustedProxies?: readonly string[];
  },
) {
  try {
    const sourceIp =
      resolveAuthEventSourceIp(input.req, input.trustedProxies ?? [])?.slice(
        0,
        AUTH_EVENT_SOURCE_IP_MAX,
      ) ?? null;
    let suppressedCount = 0;
    if (input.keyId === null && input.outcome === "bad_key" && sourceIp) {
      const admission = admitBoardKeyAuthEventBadKey(sourceIp, Date.now());
      if (!admission.write) return;
      suppressedCount = admission.suppressedCount;
    }
    await db.insert(boardApiKeyAuthEvents).values({
      keyId: input.keyId,
      outcome: input.outcome,
      sourceIp,
      userAgent: (input.req.get("user-agent") ?? "").slice(0, AUTH_EVENT_USER_AGENT_MAX) || null,
      method: input.req.method.slice(0, AUTH_EVENT_METHOD_MAX),
      route: (
        input.req.baseUrl ? `${input.req.baseUrl}${input.req.path}` : input.req.path
      ).slice(0, AUTH_EVENT_ROUTE_MAX),
      suppressedCount,
    });
  } catch (err) {
    // Fail-open on purpose: an audit-write failure must not break auth. The
    // residual risk (a full disk silently degrades the audit trail) is called
    // out in the PR description; this warn is the alert point, not just a log
    // line -- page on it.
    logger.warn({ err, keyId: input.keyId, outcome: input.outcome }, "Failed to log board API key auth event");
  }
}

async function auditAgentKeyMissingResponsibleUser(
  db: Db,
  input: { companyId: string; agentId: string; keyId: string; method: string; url: string },
) {
  try {
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      action: "auth.agent_key_missing_responsible_user",
      entityType: "agent_api_key",
      entityId: input.keyId,
      ...(isUuidLike(input.agentId) ? { agentId: input.agentId } : {}),
      details: {
        method: input.method,
        url: input.url,
      },
    });
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId, agentId: input.agentId, keyId: input.keyId },
      "Failed to audit rejected agent key without responsible user binding",
    );
  }
}

export async function auditAgentKeyExpired(
  db: Db,
  input: { companyId: string; agentId: string; keyId: string; expiresAt: Date | null; method: string; url: string },
) {
  try {
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      action: "auth.agent_key_expired",
      entityType: "agent_api_key",
      entityId: input.keyId,
      ...(isUuidLike(input.agentId) ? { agentId: input.agentId } : {}),
      details: {
        method: input.method,
        url: input.url,
        expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
      },
    });
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId, agentId: input.agentId, keyId: input.keyId },
      "Failed to audit rejected expired agent key",
    );
  }
}

interface ActorMiddlewareOptions {
  deploymentMode: DeploymentMode;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
  /**
   * Dedicated proxy IP/CIDR allowlist used ONLY to derive
   * board_api_key_auth_events.source_ip. Same operator statement as the
   * confidential-transport allowlist (CLAUDE_LOGIN_TRUSTED_PROXIES); the
   * global TRUST_PROXY setting is never read for the security log. Empty =>
   * the immediate socket peer is recorded and X-Forwarded-For is ignored.
   */
  authEventTrustedProxies?: readonly string[];
}

export function actorMiddleware(db: Db, opts: ActorMiddlewareOptions): RequestHandler {
  const boardAuth = boardAuthService(db);
  return async (req, _res, next) => {
    req.actor =
      opts.deploymentMode === "local_trusted"
        ? {
            type: "board",
            userId: "local-board",
            userName: "Local Board",
            userEmail: null,
            isInstanceAdmin: true,
            source: "local_implicit",
          }
        : { type: "none", source: "none" };

    const runIdHeader = req.header("x-paperclip-run-id");

    const authHeader = req.header("authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      if (opts.deploymentMode === "authenticated" && opts.resolveSession) {
        const cloudTenantActor = await resolveCloudTenantActor(db, req);
        if (cloudTenantActor) {
          req.actor = {
            ...cloudTenantActor,
            runId: runIdHeader ?? undefined,
          };
          next();
          return;
        }

        let session: BetterAuthSessionResult | null = null;
        try {
          session = await opts.resolveSession(req);
        } catch (err) {
          logger.warn(
            { err, method: req.method, url: req.originalUrl },
            "Failed to resolve auth session from request headers",
          );
        }
        if (session?.user?.id && session.session?.id) {
          const userId = session.user.id;
          const [roleRow, memberships] = await Promise.all([
            db
              .select({ id: instanceUserRoles.id })
              .from(instanceUserRoles)
              .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
              .then((rows) => rows[0] ?? null),
            loadActiveUserCompanyMemberships(db, userId),
          ]);
          req.actor = {
            type: "board",
            userId,
            sessionId: session.session.id,
            userName: session.user.name ?? null,
            userEmail: session.user.email ?? null,
            companyIds: memberships.map((row) => row.companyId),
            memberships,
            isInstanceAdmin: Boolean(roleRow),
            runId: runIdHeader ?? undefined,
            source: "session",
          };
          next();
          return;
        }
      }
      if (runIdHeader) req.actor.runId = runIdHeader;
      next();
      return;
    }

    const token = authHeader.slice("bearer ".length).trim();
    if (!token) {
      next();
      return;
    }

    const boardKeyLookup = await boardAuth.findBoardApiKeyForAuthEvent(token);
    if (boardKeyLookup.key) {
      const boardKey = boardKeyLookup.key;
      if (boardKeyLookup.outcome === "success") {
        const access = await boardAuth.resolveBoardAccess(boardKey.userId);
        if (access.user) {
          await boardAuth.touchBoardApiKey(boardKey.id);
          await recordBoardApiKeyAuthEvent(db, { keyId: boardKey.id, outcome: "success", req, trustedProxies: opts.authEventTrustedProxies });
          req.actor = {
            type: "board",
            userId: boardKey.userId,
            userName: access.user?.name ?? null,
            userEmail: access.user?.email ?? null,
            companyIds: access.companyIds,
            memberships: access.memberships,
            isInstanceAdmin: access.isInstanceAdmin,
            keyId: boardKey.id,
            boardKeyScope: normalizeBoardApiKeyScope(boardKey.scopeConfig),
            boardKeyExpiresAt: boardKey.expiresAt ?? null,
            runId: runIdHeader || undefined,
            source: "board_key",
          };
          next();
          return;
        }
        // Matched a live key hash but the owning user is gone -- treat as a
        // bad key for logging purposes rather than silently falling through.
        await recordBoardApiKeyAuthEvent(db, { keyId: boardKey.id, outcome: "bad_key", req, trustedProxies: opts.authEventTrustedProxies });
      } else {
        await recordBoardApiKeyAuthEvent(db, {
          keyId: boardKey.id,
          outcome: boardKeyLookup.outcome,
          req,
          trustedProxies: opts.authEventTrustedProxies,
        });
      }
    } else if (token.startsWith("pcp_board_")) {
      // Only log bad_key for tokens shaped like board keys -- other bearer
      // tokens (agent keys, JWTs) fall through to their own auth paths below
      // and should not pollute the board-key auth-event log.
      await recordBoardApiKeyAuthEvent(db, { keyId: null, outcome: "bad_key", req, trustedProxies: opts.authEventTrustedProxies });
    }

    const tokenHash = hashToken(token);
    const key = await db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
      .then((rows) => rows[0] ?? null);

    // Fail-closed expiry backstop: a key past `expiresAt` is rejected
    // even when `revokedAt` is null, so a missed manual revoke can no longer
    // leave a key usable forever. Rejected here as unauthenticated rather than
    // matched, so downstream sees `actor.type === "none"`.
    if (key && isAgentApiKeyExpired(key.expiresAt)) {
      logger.warn(
        { keyId: key.id, agentId: key.agentId, companyId: key.companyId, expiresAt: key.expiresAt },
        "Rejected expired agent API key",
      );
      await auditAgentKeyExpired(db, {
        companyId: key.companyId,
        agentId: key.agentId,
        keyId: key.id,
        expiresAt: key.expiresAt ?? null,
        method: req.method,
        url: req.originalUrl,
      });
      next();
      return;
    }

    if (!key) {
      const claims = verifyLocalAgentJwt(token);
      if (!claims) {
        next();
        return;
      }

      const agentRecord = await db
        .select()
        .from(agents)
        .where(eq(agents.id, claims.sub))
        .then((rows) => rows[0] ?? null);

      if (!agentRecord || agentRecord.companyId !== claims.company_id) {
        next();
        return;
      }

      if (agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
        next();
        return;
      }

      const normalizedRunIdHeader = normalizeOptionalString(runIdHeader);
      if (normalizedRunIdHeader && normalizedRunIdHeader !== claims.run_id) {
        await auditAgentJwtRunHeaderMismatch(db, {
          companyId: claims.company_id,
          agentId: claims.sub,
          claimRunId: claims.run_id,
          headerRunId: normalizedRunIdHeader,
          method: req.method,
          url: req.originalUrl,
        });
        next(
          unprocessable("X-Paperclip-Run-Id does not match signed agent JWT run_id", {
            code: "agent_jwt_run_id_mismatch",
            claimRunId: claims.run_id,
            headerRunId: normalizedRunIdHeader,
          }),
        );
        return;
      }

      const onBehalfOfUserId = claims.responsible_user_id !== undefined
        ? normalizeOptionalString(claims.responsible_user_id)
        : await resolveLegacyRunResponsibleUserId(db, {
            companyId: claims.company_id,
            agentId: claims.sub,
            runId: claims.run_id,
          });
      const onBehalfOfMemberships = await loadResponsibleUserMemberships(db, {
        companyId: claims.company_id,
        userId: onBehalfOfUserId,
      });

      req.actor = {
        type: "agent",
        agentId: claims.sub,
        companyId: claims.company_id,
        keyId: undefined,
        keyScope: normalizeAgentApiKeyScope(claims.key_scope),
        runId: claims.run_id,
        onBehalfOfUserId,
        onBehalfOfMemberships,
        source: "agent_jwt",
      };
      next();
      return;
    }

    await db
      .update(agentApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentApiKeys.id, key.id));

    const agentRecord = await db
      .select()
      .from(agents)
      .where(eq(agents.id, key.agentId))
      .then((rows) => rows[0] ?? null);

    if (!agentRecord || agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
      next();
      return;
    }

    const responsibleUserId = normalizeOptionalString(key.responsibleUserId);
    if (!responsibleUserId) {
      await auditAgentKeyMissingResponsibleUser(db, {
        companyId: key.companyId,
        agentId: key.agentId,
        keyId: key.id,
        method: req.method,
        url: req.originalUrl,
      });
      next(forbidden("Responsible user is unavailable for this agent key", {
        code: "RESPONSIBLE_USER_UNAVAILABLE",
      }));
      return;
    }

    req.actor = {
      type: "agent",
      agentId: key.agentId,
      companyId: key.companyId,
      keyId: key.id,
      keyScope: normalizeAgentApiKeyScope(key.scopeConfig),
      onBehalfOfUserId: responsibleUserId,
      onBehalfOfMemberships: await loadResponsibleUserMemberships(db, {
        companyId: key.companyId,
        userId: responsibleUserId,
      }),
      runId: runIdHeader || undefined,
      source: "agent_key",
    };

    next();
  };
}

/**
 * Routes a `{ kind: "plugin_ops" }` board API key is permitted to reach.
 *
 * The taxonomy is intentionally minimal — plugin lifecycle
 * (install/enable/disable/upgrade/config) plus issue read/comment so the
 * operator's CLI can still report status, plus the board-key self-service
 * surface so the scoped key can mint a successor and revoke itself. This is
 * not a general permission system.
 *
 * This list is allowlist-shaped and fail-closed: a scoped key hitting ANY route
 * not listed here gets 403 with `code: "board_key_scope_violation"`. Add a route
 * here only when a new plugin-ops flow genuinely requires it — never to "fix" a
 * 403 a regression test caught, because that 403 is the control firing.
 *
 * Path matching is against `req.path` as seen at app root (this middleware runs
 * before the `/api` mount strips the prefix), so patterns are written against
 * `/api/plugins/install`, not `/plugins/install`.
 */
const PLUGIN_OPS_ALLOWED_ROUTES: ReadonlyArray<{
  readonly method: string;
  readonly pathPattern: RegExp;
}> = [
  // --- Plugin lifecycle (the actual reason this scope exists) ---
  { method: "POST", pathPattern: /^\/api\/plugins\/install$/ },
  {
    method: "POST",
    pathPattern: /^\/api\/plugins\/[^/]+\/(?:enable|disable|upgrade|config|config\/test)$/,
  },
  { method: "GET", pathPattern: /^\/api\/plugins(?:\/[^/]+)?$/ },
  { method: "GET", pathPattern: /^\/api\/plugins\/[^/]+\/config$/ },
  { method: "GET", pathPattern: /^\/api\/plugins\/examples$/ },
  { method: "GET", pathPattern: /^\/api\/plugins\/ui-contributions$/ },

  // --- Board API key self-service (mint a successor, list, revoke) ---
  // POST /board-api-keys is allowed, but the force-inheritance branch below
  // forces any successor this key mints to inherit this key's scope (no
  // escalation).
  { method: "POST", pathPattern: /^\/api\/board-api-keys$/ },
  { method: "GET", pathPattern: /^\/api\/board-api-keys$/ },
  { method: "DELETE", pathPattern: /^\/api\/board-api-keys\/[^/]+$/ },
  { method: "POST", pathPattern: /^\/api\/cli-auth\/revoke-current$/ },

  // --- Issue read/comment (operator-readable activity surface) ---
  // Allows GETs on issue detail/list/comments/documents and posting a comment.
  // Issue create (POST /issues) and issue mutate (PATCH /issues/:id) are out
  // of scope: this is plugin_ops, not a general operator surrogate.
  { method: "GET", pathPattern: /^\/api\/issues(?:\/[^/]+)?(?:\/.*)?$/ },
  { method: "POST", pathPattern: /^\/api\/issues\/[^/]+\/comments$/ },
  { method: "GET", pathPattern: /^\/api\/companies\/[^/]+\/issues(?:\/.*)?$/ },
];

/**
 * The scope a `{ kind: "plugin_ops" }` board key forces onto any new board key
 * it mints via POST /api/board-api-keys. Without this, a scoped key could mint
 * an unscoped owner key and silently escalate; with it, scoped-ness is sticky
 * down the mint chain — a CLI using a scoped credential cannot mint an
 * unscoped owner key on this instance.
 */
const PLUGIN_OPS_FORCED_SUCCESSOR_SCOPE = { kind: "plugin_ops" } as const;

/**
 * Board-key scope enforcement. Runs after actorMiddleware, so req.actor is
 * populated. Only acts on a board API key that carries a non-standard scope —
 * every other actor source (session, local_implicit, agent_key, agent_jwt,
 * cloud_tenant, none) and every unscoped board key falls through unchanged.
 *
 * For a `{ kind: "plugin_ops" }` key: 403 with code
 * `board_key_scope_violation` unless the request matches an entry in
 * PLUGIN_OPS_ALLOWED_ROUTES. The route allowlist is the scope taxonomy made
 * literal — an allowlist-shaped predicate is the required shape here, and
 * this is that shape.
 *
 * As a side effect on POST /api/board-api-keys, the body's `scope` field is
 * force-set to the acting key's scope, so a scoped key cannot mint a wider
 * successor. This is the second half of "CLI unable to mint an unscoped
 * owner key": even if the CLI did not request plugin_ops explicitly, the
 * scoped successor inherits the acting scope.
 */
export function enforceBoardKeyScopeMiddleware(): RequestHandler {
  return (req, _res, next) => {
    const actor = req.actor;
    if (
      !actor ||
      actor.type !== "board" ||
      actor.source !== "board_key" ||
      !actor.boardKeyScope ||
      actor.boardKeyScope.kind !== "plugin_ops"
    ) {
      next();
      return;
    }

    const matched = PLUGIN_OPS_ALLOWED_ROUTES.some(
      (entry) =>
        req.method.toUpperCase() === entry.method.toUpperCase() &&
        entry.pathPattern.test(req.path),
    );
    if (!matched) {
      next(
        forbidden("Board API key scope does not permit this route", {
          code: "board_key_scope_violation",
          scope: actor.boardKeyScope.kind,
          method: req.method.toUpperCase(),
          path: req.path,
        }),
      );
      return;
    }

    // Force-inherit the acting scope on any new board key this key mints. This
    // is the server-side half of AC4: even with the CLI always requesting
    // plugin_ops, a hand-rolled client cannot mint an unscoped owner key
    // through a plugin_ops-scoped credential.
    if (
      req.method.toUpperCase() === "POST" &&
      /^\/api\/board-api-keys$/.test(req.path) &&
      req.body &&
      typeof req.body === "object"
    ) {
      req.body.scope = PLUGIN_OPS_FORCED_SUCCESSOR_SCOPE;
    }

    next();
  };
}

/**
 * Registers the actor-resolution + provenance-capture middleware pair on `app`
 * in the one order that works: `actorMiddleware` populates `req.actor`, then
 * `enforceBoardKeyScopeMiddleware` narrows a scoped board key's reachable
 * surface, then `actorProvenanceMiddleware` binds its credential provenance
 * into AsyncLocalStorage so `logActivity` records it centrally.
 *
 * Both `createApp` (production wiring) and the provenance regression test go
 * through this single function on purpose: dropping the provenance registration
 * here turns that test red instead of letting production silently write NULL
 * provenance forever — the failure mode an audit control cannot afford.
 */
export function registerActorContext(app: Application, db: Db, opts: ActorMiddlewareOptions): void {
  app.use(actorMiddleware(db, opts));
  // Must run after actorMiddleware, which is what populates req.actor. Must
  // run before route handlers so scoped-key requests never reach a route the
  // scope does not permit.
  app.use(enforceBoardKeyScopeMiddleware());
  app.use(actorProvenanceMiddleware());
}

/**
 * Whether the trusted-header actor being resolved should carry computed
 * instance-admin elevation: only the stack `owner` role elevates, and only
 * while `enableOwnerInstanceAdmin` is enabled. The flag is resolved through
 * the instance-settings service so the cloud managed-config overlay applies
 * (the harness can turn elevation off fleet-wide without touching tenant
 * DBs). Fails closed: a settings read error means no elevation.
 */
async function resolveOwnerInstanceAdmin(
  db: Db,
  stackRole: "owner" | "admin" | "member" | "support",
): Promise<boolean> {
  if (stackRole !== "owner") return false;
  try {
    const experimental = await instanceSettingsService(db).getExperimental();
    return experimental.enableOwnerInstanceAdmin === true;
  } catch (err) {
    logger.warn(
      { err },
      "Failed to resolve enableOwnerInstanceAdmin for cloud tenant owner; treating elevation as disabled",
    );
    return false;
  }
}

/**
 * Minimal header accessor `resolveCloudTenantActor` needs. Express `Request`
 * satisfies it directly; websocket upgrade paths adapt a raw
 * `IncomingMessage` with {@link cloudActorHeaderSourceFromHeaders} since
 * trusted-header authentication must work identically for upgrades — a
 * cloud-proxied browser has no local Better Auth session to fall back on.
 */
export interface CloudActorHeaderSource {
  header(name: string): string | undefined;
}

/** Adapts a raw header map (e.g. `IncomingMessage.headers`) to {@link CloudActorHeaderSource}. */
export function cloudActorHeaderSourceFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): CloudActorHeaderSource {
  return {
    header(name: string) {
      const value = headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    },
  };
}

export async function resolveCloudTenantActor(
  db: Db,
  req: CloudActorHeaderSource,
): Promise<Express.Request["actor"] | null> {
  const expectedToken = process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN?.trim();
  if (!expectedToken) return null;

  const token = req.header("x-paperclip-cloud-tenant-token")?.trim();
  if (!token || !constantTimeStringEqual(token, expectedToken)) return null;

  const userId = requiredCloudHeader(req, "x-paperclip-cloud-user-id");
  const userEmail = requiredCloudHeader(req, "x-paperclip-cloud-user-email").toLowerCase();
  const stackId = requiredCloudHeader(req, "x-paperclip-cloud-stack-id");
  const stackRole = stackMembershipRole(req.header("x-paperclip-cloud-stack-role"));
  const userName = req.header("x-paperclip-cloud-user-name")?.trim() || userEmail;
  const paperclipCompanyId = req.header("x-paperclip-cloud-paperclip-company-id")?.trim();
  const paperclipCompanyName = req
    .header("x-paperclip-cloud-paperclip-company-name")
    ?.trim();
  const companyId = cloudTenantCompanyId(stackId);
  const companyName = paperclipCompanyName || humanizeCloudStackSlug(stackId);
  const now = new Date();
  const membershipRole = stackRole === "owner" || stackRole === "admin" ? "owner" : stackRole;
  const syncFingerprint = [userEmail, userName, stackId, stackRole, paperclipCompanyId ?? ""].join(":");
  const cloudTenantWriteDebounce = cloudTenantWriteDebounceFor(db);
  pruneCloudTenantWriteDebounce(cloudTenantWriteDebounce, now.getTime());
  const previousSync = cloudTenantWriteDebounce.get(userId);
  const shouldSync = previousSync?.fingerprint !== syncFingerprint
    || previousSync.syncedAt <= now.getTime() - CLOUD_TENANT_WRITE_DEBOUNCE_MS;
  let effectiveMembership: { companyId: string; membershipRole: string | null; status: string } = {
    companyId,
    membershipRole,
    status: "active",
  };

  if (shouldSync) await db
    .insert(authUsers)
    .values({
      id: userId,
      name: userName,
      email: userEmail,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: authUsers.id,
      set: {
        name: userName,
        email: userEmail,
        emailVerified: true,
        updatedAt: now,
      },
    });

  // Earlier cloud_tenant builds granted every tenant user `instance_admin`.
  // Stale rows from those deployments would still elevate this user through
  // the BetterAuth session path, board API keys, and the authorization
  // service's own instanceUserRoles lookup — so actively purge them on every
  // trusted-header authentication instead of merely no longer inserting them.
  await db
    .delete(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")));

  if (shouldSync) await db
    .insert(companies)
    .values({
      id: companyId,
      name: companyName,
      description: `Provisioned by Paperclip Cloud for stack ${stackId}.`,
      status: "active",
      issuePrefix: issuePrefixForCloudStack(stackId),
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: companies.id,
    });

  if (shouldSync && paperclipCompanyName) {
    await repairCloudTenantCompanyName(db, {
      companyId,
      paperclipCompanyId,
      paperclipCompanyName,
      now,
    });
  }

  effectiveMembership = shouldSync ? await db
    .insert(companyMemberships)
    .values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        companyMemberships.companyId,
        companyMemberships.principalType,
        companyMemberships.principalId,
      ],
      set: {
        status: "active",
        membershipRole,
        updatedAt: now,
      },
    })
    .returning()
    .then((rows) => rows[0] ?? {
      companyId,
      membershipRole,
      status: "active",
    }) : { companyId, membershipRole, status: "active" as const };

  // Without instance-admin elevation, cloud tenant users are authorized purely
  // through company-scoped permission grants — seed the same role defaults the
  // regular membership flows create.
  if (shouldSync) await ensureHumanRoleDefaultGrants(db, {
    companyId,
    principalId: userId,
    membershipRole: effectiveMembership.membershipRole ?? membershipRole,
    grantedByUserId: null,
  });
  if (shouldSync) {
    cloudTenantWriteDebounce.delete(userId);
    cloudTenantWriteDebounce.set(userId, { fingerprint: syncFingerprint, syncedAt: Date.now() });
    pruneCloudTenantWriteDebounce(cloudTenantWriteDebounce, Date.now());
  }

  // The stack's seeded company is only where Cloud provisioned this user.
  // Companies created afterwards on the instance (imports, in-app company
  // creation) attach real membership rows for the user, so union those with
  // the pinned primary — the same active-membership scope a locally
  // authenticated session actor carries. Strictly this user's own rows; the
  // membership-creating flows seed their own permission grants, so nothing
  // needs seeding per request here. A read failure degrades to the pinned
  // primary instead of blocking authentication, mirroring the fail-closed
  // owner-elevation resolution below.
  let additionalMemberships: { companyId: string; membershipRole: string | null; status: string }[] =
    [];
  try {
    additionalMemberships = (await loadActiveUserCompanyMemberships(db, userId)).filter(
      (row) => row.companyId !== companyId,
    );
  } catch (err) {
    logger.warn(
      { err, userId, stackId },
      "Failed to load cloud tenant user's company memberships; scoping actor to the stack's primary company",
    );
  }

  return {
    type: "board",
    userId,
    userName,
    userEmail,
    companyIds: [companyId, ...additionalMemberships.map((row) => row.companyId)],
    memberships: [
      {
        companyId,
        membershipRole: effectiveMembership.membershipRole ?? membershipRole,
        status: effectiveMembership.status,
      },
      ...additionalMemberships,
    ],
    // Computed per request, never persisted: the stack owner is elevated to
    // instance admin of their own dedicated instance only while the
    // `enableOwnerInstanceAdmin` flag is on. Non-owner stack roles stay
    // company-scoped. Turning the flag off de-elevates on the next request —
    // there is no role row to clean up.
    isInstanceAdmin: await resolveOwnerInstanceAdmin(db, stackRole),
    source: "cloud_tenant",
  };
}

function requiredCloudHeader(req: CloudActorHeaderSource, name: string): string {
  const value = req.header(name)?.trim();
  if (!value) {
    throw new Error(`Missing trusted Cloud tenant header ${name}`);
  }
  return value;
}

function stackMembershipRole(value: string | undefined): "owner" | "admin" | "member" | "support" {
  if (value === "owner" || value === "admin" || value === "member" || value === "support") {
    return value;
  }
  throw new Error("Invalid trusted Cloud tenant stack role");
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function cloudTenantCompanyId(stackId: string): string {
  const bytes = createHash("sha256").update(`paperclip-cloud-tenant-company:${stackId}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function humanizeCloudStackSlug(stackId: string): string {
  const slug = stackId
    .trim()
    .replace(/^paperclip-stack-/i, "")
    .replace(/^stack-/i, "");
  const displayName = slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
  return displayName || "Workspace";
}

export function isKnownBadCloudCompanyName(
  name: string,
  ids: { companyId: string; paperclipCompanyId?: string },
): boolean {
  const normalized = name.trim();
  return (
    /^paperclip-stack-.+/i.test(normalized) ||
    /^stack-.+\s+paperclip$/i.test(normalized) ||
    normalized === ids.companyId ||
    (ids.paperclipCompanyId !== undefined &&
      normalized === ids.paperclipCompanyId)
  );
}

async function repairCloudTenantCompanyName(
  db: Db,
  input: {
    companyId: string;
    paperclipCompanyId?: string;
    paperclipCompanyName: string;
    now: Date;
  },
): Promise<void> {
  try {
    const existing = await db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .then((rows) => rows[0]);
    if (
      !existing ||
      !isKnownBadCloudCompanyName(existing.name, {
        companyId: input.companyId,
        paperclipCompanyId: input.paperclipCompanyId,
      })
    ) {
      return;
    }
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(companies)
        .set({ name: input.paperclipCompanyName, updatedAt: input.now })
        .where(
          and(
            eq(companies.id, input.companyId),
            // A user may rename the company between the read above and this
            // repair. Match the exact observed machine name so that concurrent
            // genuine renames always win.
            eq(companies.name, existing.name),
          ),
        )
        .returning({ id: companies.id });
      if (!updated) return;

      await tx.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "system",
        actorId: "cloud-tenant-auth",
        action: "company.updated",
        entityType: "company",
        entityId: input.companyId,
        details: {
          source: "cloud_tenant_auth",
          reason: "legacy_machine_name_repair",
          previousName: existing.name,
          name: input.paperclipCompanyName,
        },
      });
    });
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId },
      "Failed to repair legacy Cloud tenant company name",
    );
  }
}

function issuePrefixForCloudStack(stackId: string): string {
  const hash = createHash("sha256").update(stackId).digest("hex").slice(0, 4).toUpperCase();
  return `PC${hash}`;
}

export function requireBoard(req: Express.Request) {
  return req.actor.type === "board";
}
