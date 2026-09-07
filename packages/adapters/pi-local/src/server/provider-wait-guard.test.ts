import { afterEach, describe, expect, it } from "vitest";
import { runningProcesses } from "@paperclipai/adapter-utils/server-utils";
import {
  armProviderWaitGuard,
  classifyProviderWaitReason,
  providerWaitTimeoutResult,
  resolveProviderWaitGuardConfig,
  type ProviderWaitGuardConfig,
  type ProviderWaitGuardDeps,
} from "./provider-wait-guard.js";

interface ScheduledCall {
  fn: () => void;
  at: number;
}

class FakeClock {
  nowMs = 0;
  scheduled: ScheduledCall[] = [];
  kills: Array<{ pid: number | null; processGroupId: number | null; signal: string }> = [];

  now = (): number => this.nowMs;

  schedule = (fn: () => void, delayMs: number): ScheduledCall => {
    const entry: ScheduledCall = { fn, at: this.nowMs + Math.max(0, delayMs) };
    this.scheduled.push(entry);
    return entry;
  };

  cancel = (handle: unknown): void => {
    this.scheduled = this.scheduled.filter((entry) => entry !== handle);
  };

  kill: NonNullable<ProviderWaitGuardDeps["kill"]> = (input) => {
    this.kills.push(input);
    return true;
  };

  deps(): ProviderWaitGuardDeps {
    return { now: this.now, schedule: this.schedule, cancel: this.cancel, kill: this.kill };
  }

  /** Run every scheduled callback up to +ms, in time order. */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      const due = this.scheduled
        .filter((entry) => entry.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.nowMs = Math.max(this.nowMs, due.at);
      this.scheduled = this.scheduled.filter((entry) => entry !== due);
      due.fn();
    }
    this.nowMs = target;
  }
}

function makeEmitter() {
  const lines: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
  const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
    lines.push({ stream, text: chunk });
  };
  return { lines, onLog };
}

function enabledConfig(overrides: Partial<ProviderWaitGuardConfig> = {}): ProviderWaitGuardConfig {
  return {
    enabled: true,
    idleDiagnosticSec: 900,
    progressSec: 300,
    maxWaitSec: 3600,
    ...overrides,
  };
}

afterEach(() => {
  runningProcesses.delete("guard-test-run");
});

describe("resolveProviderWaitGuardConfig", () => {
  it("is disabled by default with documented cadences", () => {
    const resolved = resolveProviderWaitGuardConfig({}, {});
    expect(resolved).toEqual({
      enabled: false,
      idleDiagnosticSec: 900,
      progressSec: 300,
      maxWaitSec: 3600,
    });
  });

  it("reads PAPERCLIP_PI_WAIT_* environment overrides", () => {
    const resolved = resolveProviderWaitGuardConfig(
      {},
      {
        PAPERCLIP_PI_WAIT_GUARD: "1",
        PAPERCLIP_PI_WAIT_IDLE_DIAGNOSTIC_SEC: "60",
        PAPERCLIP_PI_WAIT_PROGRESS_SEC: "30",
        PAPERCLIP_PI_WAIT_MAX_SEC: "0",
      },
    );
    expect(resolved.enabled).toBe(true);
    expect(resolved.idleDiagnosticSec).toBe(60);
    expect(resolved.progressSec).toBe(30);
    expect(resolved.maxWaitSec).toBe(0);
  });

  it("lets explicit config values win over the environment", () => {
    const resolved = resolveProviderWaitGuardConfig(
      { providerWaitGuard: { enabled: true, progressSec: 120 } },
      { PAPERCLIP_PI_WAIT_GUARD: "0", PAPERCLIP_PI_WAIT_PROGRESS_SEC: "30" },
    );
    expect(resolved.enabled).toBe(true);
    expect(resolved.progressSec).toBe(120);
  });

  it("ignores malformed environment values", () => {
    const resolved = resolveProviderWaitGuardConfig(
      {},
      { PAPERCLIP_PI_WAIT_GUARD: "yes", PAPERCLIP_PI_WAIT_PROGRESS_SEC: "not-a-number" },
    );
    expect(resolved.enabled).toBe(true);
    expect(resolved.progressSec).toBe(300);
  });
});

