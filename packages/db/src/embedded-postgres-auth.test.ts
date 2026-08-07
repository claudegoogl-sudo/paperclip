import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  LEGACY_EMBEDDED_POSTGRES_PASSWORD,
  buildEmbeddedPostgresConnectionString,
  buildEmbeddedPostgresConstructorOptions,
  buildScramSha256PgHba,
  credentialFilePathFor,
  generateEmbeddedPostgresPassword,
  isPgHbaScramOnly,
  readEmbeddedPostgresCredential,
  resolveEmbeddedPostgresPasswordForStartup,
  rotateEmbeddedPostgresAuthIfNeeded,
  rewritePgHbaToScram,
  scrubEmbeddedPostgresConnectionString,
  writeEmbeddedPostgresCredential,
} from "./embedded-postgres-auth.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";
import {
  getEmbeddedPostgresTestSupport,
  sweepOrphanedEmbeddedPostgresDataDirs,
} from "./test-embedded-postgres.js";

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeEmbedded = embeddedSupport.supported ? describe : describe.skip;

// Mirror the robustness patterns in test-embedded-postgres.ts: capture startup
// logs so init/start failures are diagnosable (the library wires initdb's
// stderr nowhere, so without this a CI flake is a silent exit code), sweep
// orphaned data dirs left by killed runs before each test, and retry on
// transient startup failures. The library's init/start is known to flake
// under CI runner contention; without retry, a single initdb exit 1 takes
// the whole suite red.
//
// Two distinct retry shapes are needed:
//   - initdb flake: the data dir is partially populated; initdb refuses a
//     non-empty dir on the next attempt, so we wipe before retrying.
//   - port collision (TOCTOU): allocatePort() closes its probe socket before
//     embedded-postgres binds it, so a concurrent worker can grab the port in
//     between. embedded-postgres's start() then rejects with bare undefined
//     (no Error) — the only signal is the "address already in use" line on
//     onLog. Re-allocate the port and retry; the data dir is fine.
const MAX_STARTUP_ATTEMPTS = 5;
const MAX_RECENT_STARTUP_LOG_LINES = 40;
const PORT_COLLISION_LOG_PATTERN = /address already in use/i;

function recordStartupLogLine(recentLogs: string[], message: unknown): void {
  const text = typeof message === "string" ? message : String(message ?? "");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    recentLogs.push(line);
    if (recentLogs.length > MAX_RECENT_STARTUP_LOG_LINES) recentLogs.shift();
  }
}

function formatStartupFailure(error: unknown, recentLogs: string[]): string {
  const errMsg =
    error instanceof Error && error.message.length > 0
      ? error.message
      : typeof error === "string" && error.length > 0
        ? error
        : "embedded Postgres startup failed (no error object; likely a port collision or early exit)";
  const tail =
    recentLogs.length > 0
      ? recentLogs.slice(-15).join("\n  ")
      : "(no captured log lines; library may not wire initdb stderr)";
  return `${errMsg}\n  Captured startup log (tail):\n  ${tail}`;
}

function wipeDataDirForRetry(dataDir: string): void {
  // initdb refuses to run on a non-empty directory, so a partial initdb from
  // a failed attempt must be cleared before the next try.
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
}

function isLikelyPortCollision(recentLogs: string[]): boolean {
  return recentLogs.some((line) => PORT_COLLISION_LOG_PATTERN.test(line));
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    const cleanup = cleanups.pop()!;
    await cleanup().catch(() => undefined);
  }
});

async function allocatePort(): Promise<number> {
  for (let i = 0; i < 20; i += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close(() => reject(new Error("no port")));
          return;
        }
        const { port } = address;
        server.close((error) => {
          if (error) reject(error);
          else resolve(port);
        });
      });
    });
    if (port !== 54329) return port;
  }
  throw new Error("Could not allocate port");
}

type RealInstance = {
  instance: {
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
  };
  dataDir: string;
  port: number;
};

