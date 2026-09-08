import { describe, expect, it } from "vitest";
import {
  CGROUP_PIDS_PRESSURE_EVENT,
  CGROUP_PIDS_PRESSURE_THRESHOLD_RATIO,
  PAPERCLIP_SERVICE_CGROUP_FALLBACK_DIR,
  deriveCgroupRelativePath,
  parseCgroupPidsInt,
  parsePidsEventsDenied,
  resolveCgroupV2MountRoot,
  startCgroupPidsPressureTelemetry,
  summarizeCgroupPidsPressure,
  type CgroupPidsTelemetryDeps,
} from "./cgroup-pids-telemetry.js";

const MOUNTINFO = `33 24 0:28 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:9 - cgroup2 cgroup2 rw,nsdelegate,memory_recursiveprot
34 24 0:29 / /sys/fs/cgroup/system.slice rw - cgroup cgroup rw
`;

function fakeReadFile(files: Record<string, string>) {
  return async (path: string): Promise<string> => {
    if (Object.hasOwn(files, path)) return files[path];
    const error = new Error(`ENOENT: ${path}`) as Error & { code?: string };
    error.code = "ENOENT";
    throw error;
  };
}

type CapturedCall = { level: "info" | "debug"; payload: Record<string, unknown>; message: string };

function captureLogger() {
  const calls: CapturedCall[] = [];
  const record = (level: "info" | "debug") => (payload: Record<string, unknown>, message: string) => {
    calls.push({ level, payload, message });
  };
  return { calls, logger: { info: record("info"), debug: record("debug") } };
}

function makeDeps(overrides: Partial<CgroupPidsTelemetryDeps> & { files?: Record<string, string> }) {
  const { files = {}, ...rest } = overrides;
  const captured = captureLogger();
  return {
    deps: {
      runId: "run-1",
      agentId: "agent-1",
      logger: captured.logger,
      readFile: fakeReadFile(files),
      ...rest,
    } satisfies CgroupPidsTelemetryDeps,
    captured,
  };
}

describe("cgroup pids telemetry parsing", () => {
  it("parses plain integer files and treats 'max' as unlimited", () => {
    expect(parseCgroupPidsInt("484\n")).toBe(484);
    expect(parseCgroupPidsInt("600")).toBe(600);
    expect(parseCgroupPidsInt("max")).toBeNull();
    expect(parseCgroupPidsInt("")).toBeNull();
    expect(parseCgroupPidsInt("12x")).toBeNull();
    expect(parseCgroupPidsInt("-1")).toBeNull();
  });

  it("extracts the denial counter from pids.events rows", () => {
    expect(parsePidsEventsDenied("max 1963\n")).toBe(1963);
    expect(parsePidsEventsDenied("active 484\nlimit 600\nmax 1963\n")).toBe(1963);
    expect(parsePidsEventsDenied("active 484\nlimit 600\n")).toBeNull();
    expect(parsePidsEventsDenied("")).toBeNull();
    expect(parsePidsEventsDenied("max notanumber\n")).toBeNull();
  });

  it("derives the unified-hierarchy cgroup path from /proc/self/cgroup content", () => {
    expect(deriveCgroupRelativePath("0::/system.slice/paperclip.service\n")).toBe(
      "/system.slice/paperclip.service",
    );
    expect(deriveCgroupRelativePath("12:devices:/foo\n0::/system.slice/bar.service\n")).toBe(
      "/system.slice/bar.service",
    );
    expect(deriveCgroupRelativePath("0::/\n")).toBeNull();
    expect(deriveCgroupRelativePath("12:pids:/foo\n")).toBeNull();
  });

  it("finds the cgroup2 mount root from mountinfo content", () => {
    expect(resolveCgroupV2MountRoot(MOUNTINFO)).toBe("/sys/fs/cgroup");
    expect(resolveCgroupV2MountRoot("no mounts here\n")).toBeNull();
  });
});

