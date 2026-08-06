import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// Retention numbers and why they are what they are.
//
// plugin_webhook_deliveries persists every inbound anonymous webhook payload +
// headers. The request-rate and body-size gap on the ingestion path is now
// closed, but nothing deleted the rows afterwards, so the table still grows
// without bound. The defaults below are picked to bound cumulative growth on
// a single-tenant Paperclip host that receives real webhook traffic, while
// keeping the rows that matter for incident diagnosis.
//
// Two distinct age bounds:
//   - success: 3 days. A success row only proves the delivery reached the
//     worker and the worker returned ok. Once that has been observed (and any
//     downstream effect has happened) the row has no diagnostic value. Three
//     days covers a long weekend's worth of "did we get the webhook?" checks
//     without accumulating a week's worth of high-volume noise.
//   - failed: 30 days. Failed deliveries are the incident audit trail for
//     delivery / signature / dispatch investigations. A 30-day window
//     outlives the typical "noticed the bug this week, started digging next
//     week" cycle and the average on-call rotation, so the row is still there
//     when somebody goes looking.
//
// Size bound (max-rows) is the load-bearing bound: age alone permits
// ~169 GB/day at the documented ingestion ceiling, which is not a real bound
// on disk growth. The default cap of 1,000,000 rows is roughly 1 GB on disk
// for the typical ~1 KB JSONB payload + headers row. When the cap is exceeded
// the prune evicts oldest-first, success rows in preference to failed (failed
// is the audit trail; success is junk). This guarantees the table cannot grow
// past the configured ceiling even if both age bounds are increased.
//
// All three numbers are configurable via env vars (see server/src/config.ts).

/** Success rows older than this are pruned. */
export const DEFAULT_PLUGIN_WEBHOOK_DELIVERY_SUCCESS_RETENTION_DAYS = 3;

/** Failed rows older than this are pruned. */
export const DEFAULT_PLUGIN_WEBHOOK_DELIVERY_FAILED_RETENTION_DAYS = 30;

/**
 * Hard ceiling on total rows. When exceeded the prune evicts oldest-first
 * (success before failed) regardless of age. This is what actually bounds disk
 * growth under sustained webhook load; the age bounds alone do not.
 */
export const DEFAULT_PLUGIN_WEBHOOK_DELIVERY_MAX_ROWS = 1_000_000;

/**
 * Rows deleted per statement. Small enough that each batch is a short
 * transaction holding few row locks, so a concurrent webhook delivery never
 * waits long and WAL stays bounded. Mirrors run-history-retention.
 */
export const PLUGIN_WEBHOOK_DELIVERY_PRUNE_BATCH_SIZE = 1_000;

/**
 * Ceiling on batches per tick per prune pass, so one sweep can never delete
 * more than BATCH_SIZE * MAX_BATCHES rows however large the backlog is. A
 * backlog drains over successive ticks instead of in one burst.
 */
export const PLUGIN_WEBHOOK_DELIVERY_PRUNE_MAX_BATCHES = 20;

/**
 * Statuses that are eligible for age-based prune. `pending` is in-flight and
 * must never be pruned. Asserted by the test suite to match the partial-index
 * predicates in migration 0147 so the prune predicate cannot drift away from
 * what the index serves.
 */
export const PRUNABLE_PLUGIN_WEBHOOK_DELIVERY_STATUSES = ["success", "failed"] as const;

