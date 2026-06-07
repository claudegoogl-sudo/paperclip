import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  agents,
  assets,
  companies,
  createDb,
  issueAttachments,
  issueComments,
  issues,
} from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import {
  ArtifactsError,
  createPluginArtifactsHandler,
} from "../services/plugin-artifacts-handler.ts";
import { createPluginRunContextRegistry } from "../services/plugin-run-context-registry.ts";

// logActivity is invoked for the create/fetch audit trail; stub it so the
// integration test doesn't depend on the activity-log table wiring.
vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async () => undefined),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres artifacts.create integration tests: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * Round-trip storage keyed by objectKey — proves create()'s putFile output is
 * fetchable by fetch()'s getObject. Mirrors the StorageService surface the
 * handler actually calls (putFile / getObject).
 */
function createRoundTripStorage() {
  const store = new Map<string, { body: Buffer; contentType: string }>();
  return {
    provider: "local" as const,
    async putFile(input: {
      companyId: string;
      namespace: string;
      originalFilename: string | null;
      contentType: string;
      body: Buffer;
    }) {
      const objectKey = `${input.namespace}/${randomUUID()}-${input.originalFilename ?? "file"}`;
      store.set(`${input.companyId}/${objectKey}`, {
        body: Buffer.from(input.body),
        contentType: input.contentType,
      });
      return {
        provider: "local",
        objectKey,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: "",
        originalFilename: input.originalFilename,
      };
    },
    async getObject(companyId: string, objectKey: string) {
      const entry = store.get(`${companyId}/${objectKey}`);
      if (!entry) throw new Error(`object not found: ${companyId}/${objectKey}`);
      return {
        stream: Readable.from([entry.body]),
        contentType: entry.contentType,
        contentLength: entry.body.length,
      };
    },
    async headObject() {
      throw new Error("not used");
    },
    async deleteObject() {
      // no-op
    },
  };
}

describeEmbeddedPostgres("artifacts.create → artifacts.fetch integration (PLA-888)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const PLUGIN_DB_ID = "11111111-1111-4111-8111-aaaaaaaaaaaa";

  function buildHandler(storage: ReturnType<typeof createRoundTripStorage>) {
    const registry = createPluginRunContextRegistry({ ttlMs: 60_000, sweepIntervalMs: 60_000 });
    const handler = createPluginArtifactsHandler({
      db: db as never,
      pluginDbId: PLUGIN_DB_ID,
      pluginKey: "paperclip.messenger",
      storage: storage as never,
      attachments: { getAttachmentById: svc.getAttachmentById },
      assetWriter: {
        findReusableUnattachedAsset: svc.findReusableUnattachedAsset,
        createStandaloneAsset: svc.createStandaloneAsset,
      },
      async resolveCompanyMaxBytes() {
        return 10 * 1024 * 1024;
      },
      runContextRegistry: registry,
    });
    return { handler, registry };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-artifacts-create-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyIssueComment() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Platform",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Messenger",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Inbox",
      status: "todo",
      priority: "medium",
      createdByAgentId: agentId,
    });
    const [comment] = await db
      .insert(issueComments)
      .values({ companyId, issueId, authorAgentId: agentId, body: "inbound" })
      .returning({ id: issueComments.id });
    return { companyId, agentId, issueId, commentId: comment.id };
  }

  it("stores bytes via create(), then the bound attachment is fetchable byte-for-byte", async () => {
    const { companyId, agentId, issueId, commentId } = await seedCompanyIssueComment();
    const storage = createRoundTripStorage();
    const { handler, registry } = buildHandler(storage);
    const runId = randomUUID();
    registry.register(PLUGIN_DB_ID, {
      agentId,
      companyId,
      runId,
      projectId: "proj-1",
      toolName: "relay-inbound",
      registeredAt: Date.now(),
    });

    const payload = Buffer.from("hello inbound attachment", "utf8");
    const created = await handler.create({
      companyId,
      filename: "voice.ogg",
      mimeType: "audio/ogg",
      contentBase64: payload.toString("base64"),
      runId,
    });
    expect(typeof created.attachmentId).toBe("string");

    // create() returns the standalone *asset* id; bind it to the comment the
    // way issues.createComment(attachmentIds) does to mint an issue_attachments row.
    await svc.attachAssetsToComment({
      issueId,
      issueCommentId: commentId,
      assetIds: [created.attachmentId],
    });
    const [attachmentRow] = await db
      .select({ id: issueAttachments.id })
      .from(issueAttachments);
    expect(attachmentRow?.id).toBeTruthy();

    // Fetch via the existing PLA-574 path using the issue_attachments id.
    const fetched = await handler.fetch({ attachmentId: attachmentRow!.id, runId });
    expect(fetched.contentType).toBe("audio/ogg");
    expect(fetched.byteSize).toBe(payload.length);
    expect(Buffer.from(fetched.contentBase64, "base64").equals(payload)).toBe(true);
  });

  it("a retried create() with identical bytes converges on the same asset (idempotent)", async () => {
    const { companyId, agentId } = await seedCompanyIssueComment();
    const storage = createRoundTripStorage();
    const { handler, registry } = buildHandler(storage);
    const runId = randomUUID();
    registry.register(PLUGIN_DB_ID, {
      agentId,
      companyId,
      runId,
      projectId: "proj-1",
      toolName: "relay-inbound",
      registeredAt: Date.now(),
    });

    const payload = Buffer.from("retry me", "utf8").toString("base64");
    const first = await handler.create({
      companyId,
      filename: "a.png",
      mimeType: "image/png",
      contentBase64: payload,
      runId,
    });
    const second = await handler.create({
      companyId,
      filename: "a.png",
      mimeType: "image/png",
      contentBase64: payload,
      runId,
    });
    expect(second.attachmentId).toBe(first.attachmentId);
    const assetRows = await db.select({ id: assets.id }).from(assets);
    expect(assetRows).toHaveLength(1);
  });

  it("rejects a cross-tenant companyId from a dispatch context", async () => {
    const { agentId, companyId } = await seedCompanyIssueComment();
    const storage = createRoundTripStorage();
    const { handler, registry } = buildHandler(storage);
    const runId = randomUUID();
    registry.register(PLUGIN_DB_ID, {
      agentId,
      companyId,
      runId,
      projectId: "proj-1",
      toolName: "relay-inbound",
      registeredAt: Date.now(),
    });

    await expect(
      handler.create({
        companyId: randomUUID(), // a company the dispatching agent does not own
        filename: "a.png",
        mimeType: "image/png",
        contentBase64: Buffer.from("x").toString("base64"),
        runId,
      }),
    ).rejects.toBeInstanceOf(ArtifactsError);
    const assetRows = await db.select({ id: assets.id }).from(assets);
    expect(assetRows).toHaveLength(0);
  });
});
