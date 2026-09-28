import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { HostToWorkerMethods } from "@paperclipai/plugin-sdk";
import { companies, createDb, pluginLogs, plugins } from "@paperclipai/db";
import {
  bufferPluginLogEntry,
  flushPluginLogBuffer,
} from "../services/plugin-host-services.js";
import {
  createPluginWorkerManager,
  type PluginWorkerLogPersistSink,
} from "../services/plugin-worker-manager.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const LOGGER_EMIT_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-logger-emit.cjs");

// Synthetic, shape-valid credential fixtures for the persist-sink redaction
// regression (§26.1). These are NOT live values — they only exercise the
// shared secret-pattern recognisers (same set the pino host-log path uses).
const SYNTH_GITHUB_PAT = `github_pat_${"A".repeat(36)}`;
const SYNTH_GITHUB_PAT_MARKER = "<redacted github_pat>";
const SYNTH_AWS_KEY = `AKIA${"2".repeat(16)}`;
const SYNTH_AWS_KEY_MARKER = "<redacted aws_access_key>";

const TEST_MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

/**
 * §26.1 regression: worker `ctx.logger` calls arrive at the host as `log`
 * JSON-RPC notifications, but the notification handler only wrote a host log
 * line — nothing reached `plugin_logs`, so the operator logs panel was blind
 * to every plugin error. These tests cover the worker-notification → persist
 * path end-to-end: a real fixture worker child, the manager's persist sink,
 * the shared `bufferPluginLogEntry` buffer, and the flush into `plugin_logs`.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describe("worker log notification attribution (sink contract, no db)", () => {
  it("hands the dispatch's company and RAW meta to the persist sink", async () => {
    const sinkEntries: Array<Record<string, unknown>> = [];
    const sink: PluginWorkerLogPersistSink = (entry) => {
      sinkEntries.push({ ...entry });
    };
    const manager = createPluginWorkerManager({ workerLogPersist: sink });
    const pluginId = randomUUID();

    const handle = await manager.startWorker(pluginId, {
      entrypointPath: LOGGER_EMIT_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
    });

    try {
      // A company-scoped dispatch: the scope the host derives from params is
      // what a dispatch-scoped worker log must be pinned to.
      await handle.call("getData", {
        companyId: "company-a",
        mode: "dispatch-log",
      } as unknown as HostToWorkerMethods["getData"][0]);

      expect(sinkEntries.length).toBe(1);
      const entry = sinkEntries[0]!;
      expect(entry.pluginId).toBe(pluginId);
      expect(entry.companyId).toBe("company-a");
      expect(entry.level).toBe("error");
      expect(entry.message).toBe("evt.dispatch_failed");
      // RAW meta — sanitisation is the persist side's job (single semantics).
      expect(entry.meta).toEqual({
        plugin: "test.plugin",
        method: "upload_gcode",
        error: "config.get denied: missing invocation scope",
      });
    } finally {
      await manager.stopAll().catch(() => undefined);
    }
  });

  it("attributes an id-less proactive log to no company (null) and never throws into the notification path", async () => {
    const sinkEntries: Array<Record<string, unknown>> = [];
    const sink: PluginWorkerLogPersistSink = (entry) => {
      sinkEntries.push({ ...entry });
      if (sinkEntries.length === 1) throw new Error("sink boom");
    };
    const manager = createPluginWorkerManager({ workerLogPersist: sink });
    const pluginId = randomUUID();

    const handle = await manager.startWorker(pluginId, {
      entrypointPath: LOGGER_EMIT_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
    });

    try {
      // The dispatch itself must resolve even though the sink throws —
      // a persist failure may never break the worker notification path.
      await handle.call("getData", { companyId: "company-a", mode: "proactive-log" } as unknown as HostToWorkerMethods["getData"][0]);

      // The proactive log was emitted id-less AFTER... actually DURING the
      // dispatch, but it echoed no invocation id, so it has no resolvable
      // dispatch scope of its own and must not inherit the caller's company.
      expect(sinkEntries.length).toBe(1);
      expect(sinkEntries[0]!.companyId).toBeNull();
      expect(sinkEntries[0]!.level).toBe("warn");
      expect(sinkEntries[0]!.message).toBe("evt.proactive_warn");
    } finally {
      await manager.stopAll().catch(() => undefined);
    }
  });

  it("runs without a sink (unit-test / embedder mode): dispatch still resolves", async () => {
    const manager = createPluginWorkerManager();
    const handle = await manager.startWorker(randomUUID(), {
      entrypointPath: LOGGER_EMIT_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
    });

    try {
      const result = await handle.call("getData", { companyId: "c", mode: "dispatch-log" } as unknown as HostToWorkerMethods["getData"][0]);
      expect(result).toEqual({ ok: true });
    } finally {
      await manager.stopAll().catch(() => undefined);
    }
  });
});

describeEmbeddedPostgres("worker log notification → plugin_logs persist (§26.1)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-worker-log-persist-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // Drain the shared module buffer between tests so rows never leak across
    // cases, then clear the tables this suite owns.
    await flushPluginLogBuffer();
    await db.delete(pluginLogs);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPluginAndCompany() {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.worker-log-persist-test",
      packageName: "@paperclipai/plugin-worker-log-persist-test",
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: { ...TEST_MANIFEST, id: "paperclip.worker-log-persist-test" },
      status: "ready",
      installOrder: 1,
    });
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Tenant ${companyId.slice(0, 6)}`,
      issuePrefix: issuePrefix(companyId),
    });
    return { pluginId, companyId };
  }

  function managerPersistingTo(dbInstance: ReturnType<typeof createDb>) {
    return (entry: { pluginId: string; companyId: string | null; level: string; message: string; meta: Record<string, unknown> | null }) =>
      bufferPluginLogEntry({ db: dbInstance, ...entry });
  }

  async function rowsFor(message: string) {
    return db.select().from(pluginLogs).where(eq(pluginLogs.message, message));
  }

  it("persists a dispatch-scoped worker ctx.logger.error to plugin_logs with plugin/method/error meta (AC1)", async () => {
    const { pluginId, companyId } = await seedPluginAndCompany();
    const manager = createPluginWorkerManager({ workerLogPersist: managerPersistingTo(db) });

    const handle = await manager.startWorker(pluginId, {
      entrypointPath: LOGGER_EMIT_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
    });

    try {
      await handle.call("getData", { companyId, mode: "dispatch-log" } as unknown as HostToWorkerMethods["getData"][0]);
      await flushPluginLogBuffer();

      const rows = await rowsFor("evt.dispatch_failed");
      expect(rows.length).toBe(1);
      const row = rows[0]!;
      expect(row.pluginId).toBe(pluginId);
      expect(row.companyId).toBe(companyId);
      expect(row.level).toBe("error");
      expect(row.message).toBe("evt.dispatch_failed");
      expect(row.meta).toEqual({
        plugin: "test.plugin",
        method: "upload_gcode",
        error: "config.get denied: missing invocation scope",
      });
    } finally {
      await manager.stopAll().catch(() => undefined);
    }
  });

  it("persists a proactive id-less worker log as instance-scope (companyId NULL)", async () => {
    const { pluginId } = await seedPluginAndCompany();
    const manager = createPluginWorkerManager({ workerLogPersist: managerPersistingTo(db) });

    const handle = await manager.startWorker(pluginId, {
      entrypointPath: LOGGER_EMIT_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
    });

    try {
      // No companyId on the dispatch → no invocation scope at all; the
      // id-less log has no claim to any company and must persist instance-scoped.
      await handle.call("getData", { mode: "proactive-log" } as unknown as HostToWorkerMethods["getData"][0]);
      await flushPluginLogBuffer();

      const rows = await rowsFor("evt.proactive_warn");
      expect(rows.length).toBe(1);
      expect(rows[0]!.companyId).toBeNull();
      expect(rows[0]!.level).toBe("warn");
      expect(rows[0]!.meta).toEqual({ plugin: "test.plugin" });
    } finally {
      await manager.stopAll().catch(() => undefined);
    }
  });

  it("sanitises before persisting: reserved pino keys stripped, oversize meta capped, nothing unsanitised stored (AC3)", async () => {
    const { pluginId, companyId } = await seedPluginAndCompany();
    const manager = createPluginWorkerManager({ workerLogPersist: managerPersistingTo(db) });

    const handle = await manager.startWorker(pluginId, {
      entrypointPath: LOGGER_EMIT_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
    });

    try {
      // Reserved pino keys must not survive into the stored meta...
      await handle.call("getData", {
        companyId,
        mode: "dispatch-log",
        message: "evt.reserved_keys",
        meta: { level: "hijack", v: "hijack", plugin: "test.plugin", error: "still here" },
      } as unknown as HostToWorkerMethods["getData"][0]);
      // ...and an oversize meta must be replaced by the cap marker, not stored.
      await handle.call("getData", {
        companyId,
        mode: "dispatch-log",
        message: "evt.oversize_meta",
        meta: { blob: "x".repeat(60_000) },
      } as unknown as HostToWorkerMethods["getData"][0]);
      await flushPluginLogBuffer();

      const reserved = await rowsFor("evt.reserved_keys");
      expect(reserved.length).toBe(1);
      expect(reserved[0]!.meta).toEqual({ plugin: "test.plugin", error: "still here" });

      const oversize = await rowsFor("evt.oversize_meta");
      expect(oversize.length).toBe(1);
      expect(oversize[0]!.meta).toEqual({
        _sanitised: true,
        _error: "meta exceeded 50000 chars",
      });
    } finally {
      await manager.stopAll().catch(() => undefined);
    }
  });

  it("pattern-redacts shape-valid secrets in meta and message before persisting (persist-sink redaction)", async () => {
    const { pluginId, companyId } = await seedPluginAndCompany();
    const manager = createPluginWorkerManager({ workerLogPersist: managerPersistingTo(db) });

    const handle = await manager.startWorker(pluginId, {
      entrypointPath: LOGGER_EMIT_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
    });

    try {
      // A worker logs a message and meta that embed shape-valid credential
      // values (synthetic fixtures — the same recognisers the pino host-log
      // path uses). The persisted row must carry only the class markers; no
      // substring of either synthetic value may survive anywhere in the row.
      await handle.call("getData", {
        companyId,
        mode: "dispatch-log",
        message: `evt.leaky_message token=${SYNTH_GITHUB_PAT}`,
        meta: {
          plugin: "test.plugin",
          note: `aws=${SYNTH_AWS_KEY}`,
          nested: { deep: SYNTH_GITHUB_PAT },
        },
      } as unknown as HostToWorkerMethods["getData"][0]);
      await flushPluginLogBuffer();

      const rows = await db
        .select()
        .from(pluginLogs)
        .where(and(eq(pluginLogs.pluginId, pluginId), like(pluginLogs.message, "evt.leaky_message%")));
      expect(rows.length).toBe(1);
      const row = rows[0]!;
      expect(row.message).toBe(`evt.leaky_message token=${SYNTH_GITHUB_PAT_MARKER}`);
      expect(row.meta).toEqual({
        plugin: "test.plugin",
        note: `aws=${SYNTH_AWS_KEY_MARKER}`,
        nested: { deep: SYNTH_GITHUB_PAT_MARKER },
      });
      // Defense in depth: neither raw synthetic value survives anywhere.
      const serialised = JSON.stringify(row);
      expect(serialised).not.toContain(SYNTH_GITHUB_PAT);
      expect(serialised).not.toContain(SYNTH_AWS_KEY);
    } finally {
      await manager.stopAll().catch(() => undefined);
    }
  });

  it("normalises the worker-controlled level to the known set before persisting", async () => {
    const { pluginId, companyId } = await seedPluginAndCompany();

    // The sink receives plugin-controlled level strings that are used as a
    // read filter (`GET /api/plugins/:id/logs?level=`), so only the known set
    // may persist; anything else collapses to "info". "metric" stays: it is
    // host-minted by `metrics.write` (§26: queryable alongside logs).
    bufferPluginLogEntry({ db, pluginId, companyId, level: "VERBOSE", message: "evt.level_uppercase" });
    bufferPluginLogEntry({ db, pluginId, companyId, level: "totally-bogus", message: "evt.level_bogus" });
    bufferPluginLogEntry({ db, pluginId, companyId, level: undefined, message: "evt.level_missing" });
    bufferPluginLogEntry({ db, pluginId, companyId, level: "metric", message: "evt.level_metric" });
    bufferPluginLogEntry({ db, pluginId, companyId, level: "debug", message: "evt.level_debug" });
    await flushPluginLogBuffer();

    async function levelFor(message: string) {
      const rows = await db.select().from(pluginLogs).where(eq(pluginLogs.message, message));
      expect(rows.length).toBe(1);
      return rows[0]!.level;
    }

    expect(await levelFor("evt.level_uppercase")).toBe("info");
    expect(await levelFor("evt.level_bogus")).toBe("info");
    expect(await levelFor("evt.level_missing")).toBe("info");
    expect(await levelFor("evt.level_metric")).toBe("metric");
    expect(await levelFor("evt.level_debug")).toBe("debug");
  });
});
