import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { applyPendingMigrations, ensurePostgresDatabase } from "./client.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type EmbeddedPostgresTestSupport = {
  supported: boolean;
  reason?: string;
};

export type EmbeddedPostgresTestDatabase = {
  connectionString: string;
  cleanup(): Promise<void>;
};

let embeddedPostgresSupportPromise: Promise<EmbeddedPostgresTestSupport> | null = null;

const DEFAULT_PAPERCLIP_EMBEDDED_POSTGRES_PORT = 54329;

function getReservedTestPorts(): Set<number> {
  const configuredPorts = [
    DEFAULT_PAPERCLIP_EMBEDDED_POSTGRES_PORT,
    Number.parseInt(process.env.PAPERCLIP_EMBEDDED_POSTGRES_PORT ?? "", 10),
    ...String(process.env.PAPERCLIP_TEST_POSTGRES_RESERVED_PORTS ?? "")
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10)),
  ];
  return new Set(configuredPorts.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535));
}

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  await prepareEmbeddedPostgresNativeRuntime();
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  const reservedPorts = getReservedTestPorts();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close(() => reject(new Error("Failed to allocate test port")));
          return;
        }
        const { port } = address;
        server.close((error) => {
          if (error) reject(error);
          else resolve(port);
        });
      });
    });

    if (!reservedPorts.has(port)) return port;
  }

  throw new Error(
    `Failed to allocate embedded Postgres test port outside reserved Paperclip ports: ${[
      ...reservedPorts,
    ].join(", ")}`,
  );
}

const MAX_RECENT_STARTUP_LOG_LINES = 40;

function recordStartupLogLine(recentLogs: string[], message: unknown): void {
  const text = typeof message === "string" ? message : String(message ?? "");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    recentLogs.push(line);
    if (recentLogs.length > MAX_RECENT_STARTUP_LOG_LINES) recentLogs.shift();
  }
}

async function createEmbeddedPostgresTestInstance(tempDirPrefix: string) {
  sweepOrphanedEmbeddedPostgresDataDirs();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), tempDirPrefix));
  fs.writeFileSync(ownerPidMarkerPath(dataDir), String(process.pid));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const recentLogs: string[] = [];
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: (message) => recordStartupLogLine(recentLogs, message),
    onError: (message) => recordStartupLogLine(recentLogs, message),
  });

  return { dataDir, port, instance, recentLogs };
}

function cleanupEmbeddedPostgresTestDirs(dataDir: string) {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(ownerPidMarkerPath(dataDir), { force: true });
}

// A killed run (SIGKILL mid-suite, the routine way a heartbeat run ends here)
// never gets to run cleanup(), so it leaks the ~170MB datadir. There is no
// run-lifecycle signal to hook, so instead every new datadir starts with a
// startup sweep of os.tmpdir() that reclaims *any* leftover Postgres datadir
// (identified by the PG_VERSION marker, regardless of which caller's
// tempDirPrefix produced it) whose owning pid is no longer alive.
const EMBEDDED_POSTGRES_VERSION_MARKER = "PG_VERSION";

function ownerPidMarkerPath(dataDir: string): string {
  return `${dataDir}.owner-pid`;
}

