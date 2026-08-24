import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agentApiKeys, companies, heartbeatRuns, issues } from "@paperclipai/db";
import { isUuidLike, PLUGIN_EVENT_TYPES, type PluginEventType } from "@paperclipai/shared";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { publishLiveEvent } from "./live-events.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { sanitizeRecord } from "../redaction.js";
import { logger } from "../middleware/logger.js";
import { getActorProvenance } from "../middleware/actor-context.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { instanceSettingsService } from "./instance-settings.js";

const PLUGIN_EVENT_SET: ReadonlySet<string> = new Set(PLUGIN_EVENT_TYPES);
const ACTIVITY_ACTION_TO_PLUGIN_EVENT: Readonly<Record<string, PluginEventType>> = {
  issue_comment_added: "issue.comment.created",
  issue_comment_created: "issue.comment.created",
  issue_document_created: "issue.document.created",
  issue_document_updated: "issue.document.updated",
  issue_document_deleted: "issue.document.deleted",
  issue_blockers_updated: "issue.relations.updated",
  issue_thread_interaction_created: "issue.interaction.created",
  issue_thread_interaction_accepted: "issue.interaction.responded",
  issue_thread_interaction_rejected: "issue.interaction.responded",
  issue_thread_interaction_answered: "issue.interaction.responded",
  approval_approved: "approval.decided",
  approval_rejected: "approval.decided",
  approval_revision_requested: "approval.decided",
  budget_soft_threshold_crossed: "budget.incident.opened",
  budget_hard_threshold_crossed: "budget.incident.opened",
  budget_incident_resolved: "budget.incident.resolved",
};

const INTERACTION_OUTCOME_FROM_ACTION: Readonly<Record<string, string>> = {
  issue_thread_interaction_created: "created",
  issue_thread_interaction_accepted: "accepted",
  issue_thread_interaction_rejected: "rejected",
  issue_thread_interaction_answered: "answered",
};

let _pluginEventBus: PluginEventBus | null = null;

/** Wire the plugin event bus so domain events are forwarded to plugins. */
export function setPluginEventBus(bus: PluginEventBus): void {
  if (_pluginEventBus) {
    logger.warn("setPluginEventBus called more than once, replacing existing bus");
  }
  _pluginEventBus = bus;
}

export function eventTypeForActivityAction(action: string): PluginEventType | null {
  if (PLUGIN_EVENT_SET.has(action)) return action as PluginEventType;
  return ACTIVITY_ACTION_TO_PLUGIN_EVENT[action.replaceAll(".", "_")] ?? null;
}

export function pluginPayloadExtrasForActivityAction(action: string): Record<string, unknown> {
  const outcome = INTERACTION_OUTCOME_FROM_ACTION[action.replaceAll(".", "_")];
  return outcome ? { outcome } : {};
}

// --- Interaction event enrichment -------------------------------------------
// Chat-relay plugins subscribe to `issue.interaction.created`, but the
// event historically carried only interactionId/interactionKind, so the operator
// received a contentless ping. We attach a small, bounded projection of the
// interaction's questions/options so a subscribed plugin can render the prompt
// and choices without needing a new read capability. Bounds cap operator-authored
// text and total option/question counts so the event payload stays small.
const MAX_PROJECTED_QUESTIONS = 20;
const MAX_PROJECTED_OPTIONS_PER_QUESTION = 30;
const MAX_PROMPT_LENGTH = 500;
const MAX_LABEL_LENGTH = 160;
const MAX_OPTION_DESCRIPTION_LENGTH = 200;

export interface ProjectedInteractionOption {
  id: string;
  label: string;
  description?: string;
}

export interface ProjectedInteractionQuestion {
  id: string;
  prompt: string;
  selectionMode: "single" | "multi";
  options: ProjectedInteractionOption[];
}

export interface ProjectedInteraction {
  id: string;
  kind: string;
  title?: string;
  questions: ProjectedInteractionQuestion[];
}

interface InteractionForProjection {
  id: string;
  kind: string;
  payload?: unknown;
}

