import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  isMcpOrphanCommand,
  reapOrphanedMcpProcessesOnStartup,
  reapRunMcpDescendants,
  selectOrphanedMcpStrayPids,
  selectRunMcpDescendantPids,
  type ProcessSnapshot,
} from "./mcp-orphan-reaper.js";

describe("isMcpOrphanCommand", () => {
  it("matches MCP server command forms", () => {
    expect(isMcpOrphanCommand("node /x/node_modules/@playwright/mcp/cli.js")).toBe(true);
    expect(isMcpOrphanCommand("npm exec @playwright/mcp@latest")).toBe(true);
    expect(isMcpOrphanCommand("/usr/local/bin/mcp-server-playwright")).toBe(true);
    expect(isMcpOrphanCommand("node /x/bin/playwright-mcp --headless")).toBe(true);
  });

  it("does not match unrelated node / playwright processes", () => {
    expect(isMcpOrphanCommand("node server.js")).toBe(false);
    expect(isMcpOrphanCommand("npx playwright test")).toBe(false);
    expect(isMcpOrphanCommand("/opt/google/chrome/chrome --headless")).toBe(false);
    expect(isMcpOrphanCommand("node /x/@playwright/mcpanel/cli.js")).toBe(false);
    expect(isMcpOrphanCommand("node /x/playwright-mcpx/cli.js")).toBe(false);
  });
});

const proc = (pid: number, ppid: number, pgid: number, command: string): ProcessSnapshot => ({
  pid,
  ppid,
  pgid,
  command,
});

describe("selectRunMcpDescendantPids", () => {
  const mcp = "node /x/node_modules/@playwright/mcp/cli.js";
  it("selects MCP descendants of the run pid (including ones that escaped into their own group)", () => {
    const processes = [
      proc(100, 1, 100, "node claude-cli"), // the run child
      proc(200, 100, 200, mcp), // escaped MCP: own group, still a descendant
      proc(300, 200, 200, "node worker"), // non-MCP descendant — untouched
      proc(999, 1, 999, mcp), // unrelated MCP, not a descendant — untouched
    ];
    expect(selectRunMcpDescendantPids(processes, { pid: 100, processGroupId: 100 }, 5)).toEqual([200]);
  });

  it("selects MCP that shares the run process group", () => {
    const processes = [
      proc(200, 100, 400, mcp), // in-group MCP, not a ppid descendant of 100
    ];
    expect(selectRunMcpDescendantPids(processes, { pid: 100, processGroupId: 400 }, 5)).toEqual([200]);
  });

  it("never selects the current process", () => {
    const processes = [proc(42, 1, 42, mcp)];
    expect(selectRunMcpDescendantPids(processes, { pid: 42, processGroupId: 42 }, 42)).toEqual([]);
  });

  it("returns empty when neither pid nor group is provided", () => {
    expect(selectRunMcpDescendantPids([proc(200, 100, 200, mcp)], {}, 5)).toEqual([]);
  });
});

describe("selectOrphanedMcpStrayPids", () => {
  const mcp = "node /x/node_modules/@playwright/mcp/cli.js";
  it("selects only ppid==1 MCP strays", () => {
    const processes = [
      proc(200, 1, 200, mcp), // orphaned stray -> selected
      proc(201, 100, 201, mcp), // live parent -> not an orphan
      proc(202, 1, 202, "node server.js"), // orphaned but not MCP
    ];
    expect(selectOrphanedMcpStrayPids(processes, 5)).toEqual([200]);
  });

  it("never selects the current process even if orphaned", () => {
    expect(selectOrphanedMcpStrayPids([proc(7, 1, 7, mcp)], 7)).toEqual([]);
  });
});

// Real-process verification (acceptance criterion 3): a forced teardown must
// leave no MCP child behind, even when it escaped the run's process group.
const integration = process.platform === "win32" ? describe.skip : describe;

integration("MCP orphan reaping (real processes)", () => {
  let tempDir: string | null = null;
  const spawnedPids: number[] = [];

  afterEach(() => {
    for (const pid of spawnedPids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  function makeFakeMcpScript(): string {
    tempDir = mkdtempSync(path.join(tmpdir(), "mcp-reap-"));
    const dir = path.join(tempDir, "node_modules", "@playwright", "mcp");
    mkdirSync(dir, { recursive: true });
    const script = path.join(dir, "fake-server.mjs");
    writeFileSync(script, "setInterval(() => {}, 1_000_000_000);\n");
    return script;
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function readPpid(pid: number): number | null {
    try {
      const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim();
      const parsed = Number.parseInt(out, 10);
      return Number.isInteger(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  it("reaps an MCP child that escaped the run's process group on teardown", async () => {
    const script = makeFakeMcpScript();
    // detached:true makes it a session leader (own process group), i.e. it
    // escapes a `kill(-pgid)` on the run group but stays a ppid-descendant.
    const child = spawn(process.execPath, [script], { detached: true, stdio: "ignore" });
    child.unref();
    const childPid = child.pid!;
    spawnedPids.push(childPid);

    // Wait until ps can observe the child.
    for (let i = 0; i < 40 && readPpid(childPid) === null; i++) await delay(50);
    expect(isAlive(childPid)).toBe(true);

    // No-op terminate stands in for the run's process-group kill (which the
    // escaped child survives). The reaper must still clean it up.
    const reaped = await reapRunMcpDescendants(
      { pid: process.pid, processGroupId: null },
      async () => {},
      { graceMs: 1_500 },
    );

    expect(reaped).toContain(childPid);
    for (let i = 0; i < 40 && isAlive(childPid); i++) await delay(50);
    expect(isAlive(childPid)).toBe(false);
  }, 15_000);

  it("startup sweep reaps a pre-existing ppid==1 MCP stray", async () => {
    const script = makeFakeMcpScript();
    // Double-fork: a short-lived launcher spawns the MCP grandchild detached,
    // then exits, so the grandchild reparents to init (ppid==1).
    const launcher = [
      "const { spawn } = require('node:child_process');",
      `const c = spawn(process.execPath, [${JSON.stringify(script)}], { detached: true, stdio: 'ignore' });`,
      "c.unref();",
      "process.stdout.write(String(c.pid));",
      "process.exit(0);",
    ].join("\n");
    const res = spawnSync(process.execPath, ["-e", launcher], { encoding: "utf8" });
    const grandPid = Number.parseInt(res.stdout.trim(), 10);
    expect(Number.isInteger(grandPid)).toBe(true);
    spawnedPids.push(grandPid);

    // Wait for reparenting to init.
    for (let i = 0; i < 60 && readPpid(grandPid) !== 1; i++) await delay(50);
    expect(readPpid(grandPid)).toBe(1);

    const reaped = await reapOrphanedMcpProcessesOnStartup({ graceMs: 1_500 });
    expect(reaped).toContain(grandPid);
    for (let i = 0; i < 40 && isAlive(grandPid); i++) await delay(50);
    expect(isAlive(grandPid)).toBe(false);
  }, 15_000);
});