export type PruneOptions = {
  readonly successRetentionDays?: number;
  readonly failedRetentionDays?: number;
  readonly maxRows?: number;
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

export type PrunePluginWebhookDeliveriesResult = {
  readonly successCutoff: Date;
  readonly failedCutoff: Date;
  readonly agePrune: PruneTableResult;
  readonly sizePrune: PruneTableResult;
  readonly totalDeleted: number;
};

function resolveCutoff(retentionDays: number, now: Date): Date {
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
 * Age-prune pass: delete `success` rows older than the success cutoff and
 * `failed` rows older than the failed cutoff. `pending` rows are never touched.
 *
 * Success runs first because the typical sweep deletes only success rows; the
 * failed prune is a no-op most ticks. Each pass is bounded by MAX_BATCHES so
 * the age prune cannot itself exhaust the per-tick budget before the size
 * prune runs.
 */
async function pruneByAge(db: Db, options: PruneOptions): Promise<PruneTableResult> {
  const now = options.now ?? new Date();
  const successRetentionDays =
    options.successRetentionDays ?? DEFAULT_PLUGIN_WEBHOOK_DELIVERY_SUCCESS_RETENTION_DAYS;
  const failedRetentionDays =
    options.failedRetentionDays ?? DEFAULT_PLUGIN_WEBHOOK_DELIVERY_FAILED_RETENTION_DAYS;
  const batchSize = options.batchSize ?? PLUGIN_WEBHOOK_DELIVERY_PRUNE_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? PLUGIN_WEBHOOK_DELIVERY_PRUNE_MAX_BATCHES;

  // Share the per-tick batch ceiling across both age passes so the combined
  // age prune can never exceed MAX_BATCHES * BATCH_SIZE rows. Success goes
  // first because it is the higher-volume pass.
  const halfBatchCeiling = Math.max(1, Math.floor(maxBatches / 2));
  let deleted = 0;
  let batches = 0;
  let reachedBatchCeiling = false;

  const successResult = await runBatchedDelete(batchSize, halfBatchCeiling, async (limit) => {
    const successCutoff = resolveCutoff(successRetentionDays, now);
    const result = await db.execute(sql`
      DELETE FROM "plugin_webhook_deliveries"
      WHERE "id" IN (
        SELECT "id" FROM "plugin_webhook_deliveries"
        WHERE "status" = 'success'
          AND "created_at" < ${successCutoff.toISOString()}::timestamptz
        ORDER BY "created_at"
        LIMIT ${limit}
      )
    `);
    return rowCount(result);
  });
  deleted += successResult.deleted;
  batches += successResult.batches;
  if (successResult.reachedBatchCeiling) reachedBatchCeiling = true;

  const failedResult = await runBatchedDelete(batchSize, halfBatchCeiling, async (limit) => {
    const failedCutoff = resolveCutoff(failedRetentionDays, now);
    const result = await db.execute(sql`
      DELETE FROM "plugin_webhook_deliveries"
      WHERE "id" IN (
        SELECT "id" FROM "plugin_webhook_deliveries"
        WHERE "status" = 'failed'
          AND "created_at" < ${failedCutoff.toISOString()}::timestamptz
        ORDER BY "created_at"
        LIMIT ${limit}
      )
    `);
    return rowCount(result);
  });
  deleted += failedResult.deleted;
  batches += failedResult.batches;
  if (failedResult.reachedBatchCeiling) reachedBatchCeiling = true;

  return { deleted, batches, reachedBatchCeiling };
}

/**
 * Size-prune pass: if the table exceeds `maxRows`, evict the oldest rows
 * oldest-first. Success rows are evicted in preference to failed because failed
 * rows are the incident audit trail. Only after every success row older than
 * the cutoffs is gone does the size prune touch failed rows.
 *
 * The size prune is what actually bounds disk growth on a busy ingestion path;
 * the age prune alone is best-effort.
 */
async function pruneBySize(db: Db, options: PruneOptions): Promise<PruneTableResult> {
  const now = options.now ?? new Date();
  const successRetentionDays =
    options.successRetentionDays ?? DEFAULT_PLUGIN_WEBHOOK_DELIVERY_SUCCESS_RETENTION_DAYS;
  const failedRetentionDays =
    options.failedRetentionDays ?? DEFAULT_PLUGIN_WEBHOOK_DELIVERY_FAILED_RETENTION_DAYS;
  const maxRows = options.maxRows ?? DEFAULT_PLUGIN_WEBHOOK_DELIVERY_MAX_ROWS;
  const batchSize = options.batchSize ?? PLUGIN_WEBHOOK_DELIVERY_PRUNE_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? PLUGIN_WEBHOOK_DELIVERY_PRUNE_MAX_BATCHES;

  const successCutoff = resolveCutoff(successRetentionDays, now);
  const failedCutoff = resolveCutoff(failedRetentionDays, now);

  // Count rows that are still in-scope for size-prune (i.e. still within their
  // age window). This is a cheap indexed read on the partial retention
  // indexes; if it is at or below the cap, size prune is a no-op.
  const countResult = (await db.execute(sql`
    SELECT
      (SELECT count(*) FROM "plugin_webhook_deliveries"
         WHERE "status" = 'success' AND "created_at" >= ${successCutoff.toISOString()}::timestamptz) AS success_within_age,
      (SELECT count(*) FROM "plugin_webhook_deliveries"
         WHERE "status" = 'failed' AND "created_at" >= ${failedCutoff.toISOString()}::timestamptz) AS failed_within_age
  `)) as unknown as Array<{ success_within_age: string | number; failed_within_age: string | number }>;
  const successWithinAge = Number(countResult?.[0]?.success_within_age ?? 0);
  const failedWithinAge = Number(countResult?.[0]?.failed_within_age ?? 0);
  const withinAge = successWithinAge + failedWithinAge;

  if (withinAge <= maxRows) {
    return { deleted: 0, batches: 0, reachedBatchCeiling: false };
  }

  // Number of rows we must evict to reach the cap. Each phase gets a tight
  // limit derived from this budget so neither phase can run away and evict
  // every eligible row when the cap only requires a few.
  let budget = withinAge - maxRows;

  let deleted = 0;
  let batches = 0;
  let reachedBatchCeiling = false;

  // Phase 1: evict the oldest in-window success rows. Success is preferred
  // for eviction because it has no diagnostic value once observed; failed is
  // the audit trail.
  const successGoal = Math.min(budget, successWithinAge);
  if (successGoal > 0) {
    let successDeleted = 0;
    const successResult = await runBatchedDelete(batchSize, maxBatches, async (limit) => {
      // Tighten the per-batch limit so the last batch cannot overshoot the
      // remaining budget.
      const remainingBudget = successGoal - successDeleted;
      const effectiveLimit = Math.min(limit, remainingBudget);
      if (effectiveLimit <= 0) return 0;
      const result = await db.execute(sql`
        DELETE FROM "plugin_webhook_deliveries"
        WHERE "id" IN (
          SELECT "id" FROM "plugin_webhook_deliveries"
          WHERE "status" = 'success'
            AND "created_at" >= ${successCutoff.toISOString()}::timestamptz
          ORDER BY "created_at"
          LIMIT ${effectiveLimit}
        )
      `);
      const n = rowCount(result);
      successDeleted += n;
      return n;
    });
    deleted += successResult.deleted;
    batches += successResult.batches;
    budget -= successResult.deleted;
    if (successResult.reachedBatchCeiling) reachedBatchCeiling = true;
  }

  // Phase 2: only if success alone could not meet the cap, evict the oldest
  // in-window failed rows. Failed is last-resort.
  if (budget > 0 && !reachedBatchCeiling) {
    const failedGoal = Math.min(budget, failedWithinAge);
    if (failedGoal > 0) {
      const failedBudget = maxBatches - batches;
      if (failedBudget > 0) {
        let failedDeleted = 0;
        const failedResult = await runBatchedDelete(batchSize, failedBudget, async (limit) => {
          const remainingBudget = failedGoal - failedDeleted;
          const effectiveLimit = Math.min(limit, remainingBudget);
          if (effectiveLimit <= 0) return 0;
          const result = await db.execute(sql`
            DELETE FROM "plugin_webhook_deliveries"
            WHERE "id" IN (
              SELECT "id" FROM "plugin_webhook_deliveries"
              WHERE "status" = 'failed'
                AND "created_at" >= ${failedCutoff.toISOString()}::timestamptz
              ORDER BY "created_at"
              LIMIT ${effectiveLimit}
            )
          `);
          const n = rowCount(result);
          failedDeleted += n;
          return n;
        });
        deleted += failedResult.deleted;
        batches += failedResult.batches;
        if (failedResult.reachedBatchCeiling) reachedBatchCeiling = true;
      }
    }
  }

  return { deleted, batches, reachedBatchCeiling };
}

/**
 * Prune plugin_webhook_deliveries rows by age and then by size.
 *
 * The age pass always runs. The size pass only deletes when the in-window row
 * count exceeds the configured ceiling; it never touches rows the age pass
 * would have already deleted.
 */
export async function prunePluginWebhookDeliveries(
  db: Db,
  options: PruneOptions = {},
): Promise<PrunePluginWebhookDeliveriesResult> {
  const now = options.now ?? new Date();
  const successRetentionDays =
    options.successRetentionDays ?? DEFAULT_PLUGIN_WEBHOOK_DELIVERY_SUCCESS_RETENTION_DAYS;
  const failedRetentionDays =
    options.failedRetentionDays ?? DEFAULT_PLUGIN_WEBHOOK_DELIVERY_FAILED_RETENTION_DAYS;

  const successCutoff = resolveCutoff(successRetentionDays, now);
  const failedCutoff = resolveCutoff(failedRetentionDays, now);

  const agePrune = await pruneByAge(db, options);
  const sizePrune = await pruneBySize(db, options);

  const totalDeleted = agePrune.deleted + sizePrune.deleted;

  const summary = {
    successCutoff: successCutoff.toISOString(),
    failedCutoff: failedCutoff.toISOString(),
    ageDeleted: agePrune.deleted,
    ageBatches: agePrune.batches,
    sizeDeleted: sizePrune.deleted,
    sizeBatches: sizePrune.batches,
    totalDeleted,
  };

  if (agePrune.reachedBatchCeiling || sizePrune.reachedBatchCeiling) {
    logger.warn(
      {
        ...summary,
        batchCeiling: PLUGIN_WEBHOOK_DELIVERY_PRUNE_MAX_BATCHES,
      },
      "plugin webhook delivery retention hit its per-tick batch ceiling; backlog continues next tick",
    );
  } else if (totalDeleted > 0) {
    logger.info({ ...summary }, "plugin webhook delivery retention pruned rows");
  } else {
    logger.debug({ ...summary }, "plugin webhook delivery retention found nothing to prune");
  }

  return { successCutoff, failedCutoff, agePrune, sizePrune, totalDeleted };
}

/**
 * Start the periodic plugin_webhook_deliveries retention sweep.
 *
 * @returns a function that stops the interval.
 */
export function startPluginWebhookDeliveryRetention(
  db: Db,
  intervalMs: number,
  successRetentionDays: number = DEFAULT_PLUGIN_WEBHOOK_DELIVERY_SUCCESS_RETENTION_DAYS,
  failedRetentionDays: number = DEFAULT_PLUGIN_WEBHOOK_DELIVERY_FAILED_RETENTION_DAYS,
  maxRows: number = DEFAULT_PLUGIN_WEBHOOK_DELIVERY_MAX_ROWS,
): () => void {
  let running = false;

  const sweep = () => {
    // Skip rather than overlap: a slow sweep must not stack ticks on a host
    // that is already CPU constrained.
    if (running) return;
    running = true;
    void prunePluginWebhookDeliveries(db, { successRetentionDays, failedRetentionDays, maxRows })
      .catch((err) => {
        logger.warn({ err }, "plugin webhook delivery retention sweep failed");
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(sweep, intervalMs);
  sweep();
  return () => clearInterval(timer);
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
