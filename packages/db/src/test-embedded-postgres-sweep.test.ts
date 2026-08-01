import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  isReclaimableEmbeddedPostgresDataDir,
  sweepOrphanedEmbeddedPostgresDataDirs,
} from "./test-embedded-postgres.js";

// PLA-2020: a killed test run (SIGKILL mid-suite) never runs cleanup(), so
// the ~170MB embedded-Postgres datadir it created is orphaned in os.tmpdir().
// These tests cover the startup sweep that reclaims those datadirs, without
// needing a real Postgres cluster.

function spawnAliveProcess(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`pid ${pid} did not exit within ${timeoutMs}ms`);
}

async function spawnAndKillForDeadPid(): Promise<number> {
  const child = spawnAliveProcess();
  const pid = child.pid;
  if (!pid) throw new Error("failed to spawn helper process");
  child.kill("SIGKILL");
  await waitForPidExit(pid);
  return pid;
}

describe("isReclaimableEmbeddedPostgresDataDir (pure predicate)", () => {
  it("never reclaims a directory without the PG_VERSION marker", () => {
    expect(
      isReclaimableEmbeddedPostgresDataDir(
        { hasVersionMarker: false, postmasterPid: 1, ownerPid: 1 },
        () => false,
      ),
    ).toBe(false);
  });

  it("reclaims when postmaster.pid names a dead pid", () => {
    expect(
      isReclaimableEmbeddedPostgresDataDir(
        { hasVersionMarker: true, postmasterPid: 999, ownerPid: null },
        (pid) => pid !== 999,
      ),
    ).toBe(true);
  });

  it("never reclaims when postmaster.pid names a live pid", () => {
    expect(
      isReclaimableEmbeddedPostgresDataDir(
        { hasVersionMarker: true, postmasterPid: 999, ownerPid: null },
        (pid) => pid === 999,
      ),
    ).toBe(false);
  });

  it("falls back to ownerPid when postmaster.pid was never written (killed mid-initdb)", () => {
    expect(
      isReclaimableEmbeddedPostgresDataDir(
        { hasVersionMarker: true, postmasterPid: null, ownerPid: 999 },
        (pid) => pid !== 999,
      ),
    ).toBe(true);
    expect(
      isReclaimableEmbeddedPostgresDataDir(
        { hasVersionMarker: true, postmasterPid: null, ownerPid: 999 },
        (pid) => pid === 999,
      ),
    ).toBe(false);
  });

  it("prefers postmasterPid over ownerPid when both are present", () => {
    // postmaster.pid is written by Postgres itself once it's actually up;
    // it's the more authoritative signal, so a live postmaster wins even if
    // the original owner process (e.g. a retried port-collision attempt) is
    // long gone.
    expect(
      isReclaimableEmbeddedPostgresDataDir(
        { hasVersionMarker: true, postmasterPid: 1, ownerPid: 2 },
        (pid) => pid === 1,
      ),
    ).toBe(false);
  });

  it("reclaims a directory with no owner recorded at all (legacy pre-fix orphan)", () => {
    expect(
      isReclaimableEmbeddedPostgresDataDir(
        { hasVersionMarker: true, postmasterPid: null, ownerPid: null },
        () => true,
      ),
    ).toBe(true);
  });
});

describe("sweepOrphanedEmbeddedPostgresDataDirs (integration)", () => {
  let sweepDir: string;
  const spawnedLive: ChildProcess[] = [];

  beforeAll(() => {
    sweepDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-pg-sweep-test-"));
  });

  afterEach(() => {
    for (const child of spawnedLive.splice(0)) child.kill("SIGKILL");
  });

  afterAll(() => {
    fs.rmSync(sweepDir, { recursive: true, force: true });
  });

  function makeDataDir(name: string): string {
    const dir = path.join(sweepDir, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "PG_VERSION"), "16\n");
    return dir;
  }

  it("removes dead-owner datadirs and their marker, leaves live and unrelated ones alone", async () => {
    const deadPid = await spawnAndKillForDeadPid();

    const live = spawnAliveProcess();
    spawnedLive.push(live);
    if (!live.pid) throw new Error("failed to spawn live helper process");

    // Killed before Postgres wrote postmaster.pid: only our own owner-pid
    // marker exists, and that process is dead.
    const deadOwnerOnly = makeDataDir("dead-owner-only");
    fs.writeFileSync(`${deadOwnerOnly}.owner-pid`, String(deadPid));

    // Postgres itself died after writing postmaster.pid.
    const deadPostmaster = makeDataDir("dead-postmaster");
    fs.writeFileSync(path.join(deadPostmaster, "postmaster.pid"), `${deadPid}\nrest-of-file\n`);
    fs.writeFileSync(`${deadPostmaster}.owner-pid`, String(deadPid));

    // A live cluster: postmaster.pid names a genuinely running process. This
    // must never be swept - it's the one way this change can do damage.
    const liveCluster = makeDataDir("live-cluster");
    fs.writeFileSync(path.join(liveCluster, "postmaster.pid"), `${live.pid}\n`);

    // A live owner with no postmaster.pid yet (mid-initdb, still running).
    const liveOwnerOnly = makeDataDir("live-owner-only");
    fs.writeFileSync(`${liveOwnerOnly}.owner-pid`, String(process.pid));

    // Legacy orphan from before this fix shipped: PG_VERSION but no marker
    // of any kind.
    const legacyOrphan = makeDataDir("legacy-orphan");

    // Not a Postgres datadir at all - must never be touched regardless of
    // what pid-shaped files happen to sit inside it.
    const unrelatedDir = path.join(sweepDir, "unrelated-dir");
    fs.mkdirSync(unrelatedDir);
    fs.writeFileSync(path.join(unrelatedDir, "postmaster.pid"), String(deadPid));

    sweepOrphanedEmbeddedPostgresDataDirs(sweepDir);

    expect(fs.existsSync(deadOwnerOnly)).toBe(false);
    expect(fs.existsSync(`${deadOwnerOnly}.owner-pid`)).toBe(false);

    expect(fs.existsSync(deadPostmaster)).toBe(false);
    expect(fs.existsSync(`${deadPostmaster}.owner-pid`)).toBe(false);

    expect(fs.existsSync(legacyOrphan)).toBe(false);

    expect(fs.existsSync(liveCluster)).toBe(true);
    expect(fs.existsSync(liveOwnerOnly)).toBe(true);
    expect(fs.existsSync(`${liveOwnerOnly}.owner-pid`)).toBe(true);
    expect(fs.existsSync(unrelatedDir)).toBe(true);
  });

  it("is idempotent and safe to run with nothing to reclaim", () => {
    expect(() => sweepOrphanedEmbeddedPostgresDataDirs(sweepDir)).not.toThrow();
    expect(() => sweepOrphanedEmbeddedPostgresDataDirs(sweepDir)).not.toThrow();
  });

  it("degrades to a no-op instead of throwing when the target directory doesn't exist", () => {
    const missing = path.join(sweepDir, "does-not-exist");
    expect(() => sweepOrphanedEmbeddedPostgresDataDirs(missing)).not.toThrow();
  });

  it("degrades to a no-op instead of throwing when the target path isn't a directory", () => {
    const filePath = path.join(sweepDir, "not-a-directory");
    fs.writeFileSync(filePath, "not a directory");
    expect(() => sweepOrphanedEmbeddedPostgresDataDirs(filePath)).not.toThrow();
  });
});
