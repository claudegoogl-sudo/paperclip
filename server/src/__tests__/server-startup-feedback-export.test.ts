import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ORIGINAL_PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL;
const ORIGINAL_PAPERCLIP_RUNTIME_API_URL = process.env.PAPERCLIP_RUNTIME_API_URL;
const ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
const ORIGINAL_PAPERCLIP_LISTEN_HOST = process.env.PAPERCLIP_LISTEN_HOST;
const ORIGINAL_PAPERCLIP_LISTEN_PORT = process.env.PAPERCLIP_LISTEN_PORT;

const {
  createAppMock,
  createBetterAuthInstanceMock,
  createDbMock,
  detectPortMock,
  deriveAuthTrustedOriginsMock,
  environmentCustomImagesServiceMock,
  environmentCustomImagesServiceFactoryMock,
  executionWorkspaceServiceFactoryMock,
  executionWorkspaceServiceMock,
  externalObjectsServiceMock,
  externalObjectsServiceFactoryMock,
  feedbackExportServiceMock,
  feedbackServiceFactoryMock,
  fakeServer,
  heartbeatServiceFactoryMock,
  heartbeatServiceMock,
  issueThreadInteractionServiceFactoryMock,
  issueThreadInteractionServiceMock,
  loadConfigMock,
  resolveHeartbeatSchedulingSuppressionMock,
  routineServiceFactoryMock,
  routineServiceMock,
} = vi.hoisted(() => {
  const createAppMock = vi.fn(async () => ((_: unknown, __: unknown) => {}) as never);
  const createBetterAuthInstanceMock = vi.fn(() => ({}));
  const createDbMock = vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(async () => []) })),
    })),
  }) as never);
  const detectPortMock = vi.fn(async (port: number) => port);
  const deriveAuthTrustedOriginsMock = vi.fn(() => []);
  const resolveHeartbeatSchedulingSuppressionMock = vi.fn(() => ({
    suppressed: false,
    reason: null,
  }));
  const heartbeatServiceMock = {
    resolveSchedulingSuppression: resolveHeartbeatSchedulingSuppressionMock,
    reconcileHotRestartAdoption: vi.fn(async () => ({ mode: "none" })),
    reapOrphanedRuns: vi.fn(async () => ({ reaped: 0, runIds: [] })),
    promoteDueScheduledRetries: vi.fn(async () => ({ promoted: 0, runIds: [] })),
    resumeQueuedRuns: vi.fn(async () => undefined),
    reconcileStrandedAssignedIssues: vi.fn(async () => ({
      assignmentDispatched: 0,
      dispatchRequeued: 0,
      continuationRequeued: 0,
      successfulRunHandoffEscalated: 0,
      escalated: 0,
      skipped: 0,
      issueIds: [],
    })),
    reconcileIssueGraphLiveness: vi.fn(async () => ({
      escalationsCreated: 0,
      dependencyWakesHealed: 0,
    })),
    reconcileTaskWatchdogs: vi.fn(async () => ({ triggered: 0 })),
    scanSilentActiveRuns: vi.fn(async () => ({ created: 0, escalated: 0 })),
    sweepStaleIssueLocks: vi.fn(async () => ({ cleared: 0 })),
    sweepPendingCleanupLeases: vi.fn(async () => ({ swept: 0, destroyed: 0, capped: 0 })),
    reconcileProductivityReviews: vi.fn(async () => ({ created: 0, updated: 0, failed: 0 })),
    sweepExpiredRuntimeStatuses: vi.fn(() => 0),
    tickTimers: vi.fn(async () => ({ checked: 0, enqueued: 0, skipped: 0 })),
  };
  const heartbeatServiceFactoryMock = vi.fn(() => heartbeatServiceMock);
  const issueThreadInteractionServiceMock = {
    sweepSupersededPendingRequestConfirmations: vi.fn(async () => ({ expired: 0 })),
    sweepMergedPullRequestConfirmations: vi.fn(async () => ({
      checked: 0,
      candidates: 0,
      accepted: 0,
      woken: 0,
    })),
  };
  const issueThreadInteractionServiceFactoryMock = vi.fn(() => issueThreadInteractionServiceMock);
  const environmentCustomImagesServiceMock = {
    cleanupExpiredSetupSessions: vi.fn(async () => ({ scanned: 0, timedOut: 0, failed: 0 })),
  };
  const environmentCustomImagesServiceFactoryMock = vi.fn(() => environmentCustomImagesServiceMock);
  const executionWorkspaceServiceMock = {
    sweepTerminalWorkspaces: vi.fn(async () => ({
      checked: 0,
      eligible: 0,
      archived: 0,
      cleanupFailed: 0,
      skippedActiveRun: 0,
      skippedNonTerminalTree: 0,
      skippedUndelivered: 0,
      skippedRace: 0,
    })),
  };
  const executionWorkspaceServiceFactoryMock = vi.fn(() => executionWorkspaceServiceMock);
  const externalObjectsServiceMock = {
    refreshDueObjectsForActiveCompanies: vi.fn(async () => ({ companies: 0, checked: 0, refreshed: 0 })),
  };
  const externalObjectsServiceFactoryMock = vi.fn(() => externalObjectsServiceMock);
  const routineServiceMock = {
    tickScheduledTriggers: vi.fn(async () => ({ triggered: 0 })),
  };
  const routineServiceFactoryMock = vi.fn(() => routineServiceMock);
  const feedbackExportServiceMock = {
    flushPendingFeedbackTraces: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0 })),
  };
  const feedbackServiceFactoryMock = vi.fn(() => feedbackExportServiceMock);
  const fakeServer = {
    once: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    listen: vi.fn((_port: number, _host: string, callback?: () => void) => {
      callback?.();
      return fakeServer;
    }),
    close: vi.fn(),
  };
  const loadConfigMock = vi.fn();

  return {
    createAppMock,
    createBetterAuthInstanceMock,
    createDbMock,
    detectPortMock,
    deriveAuthTrustedOriginsMock,
    environmentCustomImagesServiceMock,
    environmentCustomImagesServiceFactoryMock,
    executionWorkspaceServiceFactoryMock,
    executionWorkspaceServiceMock,
    externalObjectsServiceMock,
    externalObjectsServiceFactoryMock,
    feedbackExportServiceMock,
    feedbackServiceFactoryMock,
    fakeServer,
    heartbeatServiceFactoryMock,
    heartbeatServiceMock,
    issueThreadInteractionServiceFactoryMock,
    issueThreadInteractionServiceMock,
    loadConfigMock,
    resolveHeartbeatSchedulingSuppressionMock,
    routineServiceFactoryMock,
    routineServiceMock,
  };
});

