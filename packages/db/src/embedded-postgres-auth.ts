import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import postgres from "postgres";

export const EMBEDDED_POSTGRES_USER = "paperclip";
// Host used by the connection-string builder when no unix-socket directory is
// supplied. Today every embedded consumer passes a socketDir and the loopback
// TCP path is never used in production — the TCP listener is killed by the
// `listen_addresses=""` flag in `buildEmbeddedPostgresConstructorOptions`. The
// fallback exists so unit tests of the URL builder can construct a TCP-shaped
// string without spinning up a real cluster.
export const EMBEDDED_POSTGRES_HOST = "127.0.0.1";
export const LEGACY_EMBEDDED_POSTGRES_PASSWORD = "paperclip";

const PASSWORD_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PASSWORD_LENGTH = 32;
const CREDENTIAL_FILE_SUFFIX = ".pg-credential";
// Sibling directory of the data dir that holds the unix-domain socket. The
// cred file already uses the `<dataDir>.pg-credential` sibling pattern; the
// socket dir mirrors it. Sibling rather than inside the data dir because
// Postgres requires 0700 ownership of the data dir itself and we do not want
// to widen or complicate that contract.
export const SOCKET_DIRECTORY_SUFFIX = ".socket";
// Directory mode: only the data-dir owner may traverse or connect. The socket
// file inside is also tightened via `unix_socket_permissions=0700` so the
// cluster cannot accidentally inherit the libpq default `0777`.
const SOCKET_DIRECTORY_MODE = 0o700;

export type EmbeddedPostgresDatabase = "postgres" | "paperclip";

export type EmbeddedPostgresAuthMethod = "scram-sha-256";

export const EMBEDDED_POSTGRES_AUTH_METHOD: EmbeddedPostgresAuthMethod =
  "scram-sha-256";

export function generateEmbeddedPostgresPassword(): string {
  const alphabet = PASSWORD_ALPHABET;
  const alphabetLength = alphabet.length;
  const max = 256 - (256 % alphabetLength);
  const out: string[] = [];
  while (out.length < PASSWORD_LENGTH) {
    const bytes = randomBytes(PASSWORD_LENGTH - out.length + 8);
    for (let i = 0; i < bytes.length && out.length < PASSWORD_LENGTH; i += 1) {
      const byte = bytes[i];
      if (byte >= max) continue;
      out.push(alphabet[byte % alphabetLength]);
    }
  }
  return out.join("");
}

export function credentialFilePathFor(dataDir: string): string {
  return `${dataDir.replace(/\/+$/, "")}${CREDENTIAL_FILE_SUFFIX}`;
}

export function socketDirectoryPathFor(dataDir: string): string {
  return `${dataDir.replace(/\/+$/, "")}${SOCKET_DIRECTORY_SUFFIX}`;
}

// Idempotent: create the socket directory beside the data dir with mode 0700
// and assert the final mode. Mirrors the cred-file mode check so a future
// permissions drift is caught at startup rather than discovered by an
// attacker. Safe to call on every start.
export function ensureEmbeddedPostgresSocketDir(dataDir: string): string {
  const socketDir = socketDirectoryPathFor(dataDir);
  if (!existsSync(socketDir)) {
    mkdirSync(socketDir, { recursive: true, mode: SOCKET_DIRECTORY_MODE });
    // mkdir's mode is masked by umask; force the final mode on the freshly
    // created dir so the assertion below cannot fail on a future start.
    try {
      chmodSync(socketDir, SOCKET_DIRECTORY_MODE);
    } catch {
      // best effort; the strict mode check below refuses insecure dirs.
    }
  }
  const stat = statSync(socketDir);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `Embedded PostgreSQL socket directory at ${socketDir} has insecure mode ` +
        `${(stat.mode & 0o777).toString(8)}: must be 0700 ` +
        `(no group or world access). Refusing to start.`,
    );
  }
  return socketDir;
}

export type EmbeddedPostgresCredential = { password: string };

export function readEmbeddedPostgresCredential(
  dataDir: string,
): EmbeddedPostgresCredential | null {
  const credPath = credentialFilePathFor(dataDir);
  if (!existsSync(credPath)) return null;
  const stat = statSync(credPath);
  // Mode check: only owner may read or write. Refuse group/world bits.
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `Embedded PostgreSQL credential file at ${credPath} has insecure mode ` +
        `${(stat.mode & 0o777).toString(8)}: must be 0600 ` +
        `(no group or world access). Refusing to start.`,
    );
  }
  const contents = readFileSync(credPath, "utf8");
  const password = contents.trim();
  if (!password) {
    throw new Error(
      `Embedded PostgreSQL credential file at ${credPath} is empty. ` +
        "Remove it so a fresh password can be generated, or restore it from backup.",
    );
  }
  return { password };
}

