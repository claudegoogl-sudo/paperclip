import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  RUN_ADMISSION_MEMORY_CGROUP_DIR_ENV_VAR,
  RUN_ADMISSION_MEMORY_PCT_DEFAULT,
  RUN_ADMISSION_MEMORY_PCT_ENV_VAR,
  RUN_ADMISSION_MEMORY_PCT_MAX,
  RUN_ADMISSION_MEMORY_PCT_MIN,
  computeEffectiveMemoryLimitBytes,
  computeMemoryPressurePct,
  computeNonReclaimableBytes,
  createRunAdmissionMemoryPressureReader,
  parseCgroupMemoryLimit,
  parseMemoryEventsCounter,
  resolveRunAdmissionMemoryPct,
} from "./run-admission-memory-pressure.js";

describe("run admission memory threshold resolution", () => {
  it("defaults to 90% of the effective soft limit", () => {
    expect(RUN_ADMISSION_MEMORY_PCT_DEFAULT).toBe(90);
    expect(resolveRunAdmissionMemoryPct(undefined)).toMatchObject({ value: 90, source: "default" });
    expect(resolveRunAdmissionMemoryPct("")).toMatchObject({ value: 90, source: "default" });
    expect(resolveRunAdmissionMemoryPct("   ")).toMatchObject({ value: 90, source: "default" });
  });

  it("honours a valid env override and clamps it to the documented range", () => {
    expect(resolveRunAdmissionMemoryPct("50")).toMatchObject({ value: 50, source: "env" });
    expect(resolveRunAdmissionMemoryPct("100")).toMatchObject({ value: 100, source: "env" });
    expect(resolveRunAdmissionMemoryPct("0")).toMatchObject({ value: RUN_ADMISSION_MEMORY_PCT_MIN, source: "env" });
    expect(resolveRunAdmissionMemoryPct("250")).toMatchObject({ value: RUN_ADMISSION_MEMORY_PCT_MAX, source: "env" });
  });

  it("reports, rather than silently accepting, an unusable env value", () => {
    for (const raw of ["abc", "1e999"]) {
      expect(resolveRunAdmissionMemoryPct(raw)).toMatchObject({
        value: 90,
        source: "default",
        invalidEnvValue: raw,
      });
    }
  });

  it("exports the documented env var names", () => {
    expect(RUN_ADMISSION_MEMORY_PCT_ENV_VAR).toBe("PAPERCLIP_RUN_ADMISSION_MEMORY_PCT");
    expect(RUN_ADMISSION_MEMORY_CGROUP_DIR_ENV_VAR).toBe("PAPERCLIP_RUN_ADMISSION_MEMORY_CGROUP_DIR");
  });
});

describe("cgroup memory file parsing", () => {
  it("parses byte limits and rejects max/unset/garbage bodies", () => {
    expect(parseCgroupMemoryLimit("8589934592\n")).toBe(8589934592);
    expect(parseCgroupMemoryLimit("max")).toBeNull();
    expect(parseCgroupMemoryLimit("max\n")).toBeNull();
    expect(parseCgroupMemoryLimit("")).toBeNull();
    expect(parseCgroupMemoryLimit("12.5")).toBeNull();
    expect(parseCgroupMemoryLimit("oops")).toBeNull();
  });

  it("extracts only the requested row from memory.events", () => {
    const events = "low 0\nhigh 7\nmax 2\noom 0\noom_kill 0\n";
    expect(parseMemoryEventsCounter(events, "high")).toBe(7);
    expect(parseMemoryEventsCounter(events, "max")).toBe(2);
    expect(parseMemoryEventsCounter(events, "oom_kill")).toBe(0);
    expect(parseMemoryEventsCounter(events, "missing")).toBeNull();
    expect(parseMemoryEventsCounter("", "high")).toBeNull();
  });

  it("measures against memory.high when only the soft limit is set", () => {
    expect(computeEffectiveMemoryLimitBytes(8 * 1024 ** 3, null)).toBe(8 * 1024 ** 3);
  });

  it("measures against memory.max when only the hard limit is set", () => {
    expect(computeEffectiveMemoryLimitBytes(null, 16 * 1024 ** 3)).toBe(16 * 1024 ** 3);
  });

  it("measures against the SMALLER limit when both are set (inverted-limits safe)", () => {
    // The incident this guardrail exists for: MemoryHigh 16G >= MemoryMax 8G.
    // Measuring against the larger `high` would only defer above the hard limit,
    // i.e. after the OOM killer has already fired.
    expect(computeEffectiveMemoryLimitBytes(16 * 1024 ** 3, 8 * 1024 ** 3)).toBe(8 * 1024 ** 3);
    expect(computeEffectiveMemoryLimitBytes(6 * 1024 ** 3, 8 * 1024 ** 3)).toBe(6 * 1024 ** 3);
  });

  it("returns null when no limit is set at all", () => {
    expect(computeEffectiveMemoryLimitBytes(null, null)).toBeNull();
  });

  it("computes pressure as a one-decimal percentage of the effective limit", () => {
    expect(computeMemoryPressurePct(95, 100)).toBe(95);
    expect(computeMemoryPressurePct(1, 3)).toBe(33.3);
    expect(computeMemoryPressurePct(0, 100)).toBe(0);
    expect(computeMemoryPressurePct(120, 100)).toBe(120);
    expect(computeMemoryPressurePct(50, 0)).toBeNull();
    expect(computeMemoryPressurePct(50, Number.NaN)).toBeNull();
  });
});

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeCgroupFixture(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-run-admission-mem-"));
  tempDirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body);
  }
  return dir;
}