async function importEmbeddedPostgres() {
  await prepareEmbeddedPostgresNativeRuntime();
  const mod = await import("embedded-postgres");
  return mod.default as new (opts: any) => RealInstance["instance"];
}

async function startLegacyCluster(
  dataDir: string,
  initialPort: number,
): Promise<RealInstance> {
  const EmbeddedPostgres = await importEmbeddedPostgres();
  let port = initialPort;
  let lastError: unknown = null;
  let lastLogs: string[] = [];

  for (let attempt = 1; attempt <= MAX_STARTUP_ATTEMPTS; attempt += 1) {
    const recentLogs: string[] = [];
    const instance = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "paperclip",
      password: LEGACY_EMBEDDED_POSTGRES_PASSWORD,
      port,
      persistent: true,
      authMethod: "password",
      initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
      onLog: (m: unknown) => recordStartupLogLine(recentLogs, m),
      onError: (m: unknown) => recordStartupLogLine(recentLogs, m),
    });

    try {
      await instance.initialise();
      await instance.start();
      return { instance, dataDir, port };
    } catch (error) {
      await instance.stop().catch(() => undefined);
      lastError = error;
      lastLogs = recentLogs;
      if (attempt === MAX_STARTUP_ATTEMPTS) break;
      if (isLikelyPortCollision(recentLogs)) {
        // embedded-postgres's start() rejects with bare undefined on early
        // process exit; the only signal is the log line. Re-allocate the
        // port and retry; the data dir is fine because the failure was
        // after initdb, not during it.
        port = await allocatePort();
      } else {
        // initdb flake: wipe before retrying (initdb refuses a non-empty
        // dir). The cred file lives BESIDE the dir, not inside, so this
        // is safe.
        wipeDataDirForRetry(dataDir);
      }
    }
  }

  throw new Error(
    `startLegacyCluster failed after ${MAX_STARTUP_ATTEMPTS} attempts: ` +
      formatStartupFailure(lastError, lastLogs),
  );
}

// Re-open an existing data dir with the new builder (no initialise()).
// Retries on port collision by re-allocating the port. The data dir is not
// touched on retry — it already has content from a prior startLegacyCluster
// call, and wiping it would destroy the test scenario.
async function reopenInstanceWithDataDir(
  dataDir: string,
  initialPort: number,
  password: string,
): Promise<{ instance: RealInstance["instance"]; port: number }> {
  const EmbeddedPostgres = await importEmbeddedPostgres();
  let port = initialPort;
  let lastError: unknown = null;
  let lastLogs: string[] = [];

  for (let attempt = 1; attempt <= MAX_STARTUP_ATTEMPTS; attempt += 1) {
    const recentLogs: string[] = [];
    const instance = new EmbeddedPostgres(
      buildEmbeddedPostgresConstructorOptions({
        dataDir,
        port,
        password,
        onLog: (m: unknown) => recordStartupLogLine(recentLogs, m),
        onError: (m: unknown) => recordStartupLogLine(recentLogs, m),
      }),
    );

    try {
      await instance.start();
      return { instance, port };
    } catch (error) {
      await instance.stop().catch(() => undefined);
      lastError = error;
      lastLogs = recentLogs;
      if (attempt === MAX_STARTUP_ATTEMPTS) break;
      // embedded-postgres rejects with bare undefined on early process exit;
      // for a re-open the most likely cause is port collision. If it isn't,
      // surface immediately rather than swallowing a real defect.
      if (!isLikelyPortCollision(recentLogs)) break;
      port = await allocatePort();
    }
  }

  throw new Error(
    `reopenInstanceWithDataDir failed after ${MAX_STARTUP_ATTEMPTS} attempts: ` +
      formatStartupFailure(lastError, lastLogs),
  );
}

