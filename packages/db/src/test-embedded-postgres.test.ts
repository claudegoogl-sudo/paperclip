import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ensurePostgresDatabase = vi.hoisted(() => vi.fn(async () => {}));
const applyPendingMigrations = vi.hoisted(() => vi.fn(async () => {}));
const prepareEmbeddedPostgresNativeRuntime = vi.hoisted(() => vi.fn(async () => {}));

// startEmbeddedPostgresTestDatabase() is the unit under test; everything it
// calls out to (real DB setup, native runtime prep) is faked so the test
// exercises only the port-collision retry loop.
vi.mock("./client.js", () => ({
  ensurePostgresDatabase,
  applyPendingMigrations,
}));

vi.mock("./embedded-postgres-native.js", () => ({
  prepareEmbeddedPostgresNativeRuntime,
}));

type FakeCtorOptions = {
  databaseDir: string;
  port: number;
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
};

const startAttempts = vi.hoisted(() => ({
  constructedDataDirs: [] as string[],
  // How many leading start() calls should simulate a port collision before
  // one finally succeeds. Configured per-test via configureStartAttempts().
  failuresBeforeSuccess: 0,
  callCount: 0,
}));

vi.mock("embedded-postgres", () => {
  class FakeEmbeddedPostgres {
    private readonly options: FakeCtorOptions;

    constructor(options: FakeCtorOptions) {
      this.options = options;
      startAttempts.constructedDataDirs.push(options.databaseDir);
    }

    async initialise(): Promise<void> {}

    async start(): Promise<void> {
      startAttempts.callCount += 1;
      if (startAttempts.callCount <= startAttempts.failuresBeforeSuccess) {
        // Mirrors real embedded-postgres: on a port collision the postgres
        // process exits immediately, stderr carries the real reason, and the
        // start() promise settles via a bare reject() with no error object.
        this.options.onLog?.("could not bind IPv4 socket: Address already in use\n");
        throw undefined;
      }
    }

    async stop(): Promise<void> {}
  }

  return { default: FakeEmbeddedPostgres };
});

function configureStartAttempts(failuresBeforeSuccess: number): void {
  startAttempts.constructedDataDirs = [];
  startAttempts.failuresBeforeSuccess = failuresBeforeSuccess;
  startAttempts.callCount = 0;
}

describe("startEmbeddedPostgresTestDatabase port collision retry", () => {
  beforeEach(() => {
    configureStartAttempts(0);
    ensurePostgresDatabase.mockClear();
    applyPendingMigrations.mockClear();
  });

  it("retries with a fresh port and dataDir, cleaning up the abandoned attempt", async () => {
    const { startEmbeddedPostgresTestDatabase } = await import("./test-embedded-postgres.js");
    configureStartAttempts(1);

    const db = await startEmbeddedPostgresTestDatabase("paperclip-retry-test-");

    expect(startAttempts.callCount).toBe(2);
    expect(startAttempts.constructedDataDirs).toHaveLength(2);
    const [abandonedDataDir, successfulDataDir] = startAttempts.constructedDataDirs;
    expect(abandonedDataDir).not.toBe(successfulDataDir);
    expect(fs.existsSync(abandonedDataDir)).toBe(false);
    expect(fs.existsSync(successfulDataDir)).toBe(true);

    await db.cleanup();
    expect(fs.existsSync(successfulDataDir)).toBe(false);
  });

  it("gives up after the bounded number of attempts and cleans up every abandoned dataDir", async () => {
    const { startEmbeddedPostgresTestDatabase } = await import("./test-embedded-postgres.js");
    configureStartAttempts(Number.POSITIVE_INFINITY);

    await expect(startEmbeddedPostgresTestDatabase("paperclip-retry-exhausted-")).rejects.toThrow(
      /Failed to start embedded PostgreSQL test database/,
    );

    expect(startAttempts.callCount).toBe(5);
    expect(startAttempts.constructedDataDirs).toHaveLength(5);
    for (const dataDir of startAttempts.constructedDataDirs) {
      expect(fs.existsSync(dataDir)).toBe(false);
    }
  });

  it("does not retry a non-collision failure", async () => {
    vi.resetModules();
    vi.doMock("embedded-postgres", () => {
      class FailingEmbeddedPostgres {
        constructor(options: FakeCtorOptions) {
          startAttempts.constructedDataDirs.push(options.databaseDir);
        }
        async initialise(): Promise<void> {}
        async start(): Promise<void> {
          startAttempts.callCount += 1;
          throw new Error("Postgres cannot run as a root user.");
        }
        async stop(): Promise<void> {}
      }
      return { default: FailingEmbeddedPostgres };
    });

    const { startEmbeddedPostgresTestDatabase } = await import("./test-embedded-postgres.js");

    await expect(startEmbeddedPostgresTestDatabase("paperclip-no-retry-test-")).rejects.toThrow(
      /Postgres cannot run as a root user/,
    );
    expect(startAttempts.callCount).toBe(1);
    expect(fs.existsSync(startAttempts.constructedDataDirs[0])).toBe(false);

    vi.doUnmock("embedded-postgres");
    vi.resetModules();
  });
});