export function writeEmbeddedPostgresCredential(
  dataDir: string,
  password: string,
): string {
  const credPath = credentialFilePathFor(dataDir);
  writeFileSync(credPath, `${password}\n`, { encoding: "utf8", mode: 0o600 });
  // The mode option on writeFileSync is subject to umask. Force the final mode
  // explicitly so the read-back assertion cannot fail on a future start.
  try {
    chmodSync(credPath, 0o600);
  } catch {
    // best effort; the strict mode check on read will refuse insecure files.
  }
  return credPath;
}

export type BuildEmbeddedPostgresConnectionStringInput = {
  port: number;
  database: EmbeddedPostgresDatabase;
  password: string;
  host?: string;
  user?: string;
  // Unix-socket directory the cluster is bound to. When set, the builder
  // appends the `?paperclip_socket=<dir>` sentinel so the URL can carry the
  // socket path across boundaries that only accept a connection string (e.g.
  // createDb / applyPendingMigrations). Decode with
  // `resolveEmbeddedPostgresConnection` immediately before `postgres()`.
  socketDir?: string;
};

// Query-param name carrying the unix-socket directory across URL boundaries.
// postgres-js has no URL form for unix sockets — its URL parser keeps `host`
// as the encoded hostname, which never contains a literal `/`, so the
// in-library path detection never triggers from the URL alone. We smuggle the
// socket dir as this sentinel param and strip it (returning a `{ host }`
// options override) at every `postgres()` call site via
// `resolveEmbeddedPostgresConnection`. The param MUST be stripped before the
// URL reaches postgres-js: an unknown query param is forwarded as a server
// startup parameter and would fail the connection.
export const SOCKET_DIR_QUERY_PARAM = "paperclip_socket";

// Build a libpq/postgres-js URL. The base is always TCP-shaped (host:port).
// When `socketDir` is supplied, the `?paperclip_socket=` sentinel is appended
// so the socket path rides along inside the URL; the loopback host/port stay
// present so `new URL()`-based guards and postgres-js port resolution (for the
// `.s.PGSQL.<port>` socket filename) still work. Pass the result through
// `resolveEmbeddedPostgresConnection` right before `postgres()` to strip the
// sentinel and obtain the `{ host: socketDir }` options override that makes
// postgres-js connect via the unix socket instead of TCP.
export function buildEmbeddedPostgresConnectionString(
  input: BuildEmbeddedPostgresConnectionStringInput,
): string {
  const user = input.user ?? EMBEDDED_POSTGRES_USER;
  // Password is generated from an alphanumeric alphabet, so URL-encoding is a
  // no-op today. We still encode so a future alphabet change cannot break the
  // URL shape.
  const encodedPassword = encodeURIComponent(input.password);
  const host = input.host ?? EMBEDDED_POSTGRES_HOST;
  const base = `postgres://${user}:${encodedPassword}@${host}:${input.port}/${input.database}`;
  if (!input.socketDir) return base;
  return `${base}?${SOCKET_DIR_QUERY_PARAM}=${encodeURIComponent(input.socketDir)}`;
}

export type ResolvedEmbeddedPostgresConnection = {
  // The connection string with the `?paperclip_socket=` sentinel removed —
  // safe to hand to postgres-js.
  connectionString: string;
  // Spread into the postgres-js options object. `{ host: socketDir }` when the
  // sentinel was present (routes over the unix socket); empty otherwise.
  sqlOptions: { host: string } | Record<string, never>;
};

// Strip the `?paperclip_socket=` sentinel from a connection string and return
// the cleaned URL plus the postgres-js options override that routes the
// connection over the unix socket. Call this at every `postgres()` boundary
// that receives a bare connection string. It is a no-op fast path for external
// postgres URLs and TCP-shaped embedded URLs (no sentinel present), so it is
// safe to funnel every connection string through it unconditionally.
export function resolveEmbeddedPostgresConnection(
  connectionString: string,
): ResolvedEmbeddedPostgresConnection {
  // Cheap substring guard avoids constructing a URL for the common (external /
  // TCP) case where no sentinel is present.
  if (!connectionString.includes(`${SOCKET_DIR_QUERY_PARAM}=`)) {
    return { connectionString, sqlOptions: {} };
  }
  const url = new URL(connectionString);
  const socketDir = url.searchParams.get(SOCKET_DIR_QUERY_PARAM);
  if (!socketDir) {
    return { connectionString, sqlOptions: {} };
  }
  url.searchParams.delete(SOCKET_DIR_QUERY_PARAM);
  return { connectionString: url.toString(), sqlOptions: { host: socketDir } };
}

