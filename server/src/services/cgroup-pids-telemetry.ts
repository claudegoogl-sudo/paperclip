import { readFile } from "node:fs/promises";

/**
 * Per-run cgroup pids-pressure telemetry.
 *
 * Every heartbeat run samples the pids controller of its own service cgroup at
 * execution start and at teardown, then emits exactly one structured log line
 * describing the window. This gives pids saturation episodes durations and
 * attribution from app logs alone; the kernel counter itself only accumulates
 * denials per service start.
 *
 * Strictly telemetry: nothing here queues, caps, or otherwise alters run
 * behavior. Reads are a handful of tiny file reads resolved in the
 * background, and any failure degrades to a single debug line at run end.
 */

export const CGROUP_PIDS_PRESSURE_EVENT = "cgroup_pids_pressure";

/** pidsEnd at or above this fraction of pidsMax is logged at info. */
export const CGROUP_PIDS_PRESSURE_THRESHOLD_RATIO = 0.9;

/** Used only when the cgroup path cannot be derived from /proc/self/cgroup. */
export const PAPERCLIP_SERVICE_CGROUP_FALLBACK_DIR =
  "/sys/fs/cgroup/system.slice/paperclip.service";

export type CgroupPidsReading = {
  /** pids.current: processes currently in the cgroup. */
  pidsCurrent: number;
  /** pids.max: hard limit; null when "max" (unlimited) or unreadable. */
  pidsMax: number | null;
  /** pids.events "max" counter: cumulative fork denials since cgroup creation. */
  pidsDenied: number | null;
};

export type CgroupPidsPressureSummary = {
  level: "info" | "debug";
  pidsStart: number;
  pidsEnd: number;
  pidsMax: number | null;
  deniedDelta: number | null;
};

/** Parses a cgroup pids integer file body; "max" or garbage yields null. */
export function parseCgroupPidsInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Extracts the denial counter from a pids.events body. The file is line-based
 * (`max <n>`, and on newer kernels also `active`/`limit` rows); only the
 * `max` row counts denied forks.
 */
export function parsePidsEventsDenied(raw: string): number | null {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.search(/\s/);
    const key = separator < 0 ? trimmed : trimmed.slice(0, separator);
    if (key !== "max") continue;
    const value = separator < 0 ? "" : trimmed.slice(separator + 1);
    return parseCgroupPidsInt(value.trim());
  }
  return null;
}

/**
 * Returns the unified-hierarchy (cgroup v2) path of the current process from
 * a /proc/self/cgroup body, e.g. "/system.slice/paperclip.service". Null when
 * the body has no usable `0::` entry (cgroup v1 hosts, namespace root).
 */
export function deriveCgroupRelativePath(procSelfCgroupRaw: string): string | null {
  for (const line of procSelfCgroupRaw.split("\n")) {
    if (!line.startsWith("0::")) continue;
    const path = line.slice(3).trim();
    return path.startsWith("/") && path !== "/" ? path : null;
  }
  return null;
}

/**
 * Finds the cgroup2 mount point from a /proc/self/mountinfo body (mount point
 * is prefix field 5, filesystem type follows the " - " separator). Null when
 * no cgroup2 mount is listed.
 */
export function resolveCgroupV2MountRoot(procSelfMountinfoRaw: string): string | null {
  for (const line of procSelfMountinfoRaw.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const mountPoint = line.slice(0, separator).split(" ")[4];
    const fsType = line.slice(separator + 3).split(" ")[0];
    if (mountPoint && fsType === "cgroup2") return mountPoint;
  }
  return null;
}

function joinCgroupPath(root: string, relative: string): string {
  return `${root.replace(/\/+$/, "")}/${relative.replace(/^\/+/, "")}`;
}

/**
 * Minimal logger contract for telemetry emission. Pino's `Logger` (and any
 * structural subset exposing these two calls) satisfies it; kept narrow so
 * tests can pass a plain capture object without casts.
 */
export type CgroupPidsPressureLogger = {
  info: (payload: Record<string, unknown>, message: string) => void;
  debug: (payload: Record<string, unknown>, message: string) => void;
};

export type CgroupPidsTelemetryDeps = {
  runId: string;
  agentId: string;
  logger: CgroupPidsPressureLogger;
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
  /** Overrides path derivation entirely (used by tests and exotic layouts). */
  cgroupDir?: string;
  now?: () => number;
};