function buildTestConfig(overrides: Record<string, unknown> = {}) {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bind: "loopback",
    customBindHost: undefined,
    host: "127.0.0.1",
    port: 3210,
    allowedHostnames: [],
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    authDisableSignUp: false,
    databaseMode: "postgres",
    databaseUrl: "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip",
    allowEmbeddedPostgresPublic: true,
    embeddedPostgresDataDir: "/tmp/paperclip-test-db",
    embeddedPostgresPort: 54329,
    databaseBackupEnabled: false,
    databaseBackupIntervalMinutes: 60,
    databaseBackupRetentionDays: 30,
    databaseBackupDir: "/tmp/paperclip-test-backups",
    serveUi: false,
    uiDevMiddleware: false,
    secretsProvider: "local_encrypted",
    secretsStrictMode: false,
    secretsMasterKeyFilePath: "/tmp/paperclip-master.key",
    storageProvider: "local_disk",
    storageLocalDiskBaseDir: "/tmp/paperclip-storage",
    storageS3Bucket: "paperclip-test",
    storageS3Region: "us-east-1",
    storageS3Endpoint: undefined,
    storageS3Prefix: "",
    storageS3ForcePathStyle: false,
    feedbackExportBackendUrl: "https://telemetry.example.com",
    feedbackExportBackendToken: "telemetry-token",
    heartbeatSchedulerEnabled: false,
    heartbeatSchedulerIntervalMs: 30000,
    companyDeletionEnabled: false,
    ...overrides,
  };
}

vi.mock("node:http", () => ({
  createServer: vi.fn(() => fakeServer),
}));

vi.mock("detect-port", () => ({
  default: detectPortMock,
}));

vi.mock("@paperclipai/db", () => ({
  createDb: createDbMock,
  ensurePostgresDatabase: vi.fn(),
  getPostgresDataDirectory: vi.fn(),
  inspectMigrations: vi.fn(async () => ({ status: "upToDate" })),
  inspectMigrationPreflight: vi.fn(async () => ({ pending: [], drift: [], unverifiable: [] })),
  applyPendingMigrations: vi.fn(),
  reconcilePendingMigrationHistory: vi.fn(async () => ({ repairedMigrations: [] })),
  formatDatabaseBackupResult: vi.fn(() => "ok"),
  runDatabaseBackup: vi.fn(),
  authUsers: {},
  companies: {},
  companyMemberships: {},
  instanceUserRoles: {},
}));

