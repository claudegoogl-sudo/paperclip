import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  pluginWebhookDeliveries,
  plugins,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  DEFAULT_PLUGIN_WEBHOOK_DELIVERY_FAILED_RETENTION_DAYS,
  DEFAULT_PLUGIN_WEBHOOK_DELIVERY_MAX_ROWS,
  DEFAULT_PLUGIN_WEBHOOK_DELIVERY_SUCCESS_RETENTION_DAYS,
  prunePluginWebhookDeliveries,
} from "../services/plugin-webhook-delivery-retention.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin webhook delivery retention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const ANCIENT = new Date("2026-01-01T00:00:00.000Z");
const RECENT = new Date();

// Approximates a real webhook payload + headers row so the size measurement
// exercises the JSONB pages that dominate this table on disk.
const PAYLOAD = { event: "x".repeat(2_000) };
const HEADERS = { "x-signature": "s".repeat(200) };

describeEmbeddedPostgres("plugin webhook delivery retention", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let pluginId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-webhook-retention-");
    db = createDb(tempDb.connectionString);
    const [company] = await db.insert(companies).values({ name: "Retention Co" }).returning();
    companyId = company.id;
    const [plugin] = await db
      .insert(plugins)
      .values({
        pluginKey: "paperclip.webhook-retention-test",
        packageName: "@paperclipai/webhook-retention-test",
        version: "0.0.1",
        apiVersion: 1,
        categories: ["automation"],
        manifestJson: {
          id: "paperclip.webhook-retention-test",
          apiVersion: 1,
          version: "0.0.1",
          displayName: "Webhook Retention Test",
          description: "Test plugin",
          author: "Paperclip",
        },
      })
      .returning();
    pluginId = plugin.id;
  }, 60_000);

  afterEach(async () => {
    await db.delete(pluginWebhookDeliveries);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedDelivery(
    status: "pending" | "success" | "failed",
    createdAt: Date,
    payload: Record<string, unknown> = PAYLOAD,
  ) {
    const [row] = await db
      .insert(pluginWebhookDeliveries)
      .values({
        pluginId,
        companyId,
        webhookKey: "wh",
        status,
        payload,
        headers: HEADERS,
        createdAt,
      })
      .returning();
    return row;
  }

  async function deliveryIds(): Promise<string[]> {
    return (await db.select({ id: pluginWebhookDeliveries.id }).from(pluginWebhookDeliveries)).map(
      (row) => row.id,
    );
  }

  it(
    "never deletes pending rows regardless of age",
    async () => {
      const ancientPending = await seedDelivery("pending", ANCIENT);
      const ancientSuccess = await seedDelivery("success", ANCIENT);

      const result = await prunePluginWebhookDeliveries(db, {
        successRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_SUCCESS_RETENTION_DAYS,
        failedRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_FAILED_RETENTION_DAYS,
      });

      // Age prune: success is past the cutoff, failed is not seeded here.
      expect(result.agePrune.deleted).toBe(1);

      const surviving = await deliveryIds();
      expect(surviving).toContain(ancientPending.id);
      expect(surviving).not.toContain(ancientSuccess.id);
    },
    120_000,
  );

  it(
    "applies the success and failed age bounds independently (failed is longer)",
    async () => {
      // 10 days old: past success cutoff (3d) but inside failed cutoff (30d).
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000);
      const oldSuccess = await seedDelivery("success", tenDaysAgo);
      const oldFailed = await seedDelivery("failed", tenDaysAgo);

      await prunePluginWebhookDeliveries(db, {
        successRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_SUCCESS_RETENTION_DAYS,
        failedRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_FAILED_RETENTION_DAYS,
      });

      const surviving = await deliveryIds();
      expect(surviving).not.toContain(oldSuccess.id);
      expect(surviving).toContain(oldFailed.id);
    },
    120_000,
  );

  it(
    "prunes failed rows once they exceed the failed age bound",
    async () => {
      const ancientFailed = await seedDelivery("failed", ANCIENT);
      const recentFailed = await seedDelivery("failed", RECENT);

      await prunePluginWebhookDeliveries(db, {
        successRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_SUCCESS_RETENTION_DAYS,
        failedRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_FAILED_RETENTION_DAYS,
      });

      const surviving = await deliveryIds();
      expect(surviving).not.toContain(ancientFailed.id);
      expect(surviving).toContain(recentFailed.id);
    },
    120_000,
  );

  it(
    "converges: a second prune is a no-op",
    async () => {
      for (let i = 0; i < 5; i += 1) {
        await seedDelivery("success", ANCIENT);
        await seedDelivery("failed", ANCIENT);
      }

      const first = await prunePluginWebhookDeliveries(db, {
        successRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_SUCCESS_RETENTION_DAYS,
        failedRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_FAILED_RETENTION_DAYS,
      });
      expect(first.totalDeleted).toBe(10);

      const second = await prunePluginWebhookDeliveries(db, {
        successRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_SUCCESS_RETENTION_DAYS,
        failedRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_FAILED_RETENTION_DAYS,
      });
      expect(second.totalDeleted).toBe(0);
    },
    120_000,
  );

  it(
    "respects the per-tick batch ceiling and drains the backlog over later ticks",
    async () => {
      for (let i = 0; i < 5; i += 1) {
        await seedDelivery("success", ANCIENT);
      }

      // maxBatches=2 split across success/failed = 1 batch per status per tick.
      // 2 batches of 2 = 4 of 5 eligible success rows this tick.
      const first = await prunePluginWebhookDeliveries(db, {
        successRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_SUCCESS_RETENTION_DAYS,
        failedRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_FAILED_RETENTION_DAYS,
        batchSize: 2,
        maxBatches: 2,
      });
      expect(first.agePrune.deleted).toBe(2);
      expect(first.agePrune.reachedBatchCeiling).toBe(true);
      expect(await deliveryIds()).toHaveLength(3);

      const second = await prunePluginWebhookDeliveries(db, {
        successRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_SUCCESS_RETENTION_DAYS,
        failedRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_FAILED_RETENTION_DAYS,
        batchSize: 2,
        maxBatches: 2,
      });
      expect(second.agePrune.deleted).toBe(2);
      expect(await deliveryIds()).toHaveLength(1);
    },
    120_000,
  );

  it(
    "enforces the max-rows bound oldest-first, evicting success before failed",
    async () => {
      // Recent rows — within their age windows — but the size cap forces
      // eviction. Size prune must evict oldest-first; success before failed
      // (failed is the incident audit trail).
      const successOld = await seedDelivery("success", new Date(Date.now() - 60 * 60 * 1_000));
      const successNew = await seedDelivery("success", new Date(Date.now() - 30 * 60 * 1_000));
      const failedOld = await seedDelivery("failed", new Date(Date.now() - 60 * 60 * 1_000));
      const failedNew = await seedDelivery("failed", new Date(Date.now() - 30 * 60 * 1_000));

      // maxRows=3, total in-window rows = 4 → must evict 1.
      // Oldest success row evicted; newest success + both failed rows
      // survive (success is preferred for eviction over failed).
      const result = await prunePluginWebhookDeliveries(db, {
        successRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_SUCCESS_RETENTION_DAYS,
        failedRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_FAILED_RETENTION_DAYS,
        maxRows: 3,
        batchSize: 1,
        maxBatches: 10,
      });

      expect(result.sizePrune.deleted).toBe(1);

      const surviving = await deliveryIds();
      // Oldest success is gone first; newest success survives.
      expect(surviving).not.toContain(successOld.id);
      expect(surviving).toContain(successNew.id);
      // Failed rows are the audit trail — preserved unless cap cannot be met
      // by success alone.
      expect(surviving).toContain(failedOld.id);
      expect(surviving).toContain(failedNew.id);
    },
    120_000,
  );

  it(
    "evicts failed rows only once success rows are exhausted",
    async () => {
      // 1 success + 3 failed, all within age windows. maxRows=1 forces
      // eviction past success alone — failed must be touched.
      const success = await seedDelivery("success", new Date(Date.now() - 60 * 60 * 1_000));
      const failedOld = await seedDelivery("failed", new Date(Date.now() - 3 * 60 * 60 * 1_000));
      const failedMid = await seedDelivery("failed", new Date(Date.now() - 2 * 60 * 60 * 1_000));
      const failedNew = await seedDelivery("failed", new Date(Date.now() - 60 * 60 * 1_000));

      // 4 rows in-window, cap=1 → evict 3. Success goes first (1 row), then
      // oldest failed (failedOld) to reach the cap.
      const result = await prunePluginWebhookDeliveries(db, {
        successRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_SUCCESS_RETENTION_DAYS,
        failedRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_FAILED_RETENTION_DAYS,
        maxRows: 1,
        batchSize: 1,
        maxBatches: 10,
      });

      // 1 success + 2 failed = 3 evictions to reach cap of 1 from 4 rows.
      expect(result.sizePrune.deleted).toBe(3);

      const surviving = await deliveryIds();
      expect(surviving).not.toContain(success.id);
      expect(surviving).not.toContain(failedOld.id);
      // failedMid and failedNew survive — newest failed is kept.
      expect(surviving).toContain(failedNew.id);
    },
    120_000,
  );

  it(
    "does not run the size prune when under the max-rows cap",
    async () => {
      for (let i = 0; i < 5; i += 1) {
        await seedDelivery("success", RECENT);
      }

      const result = await prunePluginWebhookDeliveries(db, {
        successRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_SUCCESS_RETENTION_DAYS,
        failedRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_FAILED_RETENTION_DAYS,
        maxRows: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_MAX_ROWS,
      });

      expect(result.agePrune.deleted).toBe(0);
      expect(result.sizePrune.deleted).toBe(0);
      expect(await deliveryIds()).toHaveLength(5);
    },
    120_000,
  );

  it(
    "reclaims table size measured off-live on the embedded database",
    async () => {
      for (let i = 0; i < 200; i += 1) {
        await seedDelivery("success", ANCIENT);
        await seedDelivery("failed", ANCIENT);
      }

      const measure = async (label: string) => {
        const rows = (await db.execute(sql`
          SELECT relname,
                 pg_total_relation_size(c.oid)::bigint AS total_bytes,
                 (SELECT count(*) FROM plugin_webhook_deliveries) AS row_count
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND relname = 'plugin_webhook_deliveries'
        `)) as unknown as Array<Record<string, string>>;
        for (const row of rows) {
          process.stdout.write(
            `[webhook-retention:${label}] ${row.relname}: total=${(Number(row.total_bytes) / 1024).toFixed(0)} KiB\n`,
          );
        }
        process.stdout.write(
          `[webhook-retention:${label}] rows: plugin_webhook_deliveries=${rows[0].row_count}\n`,
        );
        return rows;
      };

      const before = await measure("before");
      expect(Number(before[0].row_count)).toBe(400);

      const result = await prunePluginWebhookDeliveries(db, {
        successRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_SUCCESS_RETENTION_DAYS,
        failedRetentionDays: DEFAULT_PLUGIN_WEBHOOK_DELIVERY_FAILED_RETENTION_DAYS,
        batchSize: 1_000,
        maxBatches: 100,
      });
      expect(result.totalDeleted).toBe(400);

      // VACUUM is what actually returns the dead tuples, including the JSONB
      // pages the payloads occupy. Autovacuum does this on its own schedule;
      // forcing it here makes the reclaim measurable in one run.
      await db.execute(sql`VACUUM (ANALYZE) plugin_webhook_deliveries`);

      const after = await measure("after");
      expect(Number(after[0].row_count)).toBe(0);

      const totalBefore = Number(before[0].total_bytes);
      const totalAfter = Number(after[0].total_bytes);
      expect(totalAfter).toBeLessThan(totalBefore);
    },
    180_000,
  );
});