describe("summarizeCgroupPidsPressure", () => {
  const reading = (pidsCurrent: number, pidsMax: number | null, pidsDenied: number | null) => ({
    pidsCurrent,
    pidsMax,
    pidsDenied,
  });

  it("computes the denial delta and flags pressure at info when denials occurred", () => {
    expect(summarizeCgroupPidsPressure(reading(100, 600, 100), reading(420, 600, 165))).toEqual({
      level: "info",
      pidsStart: 100,
      pidsEnd: 420,
      pidsMax: 600,
      deniedDelta: 65,
    });
  });

  it("stays at debug below the pressure threshold with no new denials", () => {
    const summary = summarizeCgroupPidsPressure(reading(100, 600, 5), reading(539, 600, 5));
    expect(summary.level).toBe("debug");
    expect(summary.deniedDelta).toBe(0);
    expect(539).toBeLessThan(CGROUP_PIDS_PRESSURE_THRESHOLD_RATIO * 600);
  });

  it("flags info at exactly the pressure threshold even with zero denials", () => {
    expect(summarizeCgroupPidsPressure(reading(100, 600, 0), reading(540, 600, 0)).level).toBe("info");
  });

  it("keeps debug for an unlimited cgroup (pids.max 'max') without denials", () => {
    const summary = summarizeCgroupPidsPressure(reading(100, null, 3), reading(5000, null, 3));
    expect(summary).toMatchObject({ level: "debug", pidsMax: null, deniedDelta: 0 });
  });

  it("yields a null deniedDelta when either events counter is unreadable", () => {
    const summary = summarizeCgroupPidsPressure(reading(100, 600, null), reading(200, 600, 9));
    expect(summary.deniedDelta).toBeNull();
    expect(summary.level).toBe("debug");
  });
});