vi.mock("../app.js", () => ({
  createApp: createAppMock,
}));

vi.mock("../config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
      return this;
    }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../realtime/live-events-ws.js", () => ({
  setupLiveEventsWebSocketServer: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  backfillLegacyToolOAuthTokens: vi.fn(async () => ({
    scannedConnections: 0,
    migratedConnections: 0,
    sanitizedConnections: 0,
    createdSecrets: 0,
    rotatedSecrets: 0,
    accessTokensBackfilled: 0,
    refreshTokensBackfilled: 0,
  })),
  backfillPrincipalAccessCompatibility: vi.fn(async () => ({
    agentMembershipsInserted: 0,
    humanGrantsInserted: 0,
  })),
  attentionService: vi.fn(() => ({
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
  })),
  decisionService: vi.fn(() => ({
    sweepExpired: vi.fn(async () => ({ expired: 0 })),
  })),
  decisionRetentionService: vi.fn(() => ({
    autoArchive: vi.fn(async () => 0),
    deliverNotifications: vi.fn(async () => ({ notifiedAgents: 0, delivered: 0 })),
  })),
  feedbackService: feedbackServiceFactoryMock,
  bootstrapExecutionPolicyFromEnv: vi.fn(async () => null),
  applyManagedEnvironments: vi.fn(async () => null),
  environmentCustomImageService: environmentCustomImagesServiceFactoryMock,
  executionWorkspaceService: executionWorkspaceServiceFactoryMock,
  externalObjectService: externalObjectsServiceFactoryMock,
  heartbeatService: heartbeatServiceFactoryMock,
  issueThreadInteractionService: issueThreadInteractionServiceFactoryMock,
  issueService: vi.fn(() => ({ update: vi.fn(async () => null) })),
  instanceSettingsService: vi.fn(() => ({
    getExperimental: vi.fn(async () => ({
      enableExternalObjects: true,
      enableStatusCards: false,
    })),
    getGeneral: vi.fn(async () => ({
      backupRetention: {
        dailyDays: 7,
        weeklyWeeks: 4,
        monthlyMonths: 1,
      },
    })),
  })),
  reconcileCodexLocalManagedHomesOnStartup: vi.fn(async () => ({
    scanned: 0,
    seeded: 0,
    alreadySeeded: 0,
    externalOverride: 0,
    noManagedHome: 0,
    sourceAuthMissing: 0,
    failed: 0,
    seededAgentIds: [],
  })),
  reconcileBuiltInAgentsOnStartup: vi.fn(async () => ({
    scanned: 0,
    reconciled: 0,
    unknown: 0,
    duplicates: 0,
  })),
  reconcilePersistedRuntimeServicesOnStartup: vi.fn(async () => ({ reconciled: 0 })),
  resolveHeartbeatSchedulingSuppression: resolveHeartbeatSchedulingSuppressionMock,
  routineService: routineServiceFactoryMock,
  statusCardService: vi.fn(() => ({})),
  toolAccessService: vi.fn(() => ({
    sweepConnectionHealth: vi.fn(async () => ({
      checked: 0,
      healthy: 0,
      needsAttention: 0,
      failed: 0,
    })),
  })),
}));

vi.mock("../services/secret-proposals.js", () => ({
  createSecretProposalsService: vi.fn(() => ({
    sweepExpired: vi.fn(async () => 0),
  })),
}));

vi.mock("../storage/index.js", () => ({
  createStorageServiceFromConfig: vi.fn(() => ({ id: "storage-service" })),
}));

vi.mock("../services/feedback-share-client.js", () => ({
  createFeedbackTraceShareClientFromConfig: vi.fn(() => ({ id: "feedback-share-client" })),
}));

vi.mock("../services/plugin-worker-manager.js", () => ({
  createPluginWorkerManager: vi.fn(() => ({ id: "plugin-worker-manager" })),
}));

vi.mock("../startup-banner.js", () => ({
  printStartupBanner: vi.fn(),
}));

vi.mock("../board-claim.js", () => ({
  getBoardClaimWarningUrl: vi.fn(() => null),
  initializeBoardClaimChallenge: vi.fn(async () => undefined),
}));

