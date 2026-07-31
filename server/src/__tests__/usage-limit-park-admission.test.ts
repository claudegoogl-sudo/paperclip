import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  usageLimitParks,
} from "@paperclipai/db";
import { extractClaudeRetryNotBefore } from "@paperclipai/adapter-claude-local/server";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  NO_OP_DISPATCH_RETRY_SAFETY_MARGIN_MS,
  heartbeatService,
  isZeroWorkUsageLimitResult,
  resolveUsageLimitParkTarget,
  shouldParkForUsageLimit,
} from "../services/heartbeat.ts";
import { usageLimitParkService } from "../services/usage-limit-park.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres usage-limit park admission tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// PLA-1930: covers the acceptance criteria not already exercised by
// heartbeat-retry-scheduling.test.ts (attempt-counter compounding) or
// parse.test.ts (reset-string regression coverage):
//   AC2 - a park blocks admission through the wake-request dispatch path
//         (enqueueWakeup -> startNextQueuedRunForAgent), not only scheduled retry.
//   AC3 - a mid-flight limit result does not park.
//   AC5 - park state (parkedUntil + reason) is observable, with extend-not-shorten
//         and early-clear-on-success semantics pinned.
//   AC6 - replay against the ticket's literal live result_json / result string.
//
// PLA-1967 (narrowing follow-up to PLA-1930/PR#136) adds:
//   AC1 - a zero-work failure additionally requires a usage-limit signal string;
//         the three literal live false-positive strings must not park.
//   AC2 - "Usage credits are required for this model" is treated as a genuine
//         limit signal (CTO's explicit read) and still parks.
//   AC3 - representative genuine live strings (weekly w/ and w/o date, session)
//         still park.
//   AC4 - the classifier is unreachable for non-failed outcomes, independent of
//         the call site, via `shouldParkForUsageLimit`.
describeEmbeddedPostgres("PLA-1930 usage-limit park", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let usageLimitPark!: ReturnType<typeof usageLimitParkService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-usage-limit-park-admission-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    usageLimitPark = usageLimitParkService(db);
  }, 45_000);

  // The negative-control admission test below deliberately lets a real claim
  // succeed (heartbeat.wakeup -> startNextQueuedRunForAgent -> a fire-and-forget
  // `void executeRun(...)` that this test suite has no seam to await or abort —
  // see the PLA-1930 comment on `isZeroWorkUsageLimitResult` in heartbeat.ts).
  // Its errors are already caught and logged internally (never rethrown), so it
  // cannot fail a test directly, but it keeps writing to heartbeat_run_events /
  // environment_leases / agent_runtime_state in the background after the test
  // function returns. Delete in dependency order with a short bounded retry on
  // FK-violation (23503) so a still-racing write doesn't fail cleanup — once the
  // background task's current write burst subsides, the retry succeeds.
  async function deleteAllTolerantly(table: Parameters<typeof db.delete>[0]) {
    const deadline = Date.now() + 3_000;
    for (;;) {
      try {
        await db.delete(table);
        return;
      } catch (err) {
        const code = (err as { cause?: { code?: string } } | undefined)?.cause?.code;
        if (code !== "23503" || Date.now() >= deadline) throw err;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  afterEach(async () => {
    await deleteAllTolerantly(heartbeatRunEvents);
    await deleteAllTolerantly(environmentLeases);
    await deleteAllTolerantly(heartbeatRuns);
    await deleteAllTolerantly(agentWakeupRequests);
    await deleteAllTolerantly(agentRuntimeState);
    await deleteAllTolerantly(agents);
    await deleteAllTolerantly(companies);
    await deleteAllTolerantly(usageLimitParks);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // usage_limit_parks.source_run_id is a real FK onto heartbeat_runs.id (see
  // packages/db/src/schema/usage_limit_parks.ts) so any test that asserts on
  // the persisted sourceRunId must seed a matching row first.
  async function seedHeartbeatRun(input: { id: string; companyId: string; agentId: string }) {
    await db.insert(heartbeatRuns).values({
      id: input.id,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "failed",
    });
  }

  async function seedAgent(input: { companyId: string; agentId: string }) {
    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
  }

  describe("isZeroWorkUsageLimitResult classification (AC3, feeds AC2)", () => {
    it("classifies an all-zero weekly-limit result as zero-work (park-eligible)", () => {
      expect(
        isZeroWorkUsageLimitResult({
          total_cost_usd: 0,
          duration_api_ms: 0,
          num_turns: 1,
          is_error: true,
          result: "You've hit your weekly limit · resets 8am (UTC)",
        }),
      ).toBe(true);
    });

    it("AC3: does not classify a mid-flight limit result (non-zero cost, num_turns > 1) as zero-work", () => {
      expect(
        isZeroWorkUsageLimitResult({
          total_cost_usd: 0.42,
          duration_api_ms: 15321,
          num_turns: 3,
          is_error: true,
          result: "You've hit your weekly limit · resets 8am (UTC)",
        }),
      ).toBe(false);
    });

    it("fails closed when cost/duration/turns are missing rather than assuming zero-work", () => {
      expect(isZeroWorkUsageLimitResult({})).toBe(false);
      expect(isZeroWorkUsageLimitResult({ total_cost_usd: 0, duration_api_ms: 0 })).toBe(false);
    });

    // PLA-1967 AC1/AC3: literal live false-positive strings from the ticket's
    // 30-day audit (CTO, queried against heartbeat_runs) — all zero-work but
    // carrying no usage-limit signal, so none of these may park the fleet.
    it.each([
      ["expired OAuth token", "Failed to authenticate. API Error: 401 OAuth access token has expired."],
      ["bad model id", "There's an issue with the selected model (Claude Opus 5.0)..."],
      ["transient 529 overloaded", "API Error: 529 Overloaded..."],
    ])("PLA-1967: does not park a zero-work failure with no limit signal (%s)", (_label, result) => {
      expect(
        isZeroWorkUsageLimitResult({
          total_cost_usd: 0,
          duration_api_ms: 0,
          num_turns: 1,
          is_error: true,
          result,
        }),
      ).toBe(false);
    });

    // PLA-1967 AC3: representative genuine live strings must still park.
    it.each([
      ["weekly, with date", "You've hit your weekly limit · resets Jul 31, 8am (UTC)"],
      ["weekly, without date", "You've hit your weekly limit · resets 8am (UTC)"],
      ["session", "You've hit your session limit · resets 1:50pm (UTC)"],
    ])("PLA-1967: still parks a genuine zero-work limit hit (%s)", (_label, result) => {
      expect(
        isZeroWorkUsageLimitResult({
          total_cost_usd: 0,
          duration_api_ms: 0,
          num_turns: 1,
          is_error: true,
          result,
        }),
      ).toBe(true);
    });

    // PLA-1967 AC2: CTO's explicit read — "usage credits are required" is a
    // quota condition and should park, called out here rather than left
    // implicit in the regex.
    it("PLA-1967 AC2: parks on 'usage credits are required for this model'", () => {
      expect(
        isZeroWorkUsageLimitResult({
          total_cost_usd: 0,
          duration_api_ms: 0,
          num_turns: 1,
          is_error: true,
          result: "Usage credits are required for this model.",
        }),
      ).toBe(true);
    });

    it("PLA-1967: signal match is case-insensitive", () => {
      expect(
        isZeroWorkUsageLimitResult({
          total_cost_usd: 0,
          duration_api_ms: 0,
          num_turns: 1,
          result: "USAGE LIMIT REACHED",
        }),
      ).toBe(true);
    });
  });

  describe("shouldParkForUsageLimit outcome guard (PLA-1967 AC4)", () => {
    const zeroWorkLimitResult = {
      total_cost_usd: 0,
      duration_api_ms: 0,
      num_turns: 1,
      is_error: true,
      result: "You've hit your weekly limit · resets 8am (UTC)",
    };

    it.each(["succeeded", "succeeded_dirty", "cancelled", "timed_out"] as const)(
      "does not park for a %s outcome even when the result would otherwise be park-eligible",
      (outcome) => {
        expect(shouldParkForUsageLimit(outcome, zeroWorkLimitResult)).toBe(false);
      },
    );

    it("parks for a failed outcome carrying a genuine zero-work limit signal", () => {
      expect(shouldParkForUsageLimit("failed", zeroWorkLimitResult)).toBe(true);
    });

    it("does not park for a failed outcome without a limit signal", () => {
      expect(
        shouldParkForUsageLimit("failed", {
          total_cost_usd: 0,
          duration_api_ms: 0,
          num_turns: 1,
          result: "Failed to authenticate. API Error: 401 OAuth access token has expired.",
        }),
      ).toBe(false);
    });
  });

  describe("usageLimitParkService semantics (AC5)", () => {
    it("park() sets an observable parkedUntil/reason and isParked() reflects it", async () => {
      const parkedUntil = new Date("2026-07-31T08:01:00.000Z");
      await usageLimitPark.park({
        parkedUntil,
        reason: "usage_limit_zero_work",
        rawLimitText: "You've hit your weekly limit · resets 8am (UTC)",
        sourceRunId: null,
      });

      const state = await usageLimitPark.getState(new Date("2026-07-31T07:00:00.000Z"));
      expect(state.parked).toBe(true);
      expect(state.parkedUntil?.toISOString()).toBe(parkedUntil.toISOString());
      expect(state.reason).toBe("usage_limit_zero_work");

      expect(await usageLimitPark.isParked(new Date("2026-07-31T09:00:00.000Z"))).toBe(false);
    });

    it("park() extends rather than shortens an existing park (a later, less precise reset must not pull the gate open early)", async () => {
      await usageLimitPark.park({
        parkedUntil: new Date("2026-07-31T12:00:00.000Z"),
        reason: "usage_limit_zero_work",
        rawLimitText: null,
        sourceRunId: null,
      });
      await usageLimitPark.park({
        parkedUntil: new Date("2026-07-31T08:00:00.000Z"),
        reason: "usage_limit_zero_work",
        rawLimitText: null,
        sourceRunId: null,
      });

      const state = await usageLimitPark.getState();
      expect(state.parkedUntil?.toISOString()).toBe("2026-07-31T12:00:00.000Z");
    });

    it("clear() ends the park early (first-successful-run recovery)", async () => {
      await usageLimitPark.park({
        parkedUntil: new Date(Date.now() + 60 * 60 * 1000),
        reason: "usage_limit_zero_work",
        rawLimitText: null,
        sourceRunId: null,
      });
      expect(await usageLimitPark.isParked()).toBe(true);

      await usageLimitPark.clear({ reason: "run_succeeded" });
      expect(await usageLimitPark.isParked()).toBe(false);
    });
  });

  describe("admission gate integration (AC2)", () => {
    it("blocks a wake-request dispatch (enqueueWakeup -> startNextQueuedRunForAgent) for an unrelated agent in an unrelated company while parked", async () => {
      // The park is set by a DIFFERENT agent/company's zero-work usage-limit hit —
      // the gate is account-wide, so it must block this bystander agent's on-demand
      // wake too, even though nothing about the bystander's own run history is limited.
      await usageLimitPark.park({
        parkedUntil: new Date(Date.now() + 60 * 60 * 1000),
        reason: "usage_limit_zero_work",
        rawLimitText: "You've hit your weekly limit · resets 8am (UTC)",
        sourceRunId: null,
      });
      expect(await usageLimitPark.isParked()).toBe(true);

      const bystanderCompanyId = randomUUID();
      const bystanderAgentId = randomUUID();
      await seedAgent({ companyId: bystanderCompanyId, agentId: bystanderAgentId });

      const queuedRun = await heartbeat.wakeup(bystanderAgentId, {
        source: "on_demand",
        reason: "manual_test_wake",
        requestedByActorType: "system",
        requestedByActorId: "test",
      });

      expect(queuedRun).not.toBeNull();

      // This is the assertion that proves the exact bypass the ticket names is
      // closed: enqueueWakeup's own call to startNextQueuedRunForAgent would,
      // without the park gate, claim this run and flip it to "running" (and fire
      // the adapter) within the same await — a per-run scheduled-retry check never
      // enters the picture at all on this path.
      const persisted = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedRun!.id))
        .then((rows) => rows[0] ?? null);
      expect(persisted?.status).toBe("queued");
    });

    it("negative control: the same wake-request path is not blocked when nothing is parked", async () => {
      expect(await usageLimitPark.isParked()).toBe(false);

      const companyId = randomUUID();
      const agentId = randomUUID();
      await seedAgent({ companyId, agentId });

      const queuedRun = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        reason: "manual_test_wake",
        requestedByActorType: "system",
        requestedByActorId: "test",
      });

      expect(queuedRun).not.toBeNull();
      // Not parked, so startNextQueuedRunForAgent's claim path is reachable —
      // claimQueuedRun and the fire-and-forget executeRun call race with this
      // assertion, so "queued" (not yet claimed) or "running" (claimed) are both
      // valid outcomes here. What AC2's positive case above proves is that a park
      // forces "queued" to be the ONLY possible outcome; this control just confirms
      // that constraint doesn't fire spuriously when nothing is parked.
      const persisted = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedRun!.id))
        .then((rows) => rows[0] ?? null);
      expect(["queued", "running"]).toContain(persisted?.status);
    });
  });

  // AC6: replay evidence. Fields below are the LITERAL values quoted in PLA-1930's
  // "Verified state" section for heartbeat_runs.id = 1b7ad226-762e-46ba-8699-1ec494a17968
  // (started_at 2026-07-31T07:56:58.195Z), read from the issue text — the underlying
  // /tmp/pla1880-live-result.json on the core host is not reachable from this sandboxed
  // workspace, so this is a reconstruction from the ticket's quoted fields, not an
  // independently re-fetched file. The ticket gives `retry_of_run_id` and
  // `wakeup_request_id` only as truncated prefixes ("2732cd35-...", "56495803-...");
  // those two fields are irrelevant to the classifier/park decision under replay, so
  // they are omitted here rather than fabricated to a full UUID.
  describe("AC6 replay: literal live result_json from heartbeat_runs.id=1b7ad226-762e-46ba-8699-1ec494a17968", () => {
    const LIVE_RESULT_JSON = {
      noOpDispatch: true,
      noOpDispatchReason: "pre_turn_rate_limit",
      errorFamily: "transient_upstream",
      api_error_status: 429,
      total_cost_usd: 0,
      duration_api_ms: 0,
      num_turns: 1,
      is_error: true,
      subtype: "success",
      // Quoted verbatim, U+00B7 middle dot, undated form ("no retryNotBefore key at all").
      result: "You've hit your weekly limit · resets 8am (UTC)",
    };
    const STARTED_AT = new Date("2026-07-31T07:56:58.195Z");

    it("classifies the live row as zero-work (would have been park-eligible)", () => {
      expect(isZeroWorkUsageLimitResult(LIVE_RESULT_JSON)).toBe(true);
    });

    it("the live row genuinely has no parseable retryNotBefore under heartbeat.ts's own field read (resultJson.retryNotBefore / .transientRetryNotBefore), matching the ticket's 'no retryNotBefore key at all'", () => {
      expect((LIVE_RESULT_JSON as Record<string, unknown>).retryNotBefore).toBeUndefined();
      expect((LIVE_RESULT_JSON as Record<string, unknown>).transientRetryNotBefore).toBeUndefined();
    });

    it("fork/master's fixed parser CAN extract a reset instant from the live `result` string directly (the gap is only that the pre-fix adapter never stamped it onto resultJson)", () => {
      const retryNotBefore = extractClaudeRetryNotBefore({ parsed: LIVE_RESULT_JSON }, STARTED_AT);
      // Undated "resets 8am (UTC)" with started_at 07:56:58 -> next 8am UTC is the
      // same day, exactly matching the ticket's own note that the 08:00 hour dropped
      // to 0 failed runs (the real reset landed at 08:00 that day).
      expect(retryNotBefore?.toISOString()).toBe("2026-07-31T08:00:00.000Z");
    });

    it("without a stamped retryNotBefore, resolveUsageLimitParkTarget still parks via the bounded fallback window rather than not parking at all", () => {
      const parkedUntil = resolveUsageLimitParkTarget({ now: STARTED_AT, retryNotBefore: null });
      // NO_OP_DISPATCH_RETRY_FALLBACK_DELAY_MS (10 minutes) from STARTED_AT.
      expect(parkedUntil.toISOString()).toBe("2026-07-31T08:06:58.195Z");
    });

    it("with a stamped retryNotBefore (the fork.10-onward shape), resolveUsageLimitParkTarget targets reset + the no-op safety margin", () => {
      const retryNotBefore = extractClaudeRetryNotBefore({ parsed: LIVE_RESULT_JSON }, STARTED_AT);
      const parkedUntil = resolveUsageLimitParkTarget({ now: STARTED_AT, retryNotBefore });
      expect(parkedUntil.toISOString()).toBe(
        new Date(retryNotBefore!.getTime() + NO_OP_DISPATCH_RETRY_SAFETY_MARGIN_MS).toISOString(),
      );
      expect(parkedUntil.toISOString()).toBe("2026-07-31T08:01:00.000Z");
    });

    it("end-to-end: usageLimitPark.park() fed the fallback target from this exact live row is observable and admission-blocking", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const sourceRunId = "1b7ad226-762e-46ba-8699-1ec494a17968";
      await seedAgent({ companyId, agentId });
      await seedHeartbeatRun({ id: sourceRunId, companyId, agentId });

      const parkedUntil = resolveUsageLimitParkTarget({ now: STARTED_AT, retryNotBefore: null });
      await usageLimitPark.park({
        parkedUntil,
        reason: "claude_no_op_dispatch",
        rawLimitText: LIVE_RESULT_JSON.result,
        sourceRunId,
      });

      const state = await usageLimitPark.getState(STARTED_AT);
      expect(state.parked).toBe(true);
      expect(state.rawLimitText).toBe("You've hit your weekly limit · resets 8am (UTC)");
      expect(state.sourceRunId).toBe(sourceRunId);
    });
  });
});