describe("classifyProviderWaitReason", () => {
  it("recognizes auth, rate limit, and network evidence", () => {
    expect(classifyProviderWaitReason("Error: 401 unauthorized")).toBe("auth");
    expect(classifyProviderWaitReason("invalid api key for provider")).toBe("auth");
    expect(classifyProviderWaitReason("HTTP 429 too many requests")).toBe("rate_limit");
    expect(classifyProviderWaitReason("provider rate limit exceeded")).toBe("rate_limit");
    expect(classifyProviderWaitReason("fetch failed: ECONNRESET")).toBe("network");
    expect(classifyProviderWaitReason("getaddrinfo ENOTFOUND api.example.com")).toBe("network");
  });

  it("falls back to unknown for silent stalls", () => {
    expect(classifyProviderWaitReason("")).toBe("unknown");
    expect(classifyProviderWaitReason("nothing telling here")).toBe("unknown");
  });
});

describe("armProviderWaitGuard", () => {
  it("is fully inert when disabled: no timers, no output", async () => {
    const clock = new FakeClock();
    const { lines, onLog } = makeEmitter();
    const guard = armProviderWaitGuard({
      runId: "guard-test-run",
      config: enabledConfig({ enabled: false }),
      graceSec: 20,
      onLog,
      deps: clock.deps(),
    });

    await guard.noteChunk("stdout", "hello\n");
    clock.advance(24 * 3600 * 1000);
    guard.dispose();

    expect(clock.scheduled).toHaveLength(0);
    expect(lines).toHaveLength(0);
    expect(guard.waitTimeout()).toBeNull();
  });

  it("emits a diagnostic naming the wait class, periodic progress, then kills with escalation", async () => {
    const clock = new FakeClock();
    const { lines, onLog } = makeEmitter();
    const guard = armProviderWaitGuard({
      runId: "guard-test-run",
      config: enabledConfig(),
      graceSec: 20,
      onLog,
      deps: clock.deps(),
    });
    guard.onSpawn({ pid: 4242, processGroupId: 4242 });

    // Progress heartbeats every 300s of silence.
    clock.advance(300_000);
    await guard.settled();
    expect(lines).toHaveLength(1);
    expect(lines[0].stream).toBe("stderr");
    expect(lines[0].text).toContain("no CLI output for 300s");
    expect(lines[0].text).toContain("wait class: unknown");

    clock.advance(300_000);
    await guard.settled();
    expect(lines).toHaveLength(2);

    // One-time diagnostic at 900s. The same tick also carries the 900s
    // progress heartbeat (the diagnostic is emitted first).
    clock.advance(300_000);
    await guard.settled();
    expect(lines).toHaveLength(4);
    expect(lines[2].text).toContain("no CLI output for 900s");
    expect(lines[2].text).toContain("pid 4242");
    expect(lines[3].text).toContain("still waiting on the provider");

    // Progress continues past the diagnostic.
    clock.advance(300_000);
    await guard.settled();
    expect(lines).toHaveLength(5);

    // No kill before the bound...
    clock.advance(2_399_000); // idle 3599s
    expect(clock.kills).toHaveLength(0);

    // ...then SIGTERM at the bound and SIGKILL after the grace window.
    clock.advance(1_000); // idle 3600s
    await guard.settled();
    expect(clock.kills).toHaveLength(1);
    expect(clock.kills[0].signal).toBe("SIGTERM");
    expect(clock.kills[0].pid).toBe(4242);
    expect(lines.some((line) => line.text.includes("terminating the stalled CLI process"))).toBe(true);

    clock.advance(20_000);
    expect(clock.kills).toHaveLength(2);
    expect(clock.kills[1].signal).toBe("SIGKILL");

    guard.dispose();
    expect(guard.waitTimeout()).not.toBeNull();
    expect(guard.waitTimeout()?.idleSec).toBeGreaterThanOrEqual(3600);
  });

  it("classifies the wait from stderr evidence emitted before the stall", async () => {
    const clock = new FakeClock();
    const { lines, onLog } = makeEmitter();
    const guard = armProviderWaitGuard({
      runId: "guard-test-run",
      config: enabledConfig({ idleDiagnosticSec: 60, progressSec: 0, maxWaitSec: 120 }),
      graceSec: 5,
      onLog,
      deps: clock.deps(),
    });

    await guard.noteChunk("stderr", "warning: HTTP 429 received; backing off\n");
    clock.advance(60_000);
    await guard.settled();
    expect(lines[0].text).toContain("wait class: rate_limit");

    clock.advance(60_000);
    await guard.settled();
    expect(clock.kills).toHaveLength(1);
    expect(guard.waitTimeout()?.waitClass).toBe("rate_limit");

    guard.dispose();
  });

  it("stays silent and never kills while the stream keeps producing output", async () => {
    const clock = new FakeClock();
    const { lines, onLog } = makeEmitter();
    const guard = armProviderWaitGuard({
      runId: "guard-test-run",
      config: enabledConfig({ idleDiagnosticSec: 60, progressSec: 30, maxWaitSec: 120 }),
      graceSec: 5,
      onLog,
      deps: clock.deps(),
    });

    // 7s chunk cadence: never lands exactly on a 30s/60s/120s milestone.
    for (let tick = 0; tick < 45; tick += 1) {
      await guard.noteChunk("stdout", '{"type":"event"}\n');
      clock.advance(7_000);
    }

    await guard.settled();
    expect(lines).toHaveLength(0);
    expect(clock.kills).toHaveLength(0);
    expect(guard.waitTimeout()).toBeNull();

    guard.dispose();
  });

  it("supports observe-only mode: diagnostics without termination", async () => {
    const clock = new FakeClock();
    const { lines, onLog } = makeEmitter();
    const guard = armProviderWaitGuard({
      runId: "guard-test-run",
      config: enabledConfig({ idleDiagnosticSec: 60, progressSec: 30, maxWaitSec: 0 }),
      graceSec: 5,
      onLog,
      deps: clock.deps(),
    });

    clock.advance(12 * 3600 * 1000);
    await guard.settled();
    expect(clock.kills).toHaveLength(0);
    expect(lines.some((line) => line.text.includes("observe-only"))).toBe(true);
    expect(guard.waitTimeout()).toBeNull();

    guard.dispose();
  });

  it("terminates the registered process group and escalates to the child when the group signal fails", () => {
    const clock = new FakeClock();
    const { onLog } = makeEmitter();
    const childKillSignals: string[] = [];
    runningProcesses.set("guard-test-run", {
      child: {
        pid: 1111,
        killed: false,
        kill: (signal: string) => {
          childKillSignals.push(signal);
          return true;
        },
      } as unknown as import("node:child_process").ChildProcess,
      graceSec: 20,
      processGroupId: null,
    });

    const guard = armProviderWaitGuard({
      runId: "guard-test-run",
      config: enabledConfig({ idleDiagnosticSec: 0, progressSec: 0, maxWaitSec: 60 }),
      graceSec: 2,
      onLog,
      // Deliberately no kill seam: exercise the default kill path against the
      // runningProcesses registration.
      deps: { now: clock.now, schedule: clock.schedule, cancel: clock.cancel },
    });
    guard.onSpawn({ pid: 1111, processGroupId: null });

    clock.advance(60_000);
    expect(childKillSignals).toEqual(["SIGTERM"]);
    clock.advance(2_000);
    expect(childKillSignals).toEqual(["SIGTERM", "SIGKILL"]);

    guard.dispose();
  });

  it("refuses to signal a process it did not spawn", () => {
    const clock = new FakeClock();
    const { onLog } = makeEmitter();
    const childKillSignals: string[] = [];
    runningProcesses.set("guard-test-run", {
      child: {
        pid: 9999,
        killed: false,
        kill: (signal: string) => {
          childKillSignals.push(signal);
          return true;
        },
      } as unknown as import("node:child_process").ChildProcess,
      graceSec: 20,
      processGroupId: null,
    });

    const guard = armProviderWaitGuard({
      runId: "guard-test-run",
      config: enabledConfig({ idleDiagnosticSec: 0, progressSec: 0, maxWaitSec: 60 }),
      graceSec: 2,
      onLog,
      deps: { now: clock.now, schedule: clock.schedule, cancel: clock.cancel },
    });
    // Spawn metadata for pid 1111 does not match the registered pid 9999: the
    // registration belongs to a newer attempt, so the guard must stand down.
    guard.onSpawn({ pid: 1111, processGroupId: null });

    clock.advance(120_000);
    expect(childKillSignals).toEqual([]);

    guard.dispose();
    runningProcesses.delete("guard-test-run");
  });
});

describe("providerWaitTimeoutResult", () => {
  it("reports the distinct provider_wait_timeout error code as a transient upstream fault", () => {
    const result = providerWaitTimeoutResult({
      proc: { exitCode: null, signal: "SIGTERM" },
      wait: { idleSec: 3600, waitClass: "rate_limit", pid: 4242 },
    });
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.timedOut).toBe(false);
    expect(result.errorCode).toBe("provider_wait_timeout");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.clearSession).toBe(false);
    expect(result.errorMessage).toContain("no CLI output for 3600s");
    expect(result.errorMessage).toContain("wait class: rate_limit");
    expect(result.errorMessage).toContain("pid 4242");
  });
});