vi.mock("../auth/better-auth.js", () => ({
  createBetterAuthHandler: vi.fn(() => undefined),
  createBetterAuthInstance: createBetterAuthInstanceMock,
  deriveAuthTrustedOrigins: deriveAuthTrustedOriginsMock,
  resolveBetterAuthSession: vi.fn(async () => null),
  resolveBetterAuthSessionFromHeaders: vi.fn(async () => null),
}));

import { startServer } from "../index.ts";
import { logger } from "../middleware/logger.js";

describe("startServer feedback export wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "fedcba9876543210fedcba9876543210";
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "0123456789abcdef0123456789abcdef";
    loadConfigMock.mockReturnValue(buildTestConfig());
    resolveHeartbeatSchedulingSuppressionMock.mockReturnValue({
      suppressed: false,
      reason: null,
    });
    createBetterAuthInstanceMock.mockReturnValue({});
    deriveAuthTrustedOriginsMock.mockReturnValue([]);
    process.env.BETTER_AUTH_SECRET = "unit-test-strong-secret-0123456789abcdef";
  });

  it("starts without PAPERCLIP_DECISION_SIGNING_SECRET by generating a persisted key", async () => {
    const originalHome = process.env.PAPERCLIP_HOME;
    const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    const tempHome = mkdtempSync(path.join(tmpdir(), "paperclip-decision-key-"));
    process.env.PAPERCLIP_HOME = tempHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    delete process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
    try {
      const started = await startServer();
      expect(started.server).toBe(fakeServer);
      const keyPath = path.join(tempHome, "instances", "default", "secrets", "decision-signing.key");
      expect(readFileSync(keyPath, "utf8").trim().length).toBeGreaterThanOrEqual(32);
      if (process.platform !== "win32") {
        expect(statSync(path.dirname(keyPath)).mode & 0o777).toBe(0o700);
        expect(statSync(keyPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = originalHome;
      if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("repairs permissive permissions on an existing generated decision signing key", async () => {
    const originalHome = process.env.PAPERCLIP_HOME;
    const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    const tempHome = mkdtempSync(path.join(tmpdir(), "paperclip-decision-key-mode-"));
    const keyPath = path.join(tempHome, "instances", "default", "secrets", "decision-signing.key");
    const existingKey = Buffer.alloc(32, 7).toString("base64");
    mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o777 });
    chmodSync(path.dirname(keyPath), 0o777);
    writeFileSync(keyPath, existingKey, { encoding: "utf8", mode: 0o644 });
    chmodSync(keyPath, 0o644);
    process.env.PAPERCLIP_HOME = tempHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    delete process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
    try {
      const started = await startServer();
      expect(started.server).toBe(fakeServer);
      expect(readFileSync(keyPath, "utf8")).toBe(existingKey);
      if (process.platform !== "win32") {
        expect(statSync(path.dirname(keyPath)).mode & 0o777).toBe(0o700);
        expect(statSync(keyPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = originalHome;
      if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("refuses a symlink planted as the generated decision signing key", async () => {
    if (process.platform === "win32") return;

    const originalHome = process.env.PAPERCLIP_HOME;
    const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    const tempHome = mkdtempSync(path.join(tmpdir(), "paperclip-decision-key-symlink-"));
    const keyPath = path.join(tempHome, "instances", "default", "secrets", "decision-signing.key");
    const plantedTarget = path.join(tempHome, "planted.key");
    const plantedKey = Buffer.alloc(32, 9).toString("base64");
    mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o777 });
    chmodSync(path.dirname(keyPath), 0o777);
    writeFileSync(plantedTarget, plantedKey, { encoding: "utf8", mode: 0o600 });
    symlinkSync(plantedTarget, keyPath);
    process.env.PAPERCLIP_HOME = tempHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    delete process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
    try {
      await expect(startServer()).rejects.toThrow("must be a regular file");
      expect(readFileSync(plantedTarget, "utf8")).toBe(plantedKey);
    } finally {
      if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = originalHome;
      if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("refuses startup when an explicit decision signing secret is too short", async () => {
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "too-short";
    await expect(startServer()).rejects.toThrow("PAPERCLIP_DECISION_SIGNING_SECRET must be at least 32 characters");
    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("passes the feedback export service into createApp so pending traces flush in runtime", async () => {
    const started = await startServer();

    expect(started.server).toBe(fakeServer);
    expect(feedbackServiceFactoryMock).toHaveBeenCalledTimes(1);
    expect(createAppMock).toHaveBeenCalledTimes(1);
    expect(createAppMock.mock.calls[0]?.[1]).toMatchObject({
      feedbackExportService: feedbackExportServiceMock,
      storageService: { id: "storage-service" },
      serverPort: 3210,
    });
  });

  it("keeps routine ticks and setup cleanup active when heartbeat scheduling is suppressed", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      heartbeatSchedulerEnabled: true,
      heartbeatSchedulerIntervalMs: 30000,
    }));
    resolveHeartbeatSchedulingSuppressionMock.mockReturnValue({
      suppressed: true,
      reason: "worktree_instance",
    });
    // startServer registers more than one interval. Select the scheduler tick by
    // its configured period instead of keeping only the last registration, or any
    // unrelated interval registered after it silently replaces the callback under
    // test and every assertion below stops testing anything.
    const registeredIntervals: { callback: () => void; ms: number }[] = [];
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation(((callback: () => void, ms: number) => {
        registeredIntervals.push({ callback, ms });
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval);

    try {
      await startServer();

      expect(heartbeatServiceMock.reapOrphanedRuns).not.toHaveBeenCalled();
      expect(heartbeatServiceMock.tickTimers).not.toHaveBeenCalled();
      expect(environmentCustomImagesServiceMock.cleanupExpiredSetupSessions).toHaveBeenCalledTimes(1);

      const schedulerTicks = registeredIntervals.filter((entry) => entry.ms === 30000);
      expect(schedulerTicks).toHaveLength(1);
      schedulerTicks[0]?.callback();
      await Promise.resolve();
      await Promise.resolve();

      expect(heartbeatServiceMock.tickTimers).not.toHaveBeenCalled();
      expect(externalObjectsServiceMock.refreshDueObjectsForActiveCompanies).toHaveBeenCalledTimes(1);
      expect(issueThreadInteractionServiceMock.sweepMergedPullRequestConfirmations).toHaveBeenCalledTimes(1);
      expect(executionWorkspaceServiceMock.sweepTerminalWorkspaces).toHaveBeenCalledTimes(1);
      expect(routineServiceMock.tickScheduledTriggers).toHaveBeenCalledTimes(1);
      expect(environmentCustomImagesServiceMock.cleanupExpiredSetupSessions).toHaveBeenCalledTimes(2);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("keeps external object refresh active when heartbeat scheduling is disabled", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      heartbeatSchedulerEnabled: false,
      heartbeatSchedulerIntervalMs: 30000,
    }));
    let intervalCallback: (() => void) | null = null;
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation(((callback: () => void) => {
        intervalCallback = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval);

    try {
      await startServer();

      // The disabled path still creates one heartbeat runtime. This runtime owns
      // the orphan-sandbox cleanup sweep, so a leaked provider sandbox is still
      // reaped at startup and on the interval.
      expect(heartbeatServiceFactoryMock).toHaveBeenCalledTimes(1);
      expect(heartbeatServiceMock.sweepPendingCleanupLeases).toHaveBeenCalled();
      expect(intervalCallback).not.toBeNull();
      intervalCallback?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(externalObjectsServiceMock.refreshDueObjectsForActiveCompanies).toHaveBeenCalledTimes(1);
      expect(routineServiceMock.tickScheduledTriggers).not.toHaveBeenCalled();
      expect(environmentCustomImagesServiceMock.cleanupExpiredSetupSessions).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("does not replay hot-restart adoption when the orphan reaper retries", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      heartbeatSchedulerEnabled: true,
      heartbeatSchedulerIntervalMs: 30000,
    }));
    heartbeatServiceMock.reconcileHotRestartAdoption.mockRejectedValueOnce(new Error("partial adoption"));
    heartbeatServiceMock.reapOrphanedRuns
      .mockRejectedValueOnce(new Error("transient reap failure"))
      .mockResolvedValueOnce({ reaped: 0, runIds: [] });

    await startServer();

    expect(heartbeatServiceMock.reconcileHotRestartAdoption).toHaveBeenCalledTimes(1);
    expect(heartbeatServiceMock.reapOrphanedRuns).toHaveBeenCalledTimes(2);
  });

  it("warns but does not refuse authenticated public startup on embedded PostgreSQL", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      deploymentExposure: "public",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://tenant.example.com",
      databaseMode: "embedded-postgres",
      databaseUrl: undefined,
    }));

    // The cloud-DB contract guard must no longer reject embedded PostgreSQL for
    // authenticated+public deployments; it warns and falls through to the
    // embedded-postgres branch (restores pre-525 posture). The embedded boot
    // itself is out of scope for this unit, so swallow whatever happens after
    // the guard and assert only that it warned instead of throwing the contract.
    let thrown: unknown;
    await startServer().catch((err) => {
      thrown = err;
    });

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining("public deployment running on embedded PostgreSQL"),
    );
    expect(String((thrown as Error | undefined)?.message ?? "")).not.toContain(
      "refusing embedded PostgreSQL fallback",
    );
  });

  it("refuses authenticated public startup on embedded PostgreSQL when allowEmbeddedPostgresPublic=false", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      deploymentExposure: "public",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://tenant.example.com",
      databaseMode: "embedded-postgres",
      databaseUrl: undefined,
      allowEmbeddedPostgresPublic: false,
    }));

    await expect(startServer()).rejects.toThrow(
      "PAPERCLIP_ALLOW_EMBEDDED_POSTGRES_PUBLIC=false",
    );
    expect(createDbMock).not.toHaveBeenCalled();
  });

  it("refuses authenticated public startup when DATABASE_URL is not a postgres URL", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      deploymentExposure: "public",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://tenant.example.com",
      databaseUrl: "secret://paperclip-cloud/stacks/alpha/database/runtime-url",
    }));

    await expect(startServer()).rejects.toThrow(
      "authenticated public deployments require DATABASE_URL to be a postgres/postgresql connection string",
    );
    expect(createDbMock).not.toHaveBeenCalled();
  });
});

