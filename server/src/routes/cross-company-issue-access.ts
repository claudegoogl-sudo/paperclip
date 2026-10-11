import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, principalPermissionGrants } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Cross-company issue access (double key).
 *
 * An agent may act on an issue that belongs to a company other than its
 * home company only when ALL of these hold:
 *   1. actor.type === "agent" (board users and plugins keep their own paths);
 *   2. no responsible user (`onBehalfOfUserId`) is attached to the request;
 *   3. the agent id is listed in PAPERCLIP_CROSS_COMPANY_ISSUE_AGENT_IDS
 *      (exact UUID match; empty/absent = feature off);
 *   4. a `issues:cross_company_access` grant row exists for the agent in its
 *      HOME company (read on every request, no cache, so revocation is
 *      effective on the next request);
 *   5. the actor is not low-trust (checked by the caller-supplied predicate);
 *   6. the target company is active (not archived/paused).
 *
 * `hasCompanyAccess` / `assertCompanyAccess` are intentionally unchanged.
 * This helper is called only from the four issue routes that support
 * cross-company access: GET issue, GET comments, POST comment, PATCH issue.
 */

export const CROSS_COMPANY_ISSUE_PERMISSION = "issues:cross_company_access" as const;
export const CROSS_COMPANY_ISSUE_ENV = "PAPERCLIP_CROSS_COMPANY_ISSUE_AGENT_IDS";

export type CrossCompanyIssueOp = "issue.read" | "comments.list" | "comment.create" | "issue.update";

export type CrossCompanyDenyReason =
  | "not_agent"
  | "on_behalf_of_user"
  | "not_allowlisted"
  | "no_grant"
  | "low_trust"
  | "target_company_inactive"
  | "same_company"
  | "scoped_key";

export type CrossCompanyDecision =
  | { allowed: true; homeCompanyId: string; agentId: string }
  | { allowed: false; reason: CrossCompanyDenyReason };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCrossCompanyAllowlist(raw: string | undefined | null): ReadonlySet<string> {
  if (!raw) return new Set();
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (UUID_RE.test(id)) out.add(id);
  }
  return out;
}

let bootAllowlist: ReadonlySet<string> | null = null;

/** Allowlist is parsed once per process (boot). Tests may reset it. */
export function getCrossCompanyAllowlist(): ReadonlySet<string> {
  if (!bootAllowlist) bootAllowlist = parseCrossCompanyAllowlist(process.env[CROSS_COMPANY_ISSUE_ENV]);
  return bootAllowlist;
}

export function resetCrossCompanyAllowlistForTests(): void {
  bootAllowlist = null;
}

export interface CrossCompanyDeps {
  hasHomeGrant(homeCompanyId: string, agentId: string): Promise<boolean>;
  isTargetCompanyActive(companyId: string): Promise<boolean>;
  isLowTrust(req: Request, targetCompanyId: string): Promise<boolean>;
  allowlist?: () => ReadonlySet<string>;
}

export function dbCrossCompanyDeps(
  db: Db,
  isLowTrust: CrossCompanyDeps["isLowTrust"],
): CrossCompanyDeps {
  return {
    async hasHomeGrant(homeCompanyId, agentId) {
      const rows = await db
        .select({ id: principalPermissionGrants.id })
        .from(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, homeCompanyId),
            eq(principalPermissionGrants.principalType, "agent"),
            eq(principalPermissionGrants.principalId, agentId),
            eq(principalPermissionGrants.permissionKey, CROSS_COMPANY_ISSUE_PERMISSION),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
    async isTargetCompanyActive(companyId) {
      const rows = await db
        .select({ status: companies.status })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      return rows[0]?.status === "active";
    },
    isLowTrust,
  };
}

export async function decideCrossCompanyIssueAccess(
  req: Request,
  targetCompanyId: string,
  op: CrossCompanyIssueOp,
  deps: CrossCompanyDeps,
): Promise<CrossCompanyDecision> {
  const actor = req.actor;
  let decision: CrossCompanyDecision;
  if (actor.type !== "agent" || !actor.agentId || !actor.companyId) {
    decision = { allowed: false, reason: "not_agent" };
  } else if (actor.companyId === targetCompanyId) {
    decision = { allowed: false, reason: "same_company" };
  } else if (actor.keyScope) {
    // notify_only / skill_test / task_bridge keys are narrowed on purpose.
    decision = { allowed: false, reason: "scoped_key" };
  } else if (actor.onBehalfOfUserId?.trim()) {
    decision = { allowed: false, reason: "on_behalf_of_user" };
  } else if (!(deps.allowlist ?? getCrossCompanyAllowlist)().has(actor.agentId.toLowerCase())) {
    decision = { allowed: false, reason: "not_allowlisted" };
  } else if (!(await deps.hasHomeGrant(actor.companyId, actor.agentId))) {
    decision = { allowed: false, reason: "no_grant" };
  } else if (!(await deps.isTargetCompanyActive(targetCompanyId))) {
    decision = { allowed: false, reason: "target_company_inactive" };
  } else if (await deps.isLowTrust(req, targetCompanyId)) {
    decision = { allowed: false, reason: "low_trust" };
  } else {
    decision = { allowed: true, homeCompanyId: actor.companyId, agentId: actor.agentId };
  }
  if (actor.type === "agent" && decision.allowed === false && decision.reason !== "same_company" && decision.reason !== "not_allowlisted") {
    // Denies for allowlisted-but-incomplete or excluded actors are logged; the
    // common "ordinary agent touched a foreign id" case stays quiet.
    logger.info(
      { op, agentId: actor.agentId, homeCompanyId: actor.companyId, targetCompanyId, reason: decision.reason },
      "issue.cross_company_access denied",
    );
  }
  return decision;
}

export interface CrossCompanyAuditInput {
  targetCompanyId: string;
  homeCompanyId: string;
  agentId: string;
  runId: string | null;
  issueId: string;
  op: CrossCompanyIssueOp;
  method: string;
  route: string;
  outcome: "allowed" | "denied";
  reason?: string;
  changedFields?: string[];
}

/**
 * M9: one row in the TARGET company and one mirror row in the HOME company.
 * Field NAMES only, never values.
 */
export async function recordCrossCompanyIssueAccess(
  log: (row: {
    companyId: string;
    actorType: "agent";
    actorId: string;
    agentId: string;
    runId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown>;
  }) => Promise<unknown>,
  input: CrossCompanyAuditInput,
): Promise<void> {
  const details = {
    outcome: input.outcome,
    op: input.op,
    method: input.method,
    route: input.route,
    issueId: input.issueId,
    targetCompanyId: input.targetCompanyId,
    homeCompanyId: input.homeCompanyId,
    reason: input.reason ?? null,
    changedFields: input.changedFields ?? [],
  };
  for (const [companyId, mirror] of [[input.targetCompanyId, false], [input.homeCompanyId, true]] as const) {
    await log({
      companyId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      runId: input.runId,
      action: "issue.cross_company_access",
      entityType: "issue",
      entityId: input.issueId,
      details: { ...details, mirror },
    });
  }
  logger.info({ ...details, agentId: input.agentId, runId: input.runId }, "issue.cross_company_access");
}
