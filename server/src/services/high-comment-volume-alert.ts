import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { clampIssueRequestDepth } from "@paperclipai/shared";
import {
  agents,
  companies,
  issueComments,
  issues,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { budgetService } from "./budgets.js";
import { issueService } from "./issues.js";
import {
  recoveryAssigneeAdapterOverrides,
  withRecoveryModelProfileHint,
} from "./recovery/model-profile-hint.js";
import { RECOVERY_ORIGIN_KINDS } from "./recovery/origins.js";

/**
 * Fork high-comment-volume alert monitor.
 *
 * Originally built inside the productivity-review service; upstream removed the
 * automatic productivity-review feature in v2026.916.0 (commit "refactor: remove
 * automatic productivity reviews"), so this module carries the alert monitor
 * forward standalone. It scans issue_comments per company, and when an issue's
 * comment count crosses the configured threshold it files a high-priority child
 * issue assigned to a resolvable owner agent (source assignee's manager, the
 * creating agent, or the first invokable CTO/CEO) and wakes them.
 */

export const HIGH_COMMENT_VOLUME_ALERT_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.highCommentVolumeAlert;
export const HIGH_COMMENT_VOLUME_ALERT_THRESHOLD_ENV = "HIGH_COMMENT_VOLUME_ALERT_THRESHOLD";
export const DEFAULT_HIGH_COMMENT_VOLUME_ALERT_THRESHOLD = 500;

const MAX_CANDIDATE_ISSUES = 250;

type IssueRow = typeof issues.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

type EnqueueWakeup = (
  agentId: string,
  opts?: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<unknown | null>;

function readPositiveInteger(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function highCommentVolumeAlertFingerprint(sourceIssueId: string) {
  return `high-comment-volume-alert:${sourceIssueId}`;
}

export function highCommentVolumeAlertService(
  db: Db,
  deps?: { enqueueWakeup?: EnqueueWakeup; env?: Record<string, string | undefined> },
) {
  const issuesSvc = issueService(db);
  const budgets = budgetService(db);
  const env = deps?.env ?? process.env;

  function isAgentInvokable(agent: AgentRow | null | undefined) {
    return Boolean(
      agent && !["paused", "terminated", "pending_approval"].includes(agent.status),
    );
  }

  function resolveHighCommentVolumeThreshold(override?: number) {
    if (override !== undefined) {
      return readPositiveInteger(override, DEFAULT_HIGH_COMMENT_VOLUME_ALERT_THRESHOLD);
    }
    const raw = Number(env[HIGH_COMMENT_VOLUME_ALERT_THRESHOLD_ENV]);
    return readPositiveInteger(raw, DEFAULT_HIGH_COMMENT_VOLUME_ALERT_THRESHOLD);
  }

  async function getCompanyIssuePrefix(companyId: string) {
    return db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.issuePrefix ?? "PAP");
  }

  async function getAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function findExistingHighCommentVolumeAlert(companyId: string, sourceIssueId: string) {
    return db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, HIGH_COMMENT_VOLUME_ALERT_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          isNull(issues.hiddenAt),
          sql`${issues.status} <> 'cancelled'`,
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function resolveAlertOwnerAgentId(sourceIssue: IssueRow) {
    const candidateIds: string[] = [];
    if (sourceIssue.assigneeAgentId) {
      const assignee = await getAgent(sourceIssue.assigneeAgentId);
      if (assignee?.reportsTo) candidateIds.push(assignee.reportsTo);
    }
    if (sourceIssue.createdByAgentId) candidateIds.push(sourceIssue.createdByAgentId);
    const roleCandidates = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, sourceIssue.companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, agents.createdAt, agents.id);
    candidateIds.push(...roleCandidates.map((agent) => agent.id));

    const seen = new Set<string>();
    for (const agentId of candidateIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const candidate = await getAgent(agentId);
      if (!candidate || candidate.companyId !== sourceIssue.companyId || !isAgentInvokable(candidate)) continue;
      const budgetBlock = await budgets.getInvocationBlock(sourceIssue.companyId, candidate.id, {
        issueId: sourceIssue.id,
        projectId: sourceIssue.projectId ?? null,
      });
      if (!budgetBlock) return candidate.id;
    }
    return null;
  }

  function buildHighCommentVolumeAlertMarkdown(
    sourceIssue: IssueRow,
    commentCount: number,
    threshold: number,
    prefix: string,
    now: Date,
  ) {
    return [
      "Paperclip detected an issue whose comment volume has crossed the high-volume alert threshold.",
      "",
      `- **Source issue**: ${sourceIssue.identifier ?? sourceIssue.title} (${prefix})`,
      `- **Comment count**: ${commentCount} (threshold: ${threshold})`,
      `- **Detected at**: ${now.toISOString()}`,
      "",
      "Suggested owner actions:",
      "- Skim the thread and summarize the state in one comment, then steer follow-up to a focused child issue.",
      "- If the thread is being used as a chat channel, move the conversation to a dedicated issue and close the loop here.",
      "- If a run is looping on this issue, consider pausing the assignee until the thread is triaged.",
    ].join("\n");
  }

  async function createHighCommentVolumeAlert(
    sourceIssue: IssueRow,
    commentCount: number,
    threshold: number,
    prefix: string,
    now: Date,
  ) {
    const ownerAgentId = await resolveAlertOwnerAgentId(sourceIssue);
    let alert: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      alert = await issuesSvc.create(sourceIssue.companyId, {
        title: `High comment volume on ${sourceIssue.identifier ?? sourceIssue.title}`,
        description: buildHighCommentVolumeAlertMarkdown(sourceIssue, commentCount, threshold, prefix, now),
        status: "todo",
        priority: "high",
        parentId: sourceIssue.id,
        projectId: sourceIssue.projectId,
        goalId: sourceIssue.goalId,
        billingCode: sourceIssue.billingCode,
        assigneeAgentId: ownerAgentId,
        assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides("status_only"),
        originKind: HIGH_COMMENT_VOLUME_ALERT_ORIGIN_KIND,
        originId: sourceIssue.id,
        originFingerprint: highCommentVolumeAlertFingerprint(sourceIssue.id),
        requestDepth: clampIssueRequestDepth(sourceIssue.requestDepth + 1),
      });
    } catch (error) {
      // Tolerate a race: if a concurrent tick already filed the alert, treat as existing.
      const raced = await findExistingHighCommentVolumeAlert(sourceIssue.companyId, sourceIssue.id);
      if (raced) return { kind: "existing" as const, alertIssueId: raced.id };
      throw error;
    }

    await logActivity(db, {
      companyId: sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.high_comment_volume_alert_created",
      entityType: "issue",
      entityId: alert.id,
      agentId: ownerAgentId,
      details: {
        source: "high_comment_volume_alert.reconcile",
        sourceIssueId: sourceIssue.id,
        commentCount,
        threshold,
      },
    });

    if (ownerAgentId && deps?.enqueueWakeup) {
      await deps.enqueueWakeup(ownerAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: withRecoveryModelProfileHint(
          { issueId: alert.id, sourceIssueId: sourceIssue.id, commentCount, threshold },
          "status_only",
        ),
        requestedByActorType: "system",
        requestedByActorId: "high_comment_volume_alert",
        contextSnapshot: withRecoveryModelProfileHint(
          {
            issueId: alert.id,
            taskId: alert.id,
            wakeReason: "issue_assigned",
            source: HIGH_COMMENT_VOLUME_ALERT_ORIGIN_KIND,
            sourceIssueId: sourceIssue.id,
          },
          "status_only",
        ),
      });
    }

    return { kind: "created" as const, alertIssueId: alert.id };
  }

  async function reconcileHighCommentVolumeAlerts(opts?: {
    now?: Date;
    companyId?: string;
    threshold?: number;
  }) {
    const now = opts?.now ?? new Date();
    const threshold = resolveHighCommentVolumeThreshold(opts?.threshold);

    // Cheap COUNT/GROUP BY over issue_comments: one row per offending issue,
    // never a per-issue N+1 scan.
    const offenders = await db
      .select({
        companyId: issueComments.companyId,
        issueId: issueComments.issueId,
        commentCount: sql<number>`count(*)::int`,
      })
      .from(issueComments)
      .where(opts?.companyId ? eq(issueComments.companyId, opts.companyId) : undefined)
      .groupBy(issueComments.companyId, issueComments.issueId)
      .having(sql`count(*) > ${threshold}`)
      .orderBy(desc(sql`count(*)`))
      .limit(MAX_CANDIDATE_ISSUES);

    const result = {
      threshold,
      scanned: offenders.length,
      alerted: 0,
      existing: 0,
      skipped: 0,
      failed: 0,
      alertIssueIds: [] as string[],
      failedIssueIds: [] as string[],
    };

    const prefixCache = new Map<string, string>();
    for (const offender of offenders) {
      try {
        const sourceIssue = await db
          .select()
          .from(issues)
          .where(and(eq(issues.companyId, offender.companyId), eq(issues.id, offender.issueId)))
          .then((rows) => rows[0] ?? null);
        // Never raise a high-comment alert about a missing/hidden issue, and
        // never about an alert issue itself (avoids meta comment loops).
        if (
          !sourceIssue ||
          sourceIssue.hiddenAt ||
          sourceIssue.originKind === HIGH_COMMENT_VOLUME_ALERT_ORIGIN_KIND
        ) {
          result.skipped += 1;
          continue;
        }
        const existing = await findExistingHighCommentVolumeAlert(offender.companyId, offender.issueId);
        if (existing) {
          result.existing += 1;
          continue;
        }
        let prefix = prefixCache.get(offender.companyId);
        if (!prefix) {
          prefix = await getCompanyIssuePrefix(offender.companyId);
          prefixCache.set(offender.companyId, prefix);
        }
        const outcome = await createHighCommentVolumeAlert(
          sourceIssue,
          offender.commentCount,
          threshold,
          prefix,
          now,
        );
        if (outcome.kind === "created") {
          result.alerted += 1;
          result.alertIssueIds.push(outcome.alertIssueId);
        } else {
          result.existing += 1;
        }
      } catch (err) {
        result.failed += 1;
        result.failedIssueIds.push(offender.issueId);
        logger.warn(
          { err, companyId: offender.companyId, issueId: offender.issueId },
          "high comment volume alert reconciliation skipped issue",
        );
      }
    }

    return result;
  }

  return {
    reconcileHighCommentVolumeAlerts,
  };
}
