export {
  createDb,
  getPostgresDataDirectory,
  ensurePostgresDatabase,
  resetPostgresDatabase,
  inspectMigrations,
  inspectMigrationPreflight,
  assertSourceTreeMigrationAllowed,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
  type MigrationState,
  type MigrationPreflight,
  type PendingMigrationDigest,
  type MigrationIdentityDriftEntry,
  type SourceTreeMigrationTarget,
  type MigrationHistoryReconcileResult,
  migratePostgresIfEmpty,
  type MigrationBootstrapResult,
  type Db,
} from "./client.js";
export {
  createQueryCancellationScope,
  type QueryCancellationScope,
} from "./query-cancellation.js";
export {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestSupport,
} from "./test-embedded-postgres.js";
export {
  runDatabaseBackup,
  runDatabaseRestore,
  formatDatabaseBackupResult,
  type BackupRetentionPolicy,
  type RunDatabaseBackupOptions,
  type RunDatabaseBackupResult,
  type RunDatabaseRestoreOptions,
} from "./backup-lib.js";
export {
  createEmbeddedPostgresLogBuffer,
  formatEmbeddedPostgresError,
} from "./embedded-postgres-error.js";
export {
  EMBEDDED_POSTGRES_AUTH_METHOD,
  EMBEDDED_POSTGRES_HOST,
  EMBEDDED_POSTGRES_USER,
  LEGACY_EMBEDDED_POSTGRES_PASSWORD,
  buildEmbeddedPostgresConnectionString,
  buildEmbeddedPostgresConstructorOptions,
  buildScramSha256PgHba,
  credentialFilePathFor,
  embeddedPostgresSqlOptions,
  ensureEmbeddedPostgresSocketDir,
  generateEmbeddedPostgresPassword,
  isPgHbaScramOnly,
  migrateLegacyEmbeddedPostgresSocket,
  readEmbeddedPostgresCredential,
  readPidFileSocketDir,
  resolveEmbeddedPostgresConnection,
  resolveEmbeddedPostgresPasswordForStartup,
  rewritePgHbaToScram,
  rotateEmbeddedPostgresAuthIfNeeded,
  scrubEmbeddedPostgresConnectionString,
  socketDirectoryPathFor,
  stopRunningEmbeddedPostgres,
  writeEmbeddedPostgresCredential,
  SOCKET_DIR_QUERY_PARAM,
  type BuildEmbeddedPostgresConnectionStringInput,
  type EmbeddedPostgresAuthMethod,
  type EmbeddedPostgresConstructorOptions,
  type EmbeddedPostgresCredential,
  type EmbeddedPostgresDatabase,
  type ResolvedEmbeddedPostgresConnection,
  type ResolvedEmbeddedPostgresPassword,
  type RotateEmbeddedPostgresAuthEvent,
  type RotateEmbeddedPostgresAuthInput,
  type RotateEmbeddedPostgresAuthResult,
} from "./embedded-postgres-auth.js";
export {
  ensureLinuxSharedLibraryAliases,
  prepareEmbeddedPostgresNativeRuntime,
} from "./embedded-postgres-native.js";
export { issueRelations } from "./schema/issue_relations.js";
export { issueReferenceMentions } from "./schema/issue_reference_mentions.js";
export * from "./schema/index.js";