// postgres-js accepts `host` as a unix socket directory when the value
// contains a `/` — its internal path builder then constructs
// `<host>/.s.PGSQL.<port>` and connects via `socket.connect(path)`. Return
// the override shape so callers that already hold a socket dir can pass it
// alongside a TCP-shaped URL without minting a sentinel. `undefined` for TCP
// callers (no override needed). `resolveEmbeddedPostgresConnection` is the
// preferred path when the socket dir travels inside the URL; this exists for
// call sites that hold the socket dir directly.
export function embeddedPostgresSqlOptions(
  socketDir: string | undefined,
): { host: string } | undefined {
  if (!socketDir) return undefined;
  return { host: socketDir };
}

export type EmbeddedPostgresConstructorOptions = {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  authMethod: EmbeddedPostgresAuthMethod;
  initdbFlags: string[];
  postgresFlags: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
};

export type BuildEmbeddedPostgresConstructorOptionsInput = {
  dataDir: string;
  port: number;
  password: string;
  initdbFlags?: string[];
  // Value for `listen_addresses`. Defaults to "" — the production posture that
  // kills the TCP listener entirely (the socket-only hardening posture). The embedded
  // test harness overrides this to "127.0.0.1" so its broad DB test suite can
  // connect over loopback TCP without threading unix-socket options through
  // every `postgres()` call site; the killed-TCP + socket-only posture is
  // exercised directly by embedded-postgres-auth.test.ts (with a TCP-refused
  // negative control). Production callers never pass this.
  listenAddresses?: string;
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
};

export function buildEmbeddedPostgresConstructorOptions(
  input: BuildEmbeddedPostgresConstructorOptionsInput,
): EmbeddedPostgresConstructorOptions {
  // Ensure the socket directory exists with mode 0700 before postgres tries
  // to bind into it. Idempotent and cheap; safe to call on every start.
  const socketDir = ensureEmbeddedPostgresSocketDir(input.dataDir);
  return {
    databaseDir: input.dataDir,
    user: EMBEDDED_POSTGRES_USER,
    password: input.password,
    port: input.port,
    persistent: true,
    authMethod: EMBEDDED_POSTGRES_AUTH_METHOD,
    initdbFlags: input.initdbFlags ?? [
      "--encoding=UTF8",
      "--locale=C",
      "--lc-messages=C",
    ],
    // Kill the TCP listener entirely (listen_addresses=""), move the unix
    // socket off /tmp into our 0700 sibling directory, and tighten the socket
    // file mode. The pg_hba.conf host lines stay scram-sha-256 so flipping
    // TCP back on is a one-line config change rather than a coordinated dance.
    postgresFlags: [
      "-c",
      `listen_addresses=${input.listenAddresses ?? ""}`,
      "-c",
      `unix_socket_directories=${socketDir}`,
      "-c",
      "unix_socket_permissions=0700",
    ],
    onLog: input.onLog,
    onError: input.onError,
  };
}

export type ResolvedEmbeddedPostgresPassword = {
  password: string;
  source: "cred-file" | "legacy-fallback" | "generated";
};

export function resolveEmbeddedPostgresPasswordForStartup(
  dataDir: string,
): ResolvedEmbeddedPostgresPassword {
  const existing = readEmbeddedPostgresCredential(dataDir);
  if (existing) {
    return { password: existing.password, source: "cred-file" };
  }
  const clusterAlreadyInitialized = existsSync(
    path.resolve(dataDir, "PG_VERSION"),
  );
  if (clusterAlreadyInitialized) {
    // Legacy data dir initialised before per-install passwords shipped. The
    // role password is still the cleartext "paperclip" literal. We start with
    // that so we can connect to rotate; rotation happens once the cluster is
    // up (see rotateEmbeddedPostgresAuthIfNeeded).
    return { password: LEGACY_EMBEDDED_POSTGRES_PASSWORD, source: "legacy-fallback" };
  }
  // Fresh initdb: generate the password now and persist it BEFORE initdb runs
  // so a crash between generation and persistence cannot leave the cluster
  // with an unknown password.
  const generated = generateEmbeddedPostgresPassword();
  writeEmbeddedPostgresCredential(dataDir, generated);
  return { password: generated, source: "generated" };
}

