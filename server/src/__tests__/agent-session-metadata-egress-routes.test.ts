import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  companies,
  createDb,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.doMock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({
    type: "process",
    execute: vi.fn(),
    testEnvironment: vi.fn(),
  })),
  listAdapterModelProfiles: vi.fn(() => []),
  runningProcesses: new Map(),
}));

const { agentRoutes } = await import("../routes/agents.js");
const { shouldResetTaskSessionForModelChange } = await import("../services/heartbeat.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent session-metadata egress tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SESSION_METADATA_KEYS = [
  "__paperclipConfiguredModel",
  "__paperclipConfigFingerprint",
  "__paperclipConfigFingerprintVersion",
  "__paperclipConfigCategories",
  "__paperclipConfigCategoryFingerprints",
] as const;

function sessionParamsWithMetadata(configuredModel: string) {
  return {
    sessionId: `thread-${configuredModel}`,
    cwd: "/tmp/project",
    __paperclipConfiguredModel: configuredModel,
    __paperclipConfigFingerprint: "v1:sha256:abc",
    __paperclipConfigFingerprintVersion: 1,
    __paperclipConfigCategories: ["adapterConfig"],
    __paperclipConfigCategoryFingerprints: { adapterConfig: "v1:sha256:def" },
  };
}

function collectSessionMetadataKeys(params: Record<string, unknown> | null | undefined) {
  return Object.keys(params ?? {}).filter((key) =>
    (SESSION_METADATA_KEYS as readonly string[]).includes(key),
  );
}

describeEmbeddedPostgres("agent session metadata egress (runtime-state / task-sessions)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-session-metadata-egress-${randomUUID()}`);
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;

  async function seedAgentWithTaskSessions() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Session metadata egress",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SessionMetadataAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "claude-opus-5-5" },
      runtimeConfig: {},
      permissions: {},
    });
    const now = Date.now();
    // Oldest row first; the runtime-state route merges the NEWEST row's params.
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey: "issue-1",
      sessionParamsJson: sessionParamsWithMetadata("claude-opus-4"),
      sessionDisplayId: "thread-old",
      updatedAt: new Date(now - 60_000),
      createdAt: new Date(now - 60_000),
    });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey: "issue-2",
      sessionParamsJson: sessionParamsWithMetadata("claude-opus-5"),
      sessionDisplayId: "thread-new",
      updatedAt: new Date(now),
      createdAt: new Date(now),
    });
    return { companyId, agentId };
  }

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "local-board",
        userName: "Local Board",
        userEmail: null,
        isInstanceAdmin: true,
        source: "local_implicit",
      };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("session-metadata-egress-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentTaskSessions);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  it("strips __paperclip* session metadata from GET /agents/:id/runtime-state while the DB row keeps it", async () => {
    const fixture = await seedAgentWithTaskSessions();
    const res = await request(createApp()).get(`/api/agents/${fixture.agentId}/runtime-state`);

    expect(res.status).toBe(200);
    const params = res.body.sessionParamsJson as Record<string, unknown>;
    expect(params).toBeTruthy();
    // The newest task-session row (issue-2) is the merged source.
    expect(params).toMatchObject({ sessionId: "thread-claude-opus-5", cwd: "/tmp/project" });
    expect(collectSessionMetadataKeys(params)).toEqual([]);

    // The underlying DB row is untouched: internal session-reset bookkeeping
    // still reads the metadata straight from the table.
    const rows = await db
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.agentId, fixture.agentId));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.sessionParamsJson?.__paperclipConfiguredModel).toBeTruthy();
      expect(row.sessionParamsJson?.__paperclipConfigFingerprint).toBe("v1:sha256:abc");
    }
  });

  it("strips __paperclip* session metadata from every GET /agents/:id/task-sessions row", async () => {
    const fixture = await seedAgentWithTaskSessions();
    const res = await request(createApp()).get(`/api/agents/${fixture.agentId}/task-sessions`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    for (const row of res.body) {
      expect(collectSessionMetadataKeys(row.sessionParamsJson)).toEqual([]);
      // Non-metadata session params stay intact.
      expect(row.sessionParamsJson).toHaveProperty("cwd", "/tmp/project");
      expect(String(row.sessionParamsJson?.sessionId)).toMatch(/^thread-claude-opus-/);
    }
  });

  it("still resets the task session on model change using the unstripped DB params", async () => {
    const stored = sessionParamsWithMetadata("claude-opus-5");
    // Same configured model -> no reset.
    expect(
      shouldResetTaskSessionForModelChange({
        configuredModel: "claude-opus-5",
        taskSessionParams: stored,
      }),
    ).toBe(false);
    // Different configured model -> reset, reading the metadata that egress no
    // longer surfaces.
    expect(
      shouldResetTaskSessionForModelChange({
        configuredModel: "claude-opus-5-5",
        taskSessionParams: stored,
      }),
    ).toBe(true);
  });
});
