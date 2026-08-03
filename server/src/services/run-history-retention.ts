import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  TERMINAL_HEARTBEAT_RUN_STATUSES,
  TERMINAL_WAKEUP_REQUEST_STATUSES,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

export const DEFAULT_RUN_HISTORY_RETENTION_DAYS = 14;

/**
 * Rows deleted per statement. Small enough that each batch is a short
 * transaction holding few row locks, so a concurrent run-checkout never waits
 * long and WAL stays bounded.
 */
export const RUN_HISTORY_PRUNE_BATCH_SIZE = 1_000;

/**
 * Ceiling on batches per table per tick, so one sweep can never delete more
 * than BATCH_SIZE * MAX_BATCHES rows however large the backlog is. A backlog
 * drains over successive ticks instead of in one burst.
 */
export const RUN_HISTORY_PRUNE_MAX_BATCHES = 20;

export type PruneOptions = {
  readonly retentionDays?: number;
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly now?: Date;
};

export type PruneTableResult = {
  readonly deleted: number;
  readonly batches: number;
  /** True when the batch ceiling stopped the sweep with rows still eligible. */
  readonly reachedBatchCeiling: boolean;
};

export type PruneRunHistoryResult = {
  readonly cutoff: Date;
  readonly heartbeatRuns: PruneTableResult;
  readonly agentWakeupRequests: PruneTableResult;
};

function resolveCutoff(options: PruneOptions): Date {
  const retentionDays = options.retentionDays ?? DEFAULT_RUN_HISTORY_RETENTION_DAYS;
  const now = options.now ?? new Date();
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000);
}

async function runBatchedDelete(
  batchSize: number,
  maxBatches: number,
  deleteBatch: (limit: number) => Promise<number>,
): Promise<PruneTableResult> {
  let deleted = 0;
  let batches = 0;

  while (batches < maxBatches) {
    const rows = await deleteBatch(batchSize);
    deleted += rows;
    batches += 1;
    if (rows < batchSize) {
      return { deleted, batches, reachedBatchCeiling: false };
    }
  }

  return { deleted, batches, reachedBatchCeiling: true };
}

/**
 * Delete terminal heartbeat_runs rows older than the cutoff.
 *
 * Non-terminal rows (queued, scheduled_retry, running) are never eligible
 * regardless of age -- the status list is an allowlist, so a status added later
 * is excluded until it is explicitly declared terminal.
 *
 * heartbeat_run_events rows cascade with their run; cost_events, finance_events
 * and agent_task_sessions keep their rows and lose only the run back-reference.
 */
export async function pruneHeartbeatRuns(
  db: Db,
  options: PruneOptions = {},
): Promise<PruneTableResult> {
  const cutoff = resolveCutoff(options);
  const batchSize = options.batchSize ?? RUN_HISTORY_PRUNE_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? RUN_HISTORY_PRUNE_MAX_BATCHES;

  return runBatchedDelete(batchSize, maxBatches, async (limit) => {
    const result = await db.execute(sql`
      DELETE FROM "heartbeat_runs"
      WHERE "id" IN (
        SELECT "id" FROM "heartbeat_runs"
        WHERE "status" IN ${sql.raw(statusList(TERMINAL_HEARTBEAT_RUN_STATUSES))}
          AND "created_at" < ${cutoff.toISOString()}::timestamptz
        ORDER BY "created_at"
        LIMIT ${limit}
      )
    `);
    return rowCount(result);
  });
}

/**
 * Delete terminal agent_wakeup_requests rows older than the cutoff.
 *
 * Requests a heartbeat_runs row still points at are skipped by the anti-join,
 * so pruning never severs a surviving run's attribution. The FK is deliberately
 * left ON DELETE no action: if the anti-join were ever wrong the delete fails
 * loudly rather than silently nulling out a live run's link.
 */