// pg_hba.conf: six lines all using scram-sha-256. The library's initdb flag
// `--auth=scram-sha-256` writes this shape for fresh clusters; this builder is
// the source of truth for legacy clusters that need their pg_hba rewritten.
const PG_HBA_SCRAM_LINES: readonly string[] = [
  "# TYPE  DATABASE        USER            ADDRESS                 METHOD",
  "local   all             all                                     scram-sha-256",
  "host    all             all             127.0.0.1/32            scram-sha-256",
  "host    all             all             ::1/128                 scram-sha-256",
  "hostssl all             all             127.0.0.1/32            scram-sha-256",
  "hostssl all             all             ::1/128                 scram-sha-256",
];

export function buildScramSha256PgHba(): string {
  return `${PG_HBA_SCRAM_LINES.join("\n")}\n`;
}

export type RewritePgHbaResult = {
  changed: boolean;
  backupPath: string | null;
};

export function rewritePgHbaToScram(dataDir: string): RewritePgHbaResult {
  const pgHbaPath = path.resolve(dataDir, "pg_hba.conf");
  if (!existsSync(pgHbaPath)) {
    return { changed: false, backupPath: null };
  }
  const current = readFileSync(pgHbaPath, "utf8");
  const next = buildScramSha256PgHba();
  if (current === next) {
    return { changed: false, backupPath: null };
  }
  const backupPath = `${pgHbaPath}.legacy.bak`;
  writeFileSync(backupPath, current, { encoding: "utf8" });
  writeFileSync(pgHbaPath, next, { encoding: "utf8", mode: 0o600 });
  return { changed: true, backupPath };
}

// Returns true if every non-comment, non-empty line of pg_hba.conf uses
// scram-sha-256. Used by tests; not for production control flow.
export function isPgHbaScramOnly(dataDir: string): boolean {
  const pgHbaPath = path.resolve(dataDir, "pg_hba.conf");
  if (!existsSync(pgHbaPath)) return false;
  const contents = readFileSync(pgHbaPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    if (!/scram-sha-256\b/.test(line)) return false;
  }
  return true;
}

export type RotateEmbeddedPostgresAuthInput = {
  dataDir: string;
  port: number;
  // The password currently configured on the role (legacy fallback or a
  // previously-generated value that was never persisted to the cred file).
  currentPassword: string;
  // Optional logger so callers can surface rotation events in their own
  // startup transcript.
  onEvent?: (event: RotateEmbeddedPostgresAuthEvent) => void;
};

export type RotateEmbeddedPostgresAuthEvent =
  | { kind: "no-op"; reason: string }
  | { kind: "rotate"; reason: string }
  | { kind: "pg-hba-rewrite"; backupPath: string | null }
  | { kind: "reload" };

