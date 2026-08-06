import { createHash, timingSafeEqual } from "node:crypto";
import type { Application, Request, RequestHandler } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  heartbeatRuns,
  instanceUserRoles,
} from "@paperclipai/db";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { isUuidLike, normalizeAgentApiKeyScope, normalizeBoardApiKeyScope, type DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { actorProvenanceMiddleware } from "./actor-context.js";
import { logger } from "./logger.js";
import { boardAuthService } from "../services/board-auth.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { forbidden, unprocessable } from "../errors.js";

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

interface ActorMiddlewareOptions {
  deploymentMode: DeploymentMode;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
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
        if (session?.user?.id) {
          const userId = session.user.id;
          const [roleRow, memberships] = await Promise.all([
            db
              .select({ id: instanceUserRoles.id })
              .from(instanceUserRoles)
              .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
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
                  eq(companyMemberships.principalType, "user"),
                  eq(companyMemberships.principalId, userId),
                  eq(companyMemberships.status, "active"),
                ),
              ),
          ]);
          req.actor = {
            type: "board",
            userId,
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

    const boardKey = await boardAuth.findBoardApiKeyByToken(token);
    if (boardKey) {
      const access = await boardAuth.resolveBoardAccess(boardKey.userId);
      if (access.user) {
        await boardAuth.touchBoardApiKey(boardKey.id);
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
          runId: runIdHeader || undefined,
          source: "board_key",
        };
        next();
        return;
      }
    }

    const tokenHash = hashToken(token);
    const key = await db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
      .then((rows) => rows[0] ?? null);

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

export async function resolveCloudTenantActor(db: Db, req: Request): Promise<Express.Request["actor"] | null> {
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
  const companyId = cloudTenantCompanyId(stackId);
  const companyName = paperclipCompanyId || `${stackId} Paperclip`;
  const now = new Date();

  await db
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

  await db
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

  const membershipRole = stackRole === "owner" || stackRole === "admin" ? "owner" : stackRole;
  const membership = await db
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
    });

  // Without instance-admin elevation, cloud tenant users are authorized purely
  // through company-scoped permission grants — seed the same role defaults the
  // regular membership flows create.
  await ensureHumanRoleDefaultGrants(db, {
    companyId,
    principalId: userId,
    membershipRole: membership.membershipRole,
    grantedByUserId: null,
  });

  return {
    type: "board",
    userId,
    userName,
    userEmail,
    companyIds: [companyId],
    memberships: [{
      companyId,
      membershipRole: membership.membershipRole,
      status: membership.status,
    }],
    isInstanceAdmin: false,
    source: "cloud_tenant",
  };
}

function requiredCloudHeader(req: Request, name: string): string {
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

function issuePrefixForCloudStack(stackId: string): string {
  const hash = createHash("sha256").update(stackId).digest("hex").slice(0, 4).toUpperCase();
  return `PC${hash}`;
}

export function requireBoard(req: Express.Request) {
  return req.actor.type === "board";
}
