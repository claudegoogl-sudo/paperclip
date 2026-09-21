import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { MAX_ISSUE_REQUEST_DEPTH } from "@paperclipai/shared";
import {
  HIGH_COMMENT_VOLUME_ALERT_ORIGIN_KIND,
  highCommentVolumeAlertService,
} from "../services/high-comment-volume-alert.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres productivity review tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("productivity review service", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-productivity-review-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedAssignedIssue(opts?: {
    status?: "todo" | "in_progress";
    startedAt?: Date;
    parentId?: string | null;
    originKind?: string;
    executionPolicy?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `PR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const createdAt = new Date("2026-04-28T10:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Productivity Review Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implement data import",
      status: opts?.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      parentId: opts?.parentId ?? null,
      originKind: opts?.originKind ?? "manual",
      executionPolicy: opts?.executionPolicy ?? null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: opts?.startedAt ?? createdAt,
      createdAt,
      updatedAt: createdAt,
    });

    return { companyId, managerId, coderId, issueId, issuePrefix, createdAt };
  }

  async function insertRuns(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    count: number;
    now: Date;
    withRunComments?: boolean;
  }) {
    const runs: Array<typeof heartbeatRuns.$inferInsert> = [];
    for (let index = 0; index < input.count; index += 1) {
      const runId = randomUUID();
      const createdAt = new Date(input.now.getTime() - index * 60_000);
      runs.push({
        id: runId,
        companyId: input.companyId,
        agentId: input.agentId,
        status: "succeeded",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 30_000),
        contextSnapshot: { issueId: input.issueId, taskId: input.issueId },
        livenessState: "advanced",
        nextAction: "Continue processing the next batch.",
        createdAt,
        updatedAt: createdAt,
      });
    }
    await db.insert(heartbeatRuns).values(runs);

    if (input.withRunComments) {
      await db.insert(issueComments).values(
        runs.map((run, index) => ({
          companyId: input.companyId,
          issueId: input.issueId,
          authorAgentId: input.agentId,
          createdByRunId: run.id,
          body: `Progress update ${index}`,
          createdAt: run.createdAt as Date,
          updatedAt: run.createdAt as Date,
        })),
      );
    }

    return runs;
  }

  
  

});

describe("high comment volume alerts (fork monitor, standalone module)", () => {
  it("raises exactly one deduplicated high-comment-volume alert per offending issue", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertPlainComments({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      authorAgentId: seeded.coderId,
      count: 4,
      now,
    });

    const service = highCommentVolumeAlertService(db);
    const first = await service.reconcileHighCommentVolumeAlerts({ now, companyId: seeded.companyId, threshold: 3 });
    const second = await service.reconcileHighCommentVolumeAlerts({ now, companyId: seeded.companyId, threshold: 3 });

    expect(first.threshold).toBe(3);
    expect(first.scanned).toBe(1);
    expect(first.alerted).toBe(1);
    expect(second.alerted).toBe(0);
    expect(second.existing).toBe(1);

    const alerts = await listHighCommentVolumeAlerts(seeded.companyId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.parentId).toBe(seeded.issueId);
    expect(alerts[0]?.assigneeAgentId).toBe(seeded.managerId);
    expect(alerts[0]?.originId).toBe(seeded.issueId);
    expect(alerts[0]?.originFingerprint).toBe(`high-comment-volume-alert:${seeded.issueId}`);
    expect(alerts[0]?.description).toContain("Comment count: 4");
    expect(alerts[0]?.description).toContain("Alert threshold: 3");
  });

  it("does not raise a high-comment-volume alert below the threshold", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertPlainComments({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      authorAgentId: seeded.coderId,
      count: 2,
      now,
    });

    const result = await highCommentVolumeAlertService(db).reconcileHighCommentVolumeAlerts({
      now,
      companyId: seeded.companyId,
      threshold: 3,
    });

    expect(result.scanned).toBe(0);
    expect(result.alerted).toBe(0);
    expect(await listHighCommentVolumeAlerts(seeded.companyId)).toHaveLength(0);
  });
});

async function listHighCommentVolumeAlerts(companyId: string) {
  const rows = await db
    .select({ id: issues.id, parentId: issues.parentId, assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        sql`${issues.originKind} = ${HIGH_COMMENT_VOLUME_ALERT_ORIGIN_KIND}`,
      ),
    );
  const detailed = await Promise.all(
    rows.map(async (row) => {
      const [full] = await db.select().from(issues).where(eq(issues.id, row.id)).limit(1);
      return full;
    }),
  );
  return detailed.filter(Boolean);
}