export type RotateEmbeddedPostgresAuthResult = {
  rotated: boolean;
  pgHbaRewritten: boolean;
  pgHbaBackupPath: string | null;
  // The password that is now authoritative for this cluster. Callers must use
  // this for any connection they open after rotation. Equals currentPassword
  // when no rotation was needed.
  password: string;
};

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// Idempotent post-start rotation. Three states converge on every server start:
//   (a) cred file already matches the running password: no-op
//   (b) cred file missing, role still using legacy password:
//       ALTER ROLE paperclip PASSWORD <generated>; persist cred file
//   (c) cred file exists but role password differs from it (mid-flight from
//       a previous failed rotation): treat as (b) — the cred file wins because
//       nothing else has it
//
// After the password converges, rewrite pg_hba.conf to scram-sha-256 (idempotent
// — no-op if already scram) and reload Postgres so the change takes effect.
//
// Ordering: ALTER ROLE first (so a scram verifier exists), THEN rewrite pg_hba.
// Reversing that locks the instance out — cleartext clients get rejected by
// scram-only pg_hba before the new verifier has been written.
export async function rotateEmbeddedPostgresAuthIfNeeded(
  input: RotateEmbeddedPostgresAuthInput,
): Promise<RotateEmbeddedPostgresAuthResult> {
  const existing = readEmbeddedPostgresCredential(input.dataDir);
  if (existing && existing.password === input.currentPassword) {
    input.onEvent?.({ kind: "no-op", reason: "cred file matches running password" });
    const rewrite = rewritePgHbaToScram(input.dataDir);
    input.onEvent?.({
      kind: "pg-hba-rewrite",
      backupPath: rewrite.backupPath,
    });
    if (rewrite.changed) {
      await reloadEmbeddedPostgres(input.dataDir, input.port, existing.password);
      input.onEvent?.({ kind: "reload" });
    }
    return {
      rotated: false,
      pgHbaRewritten: rewrite.changed,
      pgHbaBackupPath: rewrite.backupPath,
      password: existing.password,
    };
  }

  const reason = existing
    ? "cred file present but does not match running password"
    : "cred file missing; rotating from legacy password";
  input.onEvent?.({ kind: "rotate", reason });

  // 1. Connect with the password the cluster currently knows. For a true
  //    legacy dir that is the cleartext literal; for a mid-flight restart it
  //    is the password currently on the role.
  const resolved = resolveEmbeddedPostgresConnection(
    buildEmbeddedPostgresConnectionString({
      port: input.port,
      database: "postgres",
      password: input.currentPassword,
      socketDir: socketDirectoryPathFor(input.dataDir),
    }),
  );
  const admin = postgres(resolved.connectionString, {
    max: 1,
    onnotice: () => {},
    ...resolved.sqlOptions,
  });

  let newPassword: string;
  try {
    // 2. Decide the target password. If a cred file already exists, reuse it —
    //    a previous run persisted it before the role update landed.
    const target =
      existing?.password ?? generateEmbeddedPostgresPassword();
    // Role name is a fixed constant, so it can be a literal quoted identifier
    // in the SQL. The password is parameter-bound (postgres-js auto-binding).
    await admin.unsafe(
      `ALTER ROLE "${EMBEDDED_POSTGRES_USER}" WITH PASSWORD ${quoteSqlLiteral(target)}`,
    );
    newPassword = target;
  } finally {
    await admin.end({ timeout: 5 }).catch(() => undefined);
  }

  // 3. Persist the cred file BEFORE we touch pg_hba, so a crash here leaves
  //    the cluster in a recoverable state (cred file matches the role).
  writeEmbeddedPostgresCredential(input.dataDir, newPassword);

  // 4. Rewrite pg_hba to scram-sha-256 (idempotent). Safe now: a scram
  //    verifier exists for the new password.
  const rewrite = rewritePgHbaToScram(input.dataDir);
  input.onEvent?.({
    kind: "pg-hba-rewrite",
    backupPath: rewrite.backupPath,
  });

  // 5. Reload Postgres so pg_hba takes effect.
  if (rewrite.changed) {
    await reloadEmbeddedPostgres(input.dataDir, input.port, newPassword);
    input.onEvent?.({ kind: "reload" });
  }

  return {
    rotated: true,
    pgHbaRewritten: rewrite.changed,
    pgHbaBackupPath: rewrite.backupPath,
    password: newPassword,
  };
}

async function reloadEmbeddedPostgres(
  dataDir: string,
  port: number,
  password: string,
): Promise<void> {
  const resolved = resolveEmbeddedPostgresConnection(
    buildEmbeddedPostgresConnectionString({
      port,
      database: "postgres",
      password,
      socketDir: socketDirectoryPathFor(dataDir),
    }),
  );
  const conn = postgres(resolved.connectionString, {
    max: 1,
    onnotice: () => {},
    ...resolved.sqlOptions,
  });
  try {
    await conn`SELECT pg_reload_conf()`;
  } finally {
    await conn.end({ timeout: 5 }).catch(() => undefined);
  }
}

// Best-effort scrubber for connection strings that may appear in error
// messages or logs. Replaces the password portion of any
// `postgres://user:password@host` URL with the literal `[redacted]`.
const POSTGRES_URL_PASSWORD_RE =
  /(postgres(?:ql)?:\/\/[A-Za-z0-9._~%-]*):[A-Za-z0-9._~%-]+@/g;

export function scrubEmbeddedPostgresConnectionString(input: string): string {
  return input.replace(POSTGRES_URL_PASSWORD_RE, "$1:[redacted]@");
}

// Read the socket directory a running cluster is bound to. Postgres writes
// postmaster.pid in this shape (1-indexed):
//   line 1: pid
//   line 2: data dir
//   line 3: nanosecond startup time
//   line 4: port number (-p value)
//   line 5: socket dir(s) — comma-separated unix_socket_directories
//   line 6: listen_addresses
//   line 7: shmem key
// After this change, line 5 is our `<dataDir>.socket` directory. Legacy
// clusters have `/tmp` there (the postgres default).
export function readPidFileSocketDir(postmasterPidFile: string): string | null {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const lines = readFileSync(postmasterPidFile, "utf8").split("\n");
    const raw = lines[4]?.trim();
    if (!raw) return null;
    // unix_socket_directories is comma-separated; we always pass exactly one
    // entry, but tolerate a list by returning the first.
    return raw.split(",")[0]!.trim() || null;
  } catch {
    return null;
  }
}

