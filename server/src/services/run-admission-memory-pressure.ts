import { readFile } from "node:fs/promises";

import {
  deriveCgroupRelativePath,
  resolveCgroupV2MountRoot,
} from "./cgroup-pids-telemetry.js";

/**
 * Memory-pressure-aware run admission.
 *
 * The host-wide concurrent-run ceiling (`services/host-run-ceiling.ts`, enforced in
 * `reserveHostRunSlot`) bounds how many adapter processes run at once, but it cannot see
 * the cgroup memory budget those processes fill. After a crash-loop restart, boot
 * recovery replays continuations for every stranded `in_progress` issue; the ceiling
 * admits a full house of heavy runs within seconds and the service cgroup refills to
 * `memory.high`/`memory.max`, converting a recoverable restart into another OOM.
 *
 * This module reads the service's own cgroup v2 memory files and turns the reading into
 * one number — `memoryPressurePct`, the fraction of the *effective* soft limit currently
 * in use. `reserveHostRunSlot` defers admission when that number reaches the configured
 * threshold, through the exact same deferral/drain machinery a ceiling refusal already
 * uses. Nothing here queues or retries on its own.
 *
 * Failure is a no-op, never a block: on hosts without cgroup v2 memory files (macOS,
 * Windows, minimal containers, CI), or when no limit is set, the reading reports
 * `available: false` and admission proceeds exactly as before.
 */

export const RUN_ADMISSION_MEMORY_PCT_ENV_VAR = "PAPERCLIP_RUN_ADMISSION_MEMORY_PCT";
export const RUN_ADMISSION_MEMORY_PCT_DEFAULT = 90;
export const RUN_ADMISSION_MEMORY_PCT_MIN = 1;
export const RUN_ADMISSION_MEMORY_PCT_MAX = 100;
/**
 * Escape hatch for tests and exotic layouts: pins the cgroup dir the reader samples,
 * bypassing /proc/self discovery. Also re-enables the check under Vitest (see
 * `RUN_ADMISSION_MEMORY_READER_SKIP_REASON_TESTS`).
 */
export const RUN_ADMISSION_MEMORY_CGROUP_DIR_ENV_VAR =
  "PAPERCLIP_RUN_ADMISSION_MEMORY_CGROUP_DIR";
export const RUN_ADMISSION_MEMORY_FALLBACK_CGROUP_DIR =
  "/sys/fs/cgroup/system.slice/paperclip.service";
/** One admission decision per queued run can mean dozens of reads per dispatch pass; a short cache amortizes them to one sample per window. */
export const RUN_ADMISSION_MEMORY_SAMPLE_TTL_MS_DEFAULT = 1000;

export type RunAdmissionMemoryPressureThreshold = {
  value: number;
  source: "env" | "default";
  /** Present when the env var was set but unusable, so startup can say why it was ignored. */
  invalidEnvValue?: string;
};

export function resolveRunAdmissionMemoryPct(
  rawEnvValue: unknown,
): RunAdmissionMemoryPressureThreshold {
  const fallback: RunAdmissionMemoryPressureThreshold = {
    value: RUN_ADMISSION_MEMORY_PCT_DEFAULT,
    source: "default",
  };
  if (typeof rawEnvValue !== "string") return fallback;
  const trimmed = rawEnvValue.trim();
  if (trimmed === "") return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return { ...fallback, invalidEnvValue: trimmed };
  }
  return {
    value: Math.max(
      RUN_ADMISSION_MEMORY_PCT_MIN,
      Math.min(RUN_ADMISSION_MEMORY_PCT_MAX, parsed),
    ),
    source: "env",
  };
}

/** Parses a cgroup memory limit body; "max" (unlimited) or garbage yields null. */
export function parseCgroupMemoryLimit(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Extracts a counter from a memory.events body. The file is line-based
 * (`high <n>`, `max <n>`, `oom <n>`, ...); only the requested row counts.
 */
export function parseMemoryEventsCounter(raw: string, key: string): number | null {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.search(/\s/);
    const rowKey = separator < 0 ? trimmed : trimmed.slice(0, separator);
    if (rowKey !== key) continue;
    const value = separator < 0 ? "" : trimmed.slice(separator + 1);
    return parseCgroupMemoryLimit(value.trim());
  }
  return null;
}