function clip(value: unknown, max: number): string {
  const s = typeof value === "string" ? value : String(value ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

function projectOptions(
  rawOptions: unknown,
  idField: string,
  labelField: string,
): ProjectedInteractionOption[] {
  if (!Array.isArray(rawOptions)) return [];
  const options: ProjectedInteractionOption[] = [];
  for (const raw of rawOptions.slice(0, MAX_PROJECTED_OPTIONS_PER_QUESTION)) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const rawId = o[idField];
    const rawLabel = o[labelField];
    if (typeof rawId !== "string" || typeof rawLabel !== "string") continue;
    const option: ProjectedInteractionOption = {
      id: clip(rawId, MAX_LABEL_LENGTH),
      label: clip(rawLabel, MAX_LABEL_LENGTH),
    };
    if (typeof o.description === "string" && o.description.length > 0) {
      option.description = clip(o.description, MAX_OPTION_DESCRIPTION_LENGTH);
    }
    options.push(option);
  }
  return options;
}

/**
 * Normalize a hydrated issue-thread interaction into a bounded questions/options
 * projection for the `issue.interaction.created` plugin event. Returns `null`
 * for a missing/malformed interaction and never throws — the caller runs this
 * inline while building the activity-log details, so a throw would break the
 * interaction-create request.
 *
 * Only questions/options (and an optional title) are projected — target/href,
 * secret refs, and result data are deliberately omitted to minimize what a
 * subscribed plugin sees.
 */
export function projectInteractionForPluginEvent(
  interaction: InteractionForProjection | null | undefined,
): ProjectedInteraction | null {
  if (!interaction || typeof interaction.id !== "string" || typeof interaction.kind !== "string") {
    return null;
  }
  try {
    const payload = (interaction.payload ?? {}) as Record<string, unknown>;
    const questions: ProjectedInteractionQuestion[] = [];
    let title: string | undefined;

    switch (interaction.kind) {
      case "ask_user_questions": {
        if (typeof payload.title === "string" && payload.title.length > 0) {
          title = clip(payload.title, MAX_PROMPT_LENGTH);
        }
        const rawQuestions = Array.isArray(payload.questions) ? payload.questions : [];
        for (const raw of rawQuestions.slice(0, MAX_PROJECTED_QUESTIONS)) {
          if (!raw || typeof raw !== "object") continue;
          const q = raw as Record<string, unknown>;
          if (typeof q.id !== "string" || typeof q.prompt !== "string") continue;
          questions.push({
            id: clip(q.id, MAX_LABEL_LENGTH),
            prompt: clip(q.prompt, MAX_PROMPT_LENGTH),
            selectionMode: q.selectionMode === "multi" ? "multi" : "single",
            options: projectOptions(q.options, "id", "label"),
          });
        }
        break;
      }
      case "request_checkbox_confirmation": {
        if (typeof payload.prompt === "string") {
          questions.push({
            id: interaction.id,
            prompt: clip(payload.prompt, MAX_PROMPT_LENGTH),
            selectionMode: "multi",
            options: projectOptions(payload.options, "id", "label"),
          });
        }
        break;
      }
      case "request_confirmation": {
        if (typeof payload.prompt === "string") {
          const accept = typeof payload.acceptLabel === "string" ? payload.acceptLabel : "Accept";
          const reject = typeof payload.rejectLabel === "string" ? payload.rejectLabel : "Reject";
          questions.push({
            id: interaction.id,
            prompt: clip(payload.prompt, MAX_PROMPT_LENGTH),
            selectionMode: "single",
            options: [
              { id: "accept", label: clip(accept, MAX_LABEL_LENGTH) },
              { id: "reject", label: clip(reject, MAX_LABEL_LENGTH) },
            ],
          });
        }
        break;
      }
      case "suggest_tasks": {
        const options = projectOptions(payload.tasks, "clientKey", "title");
        if (options.length > 0) {
          questions.push({
            id: interaction.id,
            prompt: "Proposed tasks",
            selectionMode: "multi",
            options,
          });
        }
        break;
      }
      default:
        break;
    }

    const projected: ProjectedInteraction = {
      id: interaction.id,
      kind: interaction.kind,
      questions,
    };
    if (title) projected.title = title;
    return projected;
  } catch (err) {
    logger.warn(
      { err, interactionId: interaction.id, kind: interaction.kind },
      "failed to project interaction for plugin event",
    );
    return { id: interaction.id, kind: interaction.kind, questions: [] };
  }
}

export function publishPluginDomainEvent(event: PluginEvent): void {
  if (!_pluginEventBus) return;
  void _pluginEventBus.emit(event).then(({ errors }) => {
    for (const { pluginId, error } of errors) {
      logger.warn({ pluginId, eventType: event.eventType, err: error }, "plugin event handler failed");
    }
  }).catch(() => {});
}

export interface LogActivityInput {
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId?: string | null;
  runId?: string | null;
  agentApiKeyId?: string | null;
  issueId?: string | null;
  details?: Record<string, unknown> | null;
  responsibleUserIdOverride?: string | null;
}

export interface ActivityPublication {
  companyId: string;
  payload: Record<string, unknown>;
  pluginEvent: PluginEvent | null;
}

export async function createActivityDetailsRedactor(db: Db) {
  const currentUserRedactionOptions = {
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  };
  return (details: Record<string, unknown> | null) => (
    details ? redactCurrentUserValue(sanitizeRecord(details), currentUserRedactionOptions) : null
  );
}

export async function redactActivityDetails(db: Db, details: Record<string, unknown> | null) {
  if (!details) return null;
  return (await createActivityDetailsRedactor(db))(details);
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function resolveResponsibleUserIdForActivity(db: Db, input: LogActivityInput) {
  if (input.responsibleUserIdOverride !== undefined) {
    return readNonEmptyString(input.responsibleUserIdOverride);
  }
  if (input.actorType === "user") return readNonEmptyString(input.actorId);

  const runId = readNonEmptyString(input.runId);
  if (runId && isUuidLike(runId)) {
    const run = await db
      .select({ responsibleUserId: heartbeatRuns.responsibleUserId })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, runId)))
      .then((rows) => rows[0] ?? null);
    const runResponsibleUserId = readNonEmptyString(run?.responsibleUserId);
    if (runResponsibleUserId) return runResponsibleUserId;
  }

  const issueIdCandidate = readNonEmptyString(input.issueId)
    ?? (input.entityType === "issue" ? readNonEmptyString(input.entityId) : null);
  const issueId = isUuidLike(issueIdCandidate) ? issueIdCandidate : null;
  if (issueId) {
    const issue = await db
      .select({
        responsibleUserId: issues.responsibleUserId,
        createdByUserId: issues.createdByUserId,
      })
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, issueId)))
      .then((rows) => rows[0] ?? null);
    const issueResponsibleUserId = readNonEmptyString(issue?.responsibleUserId)
      ?? readNonEmptyString(issue?.createdByUserId);
    if (issueResponsibleUserId) return issueResponsibleUserId;
  }

  const agentApiKeyId = readNonEmptyString(input.agentApiKeyId);
  const agentId = readNonEmptyString(input.agentId);
  if (agentApiKeyId && isUuidLike(agentApiKeyId)) {
    const apiKey = await db
      .select({ responsibleUserId: agentApiKeys.responsibleUserId })
      .from(agentApiKeys)
      .where(and(
        eq(agentApiKeys.companyId, input.companyId),
        eq(agentApiKeys.id, agentApiKeyId),
        ...(agentId && isUuidLike(agentId) ? [eq(agentApiKeys.agentId, agentId)] : []),
      ))
      .then((rows) => rows[0] ?? null);
    const apiKeyResponsibleUserId = readNonEmptyString(apiKey?.responsibleUserId);
    if (apiKeyResponsibleUserId) return apiKeyResponsibleUserId;
  }

  const company = await db
    .select({ defaultResponsibleUserId: companies.defaultResponsibleUserId })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .then((rows) => rows[0] ?? null);
  return readNonEmptyString(company?.defaultResponsibleUserId);
}

