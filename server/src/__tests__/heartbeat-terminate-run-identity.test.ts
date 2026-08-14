import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { terminateHeartbeatRunProcess } from "../services/heartbeat.js";
import { readProcessStartEpochMs } from "../services/local-service-supervisor.js";

// Regression coverage for the sibling DB-only kill paths in heartbeat.ts. Each path
// reconstructs a pid/pgid from persisted run metadata with NO live in-memory handle, so
// after a server restart the OS may have recycled that pid/pgid onto an unrelated process.
// They funnel through the identity gate centralized in terminateHeartbeatRunProcess, in two
// modes:
//  - "process" (cancelRun / wakeup-cancel no-handle branches): the persisted pid is expected
//    to be alive; any inability to positively match is a recycled live process -> skip.
//  - "descendant-group" (process-loss reaper): reached only after the parent pid is dead, so
//    a dead leader is reaped and only a *live* mismatched leader is skipped.
// These tests drive the gate with real processes exactly as the sites do.

const linuxOnly = it.skipIf(process.platform !== "linux");

describe("terminateHeartbeatRunProcess identity gate (sibling DB-only kill paths)", () => {
  const spawned: ChildProcess[] = [];
  const orphanPids: number[] = [];

  function spawnLongLived() {
    // Detached so the child is its own process-group leader (pgid === pid), matching how
    // the heartbeat runner spawns tracked local children and how these sites signal -pgid.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    spawned.push(child);
    if (typeof child.pid !== "number" || child.pid <= 0) {
      throw new Error("failed to spawn fixture process");
    }
    return child.pid;
  }

  // Reproduces the reaper's real fixture: a detached leader spawns a child in its own group,
  // then exits. The leader pid (=== pgid) is dead while the descendant keeps the group alive.
  async function spawnOrphanedGroup() {
    const leader = spawn(
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          "process.stdout.write(String(child.pid));",
          "setTimeout(() => process.exit(0), 25);",
        ].join(" "),
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    let stdout = "";
    leader.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    await new Promise<void>((resolve, reject) => {
      leader.once("error", reject);
      leader.once("exit", () => resolve());
    });
    const descendantPid = Number.parseInt(stdout.trim(), 10);
    if (!Number.isInteger(descendantPid) || descendantPid <= 0) {
      throw new Error(`failed to capture orphaned descendant pid: ${stdout}`);
    }
    orphanPids.push(descendantPid);
    return { leaderPid: leader.pid as number, descendantPid };
  }

  function isAlive(pid: number) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitForExit(pid: number, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return !isAlive(pid);
  }

  afterEach(() => {
    for (const child of spawned.splice(0)) {
      try {
        if (typeof child.pid === "number") process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    for (const pid of orphanPids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  // The cancel / wakeup-cancel no-handle branches signal a persisted pid expected to be
  // alive; a recycled live process must be protected (fail-closed).
  const processModeSites = [
    "cancelRun no-in-memory-handle branch",
    "wakeup-cancel no-in-memory-handle branch",
  ];

  for (const site of processModeSites) {
    linuxOnly(
      `${site}: does NOT signal a recycled pid/pgid when the recorded spawn time mismatches`,
      async () => {
        const pid = spawnLongLived();
        const actual = await readProcessStartEpochMs(pid);
        expect(actual).not.toBeNull();

        // Persisted metadata claims this pid/pgid was spawned ten minutes before the
        // process the OS actually has there now -- the post-restart recycle scenario.
        const recycledClaim = new Date((actual as number) - 10 * 60_000);
        const outcome = await terminateHeartbeatRunProcess({
          pid,
          processGroupId: pid,
          expectedProcessStartedAt: recycledClaim,
        });

        expect(outcome).toBe("skipped_identity_unverified");
        // Side-effect free: the innocent survivor is untouched.
        expect(isAlive(pid)).toBe(true);
      },
    );
  }

  linuxOnly(
    "process mode: still terminates the genuine survivor when the recorded spawn time matches",
    async () => {
      const pid = spawnLongLived();
      const actual = await readProcessStartEpochMs(pid);
      expect(actual).not.toBeNull();

      const outcome = await terminateHeartbeatRunProcess({
        pid,
        processGroupId: pid,
        expectedProcessStartedAt: new Date(actual as number),
        graceMs: 2_000,
      });

      expect(outcome).toBe("terminated");
      expect(isAlive(pid)).toBe(false);
    },
  );

  linuxOnly(
    "process mode: a missing recorded spawn time is unverifiable and fails closed (skip)",
    async () => {
      const pid = spawnLongLived();
      const outcome = await terminateHeartbeatRunProcess({
        pid,
        processGroupId: pid,
        expectedProcessStartedAt: null,
      });
      expect(outcome).toBe("skipped_identity_unverified");
      expect(isAlive(pid)).toBe(true);
    },
  );

  linuxOnly(
    "descendant-group reaper: reaps the orphaned group whose leader is already dead (no spawn time needed)",
    async () => {
      const { leaderPid, descendantPid } = await spawnOrphanedGroup();
      expect(isAlive(leaderPid)).toBe(false);
      expect(isAlive(descendantPid)).toBe(true);

      // The reaper reaches this branch only after the leader pid is confirmed dead, so a
      // missing/mismatched spawn time must NOT block reaping the legitimate orphans.
      const outcome = await terminateHeartbeatRunProcess({
        pid: leaderPid,
        processGroupId: leaderPid,
        identityMode: "descendant-group",
        expectedProcessStartedAt: null,
        graceMs: 2_000,
      });

      expect(outcome).toBe("terminated");
      expect(await waitForExit(descendantPid, 2_000)).toBe(true);
    },
  );

  linuxOnly(
    "descendant-group reaper: skips when the group leader is STILL ALIVE with a mismatched spawn time (recycled live group)",
    async () => {
      const pid = spawnLongLived();
      const actual = await readProcessStartEpochMs(pid);
      expect(actual).not.toBeNull();

      const recycledClaim = new Date((actual as number) - 10 * 60_000);
      const outcome = await terminateHeartbeatRunProcess({
        pid,
        processGroupId: pid,
        identityMode: "descendant-group",
        expectedProcessStartedAt: recycledClaim,
      });

      expect(outcome).toBe("skipped_identity_unverified");
      expect(isAlive(pid)).toBe(true);
    },
  );

  linuxOnly(
    "trusted-handle callers bypass the gate and terminate regardless of recorded spawn time",
    async () => {
      const pid = spawnLongLived();
      // The if(running) branches at the cancel/wakeup sites hold a live child handle and
      // pass trustedHandle:true; they must not be gated even without a spawn timestamp.
      const outcome = await terminateHeartbeatRunProcess({
        pid,
        processGroupId: pid,
        trustedHandle: true,
        expectedProcessStartedAt: null,
        graceMs: 2_000,
      });
      expect(outcome).toBe("terminated");
      expect(isAlive(pid)).toBe(false);
    },
  );

  it("no pid and no pgid is a no-op", async () => {
    const outcome = await terminateHeartbeatRunProcess({ pid: null, processGroupId: null });
    expect(outcome).toBe("no_process");
  });
});
