import { createHash } from "node:crypto";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { resolveEmbeddedPostgresConnection } from "./embedded-postgres-auth.js";
import { enableQueryCancellation } from "./query-cancellation.js";
import * as schema from "./schema/index.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));
const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";
const MIGRATIONS_JOURNAL_JSON = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));

function createUtilitySql(url: string) {
  const { connectionString, sqlOptions } = resolveEmbeddedPostgresConnection(url);
  return postgres(connectionString, { max: 1, onnotice: () => {}, ...sqlOptions });
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function quoteIdentifier(value: string): string {
  if (!isSafeIdentifier(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function splitMigrationStatements(content: string): string[] {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export type MigrationState =
  | { status: "upToDate"; tableCount: number; availableMigrations: string[]; appliedMigrations: string[] }
  | {
      status: "needsMigrations";
      tableCount: number;
      availableMigrations: string[];
      appliedMigrations: string[];
      pendingMigrations: string[];
      reason: "no-migration-journal-empty-db" | "no-migration-journal-non-empty-db" | "pending-migrations";
    };

export interface DatabaseClientOptions {
  /**
   * postgres.js `prepare`. Set false when connecting through a
   * transaction-mode pooler (pgbouncer / Neon `-pooler` endpoints /
   * Supabase Supavisor transaction ports) so the client does not rely on
   * session-scoped prepared statements. Defaults to the driver default
   * (enabled), preserving existing behavior on direct connections.
   */
  prepare?: boolean;
  /** postgres.js `max` — connection pool size (driver default: 10). */
  maxConnections?: number;
  /** postgres.js `idle_timeout` in seconds (driver default: disabled). */
  idleTimeoutSeconds?: number;
  /** postgres.js `connect_timeout` in seconds (driver default: 30). */
  connectTimeoutSeconds?: number;
}

function envBoolean(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be "true" or "false", got: ${env[name]}`);
}

function envPositiveInteger(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = env[name]?.trim();
  if (value === undefined || value === "") return undefined;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer, got: ${env[name]}`);
  }
  return Number.parseInt(value, 10);
}

/**
 * Database client tuning from the environment, so hosted deployments can
 * adapt to their connection topology (pooled endpoints, network latency)
 * without editing source. Every variable is optional; when unset the
 * driver defaults apply and behavior is identical to a bare
 * `postgres(url)` — self-hosted setups need none of these.
 */
export function databaseClientOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseClientOptions {
  const options: DatabaseClientOptions = {};
  const prepare = envBoolean(env, "DATABASE_PREPARED_STATEMENTS");
  if (prepare !== undefined) options.prepare = prepare;
  const maxConnections = envPositiveInteger(env, "DATABASE_POOL_MAX");
  if (maxConnections !== undefined) options.maxConnections = maxConnections;
  const idleTimeoutSeconds = envPositiveInteger(env, "DATABASE_IDLE_TIMEOUT_SECONDS");
  if (idleTimeoutSeconds !== undefined) options.idleTimeoutSeconds = idleTimeoutSeconds;
  const connectTimeoutSeconds = envPositiveInteger(env, "DATABASE_CONNECT_TIMEOUT_SECONDS");
  if (connectTimeoutSeconds !== undefined) options.connectTimeoutSeconds = connectTimeoutSeconds;
  return options;
}

export function postgresJsOptions(options: DatabaseClientOptions): Record<string, unknown> {
  const driverOptions: Record<string, unknown> = {};
  if (options.prepare !== undefined) driverOptions.prepare = options.prepare;
  if (options.maxConnections !== undefined) driverOptions.max = options.maxConnections;
  if (options.idleTimeoutSeconds !== undefined) driverOptions.idle_timeout = options.idleTimeoutSeconds;
  if (options.connectTimeoutSeconds !== undefined) driverOptions.connect_timeout = options.connectTimeoutSeconds;
  return driverOptions;
}

export const DEFAULT_DB_POOL_MAX = 20;
export const DEFAULT_DB_STATEMENT_TIMEOUT_MS = 60_000;

function readIntEnv(name: string, fallback: number, { min }: { min: number }): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  return parsed;
}

export function resolveDbPoolOptions(): { max: number; statementTimeoutMs: number } {
  return {
    max: readIntEnv("PAPERCLIP_DB_POOL_MAX", DEFAULT_DB_POOL_MAX, { min: 1 }),
    // 0 disables the timeout, matching Postgres' own statement_timeout semantics.
    statementTimeoutMs: readIntEnv(
      "PAPERCLIP_DB_STATEMENT_TIMEOUT_MS",
      DEFAULT_DB_STATEMENT_TIMEOUT_MS,
      { min: 0 },
    ),
  };
}

export function createDb(url: string, options?: DatabaseClientOptions) {
  const resolved = options ?? databaseClientOptionsFromEnv();
  // Pool-size precedence (fork adaptation over upstream 824.1): explicit
  // options win, then the upstream DATABASE_POOL_MAX variable, then the fork's
  // PAPERCLIP_DB_POOL_MAX, then the fork default. Upstream's options refactor
  // stopped feeding resolveDbPoolOptions().max to the driver, which silently
  // retired PAPERCLIP_DB_POOL_MAX and shrank the default pool from
  // DEFAULT_DB_POOL_MAX to the driver default — restored here so existing
  // deployments keep their configured sizing.
  const maxConnections = resolved.maxConnections
    ?? envPositiveInteger(process.env, "DATABASE_POOL_MAX")
    ?? resolveDbPoolOptions().max;
  const { statementTimeoutMs } = resolveDbPoolOptions();
  const { connectionString, sqlOptions } = resolveEmbeddedPostgresConnection(url);
  const sql = postgres(connectionString, {
    ...postgresJsOptions({ ...resolved, maxConnections }),
    connection: { statement_timeout: statementTimeoutMs },
    ...sqlOptions,
  });
  // Queries issued inside a cancellation scope (see query-cancellation.ts) are
  // cancelled when that scope aborts, so an abandoned request stops holding its
  // pool connection instead of squatting it until statement_timeout.
  return drizzlePg(enableQueryCancellation(sql), { schema });
}

export async function getPostgresDataDirectory(url: string): Promise<string | null> {
  const sql = createUtilitySql(url);
  try {
    const rows = await sql<{ data_directory: string | null }[]>`
      SELECT current_setting('data_directory', true) AS data_directory
    `;
    const actual = rows[0]?.data_directory;
    return typeof actual === "string" && actual.length > 0 ? actual : null;
  } catch {
    return null;
  } finally {
    await sql.end();
  }
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_FOLDER, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

type MigrationJournalFile = {
  entries?: Array<{ idx?: number; tag?: string; when?: number }>;
};

type JournalMigrationEntry = {
  fileName: string;
  folderMillis: number;
  order: number;
};

async function listJournalMigrationEntries(): Promise<JournalMigrationEntry[]> {
  try {
    const raw = await readFile(MIGRATIONS_JOURNAL_JSON, "utf8");
    const parsed = JSON.parse(raw) as MigrationJournalFile;
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .map((entry, entryIndex) => {
        if (typeof entry?.tag !== "string") return null;
        if (typeof entry?.when !== "number" || !Number.isFinite(entry.when)) return null;
        const order = Number.isInteger(entry.idx) ? Number(entry.idx) : entryIndex;
        return { fileName: `${entry.tag}.sql`, folderMillis: entry.when, order };
      })
      .filter((entry): entry is JournalMigrationEntry => entry !== null);
  } catch {
    return [];
  }
}

async function listJournalMigrationFiles(): Promise<string[]> {
  const entries = await listJournalMigrationEntries();
  return entries.map((entry) => entry.fileName);
}

// Journal file names in the order migrations are applied, which is also the
// order rows are appended to __drizzle_migrations. Used to correlate a recorded
// row to its migration file by ordinal when the table has no `name` column.
async function listOrderedJournalMigrationFiles(): Promise<string[]> {
  const entries = await listJournalMigrationEntries();
  return [...entries]
    .sort((left, right) =>
      left.order === right.order
        ? left.fileName.localeCompare(right.fileName)
        : left.order - right.order,
    )
    .map((entry) => entry.fileName);
}

async function readMigrationFileContent(migrationFile: string): Promise<string> {
  return readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
}

async function orderMigrationsByJournal(migrationFiles: string[]): Promise<string[]> {
  const journalEntries = await listJournalMigrationEntries();
  const orderByFileName = new Map(journalEntries.map((entry) => [entry.fileName, entry.order]));
  return [...migrationFiles].sort((left, right) => {
    const leftOrder = orderByFileName.get(left);
    const rightOrder = orderByFileName.get(right);
    if (leftOrder === undefined && rightOrder === undefined) return left.localeCompare(right);
    if (leftOrder === undefined) return 1;
    if (rightOrder === undefined) return -1;
    if (leftOrder === rightOrder) return left.localeCompare(right);
    return leftOrder - rightOrder;
  });
}

type SqlExecutor = Pick<ReturnType<typeof postgres>, "unsafe">;

async function runInTransaction(sql: SqlExecutor, action: () => Promise<void>): Promise<void> {
  await sql.unsafe("BEGIN");
  try {
    await action();
    await sql.unsafe("COMMIT");
  } catch (error) {
    try {
      await sql.unsafe("ROLLBACK");
    } catch {
      // Ignore rollback failures and surface the original error.
    }
    throw error;
  }
}

async function latestMigrationCreatedAt(
  sql: SqlExecutor,
  qualifiedTable: string,
): Promise<number | null> {
  const rows = await sql.unsafe<{ created_at: string | number | null }[]>(
    `SELECT created_at FROM ${qualifiedTable} ORDER BY created_at DESC NULLS LAST LIMIT 1`,
  );
  const value = Number(rows[0]?.created_at ?? Number.NaN);
  return Number.isFinite(value) ? value : null;
}

function normalizeFolderMillis(value: number | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return Date.now();
}

async function ensureMigrationJournalTable(
  sql: ReturnType<typeof postgres>,
): Promise<{ migrationTableSchema: string; columnNames: Set<string> }> {
  let migrationTableSchema = await discoverMigrationTableSchema(sql);
  if (!migrationTableSchema) {
    const drizzleSchema = quoteIdentifier("drizzle");
    const migrationTable = quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE);
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${drizzleSchema}`);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${drizzleSchema}.${migrationTable} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    );
    migrationTableSchema = (await discoverMigrationTableSchema(sql)) ?? "drizzle";
  }

  const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);
  return { migrationTableSchema, columnNames };
}

async function migrationHistoryEntryExists(
  sql: SqlExecutor,
  qualifiedTable: string,
  columnNames: Set<string>,
  migrationFile: string,
  hash: string,
): Promise<boolean> {
  const predicates: string[] = [];
  if (columnNames.has("hash")) predicates.push(`hash = ${quoteLiteral(hash)}`);
  if (columnNames.has("name")) predicates.push(`name = ${quoteLiteral(migrationFile)}`);
  if (predicates.length === 0) return false;

  const rows = await sql.unsafe<{ one: number }[]>(
    `SELECT 1 AS one FROM ${qualifiedTable} WHERE ${predicates.join(" OR ")} LIMIT 1`,
  );
  return rows.length > 0;
}

async function recordMigrationHistoryEntry(
  sql: SqlExecutor,
  qualifiedTable: string,
  columnNames: Set<string>,
  migrationFile: string,
  hash: string,
  folderMillis: number,
): Promise<void> {
  const insertColumns: string[] = [];
  const insertValues: string[] = [];

  if (columnNames.has("hash")) {
    insertColumns.push(quoteIdentifier("hash"));
    insertValues.push(quoteLiteral(hash));
  }
  if (columnNames.has("name")) {
    insertColumns.push(quoteIdentifier("name"));
    insertValues.push(quoteLiteral(migrationFile));
  }
  if (columnNames.has("created_at")) {
    const latestCreatedAt = await latestMigrationCreatedAt(sql, qualifiedTable);
    const createdAt = latestCreatedAt === null
      ? normalizeFolderMillis(folderMillis)
      : Math.max(latestCreatedAt + 1, normalizeFolderMillis(folderMillis));
    insertColumns.push(quoteIdentifier("created_at"));
    insertValues.push(quoteLiteral(String(createdAt)));
  }

  if (insertColumns.length === 0) return;

  await sql.unsafe(
    `INSERT INTO ${qualifiedTable} (${insertColumns.join(", ")}) VALUES (${insertValues.join(", ")})`,
  );
}

const MIGRATION_AUDIT_TABLE = "migration_apply_audit";
const MIGRATION_IDENTITY_TABLE = "migration_file_identity";
const MIGRATION_IDENTITY_WATERMARK_TABLE = "migration_identity_watermark";

let cachedPackageVersion: string | null = null;

// The version recorded in the package that shipped these migration files. The
// defining feature of the incident this guards against was an *unchanged*
// version string, so the on-disk package.json version is the most trustworthy
// attribution available; an operator-supplied PAPERCLIP_VERSION is recorded
// separately (env_version_override) rather than trusted as the identity, since
// preferring it would make attribution spoofable via the environment.
async function resolvePackageMigrationVersion(): Promise<string> {
  if (cachedPackageVersion !== null) return cachedPackageVersion;
  try {
    const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedPackageVersion = typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    cachedPackageVersion = "unknown";
  }
  return cachedPackageVersion;
}

function migrationVersionEnvOverride(): string | null {
  const value = process.env.PAPERCLIP_VERSION?.trim();
  return value ? value : null;
}

// Binds a migration file name to the content hash it carried when first
// recorded as applied. Kept in a table separate from __drizzle_migrations and
// entirely out of the dedup path (migrationHistoryEntryExists) so it can never
// mask a legitimate re-apply, and so a scrubbed drizzle journal row cannot erase
// the identity we compare against. First write wins: a later swapped re-apply
// must not overwrite the original hash, or the drift would become invisible.
async function ensureMigrationIdentityTable(
  sql: SqlExecutor,
  migrationTableSchema: string,
): Promise<string> {
  const identityTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(MIGRATION_IDENTITY_TABLE)}`;
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS ${identityTable} (` +
      `name text PRIMARY KEY, ` +
      `hash text NOT NULL, ` +
      `first_recorded_at timestamptz NOT NULL DEFAULT now()` +
      `)`,
  );
  await ensureMigrationIdentityWatermark(sql, migrationTableSchema);
  return identityTable;
}

// The number of journal rows present at the instant identity tracking began on
// this cluster. Files below it were applied before any identity could be bound
// and are permanently unverifiable; files at or above it are expected to carry
// one. Frozen on first write, because the live `count(*)` shrinks when a journal
// row is deleted — which silently reclassifies the most recently applied files
// as "not yet applied" and hides a swap of exactly the file most likely to be
// swapped.
async function ensureMigrationIdentityWatermark(
  sql: SqlExecutor,
  migrationTableSchema: string,
): Promise<void> {
  const watermarkTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(MIGRATION_IDENTITY_WATERMARK_TABLE)}`;
  const journalTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS ${watermarkTable} (` +
      `singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), ` +
      `legacy_applied_count integer NOT NULL, ` +
      `recorded_at timestamptz NOT NULL DEFAULT now()` +
      `)`,
  );
  await sql.unsafe(
    `INSERT INTO ${watermarkTable} (singleton, legacy_applied_count) ` +
      `SELECT true, count(*)::int FROM ${journalTable} ` +
      `ON CONFLICT (singleton) DO NOTHING`,
  );
}

// Returns null when no watermark is recorded, i.e. identity tracking has not
// started (or the table was removed) and no pending file can be shown clean.
async function loadMigrationIdentityWatermark(
  sql: SqlExecutor,
  migrationTableSchema: string,
): Promise<number | null> {
  const watermarkTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(MIGRATION_IDENTITY_WATERMARK_TABLE)}`;
  try {
    const rows = await sql.unsafe<{ legacy_applied_count: number | null }[]>(
      `SELECT legacy_applied_count FROM ${watermarkTable} LIMIT 1`,
    );
    const value = rows[0]?.legacy_applied_count;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

async function recordMigrationFileIdentity(
  sql: SqlExecutor,
  identityTable: string,
  migrationFile: string,
  hash: string,
): Promise<void> {
  await sql.unsafe(
    `INSERT INTO ${identityTable} (name, hash) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
    [migrationFile, hash],
  );
}

// Recorded file identities as a name -> first-applied-hash map. Returns null
// (distinct from an empty map) when the identity table does not exist, i.e. the
// cluster predates identity tracking and drift cannot be attributed from it.
async function loadMigrationFileIdentities(
  sql: SqlExecutor,
  migrationTableSchema: string,
): Promise<Map<string, string> | null> {
  const identityTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(MIGRATION_IDENTITY_TABLE)}`;
  try {
    const rows = await sql.unsafe<{ name: string | null; hash: string | null }[]>(
      `SELECT name, hash FROM ${identityTable}`,
    );
    const identities = new Map<string, string>();
    for (const row of rows) {
      if (typeof row.name === "string" && typeof row.hash === "string") {
        identities.set(row.name, row.hash);
      }
    }
    return identities;
  } catch {
    return null;
  }
}

// Durable record of what a boot-time migration actually applied. Lives in the
// same schema as __drizzle_migrations (the drizzle bookkeeping schema, not the
// application `public` schema) so it never affects migration-state detection or
// the source-tree populated-cluster guard, both of which count `public` tables.
async function recordMigrationApplyAudit(
  sql: SqlExecutor,
  migrationTableSchema: string,
  appliedMigrations: Array<{ migrationFile: string; hash: string }>,
  source: string,
): Promise<void> {
  if (appliedMigrations.length === 0) return;
  const auditTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(MIGRATION_AUDIT_TABLE)}`;
  try {
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${auditTable} (` +
        `id SERIAL PRIMARY KEY, ` +
        `applied_at timestamptz NOT NULL DEFAULT now(), ` +
        `binary_version text NOT NULL, ` +
        `env_version_override text, ` +
        `migration_count integer NOT NULL, ` +
        `migrations jsonb NOT NULL, ` +
        `source text` +
        `)`,
    );
    const version = await resolvePackageMigrationVersion();
    const envOverride = migrationVersionEnvOverride();
    const migrationsPayload = appliedMigrations.map((entry) => ({
      file: entry.migrationFile,
      hash: entry.hash,
    }));
    // Parameter-bind the payload rather than concatenating it into the SQL text:
    // removes the injection class entirely instead of relying on the server's
    // standard_conforming_strings GUC staying at its default. Identifiers cannot
    // be bound, but they are validated by quoteIdentifier above. The payload is
    // passed as a JS array (not a pre-stringified string): postgres.js JSON-
    // encodes it into the jsonb column, whereas binding a string to `$n::jsonb`
    // would store a double-encoded jsonb *string* scalar instead of an array.
    await sql.unsafe(
      `INSERT INTO ${auditTable} ` +
        `(binary_version, env_version_override, migration_count, migrations, source) ` +
        `VALUES ($1, $2, $3, $4, $5)`,
      [version, envOverride, appliedMigrations.length, migrationsPayload, source],
    );
  } catch (error) {
    // Best-effort: the migrations themselves already committed, so a failure to
    // write the audit row must not crash a server that has otherwise migrated.
    // Surface it, though — a silently swallowed logging failure (e.g. a
    // permissions problem) would hide the very attribution gap the audit exists
    // to close.
    console.warn(
      `Failed to record migration apply audit (${appliedMigrations.length} migration(s), source=${source}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Records file identity and a durable audit row for migrations applied through
// drizzle's own bootstrap migrator on an empty database, which otherwise leaves
// no identity binding and no audit trail for the first-ever application of the
// full migration set. Only ever called after a fresh bootstrap, so the on-disk
// content is by definition the original — safe to record as the identity. Never
// call this against a populated legacy cluster, where the on-disk content may
// already be swapped and recording it would permanently mask the drift.
async function recordBootstrapMigrationProvenance(url: string, source: string): Promise<void> {
  const state = await inspectMigrations(url);
  const appliedFiles = state.appliedMigrations;
  if (appliedFiles.length === 0) return;

  const sql = createUtilitySql(url);
  try {
    const migrationTableSchema = await discoverMigrationTableSchema(sql);
    if (!migrationTableSchema) return;
    const identityTable = await ensureMigrationIdentityTable(sql, migrationTableSchema);
    const applied: Array<{ migrationFile: string; hash: string }> = [];
    for (const migrationFile of appliedFiles) {
      const hash = createHash("sha256")
        .update(await readMigrationFileContent(migrationFile))
        .digest("hex");
      await recordMigrationFileIdentity(sql, identityTable, migrationFile, hash);
      applied.push({ migrationFile, hash });
    }
    await recordMigrationApplyAudit(sql, migrationTableSchema, applied, source);
  } finally {
    await sql.end();
  }
}

async function applyPendingMigrationsManually(
  url: string,
  pendingMigrations: string[],
  source = "apply-pending-migrations",
): Promise<void> {
  if (pendingMigrations.length === 0) return;

  const orderedPendingMigrations = await orderMigrationsByJournal(pendingMigrations);
  const journalEntries = await listJournalMigrationEntries();
  const folderMillisByFileName = new Map(
    journalEntries.map((entry) => [entry.fileName, normalizeFolderMillis(entry.folderMillis)]),
  );

  const sql = createUtilitySql(url);
  const appliedMigrations: Array<{ migrationFile: string; hash: string }> = [];
  try {
    const { migrationTableSchema, columnNames } = await ensureMigrationJournalTable(sql);
    const qualifiedTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;
    const identityTable = await ensureMigrationIdentityTable(sql, migrationTableSchema);

    for (const migrationFile of orderedPendingMigrations) {
      const migrationContent = await readMigrationFileContent(migrationFile);
      const hash = createHash("sha256").update(migrationContent).digest("hex");
      const existingEntry = await migrationHistoryEntryExists(
        sql,
        qualifiedTable,
        columnNames,
        migrationFile,
        hash,
      );
      if (existingEntry) continue;

      await runInTransaction(sql, async () => {
        for (const statement of splitMigrationStatements(migrationContent)) {
          await sql.unsafe(statement);
        }

        await recordMigrationHistoryEntry(
          sql,
          qualifiedTable,
          columnNames,
          migrationFile,
          hash,
          folderMillisByFileName.get(migrationFile) ?? Date.now(),
        );

        // Same transaction as the journal entry: bind this file's name to the
        // content hash applied now, so a later out-of-band swap is detectable
        // even if the journal row is subsequently scrubbed.
        await recordMigrationFileIdentity(sql, identityTable, migrationFile, hash);
      });
      appliedMigrations.push({ migrationFile, hash });
    }

    await recordMigrationApplyAudit(sql, migrationTableSchema, appliedMigrations, source);
  } finally {
    await sql.end();
  }
}

async function mapHashesToMigrationFiles(migrationFiles: string[]): Promise<Map<string, string>> {
  const mapped = new Map<string, string>();

  await Promise.all(
    migrationFiles.map(async (migrationFile) => {
      const content = await readMigrationFileContent(migrationFile);
      const hash = createHash("sha256").update(content).digest("hex");
      mapped.set(hash, migrationFile);
    }),
  );

  return mapped;
}

async function getMigrationTableColumnNames(
  sql: ReturnType<typeof postgres>,
  migrationTableSchema: string,
): Promise<Set<string>> {
  const columns = await sql.unsafe<{ column_name: string }[]>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = ${quoteLiteral(migrationTableSchema)}
        AND table_name = ${quoteLiteral(DRIZZLE_MIGRATIONS_TABLE)}
    `,
  );
  return new Set(columns.map((column) => column.column_name));
}

async function tableExists(
  sql: ReturnType<typeof postgres>,
  tableName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function columnExists(
  sql: ReturnType<typeof postgres>,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
        AND column_name = ${columnName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function indexExists(
  sql: ReturnType<typeof postgres>,
  indexName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'i'
        AND c.relname = ${indexName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function constraintExists(
  sql: ReturnType<typeof postgres>,
  constraintName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public'
        AND c.conname = ${constraintName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function migrationStatementAlreadyApplied(
  sql: ReturnType<typeof postgres>,
  statement: string,
): Promise<boolean> {
  const normalized = statement.replace(/\s+/g, " ").trim();

  const createTableMatch = normalized.match(/^CREATE TABLE(?: IF NOT EXISTS)? "([^"]+)"/i);
  if (createTableMatch) {
    return tableExists(sql, createTableMatch[1]);
  }

  const addColumnMatch = normalized.match(
    /^ALTER TABLE "([^"]+)" ADD COLUMN(?: IF NOT EXISTS)? "([^"]+)"/i,
  );
  if (addColumnMatch) {
    return columnExists(sql, addColumnMatch[1], addColumnMatch[2]);
  }

  const createIndexMatch = normalized.match(/^CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? "([^"]+)"/i);
  if (createIndexMatch) {
    return indexExists(sql, createIndexMatch[1]);
  }

  const addConstraintMatch = normalized.match(/^ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)"/i);
  if (addConstraintMatch) {
    return constraintExists(sql, addConstraintMatch[2]);
  }

  // If we cannot reason about a statement safely, require manual migration.
  return false;
}

async function migrationContentAlreadyApplied(
  sql: ReturnType<typeof postgres>,
  migrationContent: string,
): Promise<boolean> {
  const statements = splitMigrationStatements(migrationContent);
  if (statements.length === 0) return false;

  for (const statement of statements) {
    const applied = await migrationStatementAlreadyApplied(sql, statement);
    if (!applied) return false;
  }

  return true;
}

async function loadAppliedMigrations(
  sql: ReturnType<typeof postgres>,
  migrationTableSchema: string,
  availableMigrations: string[],
): Promise<string[]> {
  const quotedSchema = quoteIdentifier(migrationTableSchema);
  const qualifiedTable = `${quotedSchema}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;
  const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);

  if (columnNames.has("name")) {
    const rows = await sql.unsafe<{ name: string }[]>(`SELECT name FROM ${qualifiedTable} ORDER BY id`);
    return rows.map((row) => row.name).filter((name): name is string => Boolean(name));
  }

  if (columnNames.has("hash")) {
    const rows = await sql.unsafe<{ hash: string }[]>(`SELECT hash FROM ${qualifiedTable} ORDER BY id`);
    const hashesToMigrationFiles = await mapHashesToMigrationFiles(availableMigrations);
    const appliedFromHashes = rows
      .map((row) => hashesToMigrationFiles.get(row.hash))
      .filter((name): name is string => Boolean(name));

    if (appliedFromHashes.length > 0) {
      // Best-effort: when all hashes resolve, this is authoritative.
      if (appliedFromHashes.length === rows.length) return appliedFromHashes;

      // Partial hash resolution can happen when files have changed; return what we can trust.
      return appliedFromHashes;
    }

    // Fallback only when hashes are unavailable/unresolved.
    if (columnNames.has("created_at")) {
      const journalEntries = await listJournalMigrationEntries();
      if (journalEntries.length > 0) {
        const lastDbRows = await sql.unsafe<{ created_at: string | number | null }[]>(
          `SELECT created_at FROM ${qualifiedTable} ORDER BY created_at DESC LIMIT 1`,
        );
        const lastCreatedAt = Number(lastDbRows[0]?.created_at ?? -1);
        if (Number.isFinite(lastCreatedAt) && lastCreatedAt >= 0) {
          return journalEntries
            .filter((entry) => availableMigrations.includes(entry.fileName))
            .filter((entry) => entry.folderMillis <= lastCreatedAt)
            .map((entry) => entry.fileName)
            .slice(0, rows.length);
        }
      }
    }
  }

  const rows = await sql.unsafe<{ id: number }[]>(`SELECT id FROM ${qualifiedTable} ORDER BY id`);
  const journalMigrationFiles = await listJournalMigrationFiles();
  const appliedFromIds = rows
    .map((row) => journalMigrationFiles[row.id - 1])
    .filter((name): name is string => Boolean(name));
  if (appliedFromIds.length > 0) return appliedFromIds;

  return availableMigrations.slice(0, Math.max(0, rows.length));
}

export type MigrationHistoryReconcileResult = {
  repairedMigrations: string[];
  remainingMigrations: string[];
};

export async function reconcilePendingMigrationHistory(
  url: string,
): Promise<MigrationHistoryReconcileResult> {
  const state = await inspectMigrations(url);
  if (state.status !== "needsMigrations" || state.reason !== "pending-migrations") {
    return { repairedMigrations: [], remainingMigrations: [] };
  }

  const sql = createUtilitySql(url);
  const repairedMigrations: string[] = [];

  try {
    const journalEntries = await listJournalMigrationEntries();
    const folderMillisByFile = new Map(journalEntries.map((entry) => [entry.fileName, entry.folderMillis]));
    const migrationTableSchema = await discoverMigrationTableSchema(sql);
    if (!migrationTableSchema) {
      return { repairedMigrations, remainingMigrations: state.pendingMigrations };
    }

    const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);
    const qualifiedTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;

    for (const migrationFile of state.pendingMigrations) {
      const migrationContent = await readMigrationFileContent(migrationFile);
      const alreadyApplied = await migrationContentAlreadyApplied(sql, migrationContent);
      if (!alreadyApplied) break;

      const hash = createHash("sha256").update(migrationContent).digest("hex");
      const folderMillis = folderMillisByFile.get(migrationFile) ?? Date.now();
      const existingByHash = columnNames.has("hash")
        ? await sql.unsafe<{ created_at: string | number | null }[]>(
            `SELECT created_at FROM ${qualifiedTable} WHERE hash = ${quoteLiteral(hash)} ORDER BY created_at DESC LIMIT 1`,
          )
        : [];
      const existingByName = columnNames.has("name")
        ? await sql.unsafe<{ created_at: string | number | null }[]>(
            `SELECT created_at FROM ${qualifiedTable} WHERE name = ${quoteLiteral(migrationFile)} ORDER BY created_at DESC LIMIT 1`,
          )
        : [];
      if (existingByHash.length > 0 || existingByName.length > 0) {
        if (columnNames.has("created_at")) {
          const existingHashCreatedAt = Number(existingByHash[0]?.created_at ?? -1);
          if (existingByHash.length > 0 && Number.isFinite(existingHashCreatedAt) && existingHashCreatedAt < folderMillis) {
            await sql.unsafe(
              `UPDATE ${qualifiedTable} SET created_at = ${quoteLiteral(String(folderMillis))} WHERE hash = ${quoteLiteral(hash)} AND created_at < ${quoteLiteral(String(folderMillis))}`,
            );
          }

          const existingNameCreatedAt = Number(existingByName[0]?.created_at ?? -1);
          if (existingByName.length > 0 && Number.isFinite(existingNameCreatedAt) && existingNameCreatedAt < folderMillis) {
            await sql.unsafe(
              `UPDATE ${qualifiedTable} SET created_at = ${quoteLiteral(String(folderMillis))} WHERE name = ${quoteLiteral(migrationFile)} AND created_at < ${quoteLiteral(String(folderMillis))}`,
            );
          }
        }

        repairedMigrations.push(migrationFile);
        continue;
      }

      const insertColumns: string[] = [];
      const insertValues: string[] = [];

      if (columnNames.has("hash")) {
        insertColumns.push(quoteIdentifier("hash"));
        insertValues.push(quoteLiteral(hash));
      }
      if (columnNames.has("name")) {
        insertColumns.push(quoteIdentifier("name"));
        insertValues.push(quoteLiteral(migrationFile));
      }
      if (columnNames.has("created_at")) {
        insertColumns.push(quoteIdentifier("created_at"));
        insertValues.push(quoteLiteral(String(folderMillis)));
      }

      if (insertColumns.length === 0) break;

      await sql.unsafe(
        `INSERT INTO ${qualifiedTable} (${insertColumns.join(", ")}) VALUES (${insertValues.join(", ")})`,
      );
      repairedMigrations.push(migrationFile);
    }
  } finally {
    await sql.end();
  }

  const refreshed = await inspectMigrations(url);
  return {
    repairedMigrations,
    remainingMigrations:
      refreshed.status === "needsMigrations" ? refreshed.pendingMigrations : [],
  };
}

async function discoverMigrationTableSchema(sql: ReturnType<typeof postgres>): Promise<string | null> {
  const rows = await sql<{ schemaName: string }[]>`
    SELECT n.nspname AS "schemaName"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = ${DRIZZLE_MIGRATIONS_TABLE} AND c.relkind = 'r'
  `;

  if (rows.length === 0) return null;

  const drizzleSchema = rows.find(({ schemaName }) => schemaName === "drizzle");
  if (drizzleSchema) return drizzleSchema.schemaName;

  const publicSchema = rows.find(({ schemaName }) => schemaName === "public");
  if (publicSchema) return publicSchema.schemaName;

  return rows[0]?.schemaName ?? null;
}

export async function inspectMigrations(url: string): Promise<MigrationState> {
  const sql = createUtilitySql(url);

  try {
    const availableMigrations = await listMigrationFiles();
    const tableCountResult = await sql<{ count: number }[]>`
      select count(*)::int as count
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
    `;
    const tableCount = tableCountResult[0]?.count ?? 0;

    const migrationTableSchema = await discoverMigrationTableSchema(sql);
    if (!migrationTableSchema) {
      if (tableCount > 0) {
        return {
          status: "needsMigrations",
          tableCount,
          availableMigrations,
          appliedMigrations: [],
          pendingMigrations: availableMigrations,
          reason: "no-migration-journal-non-empty-db",
        };
      }

      return {
        status: "needsMigrations",
        tableCount,
        availableMigrations,
        appliedMigrations: [],
        pendingMigrations: availableMigrations,
        reason: "no-migration-journal-empty-db",
      };
    }

    const appliedMigrations = await loadAppliedMigrations(sql, migrationTableSchema, availableMigrations);
    const pendingMigrations = availableMigrations.filter((name) => !appliedMigrations.includes(name));
    if (pendingMigrations.length === 0) {
      return {
        status: "upToDate",
        tableCount,
        availableMigrations,
        appliedMigrations,
      };
    }

    return {
      status: "needsMigrations",
      tableCount,
      availableMigrations,
      appliedMigrations,
      pendingMigrations,
      reason: "pending-migrations",
    };
  } finally {
    await sql.end();
  }
}

export type PendingMigrationDigest = { migrationFile: string; hash: string };

// A pending migration whose file name was first recorded as applied under a
// *different* content hash than the file now on disk. This is the signature of a
// migration file whose contents were swapped underneath an unchanged version —
// the runner would otherwise re-apply it in complete silence.
export type MigrationIdentityDriftEntry = {
  migrationFile: string;
  recordedHash: string;
  currentHash: string;
};

export type MigrationPreflight = {
  pending: PendingMigrationDigest[];
  drift: MigrationIdentityDriftEntry[];
  // Pending files the journal shows were already applied but which cannot be
  // checked for drift because this cluster records no file identity for them
  // (it predates identity tracking). Undecidable — surfaced separately rather
  // than folded into a clean (empty-drift) result, which must not be mistaken
  // for "verified clean".
  unverifiable: string[];
};

// Drift is an exact per-file lookup against the recorded identity, with no
// ordinals and no orphan heuristics, so it survives a scrubbed drizzle journal
// row (deleting a row shifts no comparison). A pending file with no recorded
// identity is either genuinely new (beyond the applied range — fine) or a
// previously-applied file on a cluster that predates identity tracking
// (undecidable — reported as unverifiable).
async function detectMigrationDrift(
  sql: SqlExecutor,
  migrationTableSchema: string,
  pendingMigrations: string[],
  orderedJournalFiles: string[],
): Promise<{ drift: MigrationIdentityDriftEntry[]; unverifiable: string[] }> {
  if (pendingMigrations.length === 0) return { drift: [], unverifiable: [] };

  const identities = await loadMigrationFileIdentities(sql, migrationTableSchema);
  // No identity table at all: nothing on this cluster is attributable, so no
  // pending file can be shown clean. Report every one of them rather than
  // inferring anything from ordinals. Self-limiting — the next apply creates
  // the table and the watermark below takes over.
  if (identities === null) {
    return { drift: [], unverifiable: [...pendingMigrations] };
  }
  const legacyAppliedCount = await loadMigrationIdentityWatermark(sql, migrationTableSchema);

  const drift: MigrationIdentityDriftEntry[] = [];
  const unverifiable: string[] = [];
  for (const migrationFile of pendingMigrations) {
    const currentHash = createHash("sha256")
      .update(await readMigrationFileContent(migrationFile))
      .digest("hex");
    const recordedHash = identities.get(migrationFile);
    if (recordedHash !== undefined) {
      if (recordedHash !== currentHash) {
        drift.push({ migrationFile, recordedHash, currentHash });
      }
      continue;
    }
    // No recorded identity for this pending file. If it predates identity
    // tracking (its ordinal is below the frozen watermark) we cannot decide
    // whether its content was swapped. A migration authored after tracking
    // began sits at or above the watermark and is genuinely new, not flagged.
    // A missing watermark leaves nothing to decide against, so fail closed.
    const ordinal = orderedJournalFiles.indexOf(migrationFile);
    if (legacyAppliedCount === null || (ordinal >= 0 && ordinal < legacyAppliedCount)) {
      unverifiable.push(migrationFile);
    }
  }
  return { drift, unverifiable };
}

// Read-only report of what applying migrations would do: the pending files with
// their content hashes, any identity-drift entries, and any pending files whose
// drift status cannot be determined. Callers log this before applying so an
// out-of-band content swap is loud instead of silent.
export async function inspectMigrationPreflight(url: string): Promise<MigrationPreflight> {
  const state = await inspectMigrations(url);
  const pendingFiles = state.status === "needsMigrations" ? state.pendingMigrations : [];
  const pending: PendingMigrationDigest[] = await Promise.all(
    pendingFiles.map(async (migrationFile) => ({
      migrationFile,
      hash: createHash("sha256")
        .update(await readMigrationFileContent(migrationFile))
        .digest("hex"),
    })),
  );

  let drift: MigrationIdentityDriftEntry[] = [];
  let unverifiable: string[] = [];
  if (pendingFiles.length > 0) {
    const sql = createUtilitySql(url);
    try {
      const migrationTableSchema = await discoverMigrationTableSchema(sql);
      if (migrationTableSchema) {
        const orderedJournalFiles = await listOrderedJournalMigrationFiles();
        ({ drift, unverifiable } = await detectMigrationDrift(
          sql,
          migrationTableSchema,
          pendingFiles,
          orderedJournalFiles,
        ));
      }
    } finally {
      await sql.end();
    }
  }

  return { pending, drift, unverifiable };
}

// The database name embedded in a postgres connection string, used to scope the
// production-migration opt-in to one specific cluster.
function extractDatabaseName(connectionString: string): string | null {
  try {
    const parsed = new URL(connectionString);
    const name = decodeURIComponent(parsed.pathname.replace(/^\//, "")).trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

export type SourceTreeMigrationTarget = {
  mode: "postgres" | "embedded-postgres";
  connectionString: string;
};

// Guards the source-tree *apply* entrypoint (pnpm db:migrate) against silently
// migrating an unintended external cluster. Only an explicitly configured
// external postgres target can be production; the instance-local embedded
// cluster is the ordinary dev loop and is never guarded, so routine work never
// trips this. Read-only inspectors (db:status, --dry-run) are not gated at all.
// For an external target a populated cluster is refused and fails closed unless
// PAPERCLIP_ALLOW_PROD_MIGRATE names that exact database — a bare truthy value is
// deliberately not accepted, so a grant left in a shell profile cannot later
// authorise a different cluster.
export async function assertSourceTreeMigrationAllowed(
  target: SourceTreeMigrationTarget,
): Promise<void> {
  if (target.mode !== "postgres") return;

  const databaseName = extractDatabaseName(target.connectionString);
  const optIn = process.env.PAPERCLIP_ALLOW_PROD_MIGRATE?.trim();
  if (optIn && databaseName && optIn === databaseName) return;

  const sql = createUtilitySql(target.connectionString);
  try {
    const rows = await sql<{ count: number }[]>`
      select count(*)::int as count
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
    `;
    const tableCount = rows[0]?.count ?? 0;
    if (tableCount > 0) {
      const scope = databaseName ?? "<database-name>";
      throw new Error(
        `Refusing to migrate the external database "${databaseName ?? target.connectionString}" from a source tree: ` +
          `it already holds ${tableCount} application table(s) and may be a production cluster. ` +
          `Set PAPERCLIP_ALLOW_PROD_MIGRATE=${scope} to authorise migrating this specific database.`,
      );
    }
  } finally {
    await sql.end();
  }
}

export async function applyPendingMigrations(url: string): Promise<void> {
  const initialState = await inspectMigrations(url);
  if (initialState.status === "upToDate") return;

  if (initialState.reason === "no-migration-journal-empty-db") {
    const sql = createUtilitySql(url);
    try {
      const db = drizzlePg(sql);
      await migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await sql.end();
    }

    // drizzle's bootstrap migrator writes journal rows but no file identity and
    // no audit trail; record both for the first-ever application of the full set
    // so an empty-db boot is attributable and future drift is detectable.
    await recordBootstrapMigrationProvenance(url, "bootstrap-empty-db");

    let bootstrappedState = await inspectMigrations(url);
    if (bootstrappedState.status === "upToDate") return;
    if (bootstrappedState.reason === "pending-migrations") {
      const repair = await reconcilePendingMigrationHistory(url);
      if (repair.repairedMigrations.length > 0) {
        bootstrappedState = await inspectMigrations(url);
      }
      if (bootstrappedState.status === "needsMigrations" && bootstrappedState.reason === "pending-migrations") {
        await applyPendingMigrationsManually(url, bootstrappedState.pendingMigrations);
        bootstrappedState = await inspectMigrations(url);
      }
    }
    if (bootstrappedState.status === "upToDate") return;
    throw new Error(
      `Failed to bootstrap migrations: ${bootstrappedState.pendingMigrations.join(", ")}`,
    );
  }

  if (initialState.reason === "no-migration-journal-non-empty-db") {
    throw new Error(
      "Database has tables but no migration journal; automatic migration is unsafe. Initialize migration history manually.",
    );
  }

  let state = await inspectMigrations(url);
  if (state.status === "upToDate") return;

  const repair = await reconcilePendingMigrationHistory(url);
  if (repair.repairedMigrations.length > 0) {
    state = await inspectMigrations(url);
    if (state.status === "upToDate") return;
  }

  if (state.status !== "needsMigrations" || state.reason !== "pending-migrations") {
    throw new Error("Migrations are still pending after migration-history reconciliation; run inspectMigrations for details.");
  }

  await applyPendingMigrationsManually(url, state.pendingMigrations);

  const finalState = await inspectMigrations(url);
  if (finalState.status !== "upToDate") {
    throw new Error(
      `Failed to apply pending migrations: ${finalState.pendingMigrations.join(", ")}`,
    );
  }
}

export type MigrationBootstrapResult =
  | { migrated: true; reason: "migrated-empty-db"; tableCount: 0 }
  | { migrated: false; reason: "already-migrated"; tableCount: number }
  | { migrated: false; reason: "not-empty-no-migration-journal"; tableCount: number };

export async function migratePostgresIfEmpty(url: string): Promise<MigrationBootstrapResult> {
  const sql = createUtilitySql(url);

  try {
    const migrationTableSchema = await discoverMigrationTableSchema(sql);

    const tableCountResult = await sql<{ count: number }[]>`
      select count(*)::int as count
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
    `;

    const tableCount = tableCountResult[0]?.count ?? 0;

    if (migrationTableSchema) {
      return { migrated: false, reason: "already-migrated", tableCount };
    }

    if (tableCount > 0) {
      return { migrated: false, reason: "not-empty-no-migration-journal", tableCount };
    }

    const db = drizzlePg(sql);
    await migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER });

    // Record identity + audit for the freshly bootstrapped set so this empty-db
    // application is attributable and later content swaps are detectable. Uses a
    // fresh connection since this one is closed in the finally below.
    await recordBootstrapMigrationProvenance(url, "bootstrap-empty-db");

    return { migrated: true, reason: "migrated-empty-db", tableCount: 0 };
  } finally {
    await sql.end();
  }
}

export async function ensurePostgresDatabase(
  url: string,
  databaseName: string,
): Promise<"created" | "exists"> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(databaseName)) {
    throw new Error(`Unsafe database name: ${databaseName}`);
  }

  const sql = createUtilitySql(url);
  try {
    const existing = await sql<{ one: number }[]>`
      select 1 as one from pg_database where datname = ${databaseName} limit 1
    `;
    if (existing.length > 0) return "exists";

    await sql.unsafe(`create database "${databaseName}" encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0`);
    return "created";
  } finally {
    await sql.end();
  }
}

export async function resetPostgresDatabase(
  url: string,
  databaseName: string,
): Promise<"reset"> {
  const quotedDatabaseName = quoteIdentifier(databaseName);
  const sql = createUtilitySql(url);
  try {
    await sql`
      select pg_terminate_backend(pid)
      from pg_stat_activity
      where datname = ${databaseName}
        and pid <> pg_backend_pid()
    `;
    await sql.unsafe(`drop database if exists ${quotedDatabaseName}`);
    await sql.unsafe(`create database ${quotedDatabaseName} encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0`);
    return "reset";
  } finally {
    await sql.end();
  }
}

export type Db = ReturnType<typeof createDb>;