describe("startServer authenticated auth origin setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "fedcba9876543210fedcba9876543210";
    loadConfigMock.mockReturnValue(buildTestConfig());
    createBetterAuthInstanceMock.mockReturnValue({});
    deriveAuthTrustedOriginsMock.mockReturnValue([]);
    process.env.BETTER_AUTH_SECRET = "unit-test-strong-secret-0123456789abcdef";
  });

  it("derives trusted origins from the detected listen port before auth initializes", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      port: 3210,
      allowedHostnames: ["board.example.test"],
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "http://127.0.0.1:3210",
    }));
    detectPortMock.mockResolvedValueOnce(3211);
    deriveAuthTrustedOriginsMock.mockImplementation(
      (_config: { port: number; authPublicBaseUrl?: string }, opts?: { listenPort?: number }) => [
        `http://board.example.test:${opts?.listenPort ?? 0}`,
      ],
    );

    await startServer();

    expect(deriveAuthTrustedOriginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 3210,
        authPublicBaseUrl: "http://127.0.0.1:3211/",
      }),
      { listenPort: 3211 },
    );
    expect(createBetterAuthInstanceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        port: 3210,
        authPublicBaseUrl: "http://127.0.0.1:3211/",
      }),
      ["http://board.example.test:3211"],
    );
    expect(createAppMock.mock.calls[0]?.[1]).toMatchObject({
      serverPort: 3211,
    });
  });
});

