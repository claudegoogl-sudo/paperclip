import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { withHostAdmissionLock } from "../agent-start-lock.js";
import { HOST_MAX_CONCURRENT_RUNS_ENV_VAR, resolveHostRunCeiling } from "../host-run-ceiling.js";
import {
  RUN_ADMISSION_MEMORY_CGROUP_DIR_ENV_VAR,
  RUN_ADMISSION_MEMORY_PCT_ENV_VAR,
  RUN_ADMISSION_MEMORY_SAMPLE_TTL_MS_DEFAULT,
  createRunAdmissionMemoryPressureReader,
  resolveRunAdmissionMemoryPct,
} from "../run-admission-memory-pressure.js";

/**
 * Host-wide run admission (fork carryover): the concurrent-run ceiling, the in-flight
 * reservation that closes the claim race, the cgroup memory-pressure backoff, fair-share
 * accounting and the observable state. The dispatch loop reserves a slot per claim, hands the
 * reservation to `executeRun` on success, and frees it on every other path.
 */
export function createHostRunAdmission(input: {
  db: Db;
  runtimeEnv: Record<string, string | undefined>;
  runOccupiesHostSlot: (row: {
    id: string;
    processPid: number | null;
    processGroupId: number | null;
    adapterType: string;
  }) => boolean;
}) {
  const { db, runtimeEnv, runOccupiesHostSlot } = input;
  const hostRunCeiling = resolveHostRunCeiling(runtimeEnv[HOST_MAX_CONCURRENT_RUNS_ENV_VAR]);
  logger.info(
    {
      hostMaxConcurrentRuns: hostRunCeiling.value,
      source: hostRunCeiling.source,
      vcpuCount: hostRunCeiling.vcpuCount,
      envVar: HOST_MAX_CONCURRENT_RUNS_ENV_VAR,
      ...(hostRunCeiling.invalidEnvValue ? { ignoredEnvValue: hostRunCeiling.invalidEnvValue } : {}),
    },
    "resolved host-wide concurrent run ceiling",
  );

  // Slots taken between a successful admission decision and the moment the claim makes the
  // run visible as `running` in the DB. Held only across `claimQueuedRun` and always released
  // in a `finally`, so a crashed or cancelled claim cannot leak a slot; a process restart
  // drops them entirely and the DB count becomes authoritative again.
  let inFlightHostRunReservations = 0;
  let hostCeilingDeferralCount = 0;
  // Insertion-ordered, so draining it after a slot frees rotates through the deferred agents
  // instead of always re-offering the slot to whoever asked most recently.
  const hostCeilingDeferredAgentIds = new Set<string>();

  // Memory-pressure guardrail: when the service's own cgroup is at or above the threshold
  // fraction of its effective soft memory limit, admission defers through the same deferral
  // machinery a ceiling refusal uses. Off cgroup-v2 hosts the reading reports unavailable
  // and admission is unchanged.
  const runAdmissionMemoryPct = resolveRunAdmissionMemoryPct(
    runtimeEnv[RUN_ADMISSION_MEMORY_PCT_ENV_VAR],
  );
  const runAdmissionMemoryPressure = createRunAdmissionMemoryPressureReader({ env: runtimeEnv });
  let runAdmissionMemoryDeferralCount = 0;
  logger.info(
    {
      runAdmissionMemoryPct: runAdmissionMemoryPct.value,
      source: runAdmissionMemoryPct.source,
      envVar: RUN_ADMISSION_MEMORY_PCT_ENV_VAR,
      sampleTtlMs: RUN_ADMISSION_MEMORY_SAMPLE_TTL_MS_DEFAULT,
      cgroupDirOverrideEnvVar: RUN_ADMISSION_MEMORY_CGROUP_DIR_ENV_VAR,
      ...(runAdmissionMemoryPct.invalidEnvValue
        ? { ignoredEnvValue: runAdmissionMemoryPct.invalidEnvValue }
        : {}),
    },
    "resolved run admission memory-pressure threshold",
  );

  async function countAgentsWithQueuedRuns() {
    const [{ count }] = await db
      .select({ count: sql<number>`count(distinct ${heartbeatRuns.agentId})` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "queued"));
    return Number(count ?? 0);
  }

  async function countRunningRunsHostWide() {
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        processPid: heartbeatRuns.processPid,
        processGroupId: heartbeatRuns.processGroupId,
        adapterType: agents.adapterType,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(eq(heartbeatRuns.status, "running"));
    let count = 0;
    for (const row of rows) {
      if (runOccupiesHostSlot(row)) count += 1;
    }
    return count;
  }

  /**
   * Atomically decides whether one more run may start host-wide. The DB count and the
   * reservation increment happen inside `withHostAdmissionLock`, so two agents dispatching
   * concurrently cannot both read the same pre-claim count. Deliberately does *not* wrap the
   * claim itself.
   */
  async function reserve() {
    return withHostAdmissionLock(async () => {
      const hostRunningCount = await countRunningRunsHostWide();
      const hostInUse = hostRunningCount + inFlightHostRunReservations;
      if (hostInUse >= hostRunCeiling.value) {
        return { granted: false as const, reason: "host_ceiling" as const, hostRunningCount, hostInUse };
      }
      // Memory-pressure admission backoff: sampled from the service's own cgroup v2
      // (TTL-cached), and only when a usable reading exists. Deferred runs stay queued and
      // re-enter this gate through the existing deferral/drain machinery.
      const memoryPressure = await runAdmissionMemoryPressure.read();
      if (
        memoryPressure.available &&
        memoryPressure.memoryPressurePct !== null &&
        memoryPressure.memoryPressurePct >= runAdmissionMemoryPct.value
      ) {
        runAdmissionMemoryDeferralCount += 1;
        return {
          granted: false as const,
          reason: "memory_pressure" as const,
          hostRunningCount,
          hostInUse,
          memoryPressurePct: memoryPressure.memoryPressurePct,
          memoryPressureThresholdPct: runAdmissionMemoryPct.value,
          memoryCurrentBytes: memoryPressure.memoryCurrentBytes,
          inactiveFileBytes: memoryPressure.inactiveFileBytes,
          nonReclaimableBytes: memoryPressure.nonReclaimableBytes,
          pressureBasis: memoryPressure.pressureBasis,
          effectiveMemoryLimitBytes: memoryPressure.effectiveLimitBytes,
          memoryEventsHigh: memoryPressure.memoryEventsHigh,
          cgroupDir: memoryPressure.cgroupDir,
        };
      }
      inFlightHostRunReservations += 1;
      return { granted: true as const, reason: "granted" as const, hostRunningCount, hostInUse };
    });
  }

  type Reservation = Awaited<ReturnType<typeof reserve>>;

  // Details the deferral logger emits for a memory-pressure refusal so the one warn per
  // deferral carries the numbers an operator needs to tell memory backoff from ceiling throttling.
  function memoryPressureDeferralDetails(reservation: Reservation): Record<string, unknown> {
    if (reservation.reason !== "memory_pressure") return { deferralReason: reservation.reason };
    return {
      deferralReason: reservation.reason,
      memoryPressurePct: reservation.memoryPressurePct,
      memoryPressureThresholdPct: reservation.memoryPressureThresholdPct,
      memoryCurrentBytes: reservation.memoryCurrentBytes,
      inactiveFileBytes: reservation.inactiveFileBytes,
      nonReclaimableBytes: reservation.nonReclaimableBytes,
      pressureBasis: reservation.pressureBasis,
      effectiveMemoryLimitBytes: reservation.effectiveMemoryLimitBytes,
      memoryEventsHigh: reservation.memoryEventsHigh,
      cgroupDir: reservation.cgroupDir,
    };
  }

  function release() {
    inFlightHostRunReservations = Math.max(0, inFlightHostRunReservations - 1);
  }

  function recordDeferral(agentId: string, details: Record<string, unknown>, opts?: { message?: string }) {
    hostCeilingDeferralCount += 1;
    hostCeilingDeferredAgentIds.add(agentId);
    logger.warn(
      {
        agentId,
        hostMaxConcurrentRuns: hostRunCeiling.value,
        hostCeilingSource: hostRunCeiling.source,
        inFlightHostRunReservations,
        hostCeilingDeferralCount,
        deferredAgentCount: hostCeilingDeferredAgentIds.size,
        ...details,
      },
      opts?.message ?? "heartbeat dispatch deferred by host concurrent-run ceiling",
    );
  }

  return {
    hostRunCeiling,
    countAgentsWithQueuedRuns,
    countRunningRunsHostWide,
    reserve,
    release,
    recordDeferral,
    memoryPressureDeferralDetails,
    deferredAgentIds: hostCeilingDeferredAgentIds,
    getState: async () => {
      const memoryPressure = runAdmissionMemoryPressure.lastReading();
      return {
        maxConcurrentRuns: hostRunCeiling.value,
        source: hostRunCeiling.source,
        vcpuCount: hostRunCeiling.vcpuCount,
        hostRunningCount: await countRunningRunsHostWide(),
        inFlightReservations: inFlightHostRunReservations,
        deferralCount: hostCeilingDeferralCount,
        deferredAgentIds: [...hostCeilingDeferredAgentIds],
        // Memory-pressure admission backoff observability: the last sampled cgroup reading
        // plus the count of admissions deferred by it.
        memoryPressurePct: memoryPressure?.memoryPressurePct ?? null,
        memoryPressureAvailable: memoryPressure?.available ?? false,
        runAdmissionMemoryPct: runAdmissionMemoryPct.value,
        deferralsByMemory: runAdmissionMemoryDeferralCount,
      };
    },
  };
}