export async function pruneAgentWakeupRequests(
  db: Db,
  options: PruneOptions = {},
): Promise<PruneTableResult> {
  const cutoff = resolveCutoff(options);
  const batchSize = options.batchSize ?? RUN_HISTORY_PRUNE_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? RUN_HISTORY_PRUNE_MAX_BATCHES;

  return runBatchedDelete(batchSize, maxBatches, async (limit) => {
    const result = await db.execute(sql`
      DELETE FROM "agent_wakeup_requests"
      WHERE "id" IN (
        SELECT "requests"."id" FROM "agent_wakeup_requests" AS "requests"
        WHERE "requests"."status" IN ${sql.raw(statusList(TERMINAL_WAKEUP_REQUEST_STATUSES))}
          AND "requests"."requested_at" < ${cutoff.toISOString()}::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM "heartbeat_runs" AS "runs"
            WHERE "runs"."wakeup_request_id" = "requests"."id"
          )
        ORDER BY "requests"."requested_at"
        LIMIT ${limit}
      )
    `);
    return rowCount(result);
  });
}

/**
 * Prune both run-history tables.
 *
 * heartbeat_runs goes first so the cascaded heartbeat_run_events rows are gone
 * and fewer wakeup requests are still referenced when the anti-join runs.
 */
export async function pruneRunHistory(
  db: Db,
  options: PruneOptions = {},
): Promise<PruneRunHistoryResult> {
  const cutoff = resolveCutoff(options);
  const heartbeatRuns = await pruneHeartbeatRuns(db, { ...options, now: options.now });
  const agentWakeupRequests = await pruneAgentWakeupRequests(db, { ...options, now: options.now });

  const summary = {
    cutoff: cutoff.toISOString(),
    heartbeatRunsDeleted: heartbeatRuns.deleted,
    heartbeatRunsBatches: heartbeatRuns.batches,
    agentWakeupRequestsDeleted: agentWakeupRequests.deleted,
    agentWakeupRequestsBatches: agentWakeupRequests.batches,
  };

  if (heartbeatRuns.reachedBatchCeiling || agentWakeupRequests.reachedBatchCeiling) {
    logger.warn(
      { ...summary, batchCeiling: RUN_HISTORY_PRUNE_MAX_BATCHES },
      "run history retention hit its per-tick batch ceiling; backlog continues next tick",
    );
  } else if (heartbeatRuns.deleted > 0 || agentWakeupRequests.deleted > 0) {
    logger.info({ ...summary }, "run history retention pruned terminal rows");
  } else {
    logger.debug({ ...summary }, "run history retention found nothing to prune");
  }

  return { cutoff, heartbeatRuns, agentWakeupRequests };
}

/**
 * Start the periodic run-history retention sweep.
 *
 * @returns a function that stops the interval.
 */
export function startRunHistoryRetention(
  db: Db,
  intervalMs: number,
  retentionDays: number = DEFAULT_RUN_HISTORY_RETENTION_DAYS,
): () => void {
  let running = false;

  const sweep = () => {
    // Skip rather than overlap: a slow sweep must not stack ticks on a host
    // that is already CPU constrained.
    if (running) return;
    running = true;
    void pruneRunHistory(db, { retentionDays })
      .catch((err) => {
        logger.warn({ err }, "run history retention sweep failed");
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(sweep, intervalMs);
  sweep();
  return () => clearInterval(timer);
}

/** Render a status allowlist as a SQL literal tuple, e.g. `('a', 'b')`. */
function statusList(statuses: readonly string[]): string {
  // Statuses are compile-time constants from @paperclipai/shared, never user
  // input. Assert the shape anyway so a malformed constant cannot reach SQL.
  for (const status of statuses) {
    if (!/^[a-z_]+$/.test(status)) {
      throw new Error(`refusing to build retention predicate from unexpected status: ${status}`);
    }
  }
  return `(${statuses.map((status) => `'${status}'`).join(", ")})`;
}

function rowCount(result: unknown): number {
  // postgres.js reports affected rows as `count` on the returned RowList; the
  // node-postgres shape uses `rowCount`. Accept either so the prune reports the
  // truth rather than silently always reporting zero deletions.
  const row = result as { count?: number | null; rowCount?: number | null } | undefined;
  if (typeof row?.count === "number") return row.count;
  if (typeof row?.rowCount === "number") return row.rowCount;
  return 0;
}