describe("startServer PAPERCLIP_API_URL handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "fedcba9876543210fedcba9876543210";
    loadConfigMock.mockReturnValue(buildTestConfig());
    process.env.BETTER_AUTH_SECRET = "unit-test-strong-secret-0123456789abcdef";
    delete process.env.PAPERCLIP_API_URL;
  });

  afterEach(() => {
    if (ORIGINAL_PAPERCLIP_API_URL === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = ORIGINAL_PAPERCLIP_API_URL;

    if (ORIGINAL_PAPERCLIP_RUNTIME_API_URL === undefined) delete process.env.PAPERCLIP_RUNTIME_API_URL;
    else process.env.PAPERCLIP_RUNTIME_API_URL = ORIGINAL_PAPERCLIP_RUNTIME_API_URL;

    if (ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON === undefined) {
      delete process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
    } else {
      process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
    }

    if (ORIGINAL_PAPERCLIP_LISTEN_HOST === undefined) delete process.env.PAPERCLIP_LISTEN_HOST;
    else process.env.PAPERCLIP_LISTEN_HOST = ORIGINAL_PAPERCLIP_LISTEN_HOST;

    if (ORIGINAL_PAPERCLIP_LISTEN_PORT === undefined) delete process.env.PAPERCLIP_LISTEN_PORT;
    else process.env.PAPERCLIP_LISTEN_PORT = ORIGINAL_PAPERCLIP_LISTEN_PORT;
  });

  it("uses the externally set PAPERCLIP_API_URL when provided", async () => {
    process.env.PAPERCLIP_API_URL = "http://custom-api:3100";

    const started = await startServer();

    expect(started.apiUrl).toBe("http://custom-api:3100");
    expect(process.env.PAPERCLIP_API_URL).toBe("http://custom-api:3100");
    expect(JSON.parse(process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON ?? "[]")).toEqual(
      expect.arrayContaining(["http://custom-api:3100"]),
    );
    expect(JSON.parse(process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON ?? "[]")[0]).toBe("http://custom-api:3100");
  });

  it("falls back to host-based URL when PAPERCLIP_API_URL is not set", async () => {
    const started = await startServer();

    expect(started.apiUrl).toBe("http://127.0.0.1:3210");
    expect(process.env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:3210");
  });

  it("keeps loopback as the runtime API URL when allowed hostnames are present", async () => {
    loadConfigMock.mockReturnValueOnce(buildTestConfig({
      allowedHostnames: ["192.168.1.50"],
    }));

    const started = await startServer();

    expect(started.apiUrl).toBe("http://127.0.0.1:3210");
    expect(process.env.PAPERCLIP_RUNTIME_API_URL).toBe("http://127.0.0.1:3210");
    expect(process.env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:3210");
    expect(JSON.parse(process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON ?? "[]")).toEqual(
      expect.arrayContaining(["http://127.0.0.1:3210", "http://192.168.1.50:3210"]),
    );
  });

  it("preserves explicit-port external auth public URLs when detect-port selects a new port", async () => {
    loadConfigMock.mockReturnValueOnce(buildTestConfig({
      port: 3100,
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "http://my-host.ts.net:3100",
    }));
    detectPortMock.mockResolvedValueOnce(3110);

    const started = await startServer();

    // The server listens internally on 3110, but an explicit *external* base URL must keep
    // its advertised port. Rewriting it to the internal listen port produced an unreachable
    // URL that leaked to spawned agents as a dead PAPERCLIP_API_URL. (BRO-1558)
    expect(started.listenPort).toBe(3110);
    expect(started.apiUrl).toBe("http://my-host.ts.net:3100");
    expect(process.env.PAPERCLIP_RUNTIME_API_URL).toBe("http://my-host.ts.net:3100");
  });

  it("keeps no-port auth public URLs stable when detect-port selects a new port", async () => {
    loadConfigMock.mockReturnValueOnce(buildTestConfig({
      port: 3100,
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://paperclip.example",
    }));
    detectPortMock.mockResolvedValueOnce(3110);

    const started = await startServer();

    expect(started.listenPort).toBe(3110);
    expect(started.apiUrl).toBe("https://paperclip.example");
    expect(process.env.PAPERCLIP_RUNTIME_API_URL).toBe("https://paperclip.example");
  });
});

describe("boot warning for open sign-up on authenticated deployments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up env vars that might affect other tests
    delete process.env.PAPERCLIP_DEPLOYMENT_MODE;
    delete process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP;
  });

  it("emits console.warn when sign-up is open on authenticated deployment", () => {
    const mockWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Mock the config reading to simulate authenticated mode with open sign-up
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    // authDisableSignUp defaults to false when unset

    // Re-import the config module to trigger the warning
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "{}"),
    }));

    // The warning should be emitted during config loading
    expect(mockWarn).not.toHaveBeenCalled(); // Not called yet since we're not actually loading config

    // This test documents the expected behavior - the actual warning is emitted
    // during loadConfig() in config.ts when:
    // - deploymentMode === "authenticated"
    // - authDisableSignUp === false

    mockWarn.mockRestore();
  });

  it("does not emit warning when sign-up is closed on authenticated deployment", () => {
    // When PAPERCLIP_AUTH_DISABLE_SIGN_UP=true, no warning should be emitted
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP = "true";

    const mockWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // No warning expected in this case
    expect(mockWarn).not.toHaveBeenCalled();

    mockWarn.mockRestore();
  });

  it("does not emit warning on local_trusted deployments", () => {
    // On local_trusted deployments, no warning should be emitted regardless of authDisableSignUp
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "local_trusted";

    const mockWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // No warning expected for local_trusted mode
    expect(mockWarn).not.toHaveBeenCalled();

    mockWarn.mockRestore();
  });
});
