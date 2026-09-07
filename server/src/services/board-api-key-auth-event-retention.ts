import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// Retention for board_api_key_auth_events (migration 0241).
//
// The table records one row per board-key bearer authentication attempt. The
// write path already bounds unattributed bad_key rows to at most one per
// source per minute and attributed outcomes to the number of live keys, so
// growth is slow -- but a security log that can grow without bound is still a
// liability, not an asset. Mirrors plugin-webhook-delivery-retention:
//
//   - Age bound: 90 days. An authentication-event investigation on this
//     instance (PLA-6298) needed roughly three months of look-back; 90 days
//     outlives a quarter's audit cycle while keeping the table at a small
//     fraction of activity_log's size.
//   - Size bound: 500,000 rows (roughly tens of MB), evicting oldest-first.
//     This is the load-bearing bound under a sustained multi-source attack
//     that makes one row per source-minute per attacker.
//
// Every outcome class is equal evidence here, so both passes evict strictly
// oldest-first with no status preference.

/** Age-based TTL for auth events. */
export const DEFAULT_BOARD_API_KEY_AUTH_EVENT_RETENTION_DAYS = 90;

/**
 * Hard ceiling on total rows. When exceeded the prune evicts oldest-first
 * regardless of age. This bounds disk growth even if the throttle's per-source
 * bucketing is defeated by a distributed attempt.
 */
export const DEFAULT_BOARD_API_KEY_AUTH_EVENT_MAX_ROWS = 500_000;

/** Rows deleted per statement; small transactions, bounded lock hold time. */
export const BOARD_API_KEY_AUTH_EVENT_PRUNE_BATCH_SIZE = 1_000;

/** Ceiling on batches per tick per pass; a backlog drains over ticks. */
export const BOARD_API_KEY_AUTH_EVENT_PRUNE_MAX_BATCHES = 20;

export type PruneBoardApiKeyAuthEventsOptions = {
  readonly retentionDays?: number;
  readonly maxRows?: number;
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly now?: Date;
};

export type PrunePassResult = {
  readonly deleted: number;
  readonly batches: number;
  /** True when the batch ceiling stopped the pass with rows still eligible. */
  readonly reachedBatchCeiling: boolean;
};

export type PruneBoardApiKeyAuthEventsResult = {
  readonly ageCutoff: Date;
  readonly agePrune: PrunePassResult;
  readonly sizePrune: PrunePassResult;
  readonly totalDeleted: number;
};

function resolveCutoff(retentionDays: number, now: Date): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000);
}

