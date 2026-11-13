import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { updateInboxAgentPolicySchema } from "@paperclipai/shared";
import { forbidden, notFound, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, inboxAgentPolicyService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Routes for a company user's "inbox agent policy" — which agents may act
 * on their inbox items on their behalf.
 *
 * - `GET/PUT .../users/me/inbox-agent-policy` are self-service: any
 *   signed-in board user with company access may read or set their own
 *   policy.
 * - `GET/PUT .../users/:userId/inbox-agent-policy` are admin routes for
 *   another user's policy: require `users:manage_permissions` (or
 *   instance-admin/local-implicit) and that the target user has an active
 *   company membership.
 *
 * Every write logs an `activity_log` row recording the previous and new
 * policy mode and allowed-agent list.
 */
export function inboxAgentPolicyRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const policies = inboxAgentPolicyService(db);

  function selfUserId(req: Request) {
    if (req.actor.type !== "board" || !req.actor.userId) throw unauthorized("Board user context required");
    return req.actor.userId;
  }

  async function assertAdmin(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      if (!req.actor.userId) throw unauthorized("Board user context required");
      if (await access.canUser(companyId, req.actor.userId, "users:manage_permissions")) return;
    } else if (
      req.actor.type === "agent"
      && req.actor.agentId
      && await access.hasPermission(companyId, "agent", req.actor.agentId, "users:manage_permissions")
    ) {
      return;
    }
    throw forbidden("Inbox agent policy administration authority required", {
      code: "inbox_agent_policy_admin_required",
    });
  }

  async function assertActiveUserMembership(companyId: string, userId: string) {
    const membership = await access.getMembership(companyId, "user", userId);
    if (!membership || membership.status !== "active") {
      throw notFound("Active company user membership not found");
    }
  }

  async function writePolicy(req: Request, companyId: string, userId: string) {
    const previous = await policies.get(companyId, userId);
    const policy = await policies.update(companyId, userId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "inbox.agent_policy_updated",
      entityType: "user_inbox_agent_policy",
      entityId: userId,
      details: {
        userId,
        previousMode: previous.mode,
        mode: policy.mode,
        allowedAgentIds: policy.allowedAgentIds,
      },
    });
    return policy;
  }

  router.get("/companies/:companyId/users/me/inbox-agent-policy", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await policies.get(companyId, selfUserId(req)));
  });

  router.put(
    "/companies/:companyId/users/me/inbox-agent-policy",
    validate(updateInboxAgentPolicySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.json(await writePolicy(req, companyId, selfUserId(req)));
    },
  );

  router.get("/companies/:companyId/users/:userId/inbox-agent-policy", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = req.params.userId as string;
    await assertAdmin(req, companyId);
    await assertActiveUserMembership(companyId, userId);
    res.json(await policies.get(companyId, userId));
  });

  router.put(
    "/companies/:companyId/users/:userId/inbox-agent-policy",
    validate(updateInboxAgentPolicySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = req.params.userId as string;
      await assertAdmin(req, companyId);
      await assertActiveUserMembership(companyId, userId);
      res.json(await writePolicy(req, companyId, userId));
    },
  );

  return router;
}
