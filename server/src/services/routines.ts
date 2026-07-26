import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, not, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  documentRevisions,
  documents,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  issueInboxArchives,
  issueReadStates,
  issues,
  pluginManagedResources,
  plugins,
  projects,
  routineRevisions,
  routineRuns,
  routineDocuments,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import type {
  CreateRoutine,
  CreateRoutineTrigger,
  Routine,
  RoutineDetail,
  RoutineDescriptionDocument,
  RoutineListItem,
  RoutineManagedByPlugin,
  RoutineRevision,
  RoutineRevisionSnapshotV1,
  RoutineRunSummary,
  RoutineTrigger,
  RoutineTriggerSecretMaterial,
  RoutineVariable,
  RunRoutine,
  UpdateRoutine,
  UpdateRoutineTrigger,
} from "@paperclipai/shared";
import {
  WORKSPACE_BRANCH_ROUTINE_VARIABLE,
  getBuiltinRoutineVariableValues,
  extractRoutineVariableNames,
  interpolateRoutineTemplate,
  isValidRoutineDateString,
  pluginOperationIssueOriginKind,
  stringifyRoutineVariableValue,
  syncRoutineVariablesWithTemplate,
} from "@paperclipai/shared";
import { trackRoutineRun } from "@paperclipai/shared/telemetry";
import { conflict, forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { getTelemetryClient } from "../telemetry.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import { issueService } from "./issues.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { secretService } from "./secrets.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { parseCron, validateCron } from "./cron.js";
import { heartbeatService } from "./heartbeat.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { logActivity } from "./activity-log.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
// How long past its due time a never-started scheduled retry must sit before the routine
// staleness guard treats it as dead. Generous enough that a briefly backed-up retry promoter
// is never mistaken for a permanent stall.
const STALE_EXECUTION_PIN_GRACE_MS = 30 * 60 * 1000;
const STALE_EXECUTION_PIN_ERROR_CODE = "stale_execution_pin";

// Why a pin was reaped. Carried on the release record so the issue note, the activity log and the
// run result text can each name the arm that fired instead of collapsing to a generic "stale".
type StalePinReason =
  // A never-started retry whose due time passed more than the grace ago. The promoter is never
  // coming for it.
  | "overdue_retry"
  // A never-started retry still in the future, but due at or after the next scheduled tick.
  // Waiting on it buys nothing the next tick would not do sooner, so it is redundant rather than
  // dead — and unlike an overdue retry it needs no wall-clock grace to be provably pointless.
  | "redundant_retry"
  // An open execution issue with no non-terminal runs at all. It never reaches the skip branch —
  // it collides on issues_open_routine_execution_uq instead.
  | "runless_issue";

type StalePinRelease = { issueId: string; runIds: string[]; overdueMinutes: number; reason: StalePinReason };
const MAX_CATCH_UP_RUNS = 25;
const MAX_ROUTINE_REVISIONS = 100;
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

async function resolveCompanyDefaultResponsibleUserId(db: Db, companyId: string) {
  const company = await db
    .select({ defaultResponsibleUserId: companies.defaultResponsibleUserId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  if (company?.defaultResponsibleUserId) return company.defaultResponsibleUserId;

  const owner = await db
    .select({ userId: companyMemberships.principalId })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
        eq(companyMemberships.membershipRole, "owner"),
      ),
    )
    .orderBy(asc(companyMemberships.createdAt), asc(companyMemberships.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return owner?.userId ?? null;
}

async function resolveRoutineResponsibleUserId(db: Db, companyId: string, actorUserId: string | null | undefined, parentIssueId?: string | null) {
  if (actorUserId) return actorUserId;
  if (parentIssueId) {
    const parent = await db
      .select({ responsibleUserId: issues.responsibleUserId, createdByUserId: issues.createdByUserId })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, parentIssueId)))
      .then((rows) => rows[0] ?? null);
    if (parent?.responsibleUserId) return parent.responsibleUserId;
    if (parent?.createdByUserId) return parent.createdByUserId;
  }
  return resolveCompanyDefaultResponsibleUserId(db, companyId);
}

type Actor = { agentId?: string | null; userId?: string | null; runId?: string | null };
type RoutineRow = typeof routines.$inferSelect;
type RoutineTriggerRow = typeof routineTriggers.$inferSelect;

const ROUTINE_DESCRIPTION_DOCUMENT_KEY = "description" as const;

interface RoutineTriggerSecretRestoreMaterial extends RoutineTriggerSecretMaterial {
  triggerId: string;
}

function routineWebhookSecretConfigPath(secretId: string) {
  return `webhookSecret:${secretId}`;
}

function assertTimeZone(timeZone: string) {
  try {
    getZonedMinuteFormatter(timeZone).format(new Date());
  } catch {
    throw unprocessable(`Invalid timezone: ${timeZone}`);
  }
}

function floorToMinute(date: Date) {
  const copy = new Date(date.getTime());
  copy.setUTCSeconds(0, 0);
  return copy;
}

// Constructing an Intl.DateTimeFormat costs ~1ms of ICU work, and
// computeNextRun calls getZonedMinuteParts once per minute-step (up to
// 366*24*60*5 iterations for sparse schedules), which can block the event
// loop for minutes per scheduler tick. Formatter instances are immutable,
// so cache one per timezone. See #8033.
const zonedMinuteFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getZonedMinuteFormatter(timeZone: string) {
  let formatter = zonedMinuteFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    zonedMinuteFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function getZonedMinuteParts(date: Date, timeZone: string) {
  const formatter = getZonedMinuteFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_INDEX[map.weekday ?? ""];
  if (weekday == null) {
    throw new Error(`Unable to resolve weekday for timezone ${timeZone}`);
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday,
  };
}

function matchesCronMinute(expression: string, timeZone: string, date: Date) {
  const cron = parseCron(expression);
  const parts = getZonedMinuteParts(date, timeZone);
  return (
    cron.minutes.includes(parts.minute) &&
    cron.hours.includes(parts.hour) &&
    cron.daysOfMonth.includes(parts.day) &&
    cron.months.includes(parts.month) &&
    cron.daysOfWeek.includes(parts.weekday)
  );
}

export function nextCronTickInTimeZone(expression: string, timeZone: string, after: Date) {
  const trimmed = expression.trim();
  assertTimeZone(timeZone);
  const error = validateCron(trimmed);
  if (error) {
    throw unprocessable(error);
  }

  const cursor = floorToMinute(after);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = 366 * 24 * 60 * 5;
  for (let i = 0; i < limit; i += 1) {
    if (matchesCronMinute(trimmed, timeZone, cursor)) {
      return new Date(cursor.getTime());
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

function nextResultText(status: string, issueId?: string | null) {
  if (status === "issue_created_after_stale_pin_release" && issueId) {
    return `Released a stale execution issue pin, then created execution issue ${issueId}`;
  }
  if (status === "issue_created" && issueId) return `Created execution issue ${issueId}`;
  if (status === "coalesced") return "Coalesced into an existing live execution issue";
  if (status === "skipped_paused") return "Skipped because the project is paused";
  if (status === "skipped") return "Skipped because a live execution issue already exists";
  if (status === "completed") return "Execution issue completed";
  if (status === "failed") return "Execution failed";
  return status;
}

function normalizeWebhookTimestampMs(rawTimestamp: string) {
  const parsed = Number(rawTimestamp);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 1e12 ? parsed : parsed * 1000;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBooleanVariableValue(name: string, raw: unknown) {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number" && (raw === 0 || raw === 1)) return raw === 1;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }
  throw unprocessable(`Variable "${name}" must be a boolean`);
}

function parseNumberVariableValue(name: string, raw: unknown) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw unprocessable(`Variable "${name}" must be a number`);
}

function parseDateVariableValue(name: string, raw: unknown) {
  if (typeof raw !== "string") {
    throw unprocessable(`Variable "${name}" must be a YYYY-MM-DD date`);
  }
  const normalized = raw.trim();
  if (!isValidRoutineDateString(normalized)) {
    throw unprocessable(`Variable "${name}" must be a valid YYYY-MM-DD date`);
  }
  return normalized;
}

function normalizeRoutineVariableValue(variable: RoutineVariable, raw: unknown): string | number | boolean | null {
  if (raw == null) return null;
  if (variable.type === "boolean") return parseBooleanVariableValue(variable.name, raw);
  if (variable.type === "number") return parseNumberVariableValue(variable.name, raw);
  if (variable.type === "date") return parseDateVariableValue(variable.name, raw);

  const normalized = stringifyRoutineVariableValue(raw);
  if (variable.type === "select") {
    if (!variable.options.includes(normalized)) {
      throw unprocessable(`Variable "${variable.name}" must match one of: ${variable.options.join(", ")}`);
    }
  }
  return normalized;
}

function isMissingRoutineVariableValue(value: string | number | boolean | null) {
  return value == null || (typeof value === "string" && value.trim().length === 0);
}

function assertRoutineVariableDefinitions(variables: RoutineVariable[]) {
  for (const variable of variables) {
    if (variable.defaultValue != null) {
      normalizeRoutineVariableValue(variable, variable.defaultValue);
    }
    if (variable.type === "select" && variable.options.length === 0) {
      throw unprocessable(`Variable "${variable.name}" must define at least one option`);
    }
  }
}

function sanitizeRoutineVariableInputs(
  variables: Array<Partial<RoutineVariable> & Pick<RoutineVariable, "name">> | null | undefined,
): RoutineVariable[] {
  return (variables ?? []).map((variable) => ({
    name: variable.name,
    label: variable.label ?? null,
    type: variable.type ?? "text",
    defaultValue: variable.defaultValue ?? null,
    required: variable.required ?? true,
    options: variable.options ?? [],
  }));
}

function assertScheduleCompatibleVariables(variables: RoutineVariable[]) {
  const missingDefaults = variables
    .filter((variable) => variable.required)
    .filter((variable) => {
      try {
        return isMissingRoutineVariableValue(normalizeRoutineVariableValue(variable, variable.defaultValue));
      } catch {
        return true;
      }
    })
    .map((variable) => variable.name);
  if (missingDefaults.length > 0) {
    throw unprocessable(
      `Scheduled routines require defaults for required variables: ${missingDefaults.join(", ")}`,
    );
  }
}

function statusRequiresDefaultAgent(status: string) {
  return status === "active";
}

function normalizeDraftRoutineStatus(status: string, assigneeAgentId: string | null | undefined) {
  if (statusRequiresDefaultAgent(status) && !assigneeAgentId) {
    return "paused";
  }
  return status;
}

function assertRoutineCanEnable(status: string, assigneeAgentId: string | null | undefined) {
  if (statusRequiresDefaultAgent(status) && !assigneeAgentId) {
    throw unprocessable("Default agent required");
  }
}

function collectProvidedRoutineVariables(
  source: "schedule" | "manual" | "api" | "webhook",
  payload: Record<string, unknown> | null | undefined,
  variables: Record<string, unknown> | null | undefined,
) {
  const nestedVariables = isPlainRecord(payload) && isPlainRecord(payload.variables) ? payload.variables : {};
  const provided = {
    ...(source === "webhook" && payload ? payload : {}),
    ...nestedVariables,
    ...(variables ?? {}),
  };
  delete provided.variables;
  return provided;
}

function resolveRoutineVariableValues(
  variables: RoutineVariable[],
  input: {
    source: "schedule" | "manual" | "api" | "webhook";
    payload?: Record<string, unknown> | null;
    variables?: Record<string, unknown> | null;
    automaticVariables?: Record<string, string | number | boolean>;
  },
) {
  if (variables.length === 0) return {} as Record<string, string | number | boolean>;
  const provided = collectProvidedRoutineVariables(input.source, input.payload, input.variables);
  const automaticVariables = input.automaticVariables ?? {};
  const resolved: Record<string, string | number | boolean> = {};
  const missing: string[] = [];

  for (const variable of variables) {
    // Workspace-derived automatic values are authoritative for variables that
    // Paperclip manages from execution context, so callers cannot override them.
    const candidate = automaticVariables[variable.name] !== undefined
      ? automaticVariables[variable.name]
      : provided[variable.name] !== undefined
        ? provided[variable.name]
        : variable.defaultValue;
    const normalized = normalizeRoutineVariableValue(variable, candidate);
    if (normalized == null || (typeof normalized === "string" && normalized.trim().length === 0)) {
      if (variable.required) missing.push(variable.name);
      continue;
    }
    resolved[variable.name] = normalized;
  }

  if (missing.length > 0) {
    throw unprocessable(`Missing routine variables: ${missing.join(", ")}`);
  }

  return resolved;
}

function mergeRoutineRunPayload(
  payload: Record<string, unknown> | null | undefined,
  variables: Record<string, string | number | boolean>,
) {
  if (Object.keys(variables).length === 0) return payload ?? null;
  if (!payload) return { variables };
  const existingVariables = isPlainRecord(payload.variables) ? payload.variables : {};
  return {
    ...payload,
    variables: {
      ...existingVariables,
      ...variables,
    },
  };
}

function normalizeRoutineDispatchFingerprintValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeRoutineDispatchFingerprintValue(item));
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeRoutineDispatchFingerprintValue(value[key])]),
    );
  }
  return String(value);
}