export type CgroupPidsPressureTelemetry = {
  /** Emits the single pressure log line; never throws, safe to await in a finally. */
  finish: () => Promise<void>;
};

async function readCgroupPidsReading(
  readFileImpl: (path: string, encoding: "utf8") => Promise<string>,
  dir: string,
): Promise<CgroupPidsReading | null> {
  const [currentResult, maxResult, eventsResult] = await Promise.allSettled([
    readFileImpl(`${dir}/pids.current`, "utf8"),
    readFileImpl(`${dir}/pids.max`, "utf8"),
    readFileImpl(`${dir}/pids.events`, "utf8"),
  ]);
  if (currentResult.status !== "fulfilled") return null;
  const pidsCurrent = parseCgroupPidsInt(currentResult.value);
  if (pidsCurrent === null) return null;
  return {
    pidsCurrent,
    pidsMax: maxResult.status === "fulfilled" ? parseCgroupPidsInt(maxResult.value) : null,
    pidsDenied:
      eventsResult.status === "fulfilled" ? parsePidsEventsDenied(eventsResult.value) : null,
  };
}

async function resolveCgroupPidsDir(
  readFileImpl: (path: string, encoding: "utf8") => Promise<string>,
  overrideDir: string | undefined,
): Promise<string> {
  if (overrideDir) return overrideDir;
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
  return PAPERCLIP_SERVICE_CGROUP_FALLBACK_DIR;
}

export function summarizeCgroupPidsPressure(
  start: CgroupPidsReading,
  end: CgroupPidsReading,
): CgroupPidsPressureSummary {
  const pidsStart = start.pidsCurrent;
  const pidsEnd = end.pidsCurrent;
  const pidsMax = end.pidsMax ?? start.pidsMax;
  const deniedDelta =
    start.pidsDenied !== null && end.pidsDenied !== null
      ? end.pidsDenied - start.pidsDenied
      : null;
  const pressureSaturated =
    pidsMax !== null && pidsEnd >= CGROUP_PIDS_PRESSURE_THRESHOLD_RATIO * pidsMax;
  const level: "info" | "debug" = (deniedDelta !== null && deniedDelta > 0) || pressureSaturated
    ? "info"
    : "debug";
  return { level, pidsStart, pidsEnd, pidsMax, deniedDelta };
}

/**
 * Begins the pids-pressure window for one run. The start snapshot is read in
 * the background immediately; `finish()` awaits it, takes the end snapshot,
 * and emits exactly one `cgroup_pids_pressure` line at info (denials during
 * the window, or the cgroup ended at/above the pressure threshold) or debug.
 */
export function startCgroupPidsPressureTelemetry(
  deps: CgroupPidsTelemetryDeps,
): CgroupPidsPressureTelemetry {
  const readFileImpl = deps.readFile ?? readFile;
  const now = deps.now ?? Date.now;
  const startedAtMs = now();
  const dirPromise = resolveCgroupPidsDir(readFileImpl, deps.cgroupDir);
  const startPromise = dirPromise.then((dir) => readCgroupPidsReading(readFileImpl, dir));

  const finish = async (): Promise<void> => {
    try {
      const [dir, start] = await Promise.all([dirPromise, startPromise]);
      const end = await readCgroupPidsReading(readFileImpl, dir);
      const windowMs = Math.max(0, now() - startedAtMs);
      if (!start || !end) {
        deps.logger.debug({
          event: CGROUP_PIDS_PRESSURE_EVENT,
          runId: deps.runId,
          agentId: deps.agentId,
          available: false,
          cgroupDir: dir,
          windowMs,
          ...(start ? { pidsStart: start.pidsCurrent } : {}),
        }, "cgroup pids pressure telemetry unavailable");
        return;
      }
      const summary = summarizeCgroupPidsPressure(start, end);
      const payload = {
        event: CGROUP_PIDS_PRESSURE_EVENT,
        runId: deps.runId,
        agentId: deps.agentId,
        available: true,
        cgroupDir: dir,
        windowMs,
        pidsStart: summary.pidsStart,
        pidsEnd: summary.pidsEnd,
        pidsMax: summary.pidsMax,
        deniedDelta: summary.deniedDelta,
      };
      const message = "cgroup pids pressure during run";
      if (summary.level === "info") deps.logger.info(payload, message);
      else deps.logger.debug(payload, message);
    } catch {
      // Telemetry must never fail or slow a run: swallow everything.
    }
  };

  return { finish };
}
