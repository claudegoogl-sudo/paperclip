import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROCESS_IDENTITY_START_TOLERANCE_MS,
  readProcessStartEpochMs,
  verifyProcessStartIdentity,
} from "../services/local-service-supervisor.js";

const linuxOnly = it.skipIf(process.platform !== "linux");

describe("watchdog kill process-identity verification", () => {
  const spawned: ChildProcess[] = [];

  function spawnLongLived() {
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
  });

  linuxOnly("reads a live process start time near the actual spawn instant", async () => {
    const spawnedAt = Date.now();
    const pid = spawnLongLived();
    const start = await readProcessStartEpochMs(pid);
    expect(start).not.toBeNull();
    expect(Math.abs((start as number) - spawnedAt)).toBeLessThan(PROCESS_IDENTITY_START_TOLERANCE_MS);
  });

  linuxOnly("returns null for a pid that cannot exist", async () => {
    // pid_max leaves 2^31-1 unassignable; a dead/unreadable pid must not resolve.
    expect(await readProcessStartEpochMs(2_147_483_646)).toBeNull();
  });

  linuxOnly("verifies identity when the recorded spawn time matches the live process", async () => {
    const pid = spawnLongLived();
    const actual = await readProcessStartEpochMs(pid);
    expect(actual).not.toBeNull();
    await expect(verifyProcessStartIdentity(pid, actual as number)).resolves.toBe("verified");
  });

  linuxOnly("does NOT signal a recycled pid: mismatched start time yields 'mismatch'", async () => {
    const pid = spawnLongLived();
    const actual = await readProcessStartEpochMs(pid);
    expect(actual).not.toBeNull();

    // Simulate a recycled pid: persisted metadata claims this pid was spawned ten
    // minutes before the process the OS actually has at that pid now.
    const recycledClaim = (actual as number) - 10 * 60_000;
    await expect(verifyProcessStartIdentity(pid, recycledClaim)).resolves.toBe("mismatch");

    // The verification must be side-effect free: the innocent process is untouched,
    // which is what lets the caller skip the kill instead of SIGKILLing it.
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  linuxOnly("treats a missing recorded spawn time as unverifiable ('mismatch')", async () => {
    const pid = spawnLongLived();
    await expect(verifyProcessStartIdentity(pid, null)).resolves.toBe("mismatch");
    await expect(verifyProcessStartIdentity(pid, undefined)).resolves.toBe("mismatch");
  });

  it.skipIf(process.platform === "linux")(
    "reports 'unsupported' off Linux so prior behavior is preserved",
    async () => {
      expect(await verifyProcessStartIdentity(1, Date.now())).toBe("unsupported");
    },
  );
});
