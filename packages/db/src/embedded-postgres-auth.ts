import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import postgres from "postgres";

export const EMBEDDED_POSTGRES_USER = "paperclip";
export const EMBEDDED_POSTGRES_HOST = "127.0.0.1";
export const LEGACY_EMBEDDED_POSTGRES_PASSWORD = "paperclip";

const PASSWORD_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PASSWORD_LENGTH = 32;
const CREDENTIAL_FILE_SUFFIX = ".pg-credential";

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
};

export function buildEmbeddedPostgresConnectionString(
  input: BuildEmbeddedPostgresConnectionStringInput,
): string {
  const host = input.host ?? EMBEDDED_POSTGRES_HOST;
  const user = input.user ?? EMBEDDED_POSTGRES_USER;
  // Password is generated from an alphanumeric alphabet, so URL-encoding is a
  // no-op today. We still encode so a future alphabet change cannot break the
  // URL shape.
  const encodedPassword = encodeURIComponent(input.password);
  return `postgres://${user}:${encodedPassword}@${host}:${input.port}/${input.database}`;
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
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
};

export function buildEmbeddedPostgresConstructorOptions(
  input: BuildEmbeddedPostgresConstructorOptionsInput,
): EmbeddedPostgresConstructorOptions {
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
    // Explicit loopback bind so a library upgrade cannot silently widen it.
    postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
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
      await reloadEmbeddedPostgres(input.port, existing.password);
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
  const admin = postgres(
    buildEmbeddedPostgresConnectionString({
      port: input.port,
      database: "postgres",
      password: input.currentPassword,
    }),
    { max: 1, onnotice: () => {} },
  );

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
    await reloadEmbeddedPostgres(input.port, newPassword);
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
  port: number,
  password: string,
): Promise<void> {
  const conn = postgres(
    buildEmbeddedPostgresConnectionString({
      port,
      database: "postgres",
      password,
    }),
    { max: 1, onnotice: () => {} },
  );
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