function envWithCgroupDir(dir: string, extra: Record<string, string> = {}) {
  return {
    [RUN_ADMISSION_MEMORY_CGROUP_DIR_ENV_VAR]: dir,
    ...extra,
  };
}

describe("run admission memory-pressure reader", () => {
  it("produces a full available reading from a healthy cgroup dir", async () => {
    const dir = await makeCgroupFixture({
      "memory.current": "9500000000\n",
      "memory.high": "10000000000\n",
      "memory.max": "12000000000\n",
      "memory.events": "low 0\nhigh 3\nmax 1\noom 0\noom_kill 0\n",
    });
    const reader = createRunAdmissionMemoryPressureReader({ env: envWithCgroupDir(dir) });
    const reading = await reader.read();
    expect(reading).toMatchObject({
      available: true,
      unavailableReason: null,
      memoryPressurePct: 95,
      memoryCurrentBytes: 9_500_000_000,
      memoryHighBytes: 10_000_000_000,
      memoryMaxBytes: 12_000_000_000,
      effectiveLimitBytes: 10_000_000_000,
      memoryEventsHigh: 3,
      cgroupDir: dir,
    });
    expect(reader.lastReading()).toEqual(reading);
  });

  it("is a no-op when the cgroup files are absent (off-Linux / minimal CI container)", async () => {
    // A directory that exists but has no cgroup v2 memory files: exactly the
    // state on macOS, Windows, or a container without the cgroup v2 hierarchy.
    const dir = await makeCgroupFixture({});
    const reader = createRunAdmissionMemoryPressureReader({ env: envWithCgroupDir(dir) });
    const reading = await reader.read();
    expect(reading).toMatchObject({
      available: false,
      unavailableReason: "cgroup_unreadable",
      memoryPressurePct: null,
      cgroupDir: dir,
    });
    // lastReading still caches the no-op verdict, but the gate treats
    // available === false as "skip", never as "defer".
    expect(reader.lastReading()?.available).toBe(false);
  });

  it("is a no-op when no effective limit is set (both limits are max)", async () => {
    const dir = await makeCgroupFixture({
      "memory.current": "123\n",
      "memory.high": "max\n",
      "memory.max": "max\n",
    });
    const reader = createRunAdmissionMemoryPressureReader({ env: envWithCgroupDir(dir) });
    const reading = await reader.read();
    expect(reading).toMatchObject({
      available: false,
      unavailableReason: "no_effective_limit",
      memoryCurrentBytes: 123,
    });
  });

  it("is disabled under Vitest unless an explicit cgroup dir override opts back in", async () => {
    const reads: string[] = [];
    const readFile = async (path: string): Promise<string> => {
      reads.push(path);
      throw new Error(`ENOENT: ${path}`);
    };
    // No override: the reader must not even attempt /proc/self discovery in the
    // test process, because an ambient pressured service cgroup on the CI host
    // would flake every dispatch-path test.
    const disabled = createRunAdmissionMemoryPressureReader({
      env: { VITEST: "true" },
      readFile,
    });
    const disabledReading = await disabled.read();
    expect(disabledReading).toMatchObject({
      available: false,
      unavailableReason: "disabled_in_tests",
    });
    expect(reads).toEqual([]);

    // With the override, the same env re-enables the check against the fixture.
    const dir = await makeCgroupFixture({
      "memory.current": "50\n",
      "memory.high": "100\n",
    });
    // Default readFile (node:fs/promises) reads the real fixture from tmpdir.
    const enabled = createRunAdmissionMemoryPressureReader({
      env: envWithCgroupDir(dir, { VITEST: "true" }),
    });
    const enabledReading = await enabled.read();
    expect(enabledReading).toMatchObject({ available: true, memoryPressurePct: 50 });
  });

  it("TTL-caches samples so a dispatch pass reads the files once per window", async () => {
    const dir = await makeCgroupFixture({
      "memory.current": "10\n",
      "memory.high": "100\n",
    });
    let fileReads = 0;
    const readFile = async (path: string): Promise<string> => {
      fileReads += 1;
      if (path.endsWith("/memory.current")) return "10\n";
      if (path.endsWith("/memory.high")) return "100\n";
      if (path.endsWith("/memory.max")) return "max\n";
      throw new Error(`ENOENT: ${path}`);
    };
    let nowMs = 0;
    const reader = createRunAdmissionMemoryPressureReader({
      env: envWithCgroupDir(dir),
      readFile,
      now: () => nowMs,
      sampleTtlMs: 1000,
    });
    for (let i = 0; i < 10; i += 1) await reader.read();
    expect(fileReads).toBe(5); // current + stat + high + max + events, exactly once

    nowMs = 1001; // window expired: the next read samples again
    await reader.read();
    expect(fileReads).toBe(10);
  });

  it("never throws: an unreadable /proc falls back, and a broken override degrades to a no-op", async () => {
    const readFile = async (): Promise<string> => {
      throw new Error("EACCES");
    };
    const fallback = createRunAdmissionMemoryPressureReader({ env: {}, readFile });
    const fallbackReading = await fallback.read();
    expect(fallbackReading).toMatchObject({ available: false, unavailableReason: "cgroup_unreadable" });

    const brokenOverride = createRunAdmissionMemoryPressureReader({
      env: envWithCgroupDir("/definitely/not/a/cgroup/dir"),
      readFile,
    });
    const brokenReading = await brokenOverride.read();
    expect(brokenReading).toMatchObject({
      available: false,
      unavailableReason: "cgroup_unreadable",
      cgroupDir: "/definitely/not/a/cgroup/dir",
    });
  });
});