/**
 * The limit the pressure percentage is measured against: `memory.high` when set (the
 * kernel's throttle point, i.e. the soft limit), `memory.max` otherwise, and the
 * *smaller* of the two when both are set. The min() matters for misconfigured units
 * where MemoryHigh >= MemoryMax (the inverted-limits incident this guardrail was built
 * for): measuring against the larger `high` there would defer only above the hard limit,
 * i.e. after the OOM killer has already fired.
 */
export function computeEffectiveMemoryLimitBytes(
  memoryHighBytes: number | null,
  memoryMaxBytes: number | null,
): number | null {
  if (memoryHighBytes !== null && memoryMaxBytes !== null) {
    return Math.min(memoryHighBytes, memoryMaxBytes);
  }
  return memoryHighBytes ?? memoryMaxBytes;
}

/** Pressure as a percentage of the effective limit, rounded to one decimal. */
export function computeMemoryPressurePct(
  memoryCurrentBytes: number,
  effectiveLimitBytes: number,
): number | null {
  if (!Number.isFinite(effectiveLimitBytes) || effectiveLimitBytes <= 0) return null;
  return Math.round((memoryCurrentBytes / effectiveLimitBytes) * 1000) / 10;
}

export type RunAdmissionMemoryPressureReading = {
  /** True only when a usable percentage was computed; false means "skip the check" (no-op). */
  available: boolean;
  unavailableReason: "disabled_in_tests" | "cgroup_unreadable" | "no_effective_limit" | null;
  memoryPressurePct: number | null;
  memoryCurrentBytes: number | null;
  /** memory.high; null when "max" (unset) or unreadable. */
  memoryHighBytes: number | null;
  /** memory.max; null when "max" (unset) or unreadable. */
  memoryMaxBytes: number | null;
  effectiveLimitBytes: number | null;
  /** Cumulative memory.events "high" counter (throttle episodes since cgroup creation). */
  memoryEventsHigh: number | null;
  cgroupDir: string | null;
  sampledAtMs: number;
};

export type RunAdmissionMemoryPressureReader = {
  /** Never throws; a failed sample degrades to an `available: false` reading. */
  read: () => Promise<RunAdmissionMemoryPressureReading>;
  /** Most recent reading (cached), or null before the first read. */
  lastReading: () => RunAdmissionMemoryPressureReading | null;
};

export type RunAdmissionMemoryPressureReaderDeps = {
  env?: Record<string, string | undefined>;
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
  now?: () => number;
  sampleTtlMs?: number;
};