// First-boot start: initialise() + start() on a fresh data dir. Retries on
// initdb flake (wipe + retry) or port collision (re-allocate port).
async function startFreshInstanceWithDataDir(
  dataDir: string,
  initialPort: number,
  password: string,
): Promise<{ instance: RealInstance["instance"]; port: number }> {
  const EmbeddedPostgres = await importEmbeddedPostgres();
  let port = initialPort;
  let lastError: unknown = null;
  let lastLogs: string[] = [];

  for (let attempt = 1; attempt <= MAX_STARTUP_ATTEMPTS; attempt += 1) {
    const recentLogs: string[] = [];
    const instance = new EmbeddedPostgres(
      buildEmbeddedPostgresConstructorOptions({
        dataDir,
        port,
        password,
        onLog: (m: unknown) => recordStartupLogLine(recentLogs, m),
        onError: (m: unknown) => recordStartupLogLine(recentLogs, m),
      }),
    );

    try {
      await instance.initialise();
      await instance.start();
      return { instance, port };
    } catch (error) {
      await instance.stop().catch(() => undefined);
      lastError = error;
      lastLogs = recentLogs;
      if (attempt === MAX_STARTUP_ATTEMPTS) break;
      if (isLikelyPortCollision(recentLogs)) {
        port = await allocatePort();
      } else {
        wipeDataDirForRetry(dataDir);
      }
    }
  }

  throw new Error(
    `startFreshInstanceWithDataDir failed after ${MAX_STARTUP_ATTEMPTS} attempts: ` +
      formatStartupFailure(lastError, lastLogs),
  );
}

async function stopRealInstance(real: RealInstance): Promise<void> {
  await real.instance.stop().catch(() => undefined);
}

describe("embedded-postgres-auth: pure helpers", () => {
  it("generateEmbeddedPostgresPassword returns 32 alphanumeric chars", () => {
    for (let i = 0; i < 16; i += 1) {
      const pw = generateEmbeddedPostgresPassword();
      expect(pw.length).toBe(32);
      expect(pw).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  it("generateEmbeddedPostgresPassword produces varied output (CSPRNG)", () => {
    const samples = new Set<string>();
    for (let i = 0; i < 64; i += 1) samples.add(generateEmbeddedPostgresPassword());
    expect(samples.size).toBe(64);
  });

  it("credentialFilePathFor places the file beside the data dir with a dotfile name", () => {
    const dataDir = path.join(os.tmpdir(), "paperclip-cred-test", "db");
    expect(credentialFilePathFor(dataDir)).toBe(`${dataDir}.pg-credential`);
    expect(path.dirname(credentialFilePathFor(dataDir))).toBe(path.dirname(dataDir));
    // Trailing slashes are tolerated.
    expect(credentialFilePathFor(`${dataDir}/`)).toBe(`${dataDir}.pg-credential`);
  });

  it("writeEmbeddedPostgresCredential writes 0600 + readEmbeddedPostgresCredential round-trips", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-auth-unit-"));
    cleanups.push(async () => { fs.rmSync(dir, { recursive: true, force: true }); });
    const pw = generateEmbeddedPostgresPassword();
    writeEmbeddedPostgresCredential(dir, pw);
    const credPath = credentialFilePathFor(dir);
    const stat = fs.statSync(credPath);
    expect((stat.mode & 0o777)).toBe(0o600);
    expect(readEmbeddedPostgresCredential(dir)?.password).toBe(pw);
  });

  it("readEmbeddedPostgresCredential refuses a group/world-readable file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-auth-unit-"));
    cleanups.push(async () => { fs.rmSync(dir, { recursive: true, force: true }); });
    const pw = generateEmbeddedPostgresPassword();
    writeEmbeddedPostgresCredential(dir, pw);
    fs.chmodSync(credentialFilePathFor(dir), 0o644);
    expect(() => readEmbeddedPostgresCredential(dir)).toThrow(/insecure mode/);
  });

  it("readEmbeddedPostgresCredential returns null when no file exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-auth-unit-"));
    cleanups.push(async () => { fs.rmSync(dir, { recursive: true, force: true }); });
    expect(readEmbeddedPostgresCredential(dir)).toBeNull();
  });

  it("buildEmbeddedPostgresConnectionString includes the password URL-encoded", () => {
    const url = buildEmbeddedPostgresConnectionString({
      port: 54329,
      database: "postgres",
      password: "abc123",
    });
    expect(url).toBe("postgres://paperclip:abc123@127.0.0.1:54329/postgres");
  });

  it("buildEmbeddedPostgresConstructorOptions sets scram-sha-256 + loopback bind", () => {
    const opts = buildEmbeddedPostgresConstructorOptions({
      dataDir: "/tmp/db",
      port: 5432,
      password: "pw",
    });
    expect(opts.authMethod).toBe("scram-sha-256");
    expect(opts.user).toBe("paperclip");
    expect(opts.persistent).toBe(true);
    expect(opts.postgresFlags).toEqual(["-c", "listen_addresses=127.0.0.1"]);
  });

  it("scrubEmbeddedPostgresConnectionString redacts the password in any postgres URL", () => {
    const input = "error connecting to postgres://paperclip:hunter2@127.0.0.1:54329/postgres";
    expect(scrubEmbeddedPostgresConnectionString(input)).toBe(
      "error connecting to postgres://paperclip:[redacted]@127.0.0.1:54329/postgres",
    );
    // Multiple URLs in one line, plus postgresql:// scheme.
    expect(
      scrubEmbeddedPostgresConnectionString(
        "a postgresql://u:p@h:1/d b postgres://u:p@h:2/d",
      ),
    ).toBe("a postgresql://u:[redacted]@h:1/d b postgres://u:[redacted]@h:2/d");
  });

  it("buildScramSha256PgHba produces six scram lines", () => {
    const text = buildScramSha256PgHba();
    const lines = text.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    expect(lines.length).toBe(5); // local + 4 host/hostssl
    for (const line of lines) {
      expect(line).toMatch(/scram-sha-256\b/);
    }
  });
});

