import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { ensurePostgresDatabase, getPostgresDataDirectory } from "./client.js";
import { createEmbeddedPostgresLogBuffer, formatEmbeddedPostgresError } from "./embedded-postgres-error.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";
import {
  buildEmbeddedPostgresConnectionString,
  buildEmbeddedPostgresConstructorOptions,
  resolveEmbeddedPostgresPasswordForStartup,
  rotateEmbeddedPostgresAuthIfNeeded,
} from "./embedded-postgres-auth.js";
import { resolveDatabaseTarget } from "./runtime-config.js";

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
  authMethod?: "scram-sha-256" | "password" | "md5";
  initdbFlags?: string[];
  postgresFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type MigrationConnection = {
  mode: "postgres" | "embedded-postgres";
  connectionString: string;
  source: string;
  stop: () => Promise<void>;
};

function readRunningPostmasterPid(postmasterPidFile: string): number | null {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const pid = Number(readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function readPidFilePort(postmasterPidFile: string): number | null {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const lines = readFileSync(postmasterPidFile, "utf8").split("\n");
    const port = Number(lines[3]?.trim());
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function isPortInUse(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "EADDRINUSE");
    });
    server.listen(port, "127.0.0.1", () => {
      server.close();
      resolve(false);
    });
  });
}

async function findAvailablePort(startPort: number): Promise<number> {
  const maxLookahead = 20;
  let port = startPort;
  for (let i = 0; i < maxLookahead; i += 1, port += 1) {
    if (!(await isPortInUse(port))) return port;
  }
  throw new Error(
    `Embedded PostgreSQL could not find a free port from ${startPort} to ${startPort + maxLookahead - 1}`,
  );
}

async function loadEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  try {
    const mod = await import("embedded-postgres");
    return mod.default as EmbeddedPostgresCtor;
  } catch {
    throw new Error(
      "Embedded PostgreSQL support requires dependency `embedded-postgres`. Reinstall dependencies and try again.",
    );
  }
}

async function ensureEmbeddedPostgresConnection(
  dataDir: string,
  preferredPort: number,
): Promise<MigrationConnection> {
  const EmbeddedPostgres = await loadEmbeddedPostgresCtor();
  await prepareEmbeddedPostgresNativeRuntime();
  const selectedPort = await findAvailablePort(preferredPort);
  const postmasterPidFile = path.resolve(dataDir, "postmaster.pid");
  const pgVersionFile = path.resolve(dataDir, "PG_VERSION");
  const runningPid = readRunningPostmasterPid(postmasterPidFile);
  const runningPort = readPidFilePort(postmasterPidFile);
  const startupPasswordResolution = resolveEmbeddedPostgresPasswordForStartup(dataDir);
  const preferredAdminConnectionString = buildEmbeddedPostgresConnectionString({
    port: preferredPort,
    database: "postgres",
    password: startupPasswordResolution.password,
  });
  const logBuffer = createEmbeddedPostgresLogBuffer();

  if (!runningPid && existsSync(pgVersionFile)) {
    try {
      const actualDataDir = await getPostgresDataDirectory(preferredAdminConnectionString);
      const matchesDataDir =
        typeof actualDataDir === "string" &&
        path.resolve(actualDataDir) === path.resolve(dataDir);
      if (!matchesDataDir) {
        throw new Error("reachable postgres does not use the expected embedded data directory");
      }
      await ensurePostgresDatabase(preferredAdminConnectionString, "paperclip");
      process.emitWarning(
        `Adopting an existing PostgreSQL instance on port ${preferredPort} for embedded data dir ${dataDir} because postmaster.pid is missing.`,
      );
      const rotated = await rotateEmbeddedPostgresAuthIfNeeded({
        dataDir,
        port: preferredPort,
        currentPassword: startupPasswordResolution.password,
      });
      return {
        mode: "embedded-postgres",
        connectionString: buildEmbeddedPostgresConnectionString({
          port: preferredPort,
          database: "paperclip",
          password: rotated.password,
        }),
        source: `embedded-postgres@${preferredPort}`,
        stop: async () => {},
      };
    } catch {
      // Fall through and attempt to start the configured embedded cluster.
    }
  }

  if (runningPid) {
    const port = runningPort ?? preferredPort;
    const adminConnectionString = buildEmbeddedPostgresConnectionString({
      port,
      database: "postgres",
      password: startupPasswordResolution.password,
    });
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    const rotated = await rotateEmbeddedPostgresAuthIfNeeded({
      dataDir,
      port,
      currentPassword: startupPasswordResolution.password,
    });
    return {
      mode: "embedded-postgres",
      connectionString: buildEmbeddedPostgresConnectionString({
        port,
        database: "paperclip",
        password: rotated.password,
      }),
      source: `embedded-postgres@${port}`,
      stop: async () => {},
    };
  }

  const instance = new EmbeddedPostgres(
    buildEmbeddedPostgresConstructorOptions({
      dataDir,
      port: selectedPort,
      password: startupPasswordResolution.password,
      onLog: logBuffer.append,
      onError: logBuffer.append,
    }),
  );

  if (!existsSync(path.resolve(dataDir, "PG_VERSION"))) {
    try {
      await instance.initialise();
    } catch (error) {
      throw formatEmbeddedPostgresError(error, {
        fallbackMessage:
          `Failed to initialize embedded PostgreSQL cluster in ${dataDir} on port ${selectedPort}`,
        recentLogs: logBuffer.getRecentLogs(),
      });
    }
  }
  if (existsSync(postmasterPidFile)) {
    rmSync(postmasterPidFile, { force: true });
  }
  try {
    await instance.start();
  } catch (error) {
    throw formatEmbeddedPostgresError(error, {
      fallbackMessage: `Failed to start embedded PostgreSQL on port ${selectedPort}`,
      recentLogs: logBuffer.getRecentLogs(),
    });
  }

  const rotated = await rotateEmbeddedPostgresAuthIfNeeded({
    dataDir,
    port: selectedPort,
    currentPassword: startupPasswordResolution.password,
  });
  const adminConnectionString = buildEmbeddedPostgresConnectionString({
    port: selectedPort,
    database: "postgres",
    password: rotated.password,
  });
  await ensurePostgresDatabase(adminConnectionString, "paperclip");

  return {
    mode: "embedded-postgres",
    connectionString: buildEmbeddedPostgresConnectionString({
      port: selectedPort,
      database: "paperclip",
      password: rotated.password,
    }),
    source: `embedded-postgres@${selectedPort}`,
    stop: async () => {
      await instance.stop();
    },
  };
}

export async function resolveMigrationConnection(): Promise<MigrationConnection> {
  const target = resolveDatabaseTarget();
  if (target.mode === "postgres") {
    return {
      mode: "postgres",
      connectionString: target.connectionString,
      source: target.source,
      stop: async () => {},
    };
  }
  return ensureEmbeddedPostgresConnection(target.dataDir, target.port);
}
