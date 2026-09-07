import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { ensurePostgresDatabase, getPostgresDataDirectory } from "./client.js";
import { createEmbeddedPostgresLogBuffer, formatEmbeddedPostgresError } from "./embedded-postgres-error.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";
import {
  buildEmbeddedPostgresConnectionString,
  buildEmbeddedPostgresConstructorOptions,
  migrateLegacyEmbeddedPostgresSocket,
  resolveEmbeddedPostgresPasswordForStartup,
  rotateEmbeddedPostgresAuthIfNeeded,
  socketDirectoryPathFor,
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
  // No TCP listener is bound (listen_addresses=""), so there is nothing for a
  // free-port probe to collide with. Each cluster lives in its own data dir
  // and its own sibling socket dir; the port is just the `.s.PGSQL.<port>`
  // filename suffix and a logical identifier for postmaster.pid.
  const selectedPort = preferredPort;
  const postmasterPidFile = path.resolve(dataDir, "postmaster.pid");
  const pgVersionFile = path.resolve(dataDir, "PG_VERSION");
  const socketDir = socketDirectoryPathFor(dataDir);
  // If a legacy cluster (socket on /tmp) is still running, postgres
  // cannot move its live socket via SQL — stop it now so the start path
  // below brings it back with the new socket dir + flags. No-op when the
  // running cluster already uses our socket dir, or when nothing is running.
  await migrateLegacyEmbeddedPostgresSocket(dataDir);
  const runningPid = readRunningPostmasterPid(postmasterPidFile);
  const runningPort = readPidFilePort(postmasterPidFile);
  const startupPasswordResolution = resolveEmbeddedPostgresPasswordForStartup(dataDir);
  const preferredAdminConnectionString = buildEmbeddedPostgresConnectionString({
    port: preferredPort,
    database: "postgres",
    password: startupPasswordResolution.password,
    socketDir,
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
        `Adopting an existing PostgreSQL instance on socket ${socketDir} (port ${preferredPort}) for embedded data dir ${dataDir} because postmaster.pid is missing.`,
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
          socketDir,
        }),
        source: `embedded-postgres@${socketDir}:${preferredPort}`,
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
      socketDir,
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
        socketDir,
      }),
      source: `embedded-postgres@${socketDir}:${port}`,
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
          `Failed to initialize embedded PostgreSQL cluster in ${dataDir} on socket ${socketDir} (port ${selectedPort})`,
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
      fallbackMessage: `Failed to start embedded PostgreSQL on socket ${socketDir} (port ${selectedPort})`,
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
    socketDir,
  });
  await ensurePostgresDatabase(adminConnectionString, "paperclip");

  return {
    mode: "embedded-postgres",
    connectionString: buildEmbeddedPostgresConnectionString({
      port: selectedPort,
      database: "paperclip",
      password: rotated.password,
      socketDir,
    }),
    source: `embedded-postgres@${socketDir}:${selectedPort}`,
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