async function runBatchedDelete(
  batchSize: number,
  maxBatches: number,
  deleteBatch: (limit: number) => Promise<number>,
): Promise<PrunePassResult> {
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

function rowCount(result: unknown): number {
  // postgres.js reports affected rows as `count` on the returned RowList; the
  // node-postgres shape uses `rowCount`. Accept either so the prune reports
  // the truth rather than silently always reporting zero deletions.
  const row = result as { count?: number | null; rowCount?: number | null } | undefined;
  if (typeof row?.count === "number") return row.count;
  if (typeof row?.rowCount === "number") return row.rowCount;
  return 0;
}

/** Age pass: delete rows older than the retention cutoff, batched oldest-first. */
async function pruneByAge(db: Db, options: PruneBoardApiKeyAuthEventsOptions): Promise<PrunePassResult> {
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? DEFAULT_BOARD_API_KEY_AUTH_EVENT_RETENTION_DAYS;
  const batchSize = options.batchSize ?? BOARD_API_KEY_AUTH_EVENT_PRUNE_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? BOARD_API_KEY_AUTH_EVENT_PRUNE_MAX_BATCHES;
  const cutoff = resolveCutoff(retentionDays, now);

  return runBatchedDelete(batchSize, maxBatches, async (limit) => {
    const result = await db.execute(sql`
      DELETE FROM "board_api_key_auth_events"
      WHERE "id" IN (
        SELECT "id" FROM "board_api_key_auth_events"
        WHERE "created_at" < ${cutoff.toISOString()}::timestamptz
        ORDER BY "created_at"
        LIMIT ${limit}
      )
    `);
    return rowCount(result);
  });
}

/** Size pass: if the table exceeds maxRows, evict the oldest rows first. */
async function pruneBySize(
  db: Db,
  options: PruneBoardApiKeyAuthEventsOptions,
  ageCutoff: Date,
): Promise<PrunePassResult> {
  const maxRows = options.maxRows ?? DEFAULT_BOARD_API_KEY_AUTH_EVENT_MAX_ROWS;
  const batchSize = options.batchSize ?? BOARD_API_KEY_AUTH_EVENT_PRUNE_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? BOARD_API_KEY_AUTH_EVENT_PRUNE_MAX_BATCHES;

  const countResult = (await db.execute(sql`
    SELECT count(*) AS within_age FROM "board_api_key_auth_events"
    WHERE "created_at" >= ${ageCutoff.toISOString()}::timestamptz
  `)) as unknown as Array<{ within_age: string | number }>;
  const withinAge = Number(countResult?.[0]?.within_age ?? 0);
  if (withinAge <= maxRows) {
    return { deleted: 0, batches: 0, reachedBatchCeiling: false };
  }

  // Only evict what the cap requires so one sweep cannot overshoot.
  let budget = withinAge - maxRows;
  let deleted = 0;
  let batches = 0;
  let reachedBatchCeiling = false;

  while (batches < maxBatches && budget > 0) {
    const effectiveLimit = Math.min(batchSize, budget);
    const result = await db.execute(sql`
      DELETE FROM "board_api_key_auth_events"
      WHERE "id" IN (
        SELECT "id" FROM "board_api_key_auth_events"
        WHERE "created_at" >= ${ageCutoff.toISOString()}::timestamptz
        ORDER BY "created_at"
        LIMIT ${effectiveLimit}
      )
    `);
    const rows = rowCount(result);
    deleted += rows;
    batches += 1;
    budget -= rows;
    if (rows < effectiveLimit) {
      return { deleted, batches, reachedBatchCeiling: false };
    }
  }

  reachedBatchCeiling = budget > 0;
  return { deleted, batches, reachedBatchCeiling };
}

/**
 * Runs one retention sweep. Returns what happened; the scheduled wrapper logs
 * the summary so an operator can see the bound working in the logs.
 */
export async function pruneBoardApiKeyAuthEvents(
  db: Db,
  options: PruneBoardApiKeyAuthEventsOptions = {},
): Promise<PruneBoardApiKeyAuthEventsResult> {
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? DEFAULT_BOARD_API_KEY_AUTH_EVENT_RETENTION_DAYS;
  const ageCutoff = resolveCutoff(retentionDays, now);

  const agePrune = await pruneByAge(db, options);
  const sizePrune = await pruneBySize(db, options, ageCutoff);
  const totalDeleted = agePrune.deleted + sizePrune.deleted;

  const summary = {
    ageCutoff: ageCutoff.toISOString(),
    ageDeleted: agePrune.deleted,
    sizeDeleted: sizePrune.deleted,
    totalDeleted,
    batches: agePrune.batches + sizePrune.batches,
    reachedBatchCeiling: agePrune.reachedBatchCeiling || sizePrune.reachedBatchCeiling,
  };
  if (summary.reachedBatchCeiling) {
    logger.warn(
      summary,
      "board API key auth event retention hit its per-tick batch ceiling; backlog continues next tick",
    );
  } else if (totalDeleted > 0) {
    logger.info(summary, "board API key auth event retention pruned rows");
  } else {
    logger.debug(summary, "board API key auth event retention found nothing to prune");
  }

  return { ageCutoff, agePrune, sizePrune, totalDeleted };
}

/**
 * Start the periodic board_api_key_auth_events retention sweep.
 *
 * @returns a function that stops the interval.
 */
export function startBoardApiKeyAuthEventRetention(
  db: Db,
  intervalMs: number,
  retentionDays: number = DEFAULT_BOARD_API_KEY_AUTH_EVENT_RETENTION_DAYS,
  maxRows: number = DEFAULT_BOARD_API_KEY_AUTH_EVENT_MAX_ROWS,
): () => void {
  let running = false;

  const sweep = () => {
    // Skip rather than overlap: a slow sweep must not stack ticks on a host
    // that is already CPU constrained.
    if (running) return;
    running = true;
    void pruneBoardApiKeyAuthEvents(db, { retentionDays, maxRows })
      .catch((err) => {
        logger.warn({ err }, "board API key auth event retention sweep failed");
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(sweep, intervalMs);
  sweep();
  return () => clearInterval(timer);
}
