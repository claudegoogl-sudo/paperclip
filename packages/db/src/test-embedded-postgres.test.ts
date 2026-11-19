import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { inspectMigrations } from "./client.js";
import { drainTestPostgresOwners, TestPostgresShutdownError } from "./test-postgres-owner.js";
import {
  __embeddedPostgresStartMaxAttemptsForTests as MAX_ATTEMPTS,
  __embeddedPostgresTemplateRootDirForTests as templateRootDir,
  __isUsableEmbeddedPostgresTemplateForTests as isUsableTemplate,
  __lastEmbeddedPostgresStartModeForTests as lastStartMode,
  __resetEmbeddedPostgresTemplateStateForTests as resetTemplateState,
  __setEmbeddedPostgresCtorProviderForTests,
  __startEmbeddedPostgresWithRetryForTests as startWithRetry,
  computeEmbeddedPostgresTemplateKey,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const originalAdminUrl = process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL;
delete process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL;
afterAll(() => {
  if (originalAdminUrl !== undefined) process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL = originalAdminUrl;
});

// A fake embedded-postgres constructor. It records every constructed instance so
// the test can assert the retry uses a fresh port and a fresh data directory each
// attempt. `start()` emits the same output the real cluster writes for a port
// conflict, then rejects with an empty message (the real rejection shape). The
// option type matches the real constructor so no type cast is needed.
type FakeOptions = {
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

  it("does not start a replacement when a copied cluster cannot stop", { timeout: EMBEDDED_POSTGRES_TEST_TIMEOUT_MS }, async () => {
    delete process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
    const ready = await startEmbeddedPostgresTestDatabase("paperclip-template-stop-ready-");
    await ready.cleanup();
    const { ctor, constructed } = makeFakeCtor(Number.POSITIVE_INFINITY);
    let stops = 0;
    class FailedStopPostgres extends ctor {
      async stop(): Promise<void> {
        if (++stops === 1) throw new Error("owned stop failed");
      }
    }
    __setEmbeddedPostgresCtorProviderForTests(async () => FailedStopPostgres);
    try {
      await expect(startEmbeddedPostgresTestDatabase("paperclip-template-stop-fail-")).rejects.toBeInstanceOf(TestPostgresShutdownError);
      expect(constructed).toHaveLength(1);
      expect(fs.existsSync(constructed[0].databaseDir)).toBe(true);
    } finally {
      await drainTestPostgresOwners();
      __setEmbeddedPostgresCtorProviderForTests(null);
      for (const options of constructed) fs.rmSync(path.dirname(options.databaseDir), { recursive: true, force: true });
    }
  });

  it("publishes a complete template and starts suites from a copy of it", { timeout: EMBEDDED_POSTGRES_TEST_TIMEOUT_MS }, async () => {
    // This test covers the template path, so it enables the cache even when
    // the suite runs under PAPERCLIP_TEST_POSTGRES_TEMPLATE=0. The first
    // start then builds the template if the support probe did not.
    delete process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;

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

  it("fails the suite when PostgreSQL cannot allocate semaphores", async () => {
    const original = process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
    process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE = "0";
    const { ctor, constructed } = makeFakeCtor(Number.POSITIVE_INFINITY);
    class ExhaustedPostgres extends ctor {
      async start(): Promise<void> {
        throw new Error("could not create semaphores: No space left on device (semget)");
      }
    }
    __setEmbeddedPostgresCtorProviderForTests(async () => ExhaustedPostgres);
    resetTemplateState();
    try {
      await expect(getEmbeddedPostgresTestSupport()).rejects.toThrow("could not create semaphores");
      expect(constructed).toHaveLength(1);
    } finally {
      if (original === undefined) delete process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
      else process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE = original;
    }
  });

  it("still reports an explicitly unsupported platform as unsupported", async () => {
    const original = process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
    process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE = "0";
    __setEmbeddedPostgresCtorProviderForTests(async () => {
      throw new Error('Unsupported arch "test-cpu" for platform "test-os"');
    });
    resetTemplateState();
    try {
      expect(await getEmbeddedPostgresTestSupport()).toMatchObject({
        supported: false,
        reason: expect.stringContaining('Unsupported arch "test-cpu"'),
      });
    } finally {
      if (original === undefined) delete process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
      else process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE = original;
    }
  });

  it("falls through to the fresh probe instead of reporting the host as unsupported", { timeout: EMBEDDED_POSTGRES_TEST_TIMEOUT_MS }, async () => {
    const originalTemplateSetting = process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
    delete process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
    const scratch = useScratchTmpdir("paperclip-template-build-fail-");
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      // This test runs on every platform, so check the redirect took effect
      // before asserting on paths under it.
      expect(os.tmpdir()).toBe(scratch.scratch);
      // The fake cluster "starts" without listening, so the template build
      // fails after the start, at the migration step, the way a broken
      // migration would. A real broken migration then fails the suite on
      // the fresh path instead of being hidden by `describe.skip`.
      const { ctor, constructed } = makeFakeCtor(0);
      __setEmbeddedPostgresCtorProviderForTests(async () => ctor);
      resetTemplateState();

    vi.doUnmock("embedded-postgres");
    vi.resetModules();
  });
});