function createRoutineDispatchFingerprint(input: {
  payload: Record<string, unknown> | null;
  projectId: string | null;
  projectWorkspaceId: string | null;
  assigneeAgentId: string | null;
  routineRevisionId: string | null;
  routineEnvFingerprint: string | null;
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
  executionWorkspaceSettings?: Record<string, unknown> | null;
  title: string;
  description: string | null;
}) {
  const canonical = JSON.stringify(normalizeRoutineDispatchFingerprintValue(input));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function createRoutineEnvFingerprint(env: unknown) {
  const canonical = JSON.stringify(normalizeRoutineDispatchFingerprintValue(env ?? null));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function readManagedRoutineIssueTemplate(defaultsJson: Record<string, unknown> | null | undefined) {
  const value = defaultsJson?.issueTemplate;
  if (!isPlainRecord(value)) return null;
  return {
    surfaceVisibility: typeof value.surfaceVisibility === "string" ? value.surfaceVisibility : null,
    originId: typeof value.originId === "string" && value.originId.trim() ? value.originId.trim() : null,
    billingCode: typeof value.billingCode === "string" && value.billingCode.trim() ? value.billingCode.trim() : null,
  };
}

function routineUsesWorkspaceBranch(routine: typeof routines.$inferSelect) {
  return (routine.variables ?? []).some((variable) => variable.name === WORKSPACE_BRANCH_ROUTINE_VARIABLE)
    || extractRoutineVariableNames([routine.title, routine.description]).includes(WORKSPACE_BRANCH_ROUTINE_VARIABLE);
}

function routineRevisionSnapshotRoutine(routine: RoutineRow): RoutineRevisionSnapshotV1["routine"] {
  return {
    id: routine.id,
    companyId: routine.companyId,
    projectId: routine.projectId,
    goalId: routine.goalId,
    parentIssueId: routine.parentIssueId,
    title: routine.title,
    description: routine.description,
    assigneeAgentId: routine.assigneeAgentId,
    priority: routine.priority as RoutineRevisionSnapshotV1["routine"]["priority"],
    status: routine.status as RoutineRevisionSnapshotV1["routine"]["status"],
    concurrencyPolicy: routine.concurrencyPolicy as RoutineRevisionSnapshotV1["routine"]["concurrencyPolicy"],
    catchUpPolicy: routine.catchUpPolicy as RoutineRevisionSnapshotV1["routine"]["catchUpPolicy"],
    variables: routine.variables ?? [],
    env: routine.env ?? null,
    responsibleUserId: routine.responsibleUserId ?? null,
  };
}

function routineRevisionSnapshotTrigger(trigger: RoutineTriggerRow): RoutineRevisionSnapshotV1["triggers"][number] {
  return {
    id: trigger.id,
    kind: trigger.kind as RoutineRevisionSnapshotV1["triggers"][number]["kind"],
    label: trigger.label,
    enabled: trigger.enabled,
    cronExpression: trigger.cronExpression,
    timezone: trigger.timezone,
    publicId: trigger.publicId,
    signingMode: trigger.signingMode as RoutineRevisionSnapshotV1["triggers"][number]["signingMode"],
    replayWindowSec: trigger.replayWindowSec,
  };
}

async function buildRoutineRevisionSnapshot(
  executor: Db,
  routine: RoutineRow,
): Promise<RoutineRevisionSnapshotV1> {
  const triggers = await executor
    .select()
    .from(routineTriggers)
    .where(and(eq(routineTriggers.companyId, routine.companyId), eq(routineTriggers.routineId, routine.id)))
    .orderBy(asc(routineTriggers.createdAt), asc(routineTriggers.id));

  return {
    version: 1,
    routine: routineRevisionSnapshotRoutine(routine),
    triggers: triggers.map(routineRevisionSnapshotTrigger),
  };
}

function canonicalSnapshot(value: RoutineRevisionSnapshotV1) {
  return JSON.stringify(value);
}

function snapshotsMatch(left: RoutineRevisionSnapshotV1, right: RoutineRevisionSnapshotV1) {
  return canonicalSnapshot(left) === canonicalSnapshot(right);
}

function routineCurrentFieldsMatch(left: RoutineRow, right: RoutineRow) {
  return snapshotsMatch(
    { version: 1, routine: routineRevisionSnapshotRoutine(left), triggers: [] },
    { version: 1, routine: routineRevisionSnapshotRoutine(right), triggers: [] },
  );
}

function mapRoutineRevision(row: typeof routineRevisions.$inferSelect): RoutineRevision {
  return {
    ...row,
    snapshot: row.snapshot as RoutineRevisionSnapshotV1,
  };
}

function mapRoutineDescriptionDocument(row: {
  id: string;
  companyId: string;
  routineId: string;
  key: string;
  title: string | null;
  format: string;
  latestBody: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): RoutineDescriptionDocument {
  return {
    id: row.id,
    companyId: row.companyId,
    routineId: row.routineId,
    key: ROUTINE_DESCRIPTION_DOCUMENT_KEY,
    title: row.title,
    format: "markdown",
    body: row.latestBody,
    latestRevisionId: row.latestRevisionId,
    latestRevisionNumber: row.latestRevisionNumber,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    updatedByAgentId: row.updatedByAgentId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function routineService(
  db: Db,
  deps: {
    heartbeat?: IssueAssignmentWakeupDeps;
    pluginWorkerManager?: PluginWorkerManager;
  } = {},
) {
  const issueSvc = issueService(db);
  const secretsSvc = secretService(db);
  const heartbeat = deps.heartbeat ?? heartbeatService(db, {
    pluginWorkerManager: deps.pluginWorkerManager,
  });

  async function getRoutineById(id: string) {
    return db
      .select()
      .from(routines)
      .where(eq(routines.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getManagedRoutineBinding(routine: typeof routines.$inferSelect) {
    return db
      .select({
        pluginKey: pluginManagedResources.pluginKey,
        defaultsJson: pluginManagedResources.defaultsJson,
        manifestJson: plugins.manifestJson,
      })
      .from(pluginManagedResources)
      .innerJoin(plugins, eq(pluginManagedResources.pluginId, plugins.id))
      .where(
        and(
          eq(pluginManagedResources.companyId, routine.companyId),
          eq(pluginManagedResources.resourceKind, "routine"),
          eq(pluginManagedResources.resourceId, routine.id),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function listManagedRoutineMetadata(routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineManagedByPlugin>();
    const rows = await db
      .select({
        id: pluginManagedResources.id,
        pluginId: pluginManagedResources.pluginId,
        pluginKey: pluginManagedResources.pluginKey,
        manifestJson: plugins.manifestJson,
        resourceKey: pluginManagedResources.resourceKey,
        resourceId: pluginManagedResources.resourceId,
        defaultsJson: pluginManagedResources.defaultsJson,
        createdAt: pluginManagedResources.createdAt,
        updatedAt: pluginManagedResources.updatedAt,
      })
      .from(pluginManagedResources)
      .innerJoin(plugins, eq(pluginManagedResources.pluginId, plugins.id))
      .where(
        and(
          eq(pluginManagedResources.resourceKind, "routine"),
          inArray(pluginManagedResources.resourceId, routineIds),
        ),
      );
    return new Map(rows.map((row) => [
      row.resourceId,
      {
        id: row.id,
        pluginId: row.pluginId,
        pluginKey: row.pluginKey,
        pluginDisplayName: row.manifestJson.displayName ?? row.pluginKey,
        resourceKind: "routine",
        resourceKey: row.resourceKey,
        defaultsJson: row.defaultsJson,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      } satisfies RoutineManagedByPlugin,
    ]));
  }

  async function getTriggerById(id: string) {
    return db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getRoutineDescriptionDocument(
    routineId: string,
    executor: Db | any = db,
  ): Promise<RoutineDescriptionDocument | null> {
    const row = await executor
      .select({
        id: documents.id,
        companyId: documents.companyId,
        routineId: routineDocuments.routineId,
        key: routineDocuments.key,
        title: documents.title,
        format: documents.format,
        latestBody: documents.latestBody,
        latestRevisionId: documents.latestRevisionId,
        latestRevisionNumber: documents.latestRevisionNumber,
        createdByAgentId: documents.createdByAgentId,
        createdByUserId: documents.createdByUserId,
        updatedByAgentId: documents.updatedByAgentId,
        updatedByUserId: documents.updatedByUserId,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
      .from(routineDocuments)
      .innerJoin(documents, eq(routineDocuments.documentId, documents.id))
      .where(and(
        eq(routineDocuments.routineId, routineId),
        eq(routineDocuments.key, ROUTINE_DESCRIPTION_DOCUMENT_KEY),
      ))
      .then((rows: any[]) => rows[0] ?? null);
    return row ? mapRoutineDescriptionDocument(row) : null;
  }

  async function upsertRoutineDescriptionDocument(
    executor: Db | any,
    routine: RoutineRow,
    actor: Actor,
    options: { changeSummary?: string | null } = {},
  ): Promise<RoutineDescriptionDocument> {
    if (executor === db) {
      return db.transaction(async (tx) => (
        upsertRoutineDescriptionDocument(tx as unknown as Db, routine, actor, options)
      ));
    }

    const now = new Date();
    const body = routine.description ?? "";
    const existing = await getRoutineDescriptionDocument(routine.id, executor);

    if (existing) {
      if (existing.body === body) return existing;
      const nextRevisionNumber = existing.latestRevisionNumber + 1;
      const [revision] = await executor
        .insert(documentRevisions)
        .values({
          companyId: routine.companyId,
          documentId: existing.id,
          revisionNumber: nextRevisionNumber,
          title: "Routine description",
          format: "markdown",
          body,
          changeSummary: options.changeSummary ?? null,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          createdByRunId: actor.runId ?? null,
          createdAt: now,
        })
        .returning();

      await executor
        .update(documents)
        .set({
          title: "Routine description",
          format: "markdown",
          latestBody: body,
          latestRevisionId: revision.id,
          latestRevisionNumber: nextRevisionNumber,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: now,
        })
        .where(eq(documents.id, existing.id));
      await executor
        .update(routineDocuments)
        .set({ updatedAt: now })
        .where(eq(routineDocuments.documentId, existing.id));

      return {
        ...existing,
        title: "Routine description",
        body,
        latestRevisionId: revision.id,
        latestRevisionNumber: nextRevisionNumber,
        updatedByAgentId: actor.agentId ?? null,
        updatedByUserId: actor.userId ?? null,
        updatedAt: now,
      };
    }

    const [document] = await executor
      .insert(documents)
      .values({
        companyId: routine.companyId,
        title: "Routine description",
        format: "markdown",
        latestBody: body,
        latestRevisionId: null,
        latestRevisionNumber: 1,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        updatedByAgentId: actor.agentId ?? null,
        updatedByUserId: actor.userId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [revision] = await executor
      .insert(documentRevisions)
      .values({
        companyId: routine.companyId,
        documentId: document.id,
        revisionNumber: 1,
        title: "Routine description",
        format: "markdown",
        body,
        changeSummary: options.changeSummary ?? null,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
        createdAt: now,
      })
      .returning();
    await executor
      .update(documents)
      .set({ latestRevisionId: revision.id })
      .where(eq(documents.id, document.id));
    await executor.insert(routineDocuments).values({
      companyId: routine.companyId,
      routineId: routine.id,
      documentId: document.id,
      key: ROUTINE_DESCRIPTION_DOCUMENT_KEY,
      createdAt: now,
      updatedAt: now,
    });

    return {
      id: document.id,
      companyId: routine.companyId,
      routineId: routine.id,
      key: ROUTINE_DESCRIPTION_DOCUMENT_KEY,
      title: document.title,
      format: "markdown",
      body,
      latestRevisionId: revision.id,
      latestRevisionNumber: 1,
      createdByAgentId: document.createdByAgentId,
      createdByUserId: document.createdByUserId,
      updatedByAgentId: document.updatedByAgentId,
      updatedByUserId: document.updatedByUserId,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  }

  async function appendRoutineRevision(
    executor: Db,
    routine: RoutineRow,
    actor: Actor,
    options: {
      changeSummary?: string | null;
      restoredFromRevisionId?: string | null;
    } = {},
  ) {
    const snapshot = await buildRoutineRevisionSnapshot(executor, routine);
    const nextRevisionNumber = routine.latestRevisionId ? routine.latestRevisionNumber + 1 : 1;
    const now = new Date();
    const [revision] = await executor
      .insert(routineRevisions)
      .values({
        companyId: routine.companyId,
        routineId: routine.id,
        revisionNumber: nextRevisionNumber,
        title: snapshot.routine.title,
        description: snapshot.routine.description,
        snapshot,
        changeSummary: options.changeSummary ?? null,
        restoredFromRevisionId: options.restoredFromRevisionId ?? null,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
        responsibleUserId: snapshot.routine.responsibleUserId ?? null,
        createdAt: now,
      })
      .returning();

    const [updatedRoutine] = await executor
      .update(routines)
      .set({
        latestRevisionId: revision.id,
        latestRevisionNumber: nextRevisionNumber,
        updatedAt: now,
      })
      .where(eq(routines.id, routine.id))
      .returning();

    const routineForDocument = updatedRoutine ?? {
      ...routine,
      latestRevisionId: revision.id,
      latestRevisionNumber: nextRevisionNumber,
      updatedAt: now,
    };
    await upsertRoutineDescriptionDocument(executor, routineForDocument, actor, {
      changeSummary: options.changeSummary ?? null,
    });

    return {
      routine: routineForDocument,
      revision: mapRoutineRevision(revision),
    };
  }

  async function assertRoutineAccess(companyId: string, routineId: string) {
    const routine = await getRoutineById(routineId);
    if (!routine) throw notFound("Routine not found");
    if (routine.companyId !== companyId) throw forbidden("Routine must belong to same company");
    return routine;
  }

  async function assertRestorableAssignee(
    companyId: string,
    assigneeAgentId: string | null | undefined,
    actor: Actor,
  ) {
    await assertAssignableAgent(db, companyId, assigneeAgentId, { kind: "routine" });
    if (actor.agentId && assigneeAgentId !== actor.agentId) {
      throw forbidden("Agents can only restore routine revisions assigned to themselves");
    }
  }

  async function assertProject(companyId: string, projectId: string | null | undefined) {
    if (!projectId) return;
    const project = await db
      .select({ id: projects.id, companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
    if (!project) throw notFound("Project not found");
    if (project.companyId !== companyId) throw unprocessable("Project must belong to same company");
  }

  async function assertGoal(companyId: string, goalId: string) {
    const goal = await db
      .select({ id: goals.id, companyId: goals.companyId })
      .from(goals)
      .where(eq(goals.id, goalId))
      .then((rows) => rows[0] ?? null);
    if (!goal) throw notFound("Goal not found");
    if (goal.companyId !== companyId) throw unprocessable("Goal must belong to same company");
  }

  async function assertParentIssue(companyId: string, issueId: string) {
    const parentIssue = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!parentIssue) throw notFound("Parent issue not found");
    if (parentIssue.companyId !== companyId) throw unprocessable("Parent issue must belong to same company");
  }

  async function listTriggersForRoutineIds(companyId: string, routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineTrigger[]>();
    const rows = await db
      .select()
      .from(routineTriggers)
      .where(and(eq(routineTriggers.companyId, companyId), inArray(routineTriggers.routineId, routineIds)))
      .orderBy(asc(routineTriggers.createdAt), asc(routineTriggers.id));
    const map = new Map<string, RoutineTrigger[]>();
    for (const row of rows) {
      const list = map.get(row.routineId) ?? [];
      list.push(row);
      map.set(row.routineId, list);
    }
    return map;
  }

  async function listLatestRunByRoutineIds(companyId: string, routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineRunSummary>();
    const rows = await db
      .selectDistinctOn([routineRuns.routineId], {
        id: routineRuns.id,
        companyId: routineRuns.companyId,
        routineId: routineRuns.routineId,
        triggerId: routineRuns.triggerId,
        source: routineRuns.source,
        status: routineRuns.status,
        triggeredAt: routineRuns.triggeredAt,
        idempotencyKey: routineRuns.idempotencyKey,
        triggerPayload: routineRuns.triggerPayload,
        dispatchFingerprint: routineRuns.dispatchFingerprint,
        routineRevisionId: routineRuns.routineRevisionId,
        linkedIssueId: routineRuns.linkedIssueId,
        coalescedIntoRunId: routineRuns.coalescedIntoRunId,
        failureReason: routineRuns.failureReason,
        completedAt: routineRuns.completedAt,
        createdAt: routineRuns.createdAt,
        updatedAt: routineRuns.updatedAt,
        triggerKind: routineTriggers.kind,
        triggerLabel: routineTriggers.label,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
        issueStatus: issues.status,
        issuePriority: issues.priority,
        issueUpdatedAt: issues.updatedAt,
      })
      .from(routineRuns)
      .leftJoin(routineTriggers, eq(routineRuns.triggerId, routineTriggers.id))
      .leftJoin(issues, eq(routineRuns.linkedIssueId, issues.id))
      .where(and(eq(routineRuns.companyId, companyId), inArray(routineRuns.routineId, routineIds)))
      .orderBy(routineRuns.routineId, desc(routineRuns.createdAt), desc(routineRuns.id));

    const map = new Map<string, RoutineRunSummary>();
    for (const row of rows) {
      map.set(row.routineId, {
        id: row.id,
        companyId: row.companyId,
        routineId: row.routineId,
        triggerId: row.triggerId,
        source: row.source as RoutineRunSummary["source"],
        status: row.status as RoutineRunSummary["status"],
        triggeredAt: row.triggeredAt,
        idempotencyKey: row.idempotencyKey,
        triggerPayload: row.triggerPayload as Record<string, unknown> | null,
        dispatchFingerprint: row.dispatchFingerprint,
        routineRevisionId: row.routineRevisionId,
        linkedIssueId: row.linkedIssueId,
        coalescedIntoRunId: row.coalescedIntoRunId,
        failureReason: row.failureReason,
        completedAt: row.completedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        linkedIssue: row.linkedIssueId
          ? {
            id: row.linkedIssueId,
            identifier: row.issueIdentifier,
            title: row.issueTitle ?? "Routine execution",
            status: row.issueStatus ?? "todo",
            priority: row.issuePriority ?? "medium",
            updatedAt: row.issueUpdatedAt ?? row.updatedAt,
          }
          : null,
        trigger: row.triggerId
          ? {
            id: row.triggerId,
            kind: row.triggerKind as NonNullable<RoutineRunSummary["trigger"]>["kind"],
            label: row.triggerLabel,
          }
          : null,
      });
    }
    return map;
  }

  async function listLiveIssueByRoutineIds(companyId: string, routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineListItem["activeIssue"]>();
    const executionBoundRows = await db
      .selectDistinctOn([issues.originId], {
        originId: issues.originId,
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, issues.executionRunId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
        ),
      )
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "routine_execution"),
          inArray(issues.originId, routineIds),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(issues.originId, desc(issues.updatedAt), desc(issues.createdAt));

    const rowsByOriginId = new Map<string, (typeof executionBoundRows)[number]>();
    for (const row of executionBoundRows) {
      if (!row.originId) continue;
      rowsByOriginId.set(row.originId, row);
    }

    const missingRoutineIds = routineIds.filter((routineId) => !rowsByOriginId.has(routineId));
    if (missingRoutineIds.length > 0) {
      const legacyRows = await db
        .selectDistinctOn([issues.originId], {
          originId: issues.originId,
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .innerJoin(
          heartbeatRuns,
          and(
            eq(heartbeatRuns.companyId, issues.companyId),
            inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = cast(${issues.id} as text)`,
          ),
        )
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, "routine_execution"),
            inArray(issues.originId, missingRoutineIds),
            inArray(issues.status, OPEN_ISSUE_STATUSES),
            isNull(issues.hiddenAt),
          ),
        )
        .orderBy(issues.originId, desc(issues.updatedAt), desc(issues.createdAt));

      for (const row of legacyRows) {
        if (!row.originId) continue;
        rowsByOriginId.set(row.originId, row);
      }
    }

    const map = new Map<string, RoutineListItem["activeIssue"]>();
    for (const row of rowsByOriginId.values()) {
      if (!row.originId) continue;
      map.set(row.originId, {
        id: row.id,
        identifier: row.identifier,
        title: row.title,
        status: row.status,
        priority: row.priority,
        updatedAt: row.updatedAt,
      });
    }
    return map;
  }

  async function updateRoutineTouchedState(input: {
    routineId: string;
    triggerId?: string | null;
    triggeredAt: Date;
    status: string;
    issueId?: string | null;
    nextRunAt?: Date | null;
  }, executor: Db = db) {
    await executor
      .update(routines)
      .set({
        lastTriggeredAt: input.triggeredAt,
        lastEnqueuedAt: input.issueId ? input.triggeredAt : undefined,
        updatedAt: new Date(),
      })
      .where(eq(routines.id, input.routineId));

    if (input.triggerId) {
      await executor
        .update(routineTriggers)
        .set({
          lastFiredAt: input.triggeredAt,
          lastResult: nextResultText(input.status, input.issueId),
          nextRunAt: input.nextRunAt === undefined ? undefined : input.nextRunAt,
          updatedAt: new Date(),
        })
        .where(eq(routineTriggers.id, input.triggerId));
    }
  }

  // Records a skipped scheduled firing without creating an execution issue. Used when the
  // routine's project is paused: the tick is still claimed/advanced upstream (no backfill),
  // and run history + trigger audit reflect the pause-specific skip.
  async function recordSuppressedScheduleRun(input: {
    routine: typeof routines.$inferSelect;
    trigger: typeof routineTriggers.$inferSelect;
    reason: string;
    nextRunAt: Date | null;
  }) {
    const triggeredAt = new Date();
    const run = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const [createdRun] = await txDb
        .insert(routineRuns)
        .values({
          companyId: input.routine.companyId,
          routineId: input.routine.id,
          triggerId: input.trigger.id,
          source: "schedule",
          status: "skipped",
          triggeredAt,
          failureReason: input.reason,
          completedAt: triggeredAt,
          linkedIssueId: null,
          routineRevisionId: input.routine.latestRevisionId,
          responsibleUserId: input.routine.responsibleUserId ?? null,
        })
        .returning();
      await updateRoutineTouchedState({
        routineId: input.routine.id,
        triggerId: input.trigger.id,
        triggeredAt,
        status: "skipped_paused",
        nextRunAt: input.nextRunAt,
      }, txDb);
      return createdRun;
    });

    try {
      await logActivity(db, {
        companyId: input.routine.companyId,
        actorType: "system",
        actorId: "routine-scheduler",
        action: "routine.run_skipped",
        entityType: "routine_run",
        entityId: run.id,
        details: {
          routineId: input.routine.id,
          triggerId: input.trigger.id,
          source: "schedule",
          status: "skipped",
          reason: input.reason,
        },
      });
    } catch (err) {
      logger.warn({ err, routineId: input.routine.id, runId: run.id }, "failed to log skipped routine run");
    }

    return run;
  }

  function routineExecutionFingerprintCondition(dispatchFingerprint?: string | null) {
    if (!dispatchFingerprint) return null;
    // The "default" arm preserves coalescing against pre-migration open issues.
    // It becomes inert once those legacy routine execution issues drain out.
    return or(
      eq(issues.originFingerprint, dispatchFingerprint),
      eq(issues.originFingerprint, "default"),
    );
  }

  async function findLiveExecutionIssue(
    routine: typeof routines.$inferSelect,
    executor: Db = db,
    dispatchFingerprint?: string | null,
    origin?: { kind: string; id: string | null },
  ) {
    const fingerprintCondition = routineExecutionFingerprintCondition(dispatchFingerprint);
    const originKind = origin?.kind ?? "routine_execution";
    const originId = origin?.id ?? routine.id;
    const executionBoundIssue = await executor
      .select()
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, issues.executionRunId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
        ),
      )
      .where(
        and(
          eq(issues.companyId, routine.companyId),
          eq(issues.originKind, originKind),
          eq(issues.originId, originId),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
          ...(fingerprintCondition ? [fingerprintCondition] : []),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.issues ?? null);
    if (executionBoundIssue) return executionBoundIssue;

    return executor
      .select()
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.companyId, issues.companyId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = cast(${issues.id} as text)`,
        ),
      )
      .where(
        and(
          eq(issues.companyId, routine.companyId),
          eq(issues.originKind, originKind),
          eq(issues.originId, originId),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
          ...(fingerprintCondition ? [fingerprintCondition] : []),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.issues ?? null);
  }

  // Finds an open routine execution issue that has NO non-terminal runs behind it — the shape a
  // killed agent run leaves behind.
  //
  // It never reaches the skip branch: findLiveExecutionIssue inner-joins live runs, so it returns
  // null and the tick sails past. It does not collide on the issue insert either, because a fresh
  // issue has a null execution_run_id and `issues_open_routine_execution_uq` only covers non-null
  // ones. The collision surfaces later, when the assignment wakeup checks the new issue out and
  // sets execution_run_id — which failed the whole dispatch far from its cause.
  //
  // Scoped to routine_execution origin so no hand-made issue can be caught by it, and to
  // `in_progress` specifically. That status restriction is the important one: `in_review` and
  // `blocked` are open-with-no-live-run too, but they are deliberate parks — an agent waiting on
  // an operator answer or a sibling issue — and cancelling those destroys real state. Only
  // `in_progress` with a terminal execution run is unambiguously a run that died mid-work with
  // nothing left to wake it.
  async function findRunlessExecutionIssue(
    routine: typeof routines.$inferSelect,
    executor: Db,
    dispatchFingerprint: string | null | undefined,
    origin: { kind: string; id: string | null },
  ) {
    const fingerprintCondition = routineExecutionFingerprintCondition(dispatchFingerprint);
    return executor
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, routine.companyId),
          eq(issues.originKind, origin.kind),
          origin.id ? eq(issues.originId, origin.id) : sql`false`,
          eq(issues.status, "in_progress"),
          isNull(issues.hiddenAt),
          isNotNull(issues.executionRunId),
          ...(fingerprintCondition ? [fingerprintCondition] : []),
          // Belt and braces against a run appearing between findLiveExecutionIssue and here: if
          // anything non-terminal is attached, this is not a runless issue and must not be reaped.
          sql`not exists (
            select 1 from ${heartbeatRuns} hr
            where hr.company_id = ${issues.companyId}
              and hr.status in ('queued', 'running', 'scheduled_retry')
              and (hr.id = ${issues.executionRunId}
                or hr.context_snapshot ->> 'issueId' = cast(${issues.id} as text))
          )`,
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  // Returns the runs pinning `issue` only when EVERY one of them is demonstrably dead, i.e. a
  // scheduled retry that was never started and whose due time has long passed — the promoter
  // will never pick it up, so `skip_if_active` would otherwise skip on it forever.
  //
  // Deliberately narrow: a `running` (or merely queued, or not-yet-due) run is real work in
  // flight and must keep its pin. Stalled `running` runs are already handled by the heartbeat
  // liveness/recovery path, so this guard does not duplicate that.
  //
  // The rows are locked FOR UPDATE because promoteDueScheduledRetry flips `scheduled_retry` to
  // `queued` outside this transaction. Without the lock, READ COMMITTED lets us decide "dead" on
  // a snapshot that a concurrent promotion has already invalidated, and then cancel a run that
  // is about to start.
  async function findDeadExecutionPinRuns(
    issue: typeof issues.$inferSelect,
    executor: Db,
    now: Date,
    nextRunAt?: Date | null,
  ) {
    const pinningRuns = await executor
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        lastOutputAt: heartbeatRuns.lastOutputAt,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, issue.companyId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
          or(
            issue.executionRunId ? eq(heartbeatRuns.id, issue.executionRunId) : undefined,
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = cast(${issue.id} as text)`,
          ),
        ),
      )
      .for("update");

    if (pinningRuns.length === 0) return null;

    // Shared by both arms. `status` must be asserted explicitly: promotion to `queued` leaves
    // scheduledRetryAt and startedAt untouched, so a just-promoted run is otherwise
    // indistinguishable from a dead one on every other field.
    const untouchedRetries = pinningRuns.every((run) =>
      run.status === "scheduled_retry"
      && run.startedAt === null
      && run.lastOutputAt === null
      && run.scheduledRetryAt !== null
    );
    if (!untouchedRetries) return null;

    const retryDueAtMs = (run: (typeof pinningRuns)[number]) => new Date(run.scheduledRetryAt!).getTime();

    const deadlineMs = now.getTime() - STALE_EXECUTION_PIN_GRACE_MS;
    if (pinningRuns.every((run) => retryDueAtMs(run) <= deadlineMs)) {
      return { runs: pinningRuns, reason: "overdue_retry" as const };
    }

    // A retry due at or after the next tick cannot produce work sooner than simply letting this
    // tick through, so holding the pin for it only costs ticks. Requires a scheduled trigger:
    // for manual/webhook dispatch there is no "next tick" to compare against and the arm is
    // inert by construction.
    if (nextRunAt && pinningRuns.every((run) => retryDueAtMs(run) >= nextRunAt.getTime())) {
      return { runs: pinningRuns, reason: "redundant_retry" as const };
    }

    return null;
  }

  // Cancels the dead pin and terminalises its execution issue so the tick that follows creates
  // exactly one new execution issue rather than racing a second one against the stale pin.
  //
  // Returns null — abandoning the whole reap — if any pinning run no longer matches the shape we
  // decided on. Losing a tick to a needless skip is cheap; cancelling a run that has just started
  // is not, so the cancel is all-or-nothing and mismatch falls through to the normal skip.
  async function releaseDeadExecutionPin(input: {
    routine: typeof routines.$inferSelect;
    issue: typeof issues.$inferSelect;
    deadRuns: NonNullable<Awaited<ReturnType<typeof findDeadExecutionPinRuns>>>;
    now: Date;
    executor: Db;
  }) {
    const { runs: deadRuns, reason } = input.deadRuns;
    const runIds = deadRuns.map((run) => run.id);
    const overdueBy = deadRuns
      .map((run) => (run.scheduledRetryAt ? input.now.getTime() - new Date(run.scheduledRetryAt).getTime() : 0))
      .reduce((max, value) => Math.max(max, value), 0);
    const overdueMinutes = Math.round(overdueBy / 60_000);

    // Subquery guard, not just a per-row predicate: a per-row `WHERE status = 'scheduled_retry'`
    // would cancel the subset that still matches and leave the rest pinning the issue. Counting
    // first makes the statement match all rows or none.
    const stillDead = input.executor
      .select({ value: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(
        and(
          inArray(heartbeatRuns.id, runIds),
          eq(heartbeatRuns.status, "scheduled_retry"),
          isNull(heartbeatRuns.startedAt),
        ),
      );

    const cancelledRuns = await input.executor
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: input.now,
        error: reason === "overdue_retry"
          ? "Scheduled retry never started and is past due; cancelled by the routine staleness guard"
          : "Scheduled retry never started and is not due before the next scheduled tick; cancelled by the routine staleness guard",
        errorCode: STALE_EXECUTION_PIN_ERROR_CODE,
        scheduledRetryAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          inArray(heartbeatRuns.id, runIds),
          eq(heartbeatRuns.status, "scheduled_retry"),
          isNull(heartbeatRuns.startedAt),
          sql`(${stillDead}) = ${runIds.length}`,
        ),
      )
      .returning({ id: heartbeatRuns.id });

    if (cancelledRuns.length !== runIds.length) {
      logger.info(
        { issueId: input.issue.id, routineId: input.routine.id, runIds, cancelled: cancelledRuns.length },
        "abandoned stale routine execution pin release: a pinning run changed under the guard",
      );
      return null;
    }

    const timingLine = reason === "overdue_retry"
      ? `- Retry was due ${overdueMinutes} minute(s) ago and was never promoted`
      : `- Retry was not due until at or after the next scheduled tick, so waiting on it could not run this routine any sooner`;
    const comment = [
      "This routine execution issue was pinned by a scheduled retry that never started, so the routine could not run.",
      "",
      `- Stale run(s): ${runIds.length > 0 ? runIds.map((id) => `\`${id}\``).join(", ") : "_none_"}`,
      timingLine,
      `- Reap reason: \`${reason}\``,
      "",
      "The stale run has been cancelled and this issue closed so the routine can schedule a fresh execution.",
    ].join("\n");

    try {
      await issueSvc.addComment(input.issue.id, comment, {}, undefined, input.executor);
    } catch (err) {
      logger.warn(
        { err, issueId: input.issue.id, routineId: input.routine.id },
        "failed to comment on stale routine execution issue",
      );
    }

    await issueSvc.update(input.issue.id, { status: "cancelled" }, input.executor);

    return { runIds, overdueMinutes, reason };
  }

  // Terminalises a runless open execution issue so this tick's issue can be created and checked
  // out without colliding on issues_open_routine_execution_uq.
  //
  // Deliberately NOT on the dispatch transaction: issueSvc.create runs on its own connection, so
  // an uncommitted cancel here would leave that connection blocking on our row lock while we wait
  // on it — a self-deadlock. Committing first is also the convergent outcome: the issue has no
  // live runs, so nothing will ever move it, and cancelling it is correct even if the surrounding
  // dispatch later rolls back.
  //
  // The status guard makes it idempotent — a concurrent dispatch that reaped the same row first
  // updates zero rows and we report no reap rather than double-commenting.
  async function releaseRunlessExecutionIssue(input: {
    routine: typeof routines.$inferSelect;
    issue: typeof issues.$inferSelect;
    now: Date;
  }): Promise<StalePinRelease | null> {
    const claimed = await db
      .update(issues)
      .set({ status: "cancelled", updatedAt: input.now })
      .where(and(eq(issues.id, input.issue.id), eq(issues.status, "in_progress")))
      .returning({ id: issues.id });

    if (claimed.length === 0) {
      logger.info(
        { issueId: input.issue.id, routineId: input.routine.id },
        "abandoned runless routine execution issue release: issue was no longer in_progress",
      );
      return null;
    }

    const comment = [
      "This routine execution issue was left open with no runs still in flight, so it blocked the routine from creating a new execution issue.",
      "",
      `- Execution run: ${input.issue.executionRunId ? `\`${input.issue.executionRunId}\`` : "_none_"}`,
      "- No queued, running or scheduled-retry run was attached, so nothing was ever going to advance it",
      "- Reap reason: `runless_issue`",
      "",
      "This issue has been cancelled so the routine can schedule a fresh execution.",
    ].join("\n");

    try {
      await issueSvc.addComment(input.issue.id, comment, {}, undefined, db);
    } catch (err) {
      logger.warn(
        { err, issueId: input.issue.id, routineId: input.routine.id },
        "failed to comment on runless routine execution issue",
      );
    }

    return { issueId: input.issue.id, runIds: [], overdueMinutes: 0, reason: "runless_issue" };
  }

  async function finalizeRun(runId: string, patch: Partial<typeof routineRuns.$inferInsert>, executor: Db = db) {
    return executor
      .update(routineRuns)
      .set({
        ...patch,
        updatedAt: new Date(),
      })
      .where(eq(routineRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function createWebhookSecret(
    companyId: string,
    routineId: string,
    actor: Actor,
    executor?: Db,
  ) {
    const secretValue = crypto.randomBytes(24).toString("hex");
    const providerId = getConfiguredSecretProvider();
    const input = {
      name: `routine-${routineId}-${crypto.randomBytes(6).toString("hex")}`,
      provider: providerId,
      value: secretValue,
      description: `Webhook auth for routine ${routineId}`,
    };
    const provider = getSecretProvider(input.provider);
    const prepared = await provider.createSecret({
      value: input.value,
      externalRef: null,
      context: {
        companyId,
        secretKey: input.name,
        secretName: input.name,
        version: 1,
      },
    });

    const insertSecret = async (secretDb: Db) => {
      const secret = await secretDb
        .insert(companySecrets)
        .values({
          companyId,
          key: input.name,
          name: input.name,
          provider: input.provider,
          status: "active",
          managedMode: "paperclip_managed",
          externalRef: prepared.externalRef,
          providerMetadata: null,
          latestVersion: 1,
          description: input.description,
          lastRotatedAt: new Date(),
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
        })
        .returning()
        .then((rows) => rows[0]);

      await secretDb.insert(companySecretVersions).values({
        secretId: secret.id,
        version: 1,
        material: prepared.material,
        valueSha256: prepared.valueSha256,
        fingerprintSha256: prepared.fingerprintSha256 ?? prepared.valueSha256,
        providerVersionRef: prepared.providerVersionRef ?? null,
        status: "current",
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      });

      await secretDb.insert(companySecretBindings).values({
        companyId,
        secretId: secret.id,
        targetType: "routine",
        targetId: routineId,
        configPath: routineWebhookSecretConfigPath(secret.id),
      });

      return secret;
    };

    const secret = executor
      ? await insertSecret(executor)
      : await db.transaction(async (tx) => insertSecret(tx as unknown as Db));
    return { secret, secretValue };
  }

  async function resolveTriggerSecret(trigger: typeof routineTriggers.$inferSelect, companyId: string) {
    if (!trigger.secretId) throw notFound("Routine trigger secret not found");
    const secret = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, trigger.secretId))
      .then((rows) => rows[0] ?? null);
    if (!secret || secret.companyId !== companyId) throw notFound("Routine trigger secret not found");
    const value = await secretsSvc.resolveSecretValue(companyId, trigger.secretId, "latest", {
      consumerType: "routine",
      consumerId: trigger.routineId,
      actorType: "system",
      actorId: null,
      configPath: routineWebhookSecretConfigPath(trigger.secretId),
    });
    return value;
  }

  async function touchIssueForUserInbox(
    executor: Db,
    input: {
      companyId: string;
      issueId: string;
      userId: string;
      touchedAt: Date;
    },
  ) {
    await executor
      .insert(issueReadStates)
      .values({
        companyId: input.companyId,
        issueId: input.issueId,
        userId: input.userId,
        lastReadAt: input.touchedAt,
        updatedAt: input.touchedAt,
      })
      .onConflictDoUpdate({
        target: [issueReadStates.companyId, issueReadStates.issueId, issueReadStates.userId],
        set: {
          lastReadAt: input.touchedAt,
          updatedAt: input.touchedAt,
        },
      });

    await executor
      .delete(issueInboxArchives)
      .where(
        and(
          eq(issueInboxArchives.companyId, input.companyId),
          eq(issueInboxArchives.issueId, input.issueId),
          eq(issueInboxArchives.userId, input.userId),
        ),
      );
  }

  async function dispatchRoutineRun(input: {
    routine: typeof routines.$inferSelect;
    trigger: typeof routineTriggers.$inferSelect | null;
    source: "schedule" | "manual" | "api" | "webhook";
    payload?: Record<string, unknown> | null;
    variables?: Record<string, unknown> | null;
    projectId?: string | null;
    projectWorkspaceId?: string | null;
    assigneeAgentId?: string | null;
    idempotencyKey?: string | null;
    executionWorkspaceId?: string | null;
    executionWorkspacePreference?: string | null;
    executionWorkspaceSettings?: Record<string, unknown> | null;
    descriptionAppendix?: string | null;
    actor?: Actor;
  }) {
    const projectId = input.projectId ?? input.routine.projectId ?? null;
    const projectWorkspaceId = input.projectWorkspaceId ?? null;
    const assigneeAgentId = input.assigneeAgentId ?? input.routine.assigneeAgentId ?? null;
    if (!assigneeAgentId) {
      throw unprocessable("Default agent required");
    }
    await assertAssignableAgent(db, input.routine.companyId, assigneeAgentId, { kind: "routine" });
    const automaticVariables: Record<string, string | number | boolean> = {};
    if (input.executionWorkspaceId && routineUsesWorkspaceBranch(input.routine)) {
      const workspace = await db
        .select({
          branchName: executionWorkspaces.branchName,
          mode: executionWorkspaces.mode,
        })
        .from(executionWorkspaces)
        .where(
          and(
            eq(executionWorkspaces.id, input.executionWorkspaceId),
            eq(executionWorkspaces.companyId, input.routine.companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      const branchName = workspace?.branchName?.trim();
      if (workspace && workspace.mode !== "shared_workspace" && branchName) {
        automaticVariables[WORKSPACE_BRANCH_ROUTINE_VARIABLE] = branchName;
      }
    }
    const resolvedVariables = resolveRoutineVariableValues(input.routine.variables ?? [], {
      ...input,
      automaticVariables,
    });
    const allVariables = { ...getBuiltinRoutineVariableValues(), ...automaticVariables, ...resolvedVariables };
    const title = interpolateRoutineTemplate(input.routine.title, allVariables) ?? input.routine.title;
    const baseDescription = interpolateRoutineTemplate(input.routine.description, allVariables);
    const description = [baseDescription, input.descriptionAppendix]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join("\n\n");
    const triggerPayload = mergeRoutineRunPayload(input.payload, { ...automaticVariables, ...resolvedVariables });
    const managedRoutineBinding = await getManagedRoutineBinding(input.routine);
    const managedIssueTemplate = readManagedRoutineIssueTemplate(managedRoutineBinding?.defaultsJson);
    const issueOriginKind = managedIssueTemplate?.surfaceVisibility === "plugin_operation" && managedRoutineBinding
      ? pluginOperationIssueOriginKind(managedRoutineBinding.pluginKey)
      : "routine_execution";
    const issueOriginId = managedIssueTemplate?.originId ?? input.routine.id;
    const issueBillingCode = managedIssueTemplate?.billingCode ?? null;
    const dispatchFingerprint = createRoutineDispatchFingerprint({
      payload: triggerPayload,
      projectId,
      projectWorkspaceId,
      assigneeAgentId,
      routineRevisionId: input.routine.latestRevisionId,
      routineEnvFingerprint: createRoutineEnvFingerprint(input.routine.env),
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      executionWorkspacePreference: input.executionWorkspacePreference ?? null,
      executionWorkspaceSettings: input.executionWorkspaceSettings ?? null,
      title,
      description,
    });
    // Boxed so the assignment inside the transaction callback survives control-flow narrowing.
    const stalePinRelease: { value: StalePinRelease | null } = { value: null };
    const run = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await tx.execute(
        sql`select id from ${routines} where ${routines.id} = ${input.routine.id} and ${routines.companyId} = ${input.routine.companyId} for update`,
      );

      if (input.idempotencyKey) {
        const existing = await txDb
          .select()
          .from(routineRuns)
          .where(
            and(
              eq(routineRuns.companyId, input.routine.companyId),
              eq(routineRuns.routineId, input.routine.id),
              eq(routineRuns.source, input.source),
              eq(routineRuns.idempotencyKey, input.idempotencyKey),
              input.trigger ? eq(routineRuns.triggerId, input.trigger.id) : isNull(routineRuns.triggerId),
            ),
          )
          .orderBy(desc(routineRuns.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (existing) return existing;
      }

      const triggeredAt = new Date();
      const manualRunnerUserId = input.source === "manual" ? input.actor?.userId ?? null : null;
      const latestRevisionResponsibleUserId = input.routine.latestRevisionId
        ? await txDb
            .select({
              responsibleUserId: routineRevisions.responsibleUserId,
              snapshot: routineRevisions.snapshot,
            })
            .from(routineRevisions)
            .where(and(
              eq(routineRevisions.companyId, input.routine.companyId),
              eq(routineRevisions.routineId, input.routine.id),
              eq(routineRevisions.id, input.routine.latestRevisionId),
            ))
            .then((rows) => {
              const row = rows[0] ?? null;
              const snapshot = row?.snapshot as RoutineRevisionSnapshotV1 | undefined;
              return row?.responsibleUserId ?? snapshot?.routine.responsibleUserId ?? null;
            })
        : null;
      const responsibleUserId =
        manualRunnerUserId ?? latestRevisionResponsibleUserId ?? input.routine.responsibleUserId ?? null;
      const [createdRun] = await txDb
        .insert(routineRuns)
        .values({
          companyId: input.routine.companyId,
          routineId: input.routine.id,
          triggerId: input.trigger?.id ?? null,
          source: input.source,
          status: "received",
          triggeredAt,
          idempotencyKey: input.idempotencyKey ?? null,
          triggerPayload,
          dispatchFingerprint,
          routineRevisionId: input.routine.latestRevisionId,
          responsibleUserId,
        })
        .returning();

      const nextRunAt = input.trigger?.kind === "schedule" && input.trigger.cronExpression && input.trigger.timezone
        ? nextCronTickInTimeZone(input.trigger.cronExpression, input.trigger.timezone, triggeredAt)
        : undefined;

      let createdIssue: Awaited<ReturnType<typeof issueSvc.create>> | null = null;
      try {
        let activeIssue: typeof issues.$inferSelect | null = await findLiveExecutionIssue(
          input.routine,
          txDb,
          dispatchFingerprint,
          { kind: issueOriginKind, id: issueOriginId },
        );
        if (activeIssue && input.routine.concurrencyPolicy !== "always_enqueue") {
          const deadRuns = await findDeadExecutionPinRuns(activeIssue, txDb, triggeredAt, nextRunAt);
          if (deadRuns) {
            const released = await releaseDeadExecutionPin({
              routine: input.routine,
              issue: activeIssue,
              deadRuns,
              now: triggeredAt,
              executor: txDb,
            });
            if (released) {
              stalePinRelease.value = { issueId: activeIssue.id, ...released };
              activeIssue = null;
            }
          }
        }
        if (activeIssue && input.routine.concurrencyPolicy !== "always_enqueue") {
          const status = input.routine.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
          if (manualRunnerUserId) {
            await touchIssueForUserInbox(txDb, {
              companyId: input.routine.companyId,
              issueId: activeIssue.id,
              userId: manualRunnerUserId,
              touchedAt: triggeredAt,
            });
          }
          const updated = await finalizeRun(createdRun.id, {
            status,
            linkedIssueId: activeIssue.id,
            coalescedIntoRunId: activeIssue.originRunId,
            completedAt: triggeredAt,
          }, txDb);
          await updateRoutineTouchedState({
            routineId: input.routine.id,
            triggerId: input.trigger?.id ?? null,
            triggeredAt,
            status,
            issueId: activeIssue.id,
            nextRunAt,
          }, txDb);
          return updated ?? createdRun;
        }

        // Nothing live is pinning us, but an earlier execution issue can still be sitting open
        // with every one of its runs terminal — the shape a killed agent leaves
        // behind. It is invisible to findLiveExecutionIssue (which inner-joins live runs), so the
        // tick sails past the skip branch, and it does NOT collide on this insert either: a new
        // issue has a null execution_run_id and the unique index only covers non-null ones. The
        // collision lands later, when the assignment wakeup checks the issue out and sets
        // execution_run_id — far from here, and it fails the whole dispatch. So reap it up front.
        if (input.routine.concurrencyPolicy !== "always_enqueue") {
          const runlessIssue = await findRunlessExecutionIssue(input.routine, txDb, dispatchFingerprint, {
            kind: issueOriginKind,
            id: issueOriginId,
          });
          if (runlessIssue) {
            const released = await releaseRunlessExecutionIssue({
              routine: input.routine,
              issue: runlessIssue,
              now: triggeredAt,
            });
            if (released) stalePinRelease.value = released;
          }
        }

        const executionIssueInput = {
          projectId,
          projectWorkspaceId,
          goalId: input.routine.goalId,
          parentId: input.routine.parentIssueId,
          title,
          description,
          status: "todo" as const,
          priority: input.routine.priority,
          assigneeAgentId,
          createdByAgentId: input.source === "manual" ? input.actor?.agentId ?? null : null,
          createdByUserId: manualRunnerUserId,
          responsibleUserId,
          trustExplicitResponsibleUserId: true,
          originKind: issueOriginKind,
          originId: issueOriginId,
          originRunId: createdRun.id,
          originFingerprint: dispatchFingerprint,
          billingCode: issueBillingCode,
          executionWorkspaceId: input.executionWorkspaceId ?? null,
          executionWorkspacePreference: input.executionWorkspacePreference ?? null,
          executionWorkspaceSettings: input.executionWorkspaceSettings ?? null,
        };

        try {
          createdIssue = await issueSvc.create(input.routine.companyId, executionIssueInput);
        } catch (error) {
          const isOpenExecutionConflict =
            !!error &&
            typeof error === "object" &&
            "code" in error &&
            (error as { code?: string }).code === "23505" &&
            "constraint" in error &&
            (error as { constraint?: string }).constraint === "issues_open_routine_execution_uq";
          if (!isOpenExecutionConflict || input.routine.concurrencyPolicy === "always_enqueue") {
            throw error;
          }

          const existingIssue = await findLiveExecutionIssue(input.routine, txDb, dispatchFingerprint, {
            kind: issueOriginKind,
            id: issueOriginId,
          });
          if (existingIssue) {
            const status = input.routine.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
            if (manualRunnerUserId) {
              await touchIssueForUserInbox(txDb, {
                companyId: input.routine.companyId,
                issueId: existingIssue.id,
                userId: manualRunnerUserId,
                touchedAt: triggeredAt,
              });
            }
            const updated = await finalizeRun(createdRun.id, {
              status,
              linkedIssueId: existingIssue.id,
              coalescedIntoRunId: existingIssue.originRunId,
              completedAt: triggeredAt,
            }, txDb);
            await updateRoutineTouchedState({
              routineId: input.routine.id,
              triggerId: input.trigger?.id ?? null,
              triggeredAt,
              status,
              issueId: existingIssue.id,
              nextRunAt,
            }, txDb);
            return updated ?? createdRun;
          }

          throw error;
        }

        // Keep the dispatch lock until the issue is linked to a queued heartbeat run.
        await queueIssueAssignmentWakeup({
          heartbeat,
          issue: createdIssue,
          reason: "issue_assigned",
          mutation: "create",
          contextSource: "routine.dispatch",
          requestedByActorType: input.source === "schedule" ? "system" : undefined,
          rethrowOnError: true,
        });
        const updated = await finalizeRun(createdRun.id, {
          status: "issue_created",
          linkedIssueId: createdIssue.id,
        }, txDb);
        await updateRoutineTouchedState({
          routineId: input.routine.id,
          triggerId: input.trigger?.id ?? null,
          triggeredAt,
          // Distinct result text so a routine that had to break a stale pin stops reporting as
          // plainly healthy on the triggers list.
          status: stalePinRelease.value ? "issue_created_after_stale_pin_release" : "issue_created",
          issueId: createdIssue.id,
          nextRunAt,
        }, txDb);
        return updated ?? createdRun;
      } catch (error) {
        if (createdIssue) {
          await txDb.delete(issues).where(eq(issues.id, createdIssue.id));
        }
        const failureReason = error instanceof Error ? error.message : String(error);
        const failed = await finalizeRun(createdRun.id, {
          status: "failed",
          failureReason,
          completedAt: new Date(),
        }, txDb);
        await updateRoutineTouchedState({
          routineId: input.routine.id,
          triggerId: input.trigger?.id ?? null,
          triggeredAt,
          status: "failed",
          nextRunAt,
        }, txDb);
        return failed ?? createdRun;
      }
    });

    const releasedStalePin = stalePinRelease.value;
    if (releasedStalePin) {
      try {
        await logActivity(db, {
          companyId: input.routine.companyId,
          actorType: "system",
          actorId: "routine-scheduler",
          action: "routine.stale_execution_pin_released",
          entityType: "issue",
          entityId: releasedStalePin.issueId,
          details: {
            routineId: input.routine.id,
            triggerId: input.trigger?.id ?? null,
            runId: run.id,
            staleRunIds: releasedStalePin.runIds,
            overdueMinutes: releasedStalePin.overdueMinutes,
            reason: releasedStalePin.reason,
          },
        });
      } catch (err) {
        logger.warn(
          { err, routineId: input.routine.id, issueId: releasedStalePin.issueId },
          "failed to log stale routine execution pin release",
        );
      }
    }

    if (input.source === "schedule" || input.source === "webhook") {
      const actorId = input.source === "schedule" ? "routine-scheduler" : "routine-webhook";
      try {
        await logActivity(db, {
          companyId: input.routine.companyId,
          actorType: "system",
          actorId,
          action: "routine.run_triggered",
          entityType: "routine_run",
          entityId: run.id,
          details: {
            routineId: input.routine.id,
            triggerId: input.trigger?.id ?? null,
            source: run.source,
            status: run.status,
          },
        });
      } catch (err) {
        logger.warn({ err, routineId: input.routine.id, runId: run.id }, "failed to log automated routine run");
      }
    }

    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackRoutineRun(telemetryClient, {
        source: run.source,
        status: run.status,
      });
    }

    return run;
  }

  return {
    get: getRoutineById,
    getTrigger: getTriggerById,

    list: async (
      companyId: string,
      filters?: { projectId?: string | null },
    ): Promise<RoutineListItem[]> => {
      const conditions = [eq(routines.companyId, companyId)];
      if (filters?.projectId) conditions.push(eq(routines.projectId, filters.projectId));

      const rows = await db
        .select()
        .from(routines)
        .where(and(...conditions))
        .orderBy(desc(routines.updatedAt), asc(routines.title));
      const routineIds = rows.map((row) => row.id);
      const [triggersByRoutine, latestRunByRoutine, activeIssueByRoutine, managedByRoutine] = await Promise.all([
        listTriggersForRoutineIds(companyId, routineIds),
        listLatestRunByRoutineIds(companyId, routineIds),
        listLiveIssueByRoutineIds(companyId, routineIds),
        listManagedRoutineMetadata(routineIds),
      ]);
      return rows.map((row) => ({
        ...row,
        managedByPlugin: managedByRoutine.get(row.id) ?? null,
        triggers: (triggersByRoutine.get(row.id) ?? []).map((trigger) => ({
          id: trigger.id,
          kind: trigger.kind as RoutineListItem["triggers"][number]["kind"],
          label: trigger.label,
          enabled: trigger.enabled,
          cronExpression: trigger.cronExpression,
          timezone: trigger.timezone,
          nextRunAt: trigger.nextRunAt,
          lastFiredAt: trigger.lastFiredAt,
          lastResult: trigger.lastResult,
        })),
        lastRun: latestRunByRoutine.get(row.id) ?? null,
        activeIssue: activeIssueByRoutine.get(row.id) ?? null,
      }));
    },

    getDetail: async (id: string): Promise<RoutineDetail | null> => {
      const row = await getRoutineById(id);
      if (!row) return null;
      const [project, assignee, parentIssue, descriptionDocument, triggers, recentRuns, activeIssue, managedByRoutine] = await Promise.all([
        row.projectId
          ? db.select().from(projects).where(eq(projects.id, row.projectId)).then((rows) => rows[0] ?? null)
          : null,
        row.assigneeAgentId
          ? db.select().from(agents).where(eq(agents.id, row.assigneeAgentId)).then((rows) => rows[0] ?? null)
          : null,
        row.parentIssueId ? issueSvc.getById(row.parentIssueId) : null,
        getRoutineDescriptionDocument(row.id),
        db.select().from(routineTriggers).where(eq(routineTriggers.routineId, row.id)).orderBy(asc(routineTriggers.createdAt)),
        db
          .select({
            id: routineRuns.id,
            companyId: routineRuns.companyId,
            routineId: routineRuns.routineId,
            triggerId: routineRuns.triggerId,
            source: routineRuns.source,
            status: routineRuns.status,
            triggeredAt: routineRuns.triggeredAt,
            idempotencyKey: routineRuns.idempotencyKey,
            triggerPayload: routineRuns.triggerPayload,
            dispatchFingerprint: routineRuns.dispatchFingerprint,
            routineRevisionId: routineRuns.routineRevisionId,
            linkedIssueId: routineRuns.linkedIssueId,
            coalescedIntoRunId: routineRuns.coalescedIntoRunId,
            failureReason: routineRuns.failureReason,
            completedAt: routineRuns.completedAt,
            createdAt: routineRuns.createdAt,
            updatedAt: routineRuns.updatedAt,
            triggerKind: routineTriggers.kind,
            triggerLabel: routineTriggers.label,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
            issueStatus: issues.status,
            issuePriority: issues.priority,
            issueUpdatedAt: issues.updatedAt,
          })
          .from(routineRuns)
          .leftJoin(routineTriggers, eq(routineRuns.triggerId, routineTriggers.id))
          .leftJoin(issues, eq(routineRuns.linkedIssueId, issues.id))
          .where(eq(routineRuns.routineId, row.id))
          .orderBy(desc(routineRuns.createdAt))
          .limit(25)
          .then((runs) =>
            runs.map((run) => ({
              id: run.id,
              companyId: run.companyId,
              routineId: run.routineId,
              triggerId: run.triggerId,
              source: run.source as RoutineRunSummary["source"],
              status: run.status as RoutineRunSummary["status"],
              triggeredAt: run.triggeredAt,
              idempotencyKey: run.idempotencyKey,
              triggerPayload: run.triggerPayload as Record<string, unknown> | null,
              dispatchFingerprint: run.dispatchFingerprint,
              routineRevisionId: run.routineRevisionId,
              linkedIssueId: run.linkedIssueId,
              coalescedIntoRunId: run.coalescedIntoRunId,
              failureReason: run.failureReason,
              completedAt: run.completedAt,
              createdAt: run.createdAt,
              updatedAt: run.updatedAt,
              linkedIssue: run.linkedIssueId
                ? {
                  id: run.linkedIssueId,
                  identifier: run.issueIdentifier,
                  title: run.issueTitle ?? "Routine execution",
                  status: run.issueStatus ?? "todo",
                  priority: run.issuePriority ?? "medium",
                  updatedAt: run.issueUpdatedAt ?? run.updatedAt,
                }
                : null,
              trigger: run.triggerId
                ? {
                  id: run.triggerId,
                  kind: run.triggerKind as NonNullable<RoutineRunSummary["trigger"]>["kind"],
                  label: run.triggerLabel,
                }
                : null,
            })),
          ),
        findLiveExecutionIssue(row),
        listManagedRoutineMetadata([row.id]),
      ]);

      return {
        ...row,
        managedByPlugin: managedByRoutine.get(row.id) ?? null,
        project,
        assignee,
        parentIssue,
        descriptionDocument,
        triggers: triggers as RoutineTrigger[],
        recentRuns,
        activeIssue,
      };
    },

    getDescriptionDocument: async (routineId: string) => getRoutineDescriptionDocument(routineId),

    create: async (companyId: string, input: CreateRoutine, actor: Actor): Promise<Routine> => {
      await assertProject(companyId, input.projectId ?? null);
      await assertAssignableAgent(db, companyId, input.assigneeAgentId ?? null, { kind: "routine" });
      if (input.goalId) await assertGoal(companyId, input.goalId);
      if (input.parentIssueId) await assertParentIssue(companyId, input.parentIssueId);
      const env = input.env === undefined || input.env === null
        ? null
        : await secretsSvc.normalizeEnvBindingsForPersistence(companyId, input.env, {
            strictMode: process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true",
            fieldPath: "env",
          });
      const variables = syncRoutineVariablesWithTemplate(
        [input.title, input.description],
        sanitizeRoutineVariableInputs(input.variables),
      );
      assertRoutineVariableDefinitions(variables);
      const status = normalizeDraftRoutineStatus(input.status, input.assigneeAgentId);
      const responsibleUserId = await resolveRoutineResponsibleUserId(db, companyId, actor.userId, input.parentIssueId ?? null);
      if (!responsibleUserId) {
        throw unprocessable("Routine requires a responsible user");
      }
      const createdRoutine = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const [created] = await txDb
          .insert(routines)
          .values({
            companyId,
            projectId: input.projectId ?? null,
            goalId: input.goalId ?? null,
            parentIssueId: input.parentIssueId ?? null,
            title: input.title,
            description: input.description ?? null,
            assigneeAgentId: input.assigneeAgentId ?? null,
            priority: input.priority,
            status,
            concurrencyPolicy: input.concurrencyPolicy,
            catchUpPolicy: input.catchUpPolicy,
            variables,
            env,
            responsibleUserId,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
          })
          .returning();
        const { routine } = await appendRoutineRevision(txDb, created, actor, {
          changeSummary: "Created routine",
        });
        if (env) {
          await secretsSvc.syncEnvBindingsForTarget(
            companyId,
            { targetType: "routine", targetId: routine.id },
            env,
            { db: tx },
          );
        }
        return routine;
      });
      return createdRoutine;
    },

    update: async (id: string, patch: UpdateRoutine, actor: Actor): Promise<Routine | null> => {
      const existing = await getRoutineById(id);
      if (!existing) return null;
      const nextProjectId = patch.projectId === undefined ? existing.projectId : patch.projectId;
      const nextAssigneeAgentId = patch.assigneeAgentId === undefined ? existing.assigneeAgentId : patch.assigneeAgentId;
      const nextTitle = patch.title ?? existing.title;
      const nextDescription = patch.description === undefined ? existing.description : patch.description;
      const nextEnv = patch.env === undefined
        ? existing.env
        : patch.env === null
          ? null
          : await secretsSvc.normalizeEnvBindingsForPersistence(existing.companyId, patch.env, {
              strictMode: process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true",
              fieldPath: "env",
            });
      const requestedStatus = patch.status ?? existing.status;
      if (patch.status === "active") {
        assertRoutineCanEnable(patch.status, nextAssigneeAgentId);
      }
      const nextStatus = patch.assigneeAgentId === undefined
        ? requestedStatus
        : normalizeDraftRoutineStatus(requestedStatus, nextAssigneeAgentId);
      const nextVariables = syncRoutineVariablesWithTemplate(
        [nextTitle, nextDescription],
        patch.variables === undefined ? existing.variables : sanitizeRoutineVariableInputs(patch.variables),
      );
      if (patch.projectId !== undefined) await assertProject(existing.companyId, nextProjectId);
      if (patch.assigneeAgentId !== undefined || patch.status === "active") {
        await assertAssignableAgent(db, existing.companyId, nextAssigneeAgentId, { kind: "routine" });
      }
      if (patch.goalId) await assertGoal(existing.companyId, patch.goalId);
      if (patch.parentIssueId) await assertParentIssue(existing.companyId, patch.parentIssueId);
      assertRoutineVariableDefinitions(nextVariables);
      const enabledScheduleTriggers = await db
        .select({ id: routineTriggers.id })
        .from(routineTriggers)
        .where(
          and(
            eq(routineTriggers.routineId, existing.id),
            eq(routineTriggers.kind, "schedule"),
            eq(routineTriggers.enabled, true),
          ),
        )
        .limit(1)
        .then((rows) => rows.length > 0);
      if (enabledScheduleTriggers) {
        assertScheduleCompatibleVariables(nextVariables);
      }
      const responsibleUserId = await resolveRoutineResponsibleUserId(
        db,
        existing.companyId,
        actor.userId,
        patch.parentIssueId === undefined ? existing.parentIssueId : patch.parentIssueId,
      );
      if (!responsibleUserId) {
        throw unprocessable("Routine requires a responsible user");
      }
      const updatedRoutine = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${id} for update`);
        const locked = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, id))
          .then((rows) => rows[0] ?? null);
        if (!locked) return null;

        if (patch.baseRevisionId && patch.baseRevisionId !== locked.latestRevisionId) {
          throw conflict("Routine was updated by someone else", {
            currentRevisionId: locked.latestRevisionId,
          });
        }

        const candidate: RoutineRow = {
          ...locked,
          projectId: nextProjectId,
          goalId: patch.goalId === undefined ? locked.goalId : patch.goalId,
          parentIssueId: patch.parentIssueId === undefined ? locked.parentIssueId : patch.parentIssueId,
          title: nextTitle,
          description: nextDescription,
          assigneeAgentId: nextAssigneeAgentId,
          priority: patch.priority ?? locked.priority,
          status: nextStatus,
          concurrencyPolicy: patch.concurrencyPolicy ?? locked.concurrencyPolicy,
          catchUpPolicy: patch.catchUpPolicy ?? locked.catchUpPolicy,
          variables: nextVariables,
          env: nextEnv,
          responsibleUserId: locked.responsibleUserId ?? responsibleUserId,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
        };

        if (locked.latestRevisionId && routineCurrentFieldsMatch(locked, candidate)) {
          return locked;
        }

        const nextSnapshot = await buildRoutineRevisionSnapshot(txDb, candidate);
        if (locked.latestRevisionId) {
          const latestRevision = await txDb
            .select({ snapshot: routineRevisions.snapshot })
            .from(routineRevisions)
            .where(
              and(
                eq(routineRevisions.companyId, locked.companyId),
                eq(routineRevisions.routineId, locked.id),
                eq(routineRevisions.id, locked.latestRevisionId),
              ),
            )
            .then((rows) => rows[0] ?? null);
          if (latestRevision && snapshotsMatch(nextSnapshot, latestRevision.snapshot as RoutineRevisionSnapshotV1)) {
            if (patch.env !== undefined) {
              await secretsSvc.syncEnvBindingsForTarget(
                locked.companyId,
                { targetType: "routine", targetId: locked.id },
                candidate.env,
                { db: tx },
              );
            }
            return locked;
          }
        }

        const [updated] = await txDb
          .update(routines)
          .set({
            projectId: candidate.projectId,
            goalId: candidate.goalId,
            parentIssueId: candidate.parentIssueId,
            title: candidate.title,
            description: candidate.description,
            assigneeAgentId: candidate.assigneeAgentId,
            priority: candidate.priority,
            status: candidate.status,
            concurrencyPolicy: candidate.concurrencyPolicy,
            catchUpPolicy: candidate.catchUpPolicy,
            variables: candidate.variables,
            env: candidate.env,
            responsibleUserId: candidate.responsibleUserId,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(routines.id, id))
          .returning();
        if (!updated) return null;
        const { routine } = await appendRoutineRevision(txDb, updated, actor, {
          changeSummary: "Updated routine",
        });
        if (patch.env !== undefined) {
          await secretsSvc.syncEnvBindingsForTarget(
            routine.companyId,
            { targetType: "routine", targetId: routine.id },
            routine.env,
            { db: tx },
          );
        }
        return routine;
      });
      return updatedRoutine;
    },

    createTrigger: async (
      routineId: string,
      input: CreateRoutineTrigger,
      actor: Actor,
    ): Promise<{ trigger: RoutineTrigger; secretMaterial: RoutineTriggerSecretMaterial | null; revision: RoutineRevision }> => {
      const routine = await getRoutineById(routineId);
      if (!routine) throw notFound("Routine not found");

      let secretMaterial: RoutineTriggerSecretMaterial | null = null;
      let secretId: string | null = null;
      let publicId: string | null = null;
      let nextRunAt: Date | null = null;

      if (input.kind === "schedule") {
        assertScheduleCompatibleVariables(routine.variables ?? []);
        const timeZone = input.timezone || "UTC";
        assertTimeZone(timeZone);
        const error = validateCron(input.cronExpression);
        if (error) throw unprocessable(error);
        nextRunAt = nextCronTickInTimeZone(input.cronExpression, timeZone, new Date());
      }

      if (input.kind === "webhook") {
        publicId = crypto.randomBytes(12).toString("hex");
        const created = await createWebhookSecret(routine.companyId, routine.id, actor);
        secretId = created.secret.id;
        secretMaterial = {
          webhookUrl: `${process.env.PAPERCLIP_API_URL}/api/routine-triggers/public/${publicId}/fire`,
          webhookSecret: created.secretValue,
        };
      }

      const { trigger, revision } = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${routine.id} for update`);
        const [createdTrigger] = await txDb
          .insert(routineTriggers)
          .values({
            companyId: routine.companyId,
            routineId: routine.id,
            kind: input.kind,
            label: input.label ?? null,
            enabled: input.enabled ?? true,
            cronExpression: input.kind === "schedule" ? input.cronExpression : null,
            timezone: input.kind === "schedule" ? (input.timezone || "UTC") : null,
            nextRunAt,
            publicId,
            secretId,
            signingMode: input.kind === "webhook" ? input.signingMode : null,
            replayWindowSec: input.kind === "webhook" ? input.replayWindowSec : null,
            lastRotatedAt: input.kind === "webhook" ? new Date() : null,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
          })
          .returning();
        const latestRoutine = await txDb.select().from(routines).where(eq(routines.id, routine.id)).then((rows) => rows[0] ?? routine);
        const appended = await appendRoutineRevision(txDb, latestRoutine, actor, {
          changeSummary: `Created ${input.kind} trigger`,
        });
        return { trigger: createdTrigger, revision: appended.revision };
      });

      return {
        trigger: trigger as RoutineTrigger,
        secretMaterial,
        revision,
      };
    },

    updateTrigger: async (
      id: string,
      patch: UpdateRoutineTrigger,
      actor: Actor,
    ): Promise<{ trigger: RoutineTrigger; revision: RoutineRevision } | null> => {
      const existing = await getTriggerById(id);
      if (!existing) return null;

      let nextRunAt = existing.nextRunAt;
      let cronExpression = existing.cronExpression;
      let timezone = existing.timezone;

      if (existing.kind === "schedule") {
        const routine = await getRoutineById(existing.routineId);
        if (!routine) throw notFound("Routine not found");
        if (patch.cronExpression !== undefined) {
          if (patch.cronExpression == null) throw unprocessable("Scheduled triggers require cronExpression");
          const error = validateCron(patch.cronExpression);
          if (error) throw unprocessable(error);
          cronExpression = patch.cronExpression;
        }
        if (patch.timezone !== undefined) {
          if (patch.timezone == null) throw unprocessable("Scheduled triggers require timezone");
          assertTimeZone(patch.timezone);
          timezone = patch.timezone;
        }
        if (cronExpression && timezone) {
          nextRunAt = nextCronTickInTimeZone(cronExpression, timezone, new Date());
        }
        if ((patch.enabled ?? existing.enabled) === true) {
          assertScheduleCompatibleVariables(routine.variables ?? []);
        }
      }

      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${existing.routineId} for update`);
        const [updated] = await txDb
          .update(routineTriggers)
          .set({
            label: patch.label === undefined ? existing.label : patch.label,
            enabled: patch.enabled ?? existing.enabled,
            cronExpression,
            timezone,
            nextRunAt,
            signingMode: patch.signingMode === undefined ? existing.signingMode : patch.signingMode,
            replayWindowSec: patch.replayWindowSec === undefined ? existing.replayWindowSec : patch.replayWindowSec,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(routineTriggers.id, id))
          .returning();
        if (!updated) return null;
        const routine = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, existing.routineId))
          .then((rows) => rows[0] ?? null);
        if (!routine) throw notFound("Routine not found");
        const appended = await appendRoutineRevision(txDb, routine, actor, {
          changeSummary: `Updated ${existing.kind} trigger`,
        });
        return { trigger: updated as RoutineTrigger, revision: appended.revision };
      });
      return result;
    },

    deleteTrigger: async (id: string, actor: Actor = {}): Promise<{ deleted: boolean; revision: RoutineRevision | null }> => {
      const existing = await getTriggerById(id);
      if (!existing) return { deleted: false, revision: null };
      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${existing.routineId} for update`);
        await txDb.delete(routineTriggers).where(eq(routineTriggers.id, id));
        const routine = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, existing.routineId))
          .then((rows) => rows[0] ?? null);
        if (!routine) throw notFound("Routine not found");
        const appended = await appendRoutineRevision(txDb, routine, actor, {
          changeSummary: `Deleted ${existing.kind} trigger`,
        });
        return { deleted: true, revision: appended.revision };
      });
      if (result.deleted && existing.secretId) {
        try {
          await secretsSvc.remove(existing.secretId);
        } catch (err) {
          logger.warn(
            { err, routineId: existing.routineId, triggerId: existing.id, secretId: existing.secretId },
            "failed to remove routine trigger webhook secret after trigger deletion",
          );
        }
      }
      return result;
    },

    rotateTriggerSecret: async (
      id: string,
      actor: Actor,
    ): Promise<{ trigger: RoutineTrigger; secretMaterial: RoutineTriggerSecretMaterial; revision: RoutineRevision }> => {
      const existing = await getTriggerById(id);
      if (!existing) throw notFound("Routine trigger not found");
      if (existing.kind !== "webhook" || !existing.publicId || !existing.secretId) {
        throw unprocessable("Only webhook triggers can rotate secrets");
      }

      const secretValue = crypto.randomBytes(24).toString("hex");
      await secretsSvc.rotate(existing.secretId, { value: secretValue }, actor);
      const { trigger, revision } = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${existing.routineId} for update`);
        const [updated] = await txDb
          .update(routineTriggers)
          .set({
            lastRotatedAt: new Date(),
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(routineTriggers.id, id))
          .returning();
        const routine = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, existing.routineId))
          .then((rows) => rows[0] ?? null);
        if (!routine) throw notFound("Routine not found");
        const appended = await appendRoutineRevision(txDb, routine, actor, {
          changeSummary: "Rotated webhook trigger secret",
        });
        return { trigger: updated, revision: appended.revision };
      });

      return {
        trigger: trigger as RoutineTrigger,
        secretMaterial: {
          webhookUrl: `${process.env.PAPERCLIP_API_URL}/api/routine-triggers/public/${existing.publicId}/fire`,
          webhookSecret: secretValue,
        },
        revision,
      };
    },

    listRevisions: async (routineId: string): Promise<RoutineRevision[]> => {
      const routine = await getRoutineById(routineId);
      if (!routine) throw notFound("Routine not found");
      const rows = await db
        .select()
        .from(routineRevisions)
        .where(and(eq(routineRevisions.companyId, routine.companyId), eq(routineRevisions.routineId, routine.id)))
        .orderBy(desc(routineRevisions.revisionNumber), desc(routineRevisions.createdAt))
        .limit(MAX_ROUTINE_REVISIONS);
      return rows.map(mapRoutineRevision);
    },

    restoreRevision: async (
      routineId: string,
      revisionId: string,
      actor: Actor,
    ): Promise<{
      routine: Routine;
      revision: RoutineRevision;
      restoredFromRevisionId: string;
      restoredFromRevisionNumber: number;
      secretMaterials: RoutineTriggerSecretRestoreMaterial[];
    }> => {
      const existingRoutine = await getRoutineById(routineId);
      if (!existingRoutine) throw notFound("Routine not found");
      const targetRevision = await db
        .select()
        .from(routineRevisions)
        .where(
          and(
            eq(routineRevisions.companyId, existingRoutine.companyId),
            eq(routineRevisions.routineId, existingRoutine.id),
            eq(routineRevisions.id, revisionId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!targetRevision) throw notFound("Routine revision not found");

      const snapshot = targetRevision.snapshot as RoutineRevisionSnapshotV1;
      const routineSnapshot = snapshot.routine;
      await assertRestorableAssignee(existingRoutine.companyId, routineSnapshot.assigneeAgentId, actor);

      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${existingRoutine.id} for update`);
        const locked = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, existingRoutine.id))
          .then((rows) => rows[0] ?? null);
        if (!locked) throw notFound("Routine not found");
        if (locked.latestRevisionId === targetRevision.id) {
          throw conflict("Selected revision is already the latest revision", {
            currentRevisionId: locked.latestRevisionId,
          });
        }

        const currentTriggers = await txDb
          .select({ id: routineTriggers.id })
          .from(routineTriggers)
          .where(and(eq(routineTriggers.companyId, locked.companyId), eq(routineTriggers.routineId, locked.id)));
        const currentTriggerIds = new Set(currentTriggers.map((trigger) => trigger.id));
        const missingWebhookTriggers = snapshot.triggers
          .filter((trigger) => trigger.kind === "webhook" && !currentTriggerIds.has(trigger.id));
        const recreatedWebhookSecrets = new Map<string, { publicId: string; secretId: string; secretMaterial: RoutineTriggerSecretRestoreMaterial }>();
        for (const trigger of missingWebhookTriggers) {
          const publicId = crypto.randomBytes(12).toString("hex");
          const created = await createWebhookSecret(locked.companyId, locked.id, actor, txDb);
          recreatedWebhookSecrets.set(trigger.id, {
            publicId,
            secretId: created.secret.id,
            secretMaterial: {
              triggerId: trigger.id,
              webhookUrl: `${process.env.PAPERCLIP_API_URL}/api/routine-triggers/public/${publicId}/fire`,
              webhookSecret: created.secretValue,
            },
          });
        }

        const now = new Date();
        const [restoredRoutine] = await txDb
          .update(routines)
          .set({
            projectId: routineSnapshot.projectId,
            goalId: routineSnapshot.goalId,
            parentIssueId: routineSnapshot.parentIssueId,
            title: routineSnapshot.title,
            description: routineSnapshot.description,
            assigneeAgentId: routineSnapshot.assigneeAgentId,
            priority: routineSnapshot.priority,
            status: routineSnapshot.status,
            concurrencyPolicy: routineSnapshot.concurrencyPolicy,
            catchUpPolicy: routineSnapshot.catchUpPolicy,
            variables: routineSnapshot.variables,
            env: routineSnapshot.env,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: now,
          })
          .where(eq(routines.id, locked.id))
          .returning();

        const snapshotTriggerIds = new Set(snapshot.triggers.map((trigger) => trigger.id));
        if (snapshotTriggerIds.size === 0) {
          await txDb
            .delete(routineTriggers)
            .where(and(eq(routineTriggers.companyId, locked.companyId), eq(routineTriggers.routineId, locked.id)));
        } else {
          await txDb
            .delete(routineTriggers)
            .where(
              and(
                eq(routineTriggers.companyId, locked.companyId),
                eq(routineTriggers.routineId, locked.id),
                not(inArray(routineTriggers.id, snapshot.triggers.map((trigger) => trigger.id))),
              ),
            );
        }

        for (const triggerSnapshot of snapshot.triggers) {
          const current = await txDb
            .select()
            .from(routineTriggers)
            .where(and(eq(routineTriggers.companyId, locked.companyId), eq(routineTriggers.id, triggerSnapshot.id)))
            .then((rows) => rows[0] ?? null);
          const webhookSecret = recreatedWebhookSecrets.get(triggerSnapshot.id);
          const restoredNextRunAt = triggerSnapshot.kind === "schedule" && triggerSnapshot.enabled
            && triggerSnapshot.cronExpression && triggerSnapshot.timezone
            ? nextCronTickInTimeZone(triggerSnapshot.cronExpression, triggerSnapshot.timezone, now)
            : null;
          const baseValues = {
            companyId: locked.companyId,
            routineId: locked.id,
            kind: triggerSnapshot.kind,
            label: triggerSnapshot.label,
            enabled: triggerSnapshot.enabled,
            cronExpression: triggerSnapshot.kind === "schedule" ? triggerSnapshot.cronExpression : null,
            timezone: triggerSnapshot.kind === "schedule" ? triggerSnapshot.timezone : null,
            publicId: triggerSnapshot.kind === "webhook" ? (current?.publicId ?? webhookSecret?.publicId ?? triggerSnapshot.publicId) : null,
            secretId: triggerSnapshot.kind === "webhook" ? (current?.secretId ?? webhookSecret?.secretId ?? null) : null,
            signingMode: triggerSnapshot.kind === "webhook" ? triggerSnapshot.signingMode : null,
            replayWindowSec: triggerSnapshot.kind === "webhook" ? triggerSnapshot.replayWindowSec : null,
            nextRunAt: restoredNextRunAt,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: now,
          };
          if (current) {
            await txDb.update(routineTriggers).set(baseValues).where(eq(routineTriggers.id, triggerSnapshot.id));
          } else {
            await txDb.insert(routineTriggers).values({
              id: triggerSnapshot.id,
              ...baseValues,
              createdByAgentId: actor.agentId ?? null,
              createdByUserId: actor.userId ?? null,
              createdAt: now,
            });
          }
        }

        const appended = await appendRoutineRevision(txDb, restoredRoutine ?? locked, actor, {
          changeSummary: `Restored from revision ${targetRevision.revisionNumber}`,
          restoredFromRevisionId: targetRevision.id,
        });
        await secretsSvc.syncEnvBindingsForTarget(
          locked.companyId,
          { targetType: "routine", targetId: locked.id },
          routineSnapshot.env,
          { db: tx },
        );
        return {
          routine: appended.routine,
          revision: appended.revision,
          restoredFromRevisionId: targetRevision.id,
          restoredFromRevisionNumber: targetRevision.revisionNumber,
          secretMaterials: [...recreatedWebhookSecrets.values()].map((entry) => entry.secretMaterial),
        };
      });
      return result;
    },

    runRoutine: async (id: string, input: RunRoutine, actor?: Actor) => {
      const routine = await getRoutineById(id);
      if (!routine) throw notFound("Routine not found");
      if (routine.status === "archived") throw conflict("Routine is archived");
      await assertProject(routine.companyId, input.projectId ?? null);
      const assigneeAgentId = input.assigneeAgentId ?? routine.assigneeAgentId ?? null;
      await assertAssignableAgent(db, routine.companyId, assigneeAgentId, { kind: "routine" });
      const trigger = input.triggerId ? await getTriggerById(input.triggerId) : null;
      if (trigger && trigger.routineId !== routine.id) throw forbidden("Trigger does not belong to routine");
      if (trigger && !trigger.enabled) throw conflict("Routine trigger is not active");
      return dispatchRoutineRun({
        routine,
        trigger,
        source: input.source,
        payload: input.payload as Record<string, unknown> | null | undefined,
        variables: input.variables as Record<string, unknown> | null | undefined,
        projectId: input.projectId ?? null,
        projectWorkspaceId: input.projectWorkspaceId ?? null,
        assigneeAgentId: input.assigneeAgentId ?? null,
        idempotencyKey: input.idempotencyKey,
        executionWorkspaceId: input.executionWorkspaceId ?? null,
        executionWorkspacePreference: input.executionWorkspacePreference ?? null,
        executionWorkspaceSettings:
          (input.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? null,
        actor,
      });
    },

    runPipelineStageEntryRoutine: async (id: string, input: RunRoutine & { descriptionAppendix?: string | null }, actor?: Actor) => {
      const routine = await getRoutineById(id);
      if (!routine) throw notFound("Routine not found");
      if (routine.status === "archived") throw conflict("Routine is archived");
      await assertProject(routine.companyId, input.projectId ?? null);
      const assigneeAgentId = input.assigneeAgentId ?? routine.assigneeAgentId ?? null;
      await assertAssignableAgent(db, routine.companyId, assigneeAgentId, { kind: "routine" });
      return dispatchRoutineRun({
        routine,
        trigger: null,
        source: "api",
        payload: input.payload as Record<string, unknown> | null | undefined,
        variables: input.variables as Record<string, unknown> | null | undefined,
        projectId: input.projectId ?? null,
        projectWorkspaceId: input.projectWorkspaceId ?? null,
        assigneeAgentId: input.assigneeAgentId ?? null,
        idempotencyKey: input.idempotencyKey,
        executionWorkspaceId: input.executionWorkspaceId ?? null,
        executionWorkspacePreference: input.executionWorkspacePreference ?? null,
        executionWorkspaceSettings:
          (input.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? null,
        descriptionAppendix: input.descriptionAppendix ?? null,
        actor,
      });
    },

    firePublicTrigger: async (publicId: string, input: {
      authorizationHeader?: string | null;
      signatureHeader?: string | null;
      hubSignatureHeader?: string | null;
      timestampHeader?: string | null;
      idempotencyKey?: string | null;
      rawBody?: Buffer | null;
      payload?: Record<string, unknown> | null;
    }) => {
      const trigger = await db
        .select()
        .from(routineTriggers)
        .where(and(eq(routineTriggers.publicId, publicId), eq(routineTriggers.kind, "webhook")))
        .then((rows) => rows[0] ?? null);
      if (!trigger) throw notFound("Routine trigger not found");
      const routine = await getRoutineById(trigger.routineId);
      if (!routine) throw notFound("Routine not found");
      if (!trigger.enabled || routine.status !== "active") throw conflict("Routine trigger is not active");

      if (trigger.signingMode === "none") {
        // No authentication — the publicId in the URL acts as a shared secret.
      } else if (trigger.signingMode === "github_hmac") {
        const secretValue = await resolveTriggerSecret(trigger, routine.companyId);
        const rawBody = input.rawBody ?? Buffer.from(JSON.stringify(input.payload ?? {}));
        // Accept X-Hub-Signature-256 (GitHub/Sentry) or fall back to the
        // generic X-Paperclip-Signature header so operators can use github_hmac
        // mode with either header convention.
        const providedSignature = (input.hubSignatureHeader ?? input.signatureHeader)?.trim() ?? "";
        if (!providedSignature) throw unauthorized();
        const expectedHmac = crypto
          .createHmac("sha256", secretValue)
          .update(rawBody)
          .digest("hex");
        const normalizedSignature = providedSignature.replace(/^sha256=/, "");
        const normalizedBuf = Buffer.from(normalizedSignature);
        const expectedBuf = Buffer.from(expectedHmac);
        const valid =
          normalizedBuf.length === expectedBuf.length &&
          crypto.timingSafeEqual(normalizedBuf, expectedBuf);
        if (!valid) throw unauthorized();
      } else if (trigger.signingMode === "bearer") {
        const secretValue = await resolveTriggerSecret(trigger, routine.companyId);
        const expected = `Bearer ${secretValue}`;
        const provided = input.authorizationHeader?.trim() ?? "";
        const expectedBuf = Buffer.from(expected);
        const providedBuf = Buffer.alloc(expectedBuf.length);
        providedBuf.write(provided.slice(0, expectedBuf.length));
        const valid =
          provided.length === expected.length &&
          crypto.timingSafeEqual(providedBuf, expectedBuf);
        if (!valid) {
          throw unauthorized();
        }
      } else {
        const secretValue = await resolveTriggerSecret(trigger, routine.companyId);
        const rawBody = input.rawBody ?? Buffer.from(JSON.stringify(input.payload ?? {}));
        const providedSignature = input.signatureHeader?.trim() ?? "";
        const providedTimestamp = input.timestampHeader?.trim() ?? "";
        if (!providedSignature || !providedTimestamp) throw unauthorized();
        const tsMillis = normalizeWebhookTimestampMs(providedTimestamp);
        if (tsMillis == null) throw unauthorized();
        const replayWindowSec = trigger.replayWindowSec ?? 300;
        if (Math.abs(Date.now() - tsMillis) > replayWindowSec * 1000) {
          throw unauthorized();
        }
        const expectedHmac = crypto
          .createHmac("sha256", secretValue)
          .update(`${providedTimestamp}.`)
          .update(rawBody)
          .digest("hex");
        const normalizedSignature = providedSignature.replace(/^sha256=/, "");
        const valid =
          normalizedSignature.length === expectedHmac.length &&
          crypto.timingSafeEqual(Buffer.from(normalizedSignature), Buffer.from(expectedHmac));
        if (!valid) throw unauthorized();
      }

      return dispatchRoutineRun({
        routine,
        trigger,
        source: "webhook",
        payload: input.payload,
        variables: isPlainRecord(input.payload) && isPlainRecord(input.payload.variables)
          ? input.payload.variables
          : null,
        idempotencyKey: input.idempotencyKey,
      });
    },

    listRuns: async (routineId: string, limit = 50): Promise<RoutineRunSummary[]> => {
      const cappedLimit = Math.max(1, Math.min(limit, 200));
      const rows = await db
        .select({
          id: routineRuns.id,
          companyId: routineRuns.companyId,
          routineId: routineRuns.routineId,
          triggerId: routineRuns.triggerId,
          source: routineRuns.source,
          status: routineRuns.status,
          triggeredAt: routineRuns.triggeredAt,
          idempotencyKey: routineRuns.idempotencyKey,
          triggerPayload: routineRuns.triggerPayload,
          dispatchFingerprint: routineRuns.dispatchFingerprint,
          routineRevisionId: routineRuns.routineRevisionId,
          linkedIssueId: routineRuns.linkedIssueId,
          coalescedIntoRunId: routineRuns.coalescedIntoRunId,
          failureReason: routineRuns.failureReason,
          completedAt: routineRuns.completedAt,
          createdAt: routineRuns.createdAt,
          updatedAt: routineRuns.updatedAt,
          triggerKind: routineTriggers.kind,
          triggerLabel: routineTriggers.label,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
          issueStatus: issues.status,
          issuePriority: issues.priority,
          issueUpdatedAt: issues.updatedAt,
        })
        .from(routineRuns)
        .leftJoin(routineTriggers, eq(routineRuns.triggerId, routineTriggers.id))
        .leftJoin(issues, eq(routineRuns.linkedIssueId, issues.id))
        .where(eq(routineRuns.routineId, routineId))
        .orderBy(desc(routineRuns.createdAt))
        .limit(cappedLimit);

      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        routineId: row.routineId,
        triggerId: row.triggerId,
        source: row.source as RoutineRunSummary["source"],
        status: row.status as RoutineRunSummary["status"],
        triggeredAt: row.triggeredAt,
        idempotencyKey: row.idempotencyKey,
        triggerPayload: row.triggerPayload as Record<string, unknown> | null,
        dispatchFingerprint: row.dispatchFingerprint,
        routineRevisionId: row.routineRevisionId,
        linkedIssueId: row.linkedIssueId,
        coalescedIntoRunId: row.coalescedIntoRunId,
        failureReason: row.failureReason,
        completedAt: row.completedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        linkedIssue: row.linkedIssueId
          ? {
            id: row.linkedIssueId,
            identifier: row.issueIdentifier,
            title: row.issueTitle ?? "Routine execution",
            status: row.issueStatus ?? "todo",
            priority: row.issuePriority ?? "medium",
            updatedAt: row.issueUpdatedAt ?? row.updatedAt,
          }
          : null,
        trigger: row.triggerId
          ? {
            id: row.triggerId,
            kind: row.triggerKind as NonNullable<RoutineRunSummary["trigger"]>["kind"],
            label: row.triggerLabel,
          }
          : null,
      }));
    },

    tickScheduledTriggers: async (now: Date = new Date()) => {
      const due = await db
        .select({
          trigger: routineTriggers,
          routine: routines,
          projectPausedAt: projects.pausedAt,
        })
        .from(routineTriggers)
        .innerJoin(routines, eq(routineTriggers.routineId, routines.id))
        .leftJoin(projects, eq(routines.projectId, projects.id))
        .where(
          and(
            eq(routineTriggers.kind, "schedule"),
            eq(routineTriggers.enabled, true),
            eq(routines.status, "active"),
            isNotNull(routineTriggers.nextRunAt),
            lte(routineTriggers.nextRunAt, now),
          ),
        )
        .orderBy(asc(routineTriggers.nextRunAt), asc(routineTriggers.createdAt));

      let triggered = 0;
      for (const row of due) {
        if (!row.trigger.nextRunAt || !row.trigger.cronExpression || !row.trigger.timezone) continue;

        // Suppress scheduled firings while the routine's project is paused. The tick is still
        // claimed and advanced to the next single cron tick (no backfill), so resume continues
        // at the next cron boundary instead of replaying missed firings. Routines with no
        // project are never suppressed here.
        const projectPaused = !!(row.routine.projectId && row.projectPausedAt);

        let runCount = 1;
        let claimedNextRunAt = nextCronTickInTimeZone(row.trigger.cronExpression, row.trigger.timezone, now);

        if (!projectPaused && row.routine.catchUpPolicy === "enqueue_missed_with_cap") {
          let cursor: Date | null = row.trigger.nextRunAt;
          runCount = 0;
          while (cursor && cursor <= now && runCount < MAX_CATCH_UP_RUNS) {
            runCount += 1;
            claimedNextRunAt = nextCronTickInTimeZone(row.trigger.cronExpression, row.trigger.timezone, cursor);
            cursor = claimedNextRunAt;
          }
        }

        const claimed = await db
          .update(routineTriggers)
          .set({
            nextRunAt: claimedNextRunAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(routineTriggers.id, row.trigger.id),
              eq(routineTriggers.enabled, true),
              eq(routineTriggers.nextRunAt, row.trigger.nextRunAt),
            ),
          )
          .returning({ id: routineTriggers.id })
          .then((rows) => rows[0] ?? null);
        if (!claimed) continue;

        if (projectPaused) {
          await recordSuppressedScheduleRun({
            routine: row.routine,
            trigger: row.trigger,
            reason: "paused",
            nextRunAt: claimedNextRunAt,
          });
          continue;
        }

        for (let i = 0; i < runCount; i += 1) {
          await dispatchRoutineRun({
            routine: row.routine,
            trigger: row.trigger,
            source: "schedule",
          });
          triggered += 1;
        }
      }

      return { triggered };
    },

    syncRunStatusForIssue: async (issueId: string) => {
      const issue = await db
        .select({
          id: issues.id,
          status: issues.status,
          originKind: issues.originKind,
          originRunId: issues.originRunId,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue || issue.originKind !== "routine_execution" || !issue.originRunId) return null;
      if (issue.status === "done") {
        return finalizeRun(issue.originRunId, {
          status: "completed",
          completedAt: new Date(),
        });
      }
      if (issue.status === "blocked" || issue.status === "cancelled") {
        return finalizeRun(issue.originRunId, {
          status: "failed",
          failureReason: `Execution issue moved to ${issue.status}`,
          completedAt: new Date(),
        });
      }
      return null;
    },
  };
}