export function publishActivity(publication: ActivityPublication) {
  publishLiveEvent({
    companyId: publication.companyId,
    type: "activity.logged",
    payload: publication.payload,
  });
  if (publication.pluginEvent) publishPluginDomainEvent(publication.pluginEvent);
}

export async function persistActivity(db: Db, input: LogActivityInput) {
  const redactedDetails = await redactActivityDetails(db, input.details ?? null);
  const responsibleUserId = await resolveResponsibleUserIdForActivity(db, input);

  // Provenance of the credential that authenticated this write, captured centrally
  // from AsyncLocalStorage rather than at each of logActivity's ~179 call sites.
  // Null for background work (heartbeats, plugin workers) that runs outside a
  // request — which itself is meaningful: no request-scoped credential acted.
  const provenance = getActorProvenance();
  const actorSource = provenance?.source ?? null;
  const actorKeyId = provenance?.keyId ?? null;

  // AC4 alert: every activity_log write is a mutation (reads are not logged here),
  // so a board_key-sourced write is exactly a board-key-authenticated write to a
  // board-gated route. Surface it at warn with a stable `event` discriminator.
  // Operators grep: `event=board_key_authenticated_write` (or the JSON key). The
  // token value is never logged — keyId (a UUID) is the only credential id emitted.
  if (actorSource === "board_key") {
    logger.info(
      {
        event: "board_key_authenticated_write",
        actorSource,
        actorKeyId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        companyId: input.companyId,
      },
      "board_key-authenticated write to a board-gated route",
    );
  }
  const [activity] = await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    responsibleUserId,
    actorSource,
    actorKeyId,
    details: redactedDetails,
  }).returning({ id: activityLog.id });

  const payload = {
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    responsibleUserId,
    actorSource,
    details: redactedDetails,
  };
  const pluginEventType = eventTypeForActivityAction(input.action);
  const pluginEvent: PluginEvent | null = pluginEventType
    ? {
        eventId: randomUUID(),
        eventType: pluginEventType,
        occurredAt: new Date().toISOString(),
        actorId: input.actorId,
        actorType: input.actorType,
        entityId: input.entityId,
        entityType: input.entityType,
        companyId: input.companyId,
        payload: {
          ...redactedDetails,
          agentId: input.agentId ?? null,
          runId: input.runId ?? null,
          responsibleUserId,
          ...pluginPayloadExtrasForActivityAction(input.action),
        },
      }
    : null;

  return {
    activity,
    publication: {
      companyId: input.companyId,
      payload,
      pluginEvent,
    } satisfies ActivityPublication,
  };
}

export async function logActivity(
  db: Db,
  input: LogActivityInput,
  postCommitPublications?: ActivityPublication[],
) {
  const { activity, publication } = await persistActivity(db, input);
  if (postCommitPublications) {
    postCommitPublications.push(publication);
  } else {
    publishActivity(publication);
  }
  return activity;
}