function parsePidFileContents(contents: string): number | null {
  const firstLine = contents.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) return null;
  const pid = Number.parseInt(firstLine, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function readPidFile(filePath: string): number | null {
  try {
    return parsePidFileContents(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// Exact liveness, not a guess: process.kill(pid, 0) sends no signal, it only
// probes whether the pid exists. ESRCH means it's gone. Anything else (alive,
// EPERM because it's owned by another user, or an unexpected error) fails
// closed as "alive" so we never remove a datadir we're unsure about.
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

export type ReclaimableDataDirCandidate = {
  hasVersionMarker: boolean;
  postmasterPid: number | null;
  ownerPid: number | null;
};

// Pure decision function, unit-testable without touching a real cluster:
// hand it what a directory listing says about one entry (does it look like a
// Postgres datadir, and which pid(s) claim to own it) plus a liveness probe.
//
// postmasterPid (written by Postgres itself once it finishes booting) is
// preferred when present. Most of the orphans this exists to clean up never
// get that far - they're killed mid-initdb, before Postgres ever writes
// postmaster.pid - so we fall back to ownerPid, a marker this module writes
// itself immediately after mkdtemp naming the creating process. If neither
// marker is present at all, there is no owner on record, so it's an orphan
// from before this fix (or the exceedingly narrow window between mkdtemp and
// the marker write) and it's safe to reclaim.
export function isReclaimableEmbeddedPostgresDataDir(
  candidate: ReclaimableDataDirCandidate,
  probeIsPidAlive: (pid: number) => boolean = isPidAlive,
): boolean {
  if (!candidate.hasVersionMarker) return false;
  const ownerPid = candidate.postmasterPid ?? candidate.ownerPid;
  if (ownerPid === null) return true;
  return !probeIsPidAlive(ownerPid);
}

function readReclaimCandidate(entryPath: string): ReclaimableDataDirCandidate | null {
  let hasVersionMarker: boolean;
  try {
    hasVersionMarker = fs.statSync(path.join(entryPath, EMBEDDED_POSTGRES_VERSION_MARKER)).isFile();
  } catch {
    return null;
  }
  if (!hasVersionMarker) return null;

  return {
    hasVersionMarker,
    postmasterPid: readPidFile(path.join(entryPath, "postmaster.pid")),
    ownerPid: readPidFile(ownerPidMarkerPath(entryPath)),
  };
}

// Best-effort only: a failure to reclaim orphaned datadirs must never fail a
// test run that would otherwise pass, so every layer of this degrades to a
// no-op rather than throwing into the caller.
export function sweepOrphanedEmbeddedPostgresDataDirs(tmpDir: string = os.tmpdir()): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    try {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(tmpDir, entry.name);
      const candidate = readReclaimCandidate(entryPath);
      if (!candidate || !isReclaimableEmbeddedPostgresDataDir(candidate)) continue;
      fs.rmSync(entryPath, { recursive: true, force: true });
      fs.rmSync(ownerPidMarkerPath(entryPath), { force: true });
    } catch {
      // Leave this entry for the next sweep rather than failing the caller.
    }
  }
}

function formatEmbeddedPostgresError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "embedded Postgres startup failed";
}

async function probeEmbeddedPostgresSupport(): Promise<EmbeddedPostgresTestSupport> {
  let dataDir: string | null = null;
  let instance: EmbeddedPostgresInstance | null = null;

  try {
    const created = await createEmbeddedPostgresTestInstance(
      "paperclip-embedded-postgres-probe-",
    );
    dataDir = created.dataDir;
    instance = created.instance;
    await instance.initialise();
    await instance.start();
    return { supported: true };
  } catch (error) {
    return {
      supported: false,
      reason: formatEmbeddedPostgresError(error),
    };
  } finally {
    await instance?.stop().catch(() => {});
    if (dataDir) cleanupEmbeddedPostgresTestDirs(dataDir);
  }
}

export async function getEmbeddedPostgresTestSupport(): Promise<EmbeddedPostgresTestSupport> {
  if (!embeddedPostgresSupportPromise) {
    embeddedPostgresSupportPromise = probeEmbeddedPostgresSupport();
  }
  return await embeddedPostgresSupportPromise;
}

const MAX_PORT_COLLISION_ATTEMPTS = 5;
const PORT_COLLISION_LOG_PATTERN = /address already in use/i;

// getAvailablePort() closes its probe socket before initialise()/start() ever
// binds it, so a concurrent test worker can grab the same port in between
// (TOCTOU). When that happens, embedded-postgres's start() rejects with no
// error object at all (it settles via a bare `reject()` on early process
// exit) - the only signal is the "Address already in use" line it hands to
// onLog. Detect that in the captured startup log rather than the thrown error.
function isLikelyPortCollision(recentLogs: string[]): boolean {
  return recentLogs.some((line) => PORT_COLLISION_LOG_PATTERN.test(line));
}

export async function startEmbeddedPostgresTestDatabase(
  tempDirPrefix: string,
): Promise<EmbeddedPostgresTestDatabase> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_PORT_COLLISION_ATTEMPTS; attempt += 1) {
    let dataDir: string | null = null;
    let instance: EmbeddedPostgresInstance | null = null;
    let recentLogs: string[] = [];

    try {
      const created = await createEmbeddedPostgresTestInstance(tempDirPrefix);
      dataDir = created.dataDir;
      instance = created.instance;
      recentLogs = created.recentLogs;
      const { port } = created;
      await instance.initialise();
      await instance.start();

      const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
      await ensurePostgresDatabase(adminConnectionString, "paperclip");
      const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
      await applyPendingMigrations(connectionString);

      return {
        connectionString,
        cleanup: async () => {
          await instance?.stop().catch(() => {});
          if (dataDir) cleanupEmbeddedPostgresTestDirs(dataDir);
        },
      };
    } catch (error) {
      await instance?.stop().catch(() => {});
      if (dataDir) cleanupEmbeddedPostgresTestDirs(dataDir);

      const canRetry = attempt < MAX_PORT_COLLISION_ATTEMPTS && isLikelyPortCollision(recentLogs);
      if (!canRetry) {
        throw new Error(
          `Failed to start embedded PostgreSQL test database: ${formatEmbeddedPostgresError(error)}`,
        );
      }
      lastError = error;
    }
  }

  throw new Error(
    `Failed to start embedded PostgreSQL test database: ${formatEmbeddedPostgresError(lastError)}`,
  );
}
