import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { instanceSettingsService } from "../services/instance-settings.js";
import { logActivity } from "../services/activity-log.js";
import { logger } from "../middleware/logger.js";
import { getActorInfo } from "./authz.js";

export interface InstanceActivityInput {
  action: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
}

/**
 * Audit row for an instance-scoped mutation.
 *
 * Instance mutations have no single company, so — matching the precedent in
 * instance-settings.ts and plugins.ts — one activity_log row is written per
 * company on the instance. `logActivity` requires a companyId, and
 * listCompanyIds() returning empty would silently drop the row, so that case
 * emits a warn to keep the audit gap visible instead of silent.
 */
const MAX_FAILURE_REASON_CHARS = 300;

/** Bound free-text error fields and strip credentials embedded in URLs. */
function sanitizeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!details) return null;
  const out: Record<string, unknown> = { ...details };
  const reason = out.failureReason;
  if (typeof reason === "string") {
    const redacted = reason.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@");
    out.failureReason =
      redacted.length > MAX_FAILURE_REASON_CHARS
        ? `${redacted.slice(0, MAX_FAILURE_REASON_CHARS)}…`
        : redacted;
  }
  return out;
}

/**
 * Best-effort: an audit write failure is logged and swallowed so it can never
 * turn an already-applied instance mutation into a reported failure.
 */
export async function logInstanceActivity(
  db: Db,
  req: Request,
  input: InstanceActivityInput,
): Promise<void> {
  try {
    await writeInstanceActivity(db, req, input);
  } catch (err) {
    logger.error(
      { err, event: "instance_activity_write_failed", action: input.action, entityId: input.entityId },
      "failed to write instance activity_log row",
    );
  }
}

async function writeInstanceActivity(
  db: Db,
  req: Request,
  input: InstanceActivityInput,
): Promise<void> {
  const actor = getActorInfo(req);
  const companyIds = await instanceSettingsService(db).listCompanyIds();
  if (companyIds.length === 0) {
    logger.warn(
      {
        event: "instance_activity_not_logged",
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        actorType: actor.actorType,
        actorId: actor.actorId,
      },
      "instance-scoped mutation produced no activity_log row: no companies exist on this instance",
    );
    return;
  }
  await Promise.all(
    companyIds.map((companyId) =>
      logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        details: sanitizeDetails(input.details),
      }),
    ),
  );
}