const GIB = 1024 ** 3;
const LIVE_LIMIT = Math.round(15.81 * GIB);
function statBody(inactiveFile: number) {
  return `anon 3242459136\nfile 11000000000\nactive_file 579820584\ninactive_file ${inactiveFile}\nshmem 150000000\n`;
}

describe("run admission pressure excludes reclaimable page cache", () => {
  it("AC1: cache-heavy cgroup (15.24 GiB current, 9.72 GiB inactive_file) reads ~34.8% and is below 90", async () => {
    const dir = await makeCgroupFixture({
      "memory.current": `${Math.round(15.24 * GIB)}\n`,
      "memory.stat": statBody(Math.round(9.72 * GIB)),
      "memory.high": "max\n",
      "memory.max": `${LIVE_LIMIT}\n`,
    });
    const reading = await createRunAdmissionMemoryPressureReader({ env: envWithCgroupDir(dir) }).read();
    expect(reading).toMatchObject({
      available: true,
      pressureBasis: "current_minus_inactive_file",
      memoryCurrentBytes: Math.round(15.24 * GIB),
      inactiveFileBytes: Math.round(9.72 * GIB),
      nonReclaimableBytes: Math.round(15.24 * GIB) - Math.round(9.72 * GIB),
    });
    expect(reading.memoryPressurePct).toBeCloseTo(34.9, 0);
    expect(reading.memoryPressurePct!).toBeLessThan(RUN_ADMISSION_MEMORY_PCT_DEFAULT);
  });

  it("AC2 / cold cache after restart: anon fill (15.0 GiB current, 0.2 GiB inactive_file) still reads >= 90", async () => {
    const dir = await makeCgroupFixture({
      "memory.current": `${15 * GIB}\n`,
      "memory.stat": statBody(Math.round(0.2 * GIB)),
      "memory.max": `${LIVE_LIMIT}\n`,
    });
    const reading = await createRunAdmissionMemoryPressureReader({ env: envWithCgroupDir(dir) }).read();
    expect(reading.pressureBasis).toBe("current_minus_inactive_file");
    expect(reading.memoryPressurePct!).toBeGreaterThanOrEqual(RUN_ADMISSION_MEMORY_PCT_DEFAULT);
  });

  it("AC3: missing or garbled memory.stat falls back to raw memory.current (old behaviour)", async () => {
    for (const stat of [undefined, "garbage\nnot a stat file\n", "inactive_file oops\n"]) {
      const files: Record<string, string> = {
        "memory.current": "9500000000\n",
        "memory.high": "10000000000\n",
      };
      if (stat !== undefined) files["memory.stat"] = stat;
      const dir = await makeCgroupFixture(files);
      const reading = await createRunAdmissionMemoryPressureReader({ env: envWithCgroupDir(dir) }).read();
      expect(reading).toMatchObject({
        available: true,
        pressureBasis: "current",
        memoryPressurePct: 95,
        memoryCurrentBytes: 9_500_000_000,
        nonReclaimableBytes: 9_500_000_000,
        inactiveFileBytes: null,
      });
    }
  });

  it("AC4: a racy sample with inactive_file > memory.current clamps to 0 (no NaN, no negative)", async () => {
    expect(computeNonReclaimableBytes(100, 250)).toEqual({
      nonReclaimableBytes: 0,
      pressureBasis: "current_minus_inactive_file",
    });
    expect(computeNonReclaimableBytes(100, null)).toEqual({ nonReclaimableBytes: 100, pressureBasis: "current" });
    const dir = await makeCgroupFixture({
      "memory.current": "1000\n",
      "memory.stat": statBody(5000),
      "memory.high": "10000\n",
    });
    const reading = await createRunAdmissionMemoryPressureReader({ env: envWithCgroupDir(dir) }).read();
    expect(reading).toMatchObject({ memoryPressurePct: 0, nonReclaimableBytes: 0 });
  });
});