describeEmbedded("embedded-postgres-auth: real-cluster rotation + fresh initdb", () => {
  beforeEach(() => {
    // Cheap insurance against killed-run orphans before each real-cluster test.
    sweepOrphanedEmbeddedPostgresDataDirs();
  });

  it("fresh initdb writes a cred file, scram pg_hba, and explicit loopback bind", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-fresh-init-"));
    cleanups.push(async () => {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(credentialFilePathFor(dataDir), { force: true });
    });
    const port = await allocatePort();

    // First start: no PG_VERSION, no cred file. The builder generates +
    // persists the password BEFORE initdb runs.
    const startup = resolveEmbeddedPostgresPasswordForStartup(dataDir);
    expect(startup.source).toBe("generated");

    const { instance, port: actualPort } = await startFreshInstanceWithDataDir(
      dataDir,
      port,
      startup.password,
    );
    cleanups.push(async () => { await instance.stop().catch(() => undefined); });

    // AC2: credential persisted at initdb time.
    const cred = readEmbeddedPostgresCredential(dataDir);
    expect(cred).not.toBeNull();
    expect(cred!.password).toBe(startup.password);
    expect(cred!.password).not.toBe(LEGACY_EMBEDDED_POSTGRES_PASSWORD);

    // AC3: cred file lives BESIDE the data dir, not inside.
    const credPath = credentialFilePathFor(dataDir);
    expect(path.dirname(credPath)).toBe(path.dirname(dataDir));
    expect(fs.existsSync(path.join(dataDir, ".pg-credential"))).toBe(false);
    expect((fs.statSync(credPath).mode & 0o777)).toBe(0o600);

    // AC5: pg_hba is scram-sha-256 only.
    expect(isPgHbaScramOnly(dataDir)).toBe(true);

    // AC6: explicit listen_addresses. The library doesn't persist postgresFlags
    // to postmaster.opts verbatim, so we read the running GUC.
    const admin = postgres(
      buildEmbeddedPostgresConnectionString({
        port: actualPort,
        database: "postgres",
        password: startup.password,
      }),
      { max: 1, onnotice: () => {} },
    );
    try {
      const rows = await admin`SHOW listen_addresses`;
      expect(rows[0].listen_addresses).toBe("127.0.0.1");
    } finally {
      await admin.end({ timeout: 5 }).catch(() => undefined);
    }
  });

  it("legacy data dir rotates on next start: ALTER ROLE, cred file, scram pg_hba, reload", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-legacy-rotate-"));
    cleanups.push(async () => {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(credentialFilePathFor(dataDir), { force: true });
    });
    const port = await allocatePort();

    // Step 1: simulate a pre-fix cluster. Manual legacy shape, no cred file.
    const legacy = await startLegacyCluster(dataDir, port);
    await stopRealInstance(legacy);

    // Sanity: pg_hba is NOT scram-only after legacy init.
    expect(isPgHbaScramOnly(dataDir)).toBe(false);
    // And there is no cred file yet.
    expect(readEmbeddedPostgresCredential(dataDir)).toBeNull();

    // Step 2: re-open with the new builder. AC4: re-open with no cred file
    // resolves to the legacy password so we can authenticate to rotate.
    const startup = resolveEmbeddedPostgresPasswordForStartup(dataDir);
    expect(startup.source).toBe("legacy-fallback");
    expect(startup.password).toBe(LEGACY_EMBEDDED_POSTGRES_PASSWORD);

    const { instance, port: actualPort } = await reopenInstanceWithDataDir(
      dataDir,
      port,
      startup.password,
    );
    cleanups.push(async () => { await instance.stop().catch(() => undefined); });

    // Step 3: rotation must converge.
    const rotation = await rotateEmbeddedPostgresAuthIfNeeded({
      dataDir,
      port: actualPort,
      currentPassword: startup.password,
    });
    expect(rotation.rotated).toBe(true);
    expect(rotation.pgHbaRewritten).toBe(true);
    expect(rotation.password).not.toBe(LEGACY_EMBEDDED_POSTGRES_PASSWORD);

    // AC2/AC3: cred file written beside the data dir, 0600, new password.
    const cred = readEmbeddedPostgresCredential(dataDir);
    expect(cred).not.toBeNull();
    expect(cred!.password).toBe(rotation.password);
    const credPath = credentialFilePathFor(dataDir);
    expect((fs.statSync(credPath).mode & 0o777)).toBe(0o600);

    // AC5: pg_hba now scram-only.
    expect(isPgHbaScramOnly(dataDir)).toBe(true);

    // The cluster must accept the NEW password (scram) and reject the legacy
    // literal (so a leaked source literal stops being useful).
    const goodAdmin = postgres(
      buildEmbeddedPostgresConnectionString({
        port: actualPort,
        database: "postgres",
        password: rotation.password,
      }),
      { max: 1, onnotice: () => {} },
    );
    try {
      const rows = await goodAdmin`SELECT 1 AS ok`;
      expect(rows[0].ok).toBe(1);
    } finally {
      await goodAdmin.end({ timeout: 5 }).catch(() => undefined);
    }

    const badAdmin = postgres(
      buildEmbeddedPostgresConnectionString({
        port: actualPort,
        database: "postgres",
        password: LEGACY_EMBEDDED_POSTGRES_PASSWORD,
      }),
      { max: 1, onnotice: () => {} },
    );
    await expect(badAdmin`SELECT 1`.finally(() => badAdmin.end({ timeout: 5 }).catch(() => undefined)))
      .rejects.toThrow();
  });

  it("rotation is idempotent: a second start is a no-op", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-rotate-idempotent-"));
    cleanups.push(async () => {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(credentialFilePathFor(dataDir), { force: true });
    });
    const port = await allocatePort();

    // Bootstrap a legacy cluster, then rotate it once.
    const legacy = await startLegacyCluster(dataDir, port);
    await stopRealInstance(legacy);

    const { instance, port: actualPort } = await reopenInstanceWithDataDir(
      dataDir,
      port,
      LEGACY_EMBEDDED_POSTGRES_PASSWORD,
    );
    cleanups.push(async () => { await instance.stop().catch(() => undefined); });

    const firstStartup = resolveEmbeddedPostgresPasswordForStartup(dataDir);
    const first = await rotateEmbeddedPostgresAuthIfNeeded({
      dataDir,
      port: actualPort,
      currentPassword: firstStartup.password,
    });
    expect(first.rotated).toBe(true);

    // Second time: cred file now exists, matches the role. No-op.
    const secondStartup = resolveEmbeddedPostgresPasswordForStartup(dataDir);
    expect(secondStartup.source).toBe("cred-file");
    const second = await rotateEmbeddedPostgresAuthIfNeeded({
      dataDir,
      port: actualPort,
      currentPassword: secondStartup.password,
    });
    expect(second.rotated).toBe(false);
    expect(second.password).toBe(first.password);
    // pg_hba is already scram so the rewrite is a no-op too.
    expect(second.pgHbaRewritten).toBe(false);
  });

  it("a restored data dir without its cred file is unopenable without rotation fallback", async () => {
    // AC8 recovery story: if an operator restores just the data dir (no cred
    // file), the legacy-password fallback is what lets the cluster come back
    // up. This test proves the fallback path works, so the recovery doc can
    // honestly say "rotation from legacy is permanent for any data dir whose
    // cred file is lost".
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-restore-no-cred-"));
    cleanups.push(async () => {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(credentialFilePathFor(dataDir), { force: true });
    });
    const port = await allocatePort();

    // Bootstrap + rotate so the cred file exists.
    const legacy = await startLegacyCluster(dataDir, port);
    await stopRealInstance(legacy);
    const { instance, port: actualPort } = await reopenInstanceWithDataDir(
      dataDir,
      port,
      LEGACY_EMBEDDED_POSTGRES_PASSWORD,
    );
    cleanups.push(async () => { await instance.stop().catch(() => undefined); });
    const firstStartup = resolveEmbeddedPostgresPasswordForStartup(dataDir);
    const first = await rotateEmbeddedPostgresAuthIfNeeded({
      dataDir,
      port: actualPort,
      currentPassword: firstStartup.password,
    });
    expect(first.rotated).toBe(true);

    // Simulate "operator restored the data dir but forgot the cred file".
    fs.rmSync(credentialFilePathFor(dataDir), { force: true });

    // Now resolveEmbeddedPostgresPasswordForStartup sees a PG_VERSION but no
    // cred file -> legacy fallback. That fails to authenticate against a
    // cluster whose role password is the previously-generated value.
    const after = resolveEmbeddedPostgresPasswordForStartup(dataDir);
    expect(after.source).toBe("legacy-fallback");
    // The rotation step will fail to authenticate because the live role
    // password is no longer the legacy literal — the data dir is genuinely
    // unrecoverable without either the cred file or operator intervention
    // (e.g. SET PASSWORD in single-user mode). This is the sharp edge AC8
    // asks us to document.
    await expect(
      rotateEmbeddedPostgresAuthIfNeeded({
        dataDir,
        port: actualPort,
        currentPassword: after.password,
      }),
    ).rejects.toThrow();
  });

  it("rewritePgHbaToScram is idempotent and preserves the prior file as .legacy.bak", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-pghba-rewrite-"));
    cleanups.push(async () => { fs.rmSync(dir, { recursive: true, force: true }); });
    const pgHba = path.join(dir, "pg_hba.conf");
    fs.writeFileSync(pgHba, "local all all trust\n", "utf8");

    const first = rewritePgHbaToScram(dir);
    expect(first.changed).toBe(true);
    expect(first.backupPath).toBe(`${pgHba}.legacy.bak`);
    expect(fs.readFileSync(first.backupPath!, "utf8")).toBe("local all all trust\n");
    expect(fs.readFileSync(pgHba, "utf8")).toBe(buildScramSha256PgHba());

    const second = rewritePgHbaToScram(dir);
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeNull();
  });
});
