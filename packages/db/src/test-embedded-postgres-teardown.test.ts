import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_GRACEFUL_STOP_TIMEOUT_MS,
  EMBEDDED_POSTGRES_SIGKILL_REAP_TIMEOUT_MS,
  stopEmbeddedPostgresBounded,
} from "./test-embedded-postgres.js";

// Regression test for the systemic teardown flake: vitest's default 10s
// hookTimeout was less than the 20s startup budget, so on a loaded runner an
// afterAll cleanup that called instance.stop() could overrun the budget and
// red a passing suite. stopEmbeddedPostgresBounded() bounds total teardown
// at graceful_timeout + sigkill_reap (15s default), inside the symmetric 20s
// hookTimeout that server/vitest.config.ts now sets.

type StubInstance = {
  initialise: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

function makeStubInstance(stopBehaviour: () => Promise<void>): StubInstance {
  return {
    initialise: async () => {},
    start: async () => {},
    stop: stopBehaviour,
  };
}

describe("stopEmbeddedPostgresBounded (pure logic via injection seams)", () => {
  it("returns true when graceful stop() settles inside the graceful timeout", async () => {
    const instance = makeStubInstance(async () => {});
    const sentSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const result = await stopEmbeddedPostgresBounded(instance, null, {
      gracefulTimeoutMs: 5_000,
      sigkillReapTimeoutMs: 5_000,
      sendSignal: (pid, signal) => sentSignals.push({ pid, signal }),
    });

    expect(result).toBe(true);
    expect(sentSignals).toEqual([]);
  });

  it("treats a rejecting stop() as not-graceful and probes for a live pid before escalating", async () => {
    // A rejection from embedded-postgres's stop() means shutdown did not
    // cleanly succeed. The safe assumption is the postmaster might still be
    // alive, so we fall through to the escalation probe. With no datadir
    // there's nothing to read, so we don't escalate blindly.
    const instance = makeStubInstance(async () => {
      throw new Error("shutdown error from embedded-postgres");
    });
    const sentSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const result = await stopEmbeddedPostgresBounded(instance, null, {
      gracefulTimeoutMs: 5_000,
      sigkillReapTimeoutMs: 5_000,
      sendSignal: (pid, signal) => sentSignals.push({ pid, signal }),
    });

    expect(result).toBe(false);
    expect(sentSignals).toEqual([]);
  });

  it("escalates to SIGKILL when stop() never settles, then reaps until the pid is gone", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-teardown-bounded-"));
    const postmasterPid = 42;
    fs.writeFileSync(path.join(tmpDir, "postmaster.pid"), `${postmasterPid}\n`);

    const instance = makeStubInstance(() => new Promise<void>(() => {})); // never settles
    const sentSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const alivePids = new Set<number>([postmasterPid]);

    let clock = 1_000;
    const sleepCalls: number[] = [];

    const result = await stopEmbeddedPostgresBounded(instance, tmpDir, {
      gracefulTimeoutMs: 50,
      sigkillReapTimeoutMs: 200,
      sigkillPollIntervalMs: 25,
      now: () => clock,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        // Advance the fake clock past the sleep so the while-loop can make
        // progress. Make the pid disappear after the third poll so we exercise
        // both the "still alive, sleep again" branch and the "now gone" exit.
        clock += ms;
        if (sleepCalls.length >= 3) alivePids.delete(postmasterPid);
      },
      sendSignal: (pid, signal) => {
        sentSignals.push({ pid, signal });
      },
      probeIsPidAlive: (pid) => alivePids.has(pid),
    });

    expect(result).toBe(false);
    expect(sentSignals).toEqual([{ pid: postmasterPid, signal: "SIGKILL" }]);
    // We polled at least once before the pid vanished.
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1);
    expect(sleepCalls.every((ms) => ms === 25)).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("still returns inside the bounded budget when the postmaster never reaps", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-teardown-bounded-"));
    const postmasterPid = 99;
    fs.writeFileSync(path.join(tmpDir, "postmaster.pid"), `${postmasterPid}\n`);

    const instance = makeStubInstance(() => new Promise<void>(() => {})); // never settles
    const sentSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let clock = 0;
    const sleepCalls: number[] = [];

    const result = await stopEmbeddedPostgresBounded(instance, tmpDir, {
      gracefulTimeoutMs: 20,
      sigkillReapTimeoutMs: 60,
      sigkillPollIntervalMs: 20,
      now: () => clock,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        clock += ms;
      },
      sendSignal: (pid, signal) => sentSignals.push({ pid, signal }),
      probeIsPidAlive: () => true, // postmaster never dies
    });

    // Worst-case path: SIGKILL was sent, reap loop exhausted its budget, we
    // returned false rather than hanging.
    expect(result).toBe(false);
    expect(sentSignals).toEqual([{ pid: postmasterPid, signal: "SIGKILL" }]);
    // Reap loop ran for the full sigkillReapTimeoutMs budget.
    const totalReapSleep = sleepCalls.reduce((sum, n) => sum + n, 0);
    expect(totalReapSleep).toBeGreaterThanOrEqual(60);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not escalate when datadir has no postmaster.pid", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-teardown-bounded-"));
    const instance = makeStubInstance(() => new Promise<void>(() => {}));
    const sentSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const result = await stopEmbeddedPostgresBounded(instance, tmpDir, {
      gracefulTimeoutMs: 30,
      sigkillReapTimeoutMs: 30,
      sendSignal: (pid, signal) => sentSignals.push({ pid, signal }),
    });

    expect(result).toBe(false);
    expect(sentSignals).toEqual([]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not escalate when postmaster.pid names an already-dead pid", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-teardown-bounded-"));
    const deadPid = 12345;
    fs.writeFileSync(path.join(tmpDir, "postmaster.pid"), `${deadPid}\n`);

    const instance = makeStubInstance(() => new Promise<void>(() => {}));
    const sentSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const result = await stopEmbeddedPostgresBounded(instance, tmpDir, {
      gracefulTimeoutMs: 30,
      sigkillReapTimeoutMs: 30,
      sendSignal: (pid, signal) => sentSignals.push({ pid, signal }),
      probeIsPidAlive: () => false,
    });

    expect(result).toBe(false);
    expect(sentSignals).toEqual([]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exports constants whose sum stays under the symmetric 20s hookTimeout", () => {
    // Defence-in-depth: if someone bumps either constant without bumping
    // server/vitest.config.ts hookTimeout, this assertion fires. 20s budget
    // minus 2s headroom for the rest of cleanup (rmSync, marker unlink, etc).
    const HOOK_TIMEOUT_MS = 20_000;
    const HEADROOM_MS = 2_000;
    expect(
      EMBEDDED_POSTGRES_GRACEFUL_STOP_TIMEOUT_MS + EMBEDDED_POSTGRES_SIGKILL_REAP_TIMEOUT_MS,
    ).toBeLessThanOrEqual(HOOK_TIMEOUT_MS - HEADROOM_MS);
  });
});

