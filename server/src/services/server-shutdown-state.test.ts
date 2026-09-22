import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SERVER_SHUTDOWN_INTERRUPTED_ERROR_CODE,
  clearLastServerShutdownBoundary,
  currentShutdownSignal,
  isRunKilledByServerShutdown,
  isServerShutdownInProgress,
  markServerShutdownStarted,
  readLastServerShutdownBoundary,
  resetServerShutdownMemoryForTests,
  resolveServerShutdownBoundaryPath,
} from "./server-shutdown-state.js";

describe("server-shutdown-state", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "server-shutdown-state-"));
  });

  afterEach(async () => {
    resetServerShutdownMemoryForTests();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("exposes the shared terminal error code", () => {
    expect(SERVER_SHUTDOWN_INTERRUPTED_ERROR_CODE).toBe("server_shutdown_interrupted");
  });

  it("marks the shutdown in memory and persists the boundary synchronously", async () => {
    const at = new Date("2026-09-22T17:26:15.000Z");
    const state = markServerShutdownStarted("SIGTERM", at, home);
    expect(state).toEqual({ signal: "SIGTERM", startedAt: at });
    expect(isServerShutdownInProgress()).toBe(true);
    expect(currentShutdownSignal("SIGINT")).toBe("SIGTERM");

    const persisted = await readLastServerShutdownBoundary(home);
    expect(persisted).toEqual({ signal: "SIGTERM", startedAt: at, pid: process.pid });
  });

  it("keeps the first marker; a second signal does not move startedAt", () => {
    const first = new Date("2026-09-22T17:26:15.000Z");
    markServerShutdownStarted("SIGTERM", first, home);
    const second = markServerShutdownStarted("SIGINT", new Date("2026-09-22T17:26:20.000Z"), home);
    expect(second.startedAt).toBe(first);
    expect(second.signal).toBe("SIGTERM");
  });

  it("reads null when no boundary marker exists", async () => {
    expect(await readLastServerShutdownBoundary(home)).toBeNull();
  });

  it("clears the persisted boundary", async () => {
    markServerShutdownStarted("SIGTERM", new Date("2026-09-22T17:26:15.000Z"), home);
    await clearLastServerShutdownBoundary(home);
    expect(await readLastServerShutdownBoundary(home)).toBeNull();
  });

  it("throws on a malformed marker so callers fail open to the failure class", async () => {
    await fs.mkdir(path.dirname(resolveServerShutdownBoundaryPath(home)), { recursive: true });
    await fs.writeFile(resolveServerShutdownBoundaryPath(home), "not-json{", "utf8");
    await expect(readLastServerShutdownBoundary(home)).rejects.toBeInstanceOf(Error);
  });

  describe("isRunKilledByServerShutdown (the one shared predicate)", () => {
    const boundary = { signal: "SIGTERM" as const, startedAt: new Date("2026-09-22T17:26:15.000Z"), pid: 4242 };

    it("returns true whenever a shutdown is in progress in this process", () => {
      expect(isRunKilledByServerShutdown({ inProgress: true })).toBe(true);
      expect(isRunKilledByServerShutdown({ inProgress: true, boundary, runStartedAt: null })).toBe(true);
    });

    it("classifies a run alive at the boundary as a shutdown kill", () => {
      expect(isRunKilledByServerShutdown({
        inProgress: false,
        boundary,
        runStartedAt: new Date("2026-09-22T17:18:02.000Z"),
      })).toBe(true);
      expect(isRunKilledByServerShutdown({
        inProgress: false,
        boundary,
        runStartedAt: boundary.startedAt,
      })).toBe(true);
    });

    it("never classifies a run started after the boundary", () => {
      expect(isRunKilledByServerShutdown({
        inProgress: false,
        boundary,
        runStartedAt: new Date("2026-09-22T17:26:15.001Z"),
      })).toBe(false);
    });

    it("requires a boundary and a run start to prove a cross-process kill", () => {
      expect(isRunKilledByServerShutdown({ inProgress: false, boundary, runStartedAt: null })).toBe(false);
      expect(isRunKilledByServerShutdown({ inProgress: false, boundary: null, runStartedAt: new Date() })).toBe(false);
      expect(isRunKilledByServerShutdown({ inProgress: false })).toBe(false);
    });
  });
});
