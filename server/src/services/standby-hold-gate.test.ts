import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { legacyExecutionNeedsReconciliation } from "./legacy-execution-recovery.js";
import { recordExecutionWait, EXECUTION_HOLD_ALERT_THRESHOLD } from "./execution-wait.js";

const base = { runtimeMode: "legacy", status: "failed", errorCode: "adapter_failed", resultJson: null } as never;

describe("legacyExecutionNeedsReconciliation never-started runs", () => {
  const cancelled = { runtimeMode: "legacy", status: "cancelled", errorCode: "execution_reconciliation_required", resultJson: null, startedAt: null, processPid: null, processGroupId: null } as never;
  it("does not mint a hold for a stale-gate cancel that never started", () => {
    expect(legacyExecutionNeedsReconciliation(cancelled)).toBe(false);
    expect(legacyExecutionNeedsReconciliation({ ...(cancelled as object), startedAt: new Date() } as never)).toBe(true);
    expect(legacyExecutionNeedsReconciliation({ ...(cancelled as object), processPid: 42 } as never)).toBe(true);
  });
  it("does not mint a hold for provider-unreachable failures", () => {
    for (const error of ["No API key for provider anthropic", "spawn E2BIG"])
      expect(legacyExecutionNeedsReconciliation({ ...(base as object), error } as never)).toBe(false);
    expect(legacyExecutionNeedsReconciliation({ ...(base as object), error: "No API key for provider x", resultJson: { toolCallCount: 2 } } as never)).toBe(true);
    expect(legacyExecutionNeedsReconciliation({ ...(base as object), error: "boom" } as never)).toBe(true);
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("standby inbox recovery holds", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("standby-hold-"); db = createDb(database.connectionString); }, 30000);
  afterAll(async () => { await database?.cleanup(); });
  async function seed(opts: { standby: boolean; status: string; restoreFailure?: boolean }) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Standby", defaultResponsibleUserId: "board", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "A", role: "engineer", adapterType: "paperclip_runner", status: "idle", runtimeConfig: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Inbox", status: "in_progress", assigneeAgentId: agentId,
      ...(opts.standby ? { executionPolicy: { standbyWakeTarget: true } as never } : {}) });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "legacy_execution_requires_reconciliation", fingerprint: randomUUID(), status: opts.status, outcome: "blocked",
      nextAction: "held", evidence: { automaticRecovery: { replay: "blocked" }, ...(opts.restoreFailure ? { workspaceRestoreFailure: "restore_unsafe_archive" } : {}) } } as never);
    return { companyId, agentId, issueId };
  }
  it("ignores settled holds on standby inboxes only", async () => {
    const s = await seed({ standby: true, status: "resolved" });
    expect(await getExecutionBlocker(db, s.companyId, s.issueId)).toBeNull();
    const n = await seed({ standby: false, status: "resolved" });
    expect(await getExecutionBlocker(db, n.companyId, n.issueId)).not.toBeNull();
  });
  it("still blocks standby inboxes on active holds and unsafe-workspace holds", async () => {
    const a = await seed({ standby: true, status: "active" });
    expect(await getExecutionBlocker(db, a.companyId, a.issueId)).not.toBeNull();
    const r = await seed({ standby: true, status: "resolved", restoreFailure: true });
    expect(await getExecutionBlocker(db, r.companyId, r.issueId)).not.toBeNull();
  });
  it("posts exactly one alert comment when a held issue is skipped N times", async () => {
    const s = await seed({ standby: false, status: "active" });
    for (let i = 0; i < EXECUTION_HOLD_ALERT_THRESHOLD + 3; i++)
      await recordExecutionWait(db, { issueId: s.issueId, coalesce: true, condition: { recoveryActionId: "x" },
        request: { companyId: s.companyId, agentId: s.agentId, source: "automation", triggerDetail: "system",
          reason: "execution_reconciliation_required", payload: {} } as never });
    const alerts = await db.select().from(issueComments).where(eq(issueComments.issueId, s.issueId));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].authorType).toBe("system");
    const [w] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.agentId));
    expect(w.coalescedCount).toBe(EXECUTION_HOLD_ALERT_THRESHOLD + 2);
  });
});