describe("stopEmbeddedPostgresBounded (integration with a real child process)", () => {
  let sweepDir: string;
  const spawned: ChildProcess[] = [];

  beforeAll(() => {
    sweepDir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-teardown-bounded-integration-"));
  });

  afterEach(() => {
    for (const child of spawned.splice(0)) child.kill("SIGKILL");
  });

  afterAll(() => {
    fs.rmSync(sweepDir, { recursive: true, force: true });
  });

  it("actually SIGKILLs the process named by postmaster.pid when stop() hangs", async () => {
    // Spawn a real long-running child to stand in for a stuck postmaster.
    // Real process.kill(SIGKILL) is what we're verifying here, so the
    // indirection through Node's child_process is on purpose.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
      stdio: "ignore",
    });
    spawned.push(child);
    if (!child.pid) throw new Error("failed to spawn helper process");

    const dataDir = path.join(sweepDir, "stuck-postmaster");
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir, "postmaster.pid"), `${child.pid}\n`);

    const instance = makeStubInstance(() => new Promise<void>(() => {})); // stop() hangs

    const start = Date.now();
    const result = await stopEmbeddedPostgresBounded(instance, dataDir, {
      // Tiny overrides so the test runs in well under a second. The real
      // defaults are exercised by the constants test above.
      gracefulTimeoutMs: 50,
      sigkillReapTimeoutMs: 2_000,
      sigkillPollIntervalMs: 25,
    });
    const elapsed = Date.now() - start;

    expect(result).toBe(false); // we escalated

    // The child is really dead now.
    const childPid = child.pid;
    if (childPid !== undefined) {
      expect(() => process.kill(childPid, 0)).toThrow();
    }

    // Total teardown stayed inside the small override budget + slack.
    expect(elapsed).toBeLessThan(1_500);
  });
});