// Resolve the bundled `pg_ctl` binary path. The embedded-postgres library
// resolves binaries via the platform-specific `@embedded-postgres/<platform>`
// package; we resolve the same way so we can shell out to `pg_ctl stop` for
// warm-restart migration (the library's own `.stop()` only works for clusters
// the same JS instance started; a foreign running cluster needs pg_ctl).
//
// The platform package is plain ESM with named exports `pg_ctl`, `initdb`,
// `postgres`, so we use dynamic import to match the library's own loading path.
async function resolvePgCtlBinary(): Promise<string | null> {
  const platformPackage =
    process.platform === "linux"
      ? process.arch === "arm64"
        ? "@embedded-postgres/linux-arm64"
        : "@embedded-postgres/linux-x64"
      : process.platform === "darwin"
        ? process.arch === "arm64"
          ? "@embedded-postgres/darwin-arm64"
          : "@embedded-postgres/darwin-x64"
        : null;
  if (!platformPackage) return null;
  try {
    const mod = (await import(platformPackage)) as {
      pg_ctl?: string;
    };
    return typeof mod.pg_ctl === "string" ? mod.pg_ctl : null;
  } catch {
    return null;
  }
}

// Stop a running embedded cluster that was started by a previous run.
// Required when a legacy cluster (socket at /tmp) is discovered on
// startup: postgres cannot move a live socket dir via SQL, so the only way
// to apply the new `unix_socket_directories` flag is a full stop+start. The
// data dir and cred file survive, so the cluster comes back with the same
// data, the same scram password, and the same pg_hba — only the listener
// shape moves.
//
// Tries the bundled `pg_ctl stop -m fast` first; falls back to SIGTERM if the
// binary cannot be resolved (e.g. unsupported platform). Returns true if a
// cluster was stopped, false if there was nothing running.
export async function stopRunningEmbeddedPostgres(
  dataDir: string,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const postmasterPidFile = path.resolve(dataDir, "postmaster.pid");
  let pid: number | null = null;
  try {
    const raw = readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim();
    pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
  } catch {
    // Pid file missing, malformed, or process already gone. Clean up a stale
    // pid file if it lingers.
    try {
      rmSync(postmasterPidFile, { force: true });
    } catch {
      // best effort
    }
    return false;
  }

  const pgCtl = await resolvePgCtlBinary();
  if (pgCtl) {
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(
          pgCtl,
          ["stop", "-D", dataDir, "-m", "fast", "-w", "-t", "30"],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stderr = "";
        proc.stderr?.on("data", (chunk) => {
          stderr += chunk.toString("utf8");
        });
        proc.on("error", reject);
        proc.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`pg_ctl stop exited ${code}: ${stderr.trim()}`));
        });
      });
    } catch {
      // Fall through to SIGTERM; the pid-alive wait below is the source of truth.
    }
  }

  if (pid != null) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone — fine
    }
  }

  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (pid != null && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      break;
    }
  }

  try {
    rmSync(postmasterPidFile, { force: true });
  } catch {
    // best effort
  }
  return true;
}

// Detect a legacy cluster (socket dir on postmaster.pid line 5 differs
// from our expected `<dataDir>.socket`) and stop it so the caller can start
// fresh with new flags. No-op when the running cluster already uses our
// socket dir, or when no cluster is running. Idempotent: callers can invoke
// it on every startup without checking first.
export async function migrateLegacyEmbeddedPostgresSocket(
  dataDir: string,
): Promise<{ stoppedLegacyCluster: boolean; legacySocketDir: string | null }> {
  const postmasterPidFile = path.resolve(dataDir, "postmaster.pid");
  const expectedSocketDir = socketDirectoryPathFor(dataDir);
  const currentSocketDir = readPidFileSocketDir(postmasterPidFile);
  if (!currentSocketDir || currentSocketDir === expectedSocketDir) {
    return { stoppedLegacyCluster: false, legacySocketDir: currentSocketDir };
  }
  await stopRunningEmbeddedPostgres(dataDir);
  return { stoppedLegacyCluster: true, legacySocketDir: currentSocketDir };
}