describe("startCgroupPidsPressureTelemetry", () => {
  it("emits one structured info line with the required fields for a pressured window", async () => {
    const { deps, captured } = makeDeps({
      cgroupDir: "/sys/fs/cgroup/system.slice/paperclip.service",
      files: {
        "/sys/fs/cgroup/system.slice/paperclip.service/pids.current": "560\n",
        "/sys/fs/cgroup/system.slice/paperclip.service/pids.max": "600\n",
        "/sys/fs/cgroup/system.slice/paperclip.service/pids.events": "max 12\n",
      },
    });
    const telemetry = startCgroupPidsPressureTelemetry(deps);
    await telemetry.finish();

    expect(captured.calls).toHaveLength(1);
    const call = captured.calls[0];
    expect(call.level).toBe("info");
    expect(call.payload).toMatchObject({
      event: CGROUP_PIDS_PRESSURE_EVENT,
      runId: "run-1",
      agentId: "agent-1",
      available: true,
      pidsStart: 560,
      pidsEnd: 560,
      pidsMax: 600,
      deniedDelta: 0,
      cgroupDir: "/sys/fs/cgroup/system.slice/paperclip.service",
    });
    expect(call.payload.windowMs).toBeGreaterThanOrEqual(0);
  });

  it("emits at debug for a quiet window with the same shape", async () => {
    const { deps, captured } = makeDeps({
      cgroupDir: "/cgroup",
      files: {
        "/cgroup/pids.current": "10\n",
        "/cgroup/pids.max": "600\n",
        "/cgroup/pids.events": "max 0\n",
      },
    });
    await startCgroupPidsPressureTelemetry(deps).finish();

    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0].level).toBe("debug");
    expect(captured.calls[0].payload).toMatchObject({
      event: CGROUP_PIDS_PRESSURE_EVENT,
      pidsStart: 10,
      pidsEnd: 10,
      pidsMax: 600,
      deniedDelta: 0,
      available: true,
    });
  });

  it("degrades to a debug line when the cgroup files are missing", async () => {
    const { deps, captured } = makeDeps({ cgroupDir: "/nonexistent" });
    await expect(startCgroupPidsPressureTelemetry(deps).finish()).resolves.toBeUndefined();

    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0].level).toBe("debug");
    expect(captured.calls[0].payload).toMatchObject({
      event: CGROUP_PIDS_PRESSURE_EVENT,
      runId: "run-1",
      agentId: "agent-1",
      available: false,
      cgroupDir: "/nonexistent",
    });
  });

  it("never throws even when the logger itself throws", async () => {
    const throwingLogger = {
      info: () => {
        throw new Error("broken stream");
      },
      debug: () => {
        throw new Error("broken stream");
      },
    };
    await expect(
      startCgroupPidsPressureTelemetry({
        runId: "run-1",
        agentId: "agent-1",
        logger: throwingLogger,
        readFile: fakeReadFile({ "/cgroup/pids.current": "1\n" }),
        cgroupDir: "/cgroup",
      }).finish(),
    ).resolves.toBeUndefined();
  });

  it("falls back to the literal service path when derivation is impossible", async () => {
    const { deps, captured } = makeDeps({
      files: {
        "/proc/self/cgroup": "12:pids:/foo\n",
        [`${PAPERCLIP_SERVICE_CGROUP_FALLBACK_DIR}/pids.current`]: "7\n",
        [`${PAPERCLIP_SERVICE_CGROUP_FALLBACK_DIR}/pids.max`]: "max\n",
        [`${PAPERCLIP_SERVICE_CGROUP_FALLBACK_DIR}/pids.events`]: "max 4\n",
      },
    });
    await startCgroupPidsPressureTelemetry(deps).finish();

    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0].payload).toMatchObject({
      cgroupDir: PAPERCLIP_SERVICE_CGROUP_FALLBACK_DIR,
      pidsStart: 7,
      pidsEnd: 7,
      pidsMax: null,
      deniedDelta: 0,
      available: true,
    });
  });

  it("derives the service cgroup dir from proc files when available", async () => {
    const dir = "/sys/fs/cgroup/system.slice/paperclip.service";
    const { deps, captured } = makeDeps({
      files: {
        "/proc/self/cgroup": "0::/system.slice/paperclip.service\n",
        "/proc/self/mountinfo": MOUNTINFO,
        [`${dir}/pids.current`]: "300\n",
        [`${dir}/pids.max`]: "600\n",
        [`${dir}/pids.events`]: "active 300\nlimit 600\nmax 2\n",
      },
    });
    await startCgroupPidsPressureTelemetry(deps).finish();

    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0].payload).toMatchObject({
      cgroupDir: dir,
      pidsStart: 300,
      pidsEnd: 300,
      pidsMax: 600,
      deniedDelta: 0,
    });
  });

  it("degrades to debug when only pids.current exists at start but files vanish by end", async () => {
    // finish() awaits the start snapshot before reading the end snapshot, so a
    // per-path counter makes the end reads deterministically fail.
    const readCounts = new Map<string, number>();
    const readFile = async (path: string): Promise<string> => {
      const read = (readCounts.get(path) ?? 0) + 1;
      readCounts.set(path, read);
      if (read > 1) {
        const error = new Error(`ENOENT: ${path}`) as Error & { code?: string };
        error.code = "ENOENT";
        throw error;
      }
      if (path.endsWith("pids.current")) return "50\n";
      if (path.endsWith("pids.max")) return "600\n";
      if (path.endsWith("pids.events")) return "max 0\n";
      throw new Error(`unexpected ${path}`);
    };
    const captured = captureLogger();
    const telemetry = startCgroupPidsPressureTelemetry({
      runId: "run-1",
      agentId: "agent-1",
      logger: captured.logger,
      readFile,
      cgroupDir: "/cgroup",
    });
    await telemetry.finish();

    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0].level).toBe("debug");
    expect(captured.calls[0].payload).toMatchObject({ available: false, pidsStart: 50 });
  });
});
