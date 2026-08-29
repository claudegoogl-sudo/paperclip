import { and, asc, desc, eq, gt, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { clampIssueRequestDepth, TERMINAL_HEARTBEAT_RUN_STATUSES } from "@paperclipai/shared";
import {
  activityLog,
  agents,
  companies,
  costEvents,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { budgetService } from "./budgets.js";
import { issueService } from "./issues.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import {
  recoveryAssigneeAdapterOverrides,
  withRecoveryModelProfileHint,
} from "./recovery/model-profile-hint.js";
import { RECOVERY_ORIGIN_KINDS } from "./recovery/origins.js";
import { isStandbyWakeTargetIssue } from "./recovery/successful-run-handoff.js";
import {
  isProviderAdmissionFailureRun,
  notProviderAdmissionFailureCondition,
} from "./provider-admission-failure.js";

export const PRODUCTIVITY_REVIEW_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.issueProductivityReview;
export const HIGH_COMMENT_VOLUME_ALERT_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.highCommentVolumeAlert;
export const PRODUCTIVITY_REVIEW_ENABLED_ENV = "PRODUCTIVITY_REVIEW_ENABLED";
export const HIGH_COMMENT_VOLUME_ALERT_THRESHOLD_ENV = "HIGH_COMMENT_VOLUME_ALERT_THRESHOLD";
export const DEFAULT_HIGH_COMMENT_VOLUME_ALERT_THRESHOLD = 500;
export const DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS = 10;
export const DEFAULT_PRODUCTIVITY_REVIEW_LONG_ACTIVE_HOURS = 6;
export const DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY = 10;
export const DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS = 30;
export const DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS = 3;
export const DEFAULT_PRODUCTIVITY_REVIEW_CREATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PRODUCTIVITY_REVIEW_MAX_CREATIONS_PER_WINDOW = 1;
export const DEFAULT_PRODUCTIVITY_REVIEW_MAX_CONSECUTIVE_NO_ACTION_REVIEWS = 3;

// Fork: derive from the shared heartbeat-run status model ("succeeded_dirty"
// stays terminal/successful) and union upstream's "interrupted" status, which
// is likewise terminal (non-live) for review staleness purposes.
const TERMINAL_RUN_STATUSES = [...TERMINAL_HEARTBEAT_RUN_STATUSES, "interrupted"] as const;
const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const MAX_CANDIDATE_ISSUES = 250;
const MAX_RUNS_FOR_STREAK = 100;
const MAX_PARENT_WALK_DEPTH = 25;
export const PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX = "Productivity review evidence refreshed.";

type IssueRow = typeof issues.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
// Evidence only reads these run fields; selecting the full row detoasts
// result_json/context_snapshot for up to MAX_RUNS_FOR_STREAK runs per issue.
type ProductivityRunSample = Pick<
  HeartbeatRunRow,
  "id" | "agentId" | "status" | "livenessState" | "createdAt" | "nextAction" | "usageJson"
>;
type ProductivityReviewTrigger = "no_comment_streak" | "long_active_duration" | "high_churn";

type ProductivityReviewThresholds = {
  noCommentStreakRuns: number;
  longActiveMs: number;
  highChurnHourly: number;
  highChurnSixHours: number;
  resolvedSnoozeMs: number;
  refreshIntervalMs: number;
  maxRefreshComments: number;
  creationWindowMs: number;
  maxCreationsPerWindow: number;
  maxConsecutiveNoActionReviews: number;
};

type ProductivityReviewEvidence = {
  trigger: ProductivityReviewTrigger;
  triggerReasons: string[];
  sourceIssue: IssueRow;
  sourceAgent: AgentRow;
  noCommentStreak: number;
  totalRunCount: number;
  terminalRunCount: number;
  activeRunCount: number;
  providerAdmissionFailureCount: number;
  runCountLastHour: number;
  runCountLastSixHours: number;
  commentCount: number;
  commentCountLastHour: number;
  commentCountLastSixHours: number;
  elapsedMs: number | null;
  latestRuns: ProductivityRunSample[];
  latestComments: Array<typeof issueComments.$inferSelect>;
  costCents: number;
  usageSamples: Array<{ runId: string; usageJson: Record<string, unknown> | null }>;
  nextAction: string | null;
  thresholds: ProductivityReviewThresholds;
  generatedAt: Date;
};

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

function productivityReviewFingerprint(sourceIssueId: string) {
  return `productivity-review:${sourceIssueId}`;
}

function highCommentVolumeAlertFingerprint(sourceIssueId: string) {
  return `high-comment-volume-alert:${sourceIssueId}`;
}

// Log the kill-switch suppression at most once per process so a disabled
// productivity reviewer does not spam a line every heartbeat tick (~30s).
let productivityReviewSuppressionLogged = false;

function issueRunScopeSql(issueId: string) {
  return sql`(
    ${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}
    or ${heartbeatRuns.contextSnapshot}->>'taskId' = ${issueId}
    or ${heartbeatRuns.contextSnapshot}->>'taskKey' = ${issueId}
  )`;
}

function msToHuman(ms: number | null) {
  if (ms === null) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  return `${hours}h ${minutes % 60}m`;
}

function issueUiLink(issue: { identifier: string | null; id: string }, prefix: string) {
  const label = issue.identifier ?? issue.id;
  return `[${label}](/${prefix}/issues/${label})`;
}

function runUiLink(run: { id: string; agentId: string }, prefix: string) {
  return `[${run.id}](/${prefix}/agents/${run.agentId}/runs/${run.id})`;
}

function truncateInline(value: string | null | undefined, max = 260) {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 3)}...`;
}

function readPositiveInteger(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function coerceDate(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function buildThresholds(overrides?: Partial<ProductivityReviewThresholds>): ProductivityReviewThresholds {
  return {
    noCommentStreakRuns: readPositiveInteger(
      overrides?.noCommentStreakRuns ?? DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
    ),
    longActiveMs: readPositiveInteger(
      overrides?.longActiveMs ?? DEFAULT_PRODUCTIVITY_REVIEW_LONG_ACTIVE_HOURS * 60 * 60 * 1000,
      DEFAULT_PRODUCTIVITY_REVIEW_LONG_ACTIVE_HOURS * 60 * 60 * 1000,
    ),
    highChurnHourly: readPositiveInteger(
      overrides?.highChurnHourly ?? DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY,
      DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY,
    ),
    highChurnSixHours: readPositiveInteger(
      overrides?.highChurnSixHours ?? DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS,
      DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS,
    ),
    resolvedSnoozeMs: readPositiveInteger(
      overrides?.resolvedSnoozeMs ?? DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS,
      DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS,
    ),
    refreshIntervalMs: readPositiveInteger(
      overrides?.refreshIntervalMs ?? DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS,
      DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS,
    ),
    maxRefreshComments: readPositiveInteger(
      overrides?.maxRefreshComments ?? DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS,
      DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS,
    ),
    creationWindowMs: readPositiveInteger(
      overrides?.creationWindowMs ?? DEFAULT_PRODUCTIVITY_REVIEW_CREATION_WINDOW_MS,
      DEFAULT_PRODUCTIVITY_REVIEW_CREATION_WINDOW_MS,
    ),
    maxCreationsPerWindow: readPositiveInteger(
      overrides?.maxCreationsPerWindow ?? DEFAULT_PRODUCTIVITY_REVIEW_MAX_CREATIONS_PER_WINDOW,
      DEFAULT_PRODUCTIVITY_REVIEW_MAX_CREATIONS_PER_WINDOW,
    ),
    maxConsecutiveNoActionReviews: readPositiveInteger(
      overrides?.maxConsecutiveNoActionReviews ?? DEFAULT_PRODUCTIVITY_REVIEW_MAX_CONSECUTIVE_NO_ACTION_REVIEWS,
      DEFAULT_PRODUCTIVITY_REVIEW_MAX_CONSECUTIVE_NO_ACTION_REVIEWS,
    ),
  };
}

function choosePrimaryTrigger(input: {
  noComment: boolean;
  longActive: boolean;
  highChurn: boolean;
}): ProductivityReviewTrigger | null {
  if (input.noComment) return "no_comment_streak";
  if (input.highChurn) return "high_churn";
  if (input.longActive) return "long_active_duration";
  return null;
}

function isSoftStopTrigger(trigger: ProductivityReviewTrigger) {
  return trigger === "no_comment_streak" || trigger === "high_churn";
}

function formatTrigger(trigger: ProductivityReviewTrigger) {
  if (trigger === "no_comment_streak") return "No-comment streak";
  if (trigger === "high_churn") return "High churn";
  return "Long active duration";
}

export function productivityReviewService(
  db: Db,
  deps?: { enqueueWakeup?: EnqueueWakeup; env?: Record<string, string | undefined> },
) {
  const issuesSvc = issueService(db);
  const budgets = budgetService(db);
  const env = deps?.env ?? process.env;

  function isProductivityReviewEnabled() {
    return env[PRODUCTIVITY_REVIEW_ENABLED_ENV] !== "false";
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

  function isAgentInvokable(agent: AgentRow | null | undefined) {
    return Boolean(agent && !["paused", "terminated", "pending_approval"].includes(agent.status));
  }

  async function isProductivityReviewDescendant(issue: Pick<IssueRow, "companyId" | "parentId">) {
    let parentId = issue.parentId;
    let depth = 0;
    while (parentId && depth < MAX_PARENT_WALK_DEPTH) {
      const parent = await db
        .select({ id: issues.id, parentId: issues.parentId, originKind: issues.originKind })
        .from(issues)
        .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, parentId)))
        .then((rows) => rows[0] ?? null);
      if (!parent) return false;
      if (parent.originKind === PRODUCTIVITY_REVIEW_ORIGIN_KIND) return true;
      parentId = parent.parentId;
      depth += 1;
    }
    return false;
  }

  async function findOpenProductivityReview(companyId: string, sourceIssueId: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function findRecentTerminalProductivityReview(
    companyId: string,
    sourceIssueId: string,
    thresholds: ProductivityReviewThresholds,
    now: Date,
  ) {
    const cutoff = new Date(now.getTime() - thresholds.resolvedSnoozeMs);
    return db
      .select({ id: issues.id, identifier: issues.identifier, status: issues.status, updatedAt: issues.updatedAt })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          inArray(issues.status, ["done", "cancelled"]),
          gt(issues.updatedAt, cutoff),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function countRecentProductivityReviews(
    companyId: string,
    sourceIssueId: string,
    thresholds: ProductivityReviewThresholds,
    now: Date,
  ) {
    const cutoff = new Date(now.getTime() - thresholds.creationWindowMs);
    return db
      .select({ count: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          visibleIssueCondition(),
          sql`${issues.status} <> 'cancelled'`,
          sql`${issues.createdAt} >= ${cutoff.toISOString()}::timestamptz`,
        ),
      )
      .then((rows) => Number(rows[0]?.count ?? 0));
  }

  async function countConsecutiveNoActionProductivityReviews(
    companyId: string,
    sourceIssueId: string,
    thresholds: ProductivityReviewThresholds,
  ) {
    const completedReviews = await db
      .select({
        createdAt: issues.createdAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          eq(issues.status, "done"),
          visibleIssueCondition(),
        ),
      )
      .orderBy(desc(issues.createdAt), desc(issues.id))
      .limit(thresholds.maxConsecutiveNoActionReviews);

    const earliestReviewCreatedAt = completedReviews.at(-1)?.createdAt;
    if (!earliestReviewCreatedAt) return 0;
    const sourceActions = await db
      .select({ createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, sourceIssueId),
          gte(activityLog.createdAt, earliestReviewCreatedAt),
        ),
      );

    let streak = 0;
    for (const [index, review] of completedReviews.entries()) {
      const nextNewerReviewCreatedAt = completedReviews[index - 1]?.createdAt ?? null;
      const sourceAction = sourceActions.some((activity) => {
        if (activity.createdAt < review.createdAt) return false;
        return !nextNewerReviewCreatedAt || activity.createdAt < nextNewerReviewCreatedAt;
      });
      if (sourceAction) break;
      streak += 1;
    }
    return streak;
  }

  async function getRefreshCommentState(companyId: string, reviewIssueId: string) {
    return db
      .select({
        count: sql<number>`count(*)::int`,
        latestCreatedAt: sql<Date | null>`max(${issueComments.createdAt})`,
      })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          eq(issueComments.issueId, reviewIssueId),
          sql`${issueComments.body} like ${`${PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX}%`}`,
        ),
      )
      .then((rows) => {
        const row = rows[0];
        return {
          count: Number(row?.count ?? 0),
          latestCreatedAt: coerceDate(row?.latestCreatedAt),
        };
      });
  }

  async function addRefreshComment(
    reviewIssueId: string,
    body: string,
    generatedAt: Date,
  ) {
    const comment = await issuesSvc.addComment(reviewIssueId, body, {});
    await db
      .update(issueComments)
      .set({ createdAt: generatedAt, updatedAt: generatedAt })
      .where(eq(issueComments.id, comment.id));
    await db
      .update(issues)
      .set({ updatedAt: generatedAt })
      .where(eq(issues.id, reviewIssueId));
    return comment;
  }

  async function countIssueRunsSince(companyId: string, agentId: string, issueId: string, since: Date) {
    return db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          issueRunScopeSql(issueId),
          sql`coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) >= ${since.toISOString()}::timestamptz`,
          notProviderAdmissionFailureCondition(),
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);
  }

  async function countIssueCommentsSince(companyId: string, issueId: string, agentId: string, since?: Date) {
    return db
      .select({ count: sql<number>`count(*)::int` })
      .from(issueComments)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, issueComments.createdByRunId))
      .where(
        and(
          eq(issueComments.companyId, companyId),
          eq(issueComments.issueId, issueId),
          eq(issueComments.authorAgentId, agentId),
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          issueRunScopeSql(issueId),
          since ? sql`${issueComments.createdAt} >= ${since.toISOString()}::timestamptz` : undefined,
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);
  }

  async function collectEvidence(
    sourceIssue: IssueRow,
    sourceAgent: AgentRow,
    thresholds: ProductivityReviewThresholds,
    now: Date,
  ): Promise<ProductivityReviewEvidence | null> {
    // Standby wake targets (executionPolicy.standbyWakeTarget=true)
    // are designed to sit `in_progress` indefinitely between externally-driven
    // wakes, so long-active / no-comment evidence is meaningless for them.
    // Skip the issue entirely, mirroring the recovery reconciler.
    if (isStandbyWakeTargetIssue(sourceIssue)) return null;

    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

    const latestRuns = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        livenessState: heartbeatRuns.livenessState,
        createdAt: heartbeatRuns.createdAt,
        nextAction: heartbeatRuns.nextAction,
        usageJson: heartbeatRuns.usageJson,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, sourceIssue.companyId),
          eq(heartbeatRuns.agentId, sourceAgent.id),
          issueRunScopeSql(sourceIssue.id),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(MAX_RUNS_FOR_STREAK);

    const runIds = latestRuns.map((run) => run.id);
    const commentRunIds = new Set<string>();
    if (runIds.length > 0) {
      const commentRows = await db
        .select({ createdByRunId: issueComments.createdByRunId })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, sourceIssue.companyId),
            eq(issueComments.issueId, sourceIssue.id),
            inArray(issueComments.createdByRunId, runIds),
          ),
        );
      for (const row of commentRows) {
        if (row.createdByRunId) commentRunIds.add(row.createdByRunId);
      }
    }

    // Provider-admission failures (429-class transient upstream, zero cost)
    // never reached the model, so they say nothing about the assignee's
    // productivity. Exclude them from the no-comment streak and the churn
    // windows so an account-wide outage does not read as stalled work.
    const providerAdmissionFailureCount = latestRuns.filter(isProviderAdmissionFailureRun).length;
    const streakEligibleRuns = latestRuns.filter((run) => !isProviderAdmissionFailureRun(run));
    const terminalRuns = streakEligibleRuns.filter((run) =>
      TERMINAL_RUN_STATUSES.includes(run.status as (typeof TERMINAL_RUN_STATUSES)[number]),
    );
    let noCommentStreak = 0;
    for (const run of terminalRuns) {
      if (commentRunIds.has(run.id)) break;
      noCommentStreak += 1;
    }

    const [
      runCountLastHour,
      runCountLastSixHours,
      assigneeRunCommentCount,
      assigneeRunCommentCountLastHour,
      assigneeRunCommentCountLastSixHours,
      latestComments,
      costRow,
    ] = await Promise.all([
      countIssueRunsSince(sourceIssue.companyId, sourceAgent.id, sourceIssue.id, oneHourAgo),
      countIssueRunsSince(sourceIssue.companyId, sourceAgent.id, sourceIssue.id, sixHoursAgo),
      countIssueCommentsSince(sourceIssue.companyId, sourceIssue.id, sourceAgent.id),
      countIssueCommentsSince(sourceIssue.companyId, sourceIssue.id, sourceAgent.id, oneHourAgo),
      countIssueCommentsSince(sourceIssue.companyId, sourceIssue.id, sourceAgent.id, sixHoursAgo),
      db
        .select({ comment: issueComments })
        .from(issueComments)
        .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, issueComments.createdByRunId))
        .where(
          and(
            eq(issueComments.companyId, sourceIssue.companyId),
            eq(issueComments.issueId, sourceIssue.id),
            eq(issueComments.authorAgentId, sourceAgent.id),
            eq(heartbeatRuns.companyId, sourceIssue.companyId),
            eq(heartbeatRuns.agentId, sourceAgent.id),
            issueRunScopeSql(sourceIssue.id),
          ),
        )
        .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
        .limit(5)
        .then((rows) => rows.map((row) => row.comment)),
      db
        .select({ costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
        .from(costEvents)
        .where(and(eq(costEvents.companyId, sourceIssue.companyId), eq(costEvents.issueId, sourceIssue.id)))
        .then((rows) => rows[0] ?? { costCents: 0 }),
    ]);

    const activeRunCount = latestRuns.filter((run) =>
      ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number]),
    ).length;
    const activeStartedAt = sourceIssue.startedAt ?? sourceIssue.executionLockedAt ?? null;
    const elapsedMs = sourceIssue.status === "in_progress" && activeStartedAt
      ? Math.max(0, now.getTime() - activeStartedAt.getTime())
      : null;

    const noComment = noCommentStreak >= thresholds.noCommentStreakRuns;
    let longActive = elapsedMs !== null && elapsedMs >= thresholds.longActiveMs;

    // Suppress `long_active_duration` when the issue's
    // `checkoutRunId` points to a terminal run AND the latest assignee comment on
    // this issue is older than that run's `finished_at`. In that case the issue is
    // not actually "stuck for N hours" — it is sitting in an orphan-checkoutRunId
    // state and there has been no real assignee activity since
    // the run completed. The defensive back-fill in mutation handlers will clean up
    // the orphan on next touch; we should not page a reviewer in the meantime.
    if (longActive && sourceIssue.checkoutRunId) {
      const checkoutRun = await db
        .select({ status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, sourceIssue.checkoutRunId))
        .then((rows) => rows[0] ?? null);
      const isTerminal =
        !checkoutRun ||
        TERMINAL_RUN_STATUSES.includes(checkoutRun.status as (typeof TERMINAL_RUN_STATUSES)[number]);
      if (isTerminal) {
        const runFinishedAt = coerceDate(checkoutRun?.finishedAt ?? null);
        const latestAssigneeCommentAt = coerceDate(latestComments[0]?.createdAt ?? null);
        if (
          runFinishedAt &&
          (!latestAssigneeCommentAt || latestAssigneeCommentAt.getTime() <= runFinishedAt.getTime())
        ) {
          longActive = false;
        }
      }
    }

    const highChurn =
      runCountLastHour >= thresholds.highChurnHourly ||
      assigneeRunCommentCountLastHour >= thresholds.highChurnHourly ||
      runCountLastSixHours >= thresholds.highChurnSixHours ||
      assigneeRunCommentCountLastSixHours >= thresholds.highChurnSixHours;
    const trigger = choosePrimaryTrigger({ noComment, longActive, highChurn });
    if (!trigger) return null;

    const triggerReasons: string[] = [];
    if (noComment) triggerReasons.push(`${noCommentStreak} consecutive completed issue-linked runs had no run-created issue comment`);
    if (longActive) triggerReasons.push(`current active episode has lasted ${msToHuman(elapsedMs)}`);
    if (highChurn) {
      triggerReasons.push(
        `${runCountLastHour} runs/${assigneeRunCommentCountLastHour} assignee-run comments in 1h; ${runCountLastSixHours} runs/${assigneeRunCommentCountLastSixHours} assignee-run comments in 6h`,
      );
    }

    return {
      trigger,
      triggerReasons,
      sourceIssue,
      sourceAgent,
      noCommentStreak,
      totalRunCount: latestRuns.length,
      terminalRunCount: terminalRuns.length,
      activeRunCount,
      providerAdmissionFailureCount,
      runCountLastHour,
      runCountLastSixHours,
      commentCount: assigneeRunCommentCount,
      commentCountLastHour: assigneeRunCommentCountLastHour,
      commentCountLastSixHours: assigneeRunCommentCountLastSixHours,
      elapsedMs,
      latestRuns: latestRuns.slice(0, 5),
      latestComments,
      costCents: costRow.costCents,
      usageSamples: latestRuns
        .filter((run) => run.usageJson)
        .slice(0, 3)
        .map((run) => ({ runId: run.id, usageJson: run.usageJson ?? null })),
      nextAction: latestRuns.find((run) => run.nextAction)?.nextAction ?? null,
      thresholds,
      generatedAt: now,
    };
  }

  async function resolveReviewOwnerAgentId(sourceIssue: IssueRow, sourceAgent: AgentRow) {
    const candidateIds: string[] = [];
    if (sourceAgent.reportsTo) candidateIds.push(sourceAgent.reportsTo);
    if (sourceIssue.createdByAgentId) candidateIds.push(sourceIssue.createdByAgentId);
    if (sourceIssue.projectId) {
      const project = await db
        .select({ leadAgentId: projects.leadAgentId })
        .from(projects)
        .where(and(eq(projects.companyId, sourceIssue.companyId), eq(projects.id, sourceIssue.projectId)))
        .then((rows) => rows[0] ?? null);
      if (project?.leadAgentId) candidateIds.push(project.leadAgentId);
    }
    const roleCandidates = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, sourceIssue.companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt), asc(agents.id));
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

  function buildReviewMarkdown(evidence: ProductivityReviewEvidence, prefix: string) {
    const latestRuns = evidence.latestRuns.length > 0
      ? evidence.latestRuns.map((run) =>
        `- ${runUiLink(run, prefix)} \`${run.status}\` liveness \`${run.livenessState ?? "unknown"}\`, created ${run.createdAt.toISOString()}${run.nextAction ? `, next action: ${truncateInline(run.nextAction, 160)}` : ""}`,
      ).join("\n")
      : "- none";
    const latestComments = evidence.latestComments.length > 0
      ? evidence.latestComments.map((comment) =>
        `- ${comment.createdAt.toISOString()}${comment.createdByRunId ? ` run \`${comment.createdByRunId}\`` : ""}: ${truncateInline(comment.body)}`,
      ).join("\n")
      : "- none";
    const usage = evidence.usageSamples.length > 0
      ? evidence.usageSamples.map((sample) => `- \`${sample.runId}\`: \`${JSON.stringify(sample.usageJson).slice(0, 500)}\``).join("\n")
      : "- no usage payloads on sampled runs";
    return [
      "Paperclip detected an unusual productivity/progression pattern on an assigned issue.",
      "",
      "## Source",
      "",
      `- Source issue: ${issueUiLink(evidence.sourceIssue, prefix)}`,
      `- Assigned agent: ${evidence.sourceAgent.name} (${evidence.sourceAgent.role})`,
      `- Primary trigger: \`${evidence.trigger}\` (${formatTrigger(evidence.trigger)})`,
      `- Trigger reasons: ${evidence.triggerReasons.join("; ")}`,
      `- Generated at: ${evidence.generatedAt.toISOString()}`,
      "",
      "## Evidence",
      "",
      `- Total sampled issue-linked runs: ${evidence.totalRunCount}`,
      `- Terminal sampled runs: ${evidence.terminalRunCount}`,
      `- Active queued/running/scheduled runs: ${evidence.activeRunCount}`,
      ...(evidence.providerAdmissionFailureCount > 0
        ? [
            `- Provider outage window: ${evidence.providerAdmissionFailureCount} sampled runs were zero-cost provider-admission failures (429-class transient upstream) and are excluded from streak/churn evidence — treat stalled-looking signals in this window as outage noise, not actionable drift`,
          ]
        : []),
      `- No-comment completed-run streak: ${evidence.noCommentStreak}`,
      `- Current active elapsed time: ${msToHuman(evidence.elapsedMs)}`,
      `- Runs in rolling windows: ${evidence.runCountLastHour}/1h, ${evidence.runCountLastSixHours}/6h`,
      `- Assignee run-linked comments total/window: ${evidence.commentCount} total, ${evidence.commentCountLastHour}/1h, ${evidence.commentCountLastSixHours}/6h`,
      `- Cost events total: ${evidence.costCents} cents`,
      `- Current next action: ${evidence.nextAction ? truncateInline(evidence.nextAction, 500) : "none recorded"}`,
      "",
      "## Thresholds",
      "",
      `- No-comment streak: ${evidence.thresholds.noCommentStreakRuns} completed runs`,
      `- Long active duration: ${msToHuman(evidence.thresholds.longActiveMs)}`,
      `- High churn: ${evidence.thresholds.highChurnHourly}/1h or ${evidence.thresholds.highChurnSixHours}/6h runs/assignee-run comments`,
      `- Resolved-review snooze: ${msToHuman(evidence.thresholds.resolvedSnoozeMs)}`,
      "",
      "## Latest Runs",
      "",
      latestRuns,
      "",
      "## Latest Assignee Run Comments",
      "",
      latestComments,
      "",
      "## Usage Samples",
      "",
      usage,
      "",
      "## Manager Decision",
      "",
      "- Close as productive if this pattern is expected.",
      "- Continue with a snooze window if the current work should keep running without repeat review spam.",
      "- Request decomposition, reroute, block with an unblock owner, or stop/cancel the source work if the work is inefficient.",
    ].join("\n");
  }

  function buildRefreshComment(evidence: ProductivityReviewEvidence, prefix: string) {
    return [
      "Productivity review evidence refreshed.",
      "",
      `- Source issue: ${issueUiLink(evidence.sourceIssue, prefix)}`,
      `- Trigger: \`${evidence.trigger}\` (${formatTrigger(evidence.trigger)})`,
      `- Reasons: ${evidence.triggerReasons.join("; ")}`,
      `- No-comment streak: ${evidence.noCommentStreak}`,
      `- Runs/assignee comments: ${evidence.runCountLastHour}/${evidence.commentCountLastHour} in 1h, ${evidence.runCountLastSixHours}/${evidence.commentCountLastSixHours} in 6h`,
      ...(evidence.providerAdmissionFailureCount > 0
        ? [
            `- Provider outage window: ${evidence.providerAdmissionFailureCount} sampled zero-cost provider-admission failures excluded from streak/churn evidence`,
          ]
        : []),
      `- Next action: ${evidence.nextAction ? truncateInline(evidence.nextAction, 300) : "none recorded"}`,
    ].join("\n");
  }

  async function createOrUpdateReview(
    evidence: ProductivityReviewEvidence,
    opts: { prefix: string; thresholds: ProductivityReviewThresholds },
  ) {
    const existing = await findOpenProductivityReview(evidence.sourceIssue.companyId, evidence.sourceIssue.id);
    if (existing) {
      const refreshState = await getRefreshCommentState(evidence.sourceIssue.companyId, existing.id);
      const lastRefreshOrCreationAt = refreshState.latestCreatedAt ?? existing.createdAt;
      if (
        refreshState.count >= opts.thresholds.maxRefreshComments ||
        evidence.generatedAt.getTime() - lastRefreshOrCreationAt.getTime() < opts.thresholds.refreshIntervalMs
      ) {
        return { kind: "existing" as const, reviewIssueId: existing.id };
      }
      await addRefreshComment(existing.id, buildRefreshComment(evidence, opts.prefix), evidence.generatedAt);
      await logActivity(db, {
        companyId: evidence.sourceIssue.companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.productivity_review_updated",
        entityType: "issue",
        entityId: existing.id,
        agentId: existing.assigneeAgentId,
        details: {
          source: "productivity_review.reconcile",
          sourceIssueId: evidence.sourceIssue.id,
          trigger: evidence.trigger,
          noCommentStreak: evidence.noCommentStreak,
          runCountLastHour: evidence.runCountLastHour,
          commentCountLastHour: evidence.commentCountLastHour,
        },
      });
      return { kind: "updated" as const, reviewIssueId: existing.id };
    }

    const recentCreationCount = await countRecentProductivityReviews(
      evidence.sourceIssue.companyId,
      evidence.sourceIssue.id,
      opts.thresholds,
      evidence.generatedAt,
    );
    if (recentCreationCount >= opts.thresholds.maxCreationsPerWindow) {
      return { kind: "creation_capped" as const, reviewIssueId: null };
    }

    const consecutiveNoActionReviews = await countConsecutiveNoActionProductivityReviews(
      evidence.sourceIssue.companyId,
      evidence.sourceIssue.id,
      opts.thresholds,
    );
    if (consecutiveNoActionReviews >= opts.thresholds.maxConsecutiveNoActionReviews) {
      return { kind: "no_action_suppressed" as const, reviewIssueId: null };
    }

    const ownerAgentId = await resolveReviewOwnerAgentId(evidence.sourceIssue, evidence.sourceAgent);
    let review: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      review = await issuesSvc.create(evidence.sourceIssue.companyId, {
        title: `Review productivity for ${evidence.sourceIssue.identifier ?? evidence.sourceIssue.title}`,
        description: buildReviewMarkdown(evidence, opts.prefix),
        status: "todo",
        priority: evidence.trigger === "long_active_duration" ? "medium" : "high",
        parentId: evidence.sourceIssue.id,
        projectId: evidence.sourceIssue.projectId,
        goalId: evidence.sourceIssue.goalId,
        billingCode: evidence.sourceIssue.billingCode,
        assigneeAgentId: ownerAgentId,
        assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides("status_only"),
        originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
        originId: evidence.sourceIssue.id,
        originFingerprint: productivityReviewFingerprint(evidence.sourceIssue.id),
        requestDepth: clampIssueRequestDepth(evidence.sourceIssue.requestDepth + 1),
      });
    } catch (error) {
      const maybe = error as { code?: string; constraint?: string; message?: string };
      const uniqueConflict = maybe.code === "23505" &&
        (
          maybe.constraint === "issues_active_productivity_review_uq" ||
          typeof maybe.message === "string" && maybe.message.includes("issues_active_productivity_review_uq")
        );
      if (!uniqueConflict) throw error;
      const raced = await findOpenProductivityReview(evidence.sourceIssue.companyId, evidence.sourceIssue.id);
      if (!raced) throw error;
      return { kind: "existing" as const, reviewIssueId: raced.id };
    }
    await db
      .update(issues)
      .set({ createdAt: evidence.generatedAt, updatedAt: evidence.generatedAt })
      .where(eq(issues.id, review.id));

    await logActivity(db, {
      companyId: evidence.sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_created",
      entityType: "issue",
      entityId: review.id,
      agentId: ownerAgentId,
      details: {
        source: "productivity_review.reconcile",
        sourceIssueId: evidence.sourceIssue.id,
        trigger: evidence.trigger,
        noCommentStreak: evidence.noCommentStreak,
        runCountLastHour: evidence.runCountLastHour,
        commentCountLastHour: evidence.commentCountLastHour,
      },
    });

    if (ownerAgentId && deps?.enqueueWakeup) {
      await deps.enqueueWakeup(ownerAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: withRecoveryModelProfileHint({
          issueId: review.id,
          sourceIssueId: evidence.sourceIssue.id,
          trigger: evidence.trigger,
        }, "status_only"),
        requestedByActorType: "system",
        requestedByActorId: "productivity_review",
        contextSnapshot: withRecoveryModelProfileHint({
          issueId: review.id,
          taskId: review.id,
          wakeReason: "issue_assigned",
          source: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
          sourceIssueId: evidence.sourceIssue.id,
          productivityReviewTrigger: evidence.trigger,
        }, "status_only"),
      });
    }

    return { kind: "created" as const, reviewIssueId: review.id };
  }

  function emptyReconcileResult() {
    return {
      scanned: 0,
      created: 0,
      updated: 0,
      existing: 0,
      snoozed: 0,
      creationCapped: 0,
      skipped: 0,
      failed: 0,
      reviewIssueIds: [] as string[],
      failedIssueIds: [] as string[],
      disabled: false,
    };
  }

  async function reconcileProductivityReviews(opts?: {
    now?: Date;
    companyId?: string;
    thresholds?: Partial<ProductivityReviewThresholds>;
    issueCreatedAtGte?: Date | null;
  }) {
    // Kill-switch: short-circuit the reviewer without touching the rest of the
    // heartbeat scheduler. Default is enabled to preserve existing behaviour;
    // set PRODUCTIVITY_REVIEW_ENABLED=false to suppress.
    if (!isProductivityReviewEnabled()) {
      if (!productivityReviewSuppressionLogged) {
        productivityReviewSuppressionLogged = true;
        logger.warn(
          { env: PRODUCTIVITY_REVIEW_ENABLED_ENV },
          "productivity review reconciliation suppressed by kill-switch",
        );
      }
      return { ...emptyReconcileResult(), disabled: true };
    }

    const now = opts?.now ?? new Date();
    const thresholds = buildThresholds(opts?.thresholds);
    const candidates = await db
      .select()
      .from(issues)
      .where(
        and(
          opts?.companyId ? eq(issues.companyId, opts.companyId) : undefined,
          visibleIssueCondition(),
          isNull(issues.assigneeUserId),
          inArray(issues.status, ["todo", "in_progress"]),
          sql`${issues.assigneeAgentId} is not null`,
          sql`${issues.originKind} <> ${PRODUCTIVITY_REVIEW_ORIGIN_KIND}`,
          opts?.issueCreatedAtGte ? gte(issues.createdAt, opts.issueCreatedAtGte) : undefined,
        ),
      )
      .orderBy(asc(issues.updatedAt), asc(issues.id))
      .limit(MAX_CANDIDATE_ISSUES);

    const result = {
      scanned: candidates.length,
      created: 0,
      updated: 0,
      existing: 0,
      snoozed: 0,
      creationCapped: 0,
      noActionSuppressed: 0,
      skipped: 0,
      failed: 0,
      reviewIssueIds: [] as string[],
      failedIssueIds: [] as string[],
      disabled: false,
    };

    const prefixCache = new Map<string, string>();
    for (const candidate of candidates) {
      if (!candidate.assigneeAgentId) {
        result.skipped += 1;
        continue;
      }
      if (await isProductivityReviewDescendant(candidate)) {
        result.skipped += 1;
        continue;
      }
      if (await findRecentTerminalProductivityReview(candidate.companyId, candidate.id, thresholds, now)) {
        result.snoozed += 1;
        continue;
      }
      const sourceAgent = await getAgent(candidate.assigneeAgentId);
      if (!sourceAgent || sourceAgent.companyId !== candidate.companyId) {
        result.skipped += 1;
        continue;
      }
      // A paused assignee cannot act on a review, so raising one only creates noise.
      if (sourceAgent.status === "paused") {
        result.skipped += 1;
        continue;
      }
      const evidence = await collectEvidence(candidate, sourceAgent, thresholds, now);
      if (!evidence) {
        result.skipped += 1;
        continue;
      }
      let prefix = prefixCache.get(candidate.companyId);
      if (!prefix) {
        prefix = await getCompanyIssuePrefix(candidate.companyId);
        prefixCache.set(candidate.companyId, prefix);
      }
      try {
        const outcome = await createOrUpdateReview(evidence, { prefix, thresholds });
        if (outcome.kind === "created") result.created += 1;
        else if (outcome.kind === "updated") result.updated += 1;
        else if (outcome.kind === "creation_capped") result.creationCapped += 1;
        else if (outcome.kind === "no_action_suppressed") result.noActionSuppressed += 1;
        else result.existing += 1;
        if (outcome.reviewIssueId) result.reviewIssueIds.push(outcome.reviewIssueId);
      } catch (err) {
        result.failed += 1;
        result.failedIssueIds.push(candidate.id);
        logger.warn(
          {
            err,
            companyId: candidate.companyId,
            issueId: candidate.id,
            requestDepth: candidate.requestDepth,
          },
          "productivity review reconciliation skipped malformed candidate",
        );
      }
    }

    return result;
  }

  async function isProductivityReviewContinuationHoldActive(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    now?: Date;
    thresholds?: Partial<ProductivityReviewThresholds>;
  }) {
    const now = input.now ?? new Date();
    const thresholds = buildThresholds(input.thresholds);
    const [sourceIssue, sourceAgent, openReview] = await Promise.all([
      db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
        .then((rows) => rows[0] ?? null),
      getAgent(input.agentId),
      findOpenProductivityReview(input.companyId, input.issueId),
    ]);
    if (!sourceIssue || !sourceAgent || !openReview) return { held: false as const };
    if (sourceAgent.companyId !== input.companyId) return { held: false as const };
    const evidence = await collectEvidence(sourceIssue, sourceAgent, thresholds, now);
    if (!evidence || !isSoftStopTrigger(evidence.trigger)) return { held: false as const };
    return {
      held: true as const,
      reviewIssueId: openReview.id,
      reviewIdentifier: openReview.identifier,
      trigger: evidence.trigger,
      reason: evidence.triggerReasons.join("; "),
    };
  }

  async function recordContinuationHold(input: {
    companyId: string;
    issueId: string;
    runId: string;
    agentId: string;
    reviewIssueId: string;
    trigger: ProductivityReviewTrigger;
    reason: string;
  }) {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "system",
      agentId: input.agentId,
      runId: input.runId,
      action: "issue.productivity_review_continuation_held",
      entityType: "issue",
      entityId: input.issueId,
      details: {
        source: "productivity_review.continuation_hold",
        reviewIssueId: input.reviewIssueId,
        trigger: input.trigger,
        reason: input.reason,
      },
    });
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
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt), asc(agents.id));
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
      "## Source",
      "",
      `- Source issue: ${issueUiLink(sourceIssue, prefix)}`,
      `- Comment count: ${commentCount}`,
      `- Alert threshold: ${threshold}`,
      `- Detected at: ${now.toISOString()}`,
      "",
      "## Why this matters",
      "",
      "- A single issue accumulating hundreds of comments is a strong signal of a runaway automation or comment loop.",
      "- This alert is deduplicated by origin fingerprint, so it never adds repeat comments to the offending issue and cannot itself become a comment loop.",
      "",
      "## Manager Decision",
      "",
      "- Confirm whether the comment volume is legitimate discussion or an automation loop.",
      "- If it is a loop, identify the producer and stop or snooze it, then close this alert.",
      "- If it is legitimate, close this alert as expected.",
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
    reconcileProductivityReviews,
    reconcileHighCommentVolumeAlerts,
    isProductivityReviewContinuationHoldActive,
    recordContinuationHold,
  };
}