function isTruthyEnvValue(value: string | undefined) {
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

function joinCgroupPath(root: string, relative: string) {
  return `${root.replace(/\/+$/, "")}/${relative.replace(/^\/+/, "")}`;
}

function unavailable(
  reason: RunAdmissionMemoryPressureReading["unavailableReason"],
  cgroupDir: string | null,
  now: () => number,
  partial: Partial<RunAdmissionMemoryPressureReading> = {},
): RunAdmissionMemoryPressureReading {
  return {
    available: false,
    unavailableReason: reason,
    memoryPressurePct: null,
    memoryCurrentBytes: null,
    memoryHighBytes: null,
    memoryMaxBytes: null,
    effectiveLimitBytes: null,
    memoryEventsHigh: null,
    cgroupDir,
    sampledAtMs: now(),
    ...partial,
  };
}

/**
 * Samples the process's own cgroup v2 memory usage, TTL-cached so a dispatch pass over
 * many queued runs performs at most one file sweep per window. Concurrent `read()` calls
 * share a single in-flight sample (single-flight), so the admission lock never piles up
 * duplicate reads.
 */
export function createRunAdmissionMemoryPressureReader(
  deps: RunAdmissionMemoryPressureReaderDeps = {},
): RunAdmissionMemoryPressureReader {
  const readFileImpl = deps.readFile ?? readFile;
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const sampleTtlMs = deps.sampleTtlMs ?? RUN_ADMISSION_MEMORY_SAMPLE_TTL_MS_DEFAULT;

  // Vitest runs on hosts whose test processes can live inside a genuinely pressured
  // service cgroup (the exact condition this gate exists for); an ambient reading there
  // would flake every dispatch-path test. The explicit cgroup-dir override opts a test
  // back in with a fixture directory, which is how the gate's own tests drive it through
  // the real admission wiring.
  const disabledInTests = isTruthyEnvValue(env.VITEST)
    && !(env[RUN_ADMISSION_MEMORY_CGROUP_DIR_ENV_VAR] ?? "").trim();

  let cachedDir: string | null = null;
  let cachedDirPromise: Promise<string | null> | null = null;
  let cachedReading: RunAdmissionMemoryPressureReading | null = null;
  let cachedAtMs = 0;
  let inFlight: Promise<RunAdmissionMemoryPressureReading> | null = null;

  const resolveDir = async (): Promise<string | null> => {
    if (cachedDir !== null) return cachedDir;
    if (!cachedDirPromise) {
      cachedDirPromise = (async () => {
        const override = (env[RUN_ADMISSION_MEMORY_CGROUP_DIR_ENV_VAR] ?? "").trim();
        if (override) return override;
        try {
          const [cgroupRaw, mountinfoRaw] = await Promise.all([
            readFileImpl("/proc/self/cgroup", "utf8"),
            readFileImpl("/proc/self/mountinfo", "utf8"),
          ]);
          const relative = deriveCgroupRelativePath(cgroupRaw);
          if (relative) {
            const root = resolveCgroupV2MountRoot(mountinfoRaw) ?? "/sys/fs/cgroup";
            return joinCgroupPath(root, relative);
          }
        } catch {
          // Fall through to the literal service path below.
        }
        return RUN_ADMISSION_MEMORY_FALLBACK_CGROUP_DIR;
      })();
      void cachedDirPromise.then((dir) => {
        cachedDir = dir;
      }).catch(() => {
        cachedDir = null;
      });
    }
    return cachedDirPromise;
  };

  const sample = async (): Promise<RunAdmissionMemoryPressureReading> => {
    if (disabledInTests) return unavailable("disabled_in_tests", null, now);
    const dir = await resolveDir();
    if (!dir) return unavailable("cgroup_unreadable", null, now);
    const [currentResult, highResult, maxResult, eventsResult] = await Promise.allSettled([
      readFileImpl(`${dir}/memory.current`, "utf8"),
      readFileImpl(`${dir}/memory.high`, "utf8"),
      readFileImpl(`${dir}/memory.max`, "utf8"),
      readFileImpl(`${dir}/memory.events`, "utf8"),
    ]);
    if (currentResult.status !== "fulfilled") {
      return unavailable("cgroup_unreadable", dir, now);
    }
    const memoryCurrentBytes = parseCgroupMemoryLimit(currentResult.value);
    if (memoryCurrentBytes === null) {
      return unavailable("cgroup_unreadable", dir, now);
    }
    const memoryHighBytes =
      highResult.status === "fulfilled" ? parseCgroupMemoryLimit(highResult.value) : null;
    const memoryMaxBytes =
      maxResult.status === "fulfilled" ? parseCgroupMemoryLimit(maxResult.value) : null;
    const memoryEventsHigh =
      eventsResult.status === "fulfilled"
        ? parseMemoryEventsCounter(eventsResult.value, "high")
        : null;
    const effectiveLimitBytes = computeEffectiveMemoryLimitBytes(memoryHighBytes, memoryMaxBytes);
    if (effectiveLimitBytes === null) {
      // No soft and no hard limit: there is nothing to be under pressure relative to.
      return unavailable("no_effective_limit", dir, now, { memoryCurrentBytes });
    }
    return {
      available: true,
      unavailableReason: null,
      memoryPressurePct: computeMemoryPressurePct(memoryCurrentBytes, effectiveLimitBytes),
      memoryCurrentBytes,
      memoryHighBytes,
      memoryMaxBytes,
      effectiveLimitBytes,
      memoryEventsHigh,
      cgroupDir: dir,
      sampledAtMs: now(),
    };
  };

  const read = async (): Promise<RunAdmissionMemoryPressureReading> => {
    if (cachedReading !== null && now() - cachedAtMs < sampleTtlMs) return cachedReading;
    if (!inFlight) {
      inFlight = sample()
        .then((reading) => {
          cachedReading = reading;
          cachedAtMs = reading.sampledAtMs;
          return reading;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };

  return {
    read,
    lastReading: () => cachedReading,
  };
}
