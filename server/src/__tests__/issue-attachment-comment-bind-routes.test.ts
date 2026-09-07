import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  assets,
  companies,
  createDb,
  issueAttachments,
  issueComments,
  issues,
} from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

// End-to-end coverage for the upload → comment attachment-bind contract at the
// HTTP layer: the multipart upload route creates an unbound issue_attachments
// row (issueCommentId NULL) at upload time, and the comment route's
// attachmentIds bind must adopt that row instead of silently no-oping on the
// UNIQUE(asset_id) index. Conflicts must fail the comment POST explicitly.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue attachment bind route tests: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

function createMemoryStorage() {
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
        provider: "local" as const,
        objectKey,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: createHash("sha256").update(input.body).digest("hex"),
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

describeEmbeddedPostgres("issue attachment comment-bind routes", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let app!: express.Express;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const seededCompanyIds = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-attach-bind-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    const [{ errorHandler }, { issueRoutes }] = await Promise.all([
      import("../middleware/index.js"),
      import("../routes/issues.js"),
    ]);
    const built = express();
    built.use(express.json());
    built.use((req, _res, next) => {
      const companyIds = [...seededCompanyIds];
      (req as any).actor = {
        type: "board",
        userId: "board-user-a",
        userName: "Board User",
        userEmail: "board-user-a@example.com",
        companyIds,
        memberships: companyIds.map((companyId) => ({
          companyId,
          membershipRole: "owner",
          status: "active",
        })),
        isInstanceAdmin: true,
        source: "session",
      };
      next();
    });
    built.use("/api", issueRoutes(db, createMemoryStorage() as never));
    built.use(errorHandler);
    app = built;
  }, 20_000);

  afterEach(async () => {
    seededCompanyIds.clear();
    // The comment/upload routes write audit rows that reference companies.
    await db.delete(activityLog);
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

  async function seedCompanyWithIssue(title: string): Promise<{
    companyId: string;
    agentId: string;
    issueId: string;
  }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    seededCompanyIds.add(companyId);
    await db.insert(companies).values({
      id: companyId,
      name: `Bind Test ${companyId.slice(0, 6)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Bind Tester",
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
      title,
      status: "todo",
      priority: "medium",
      createdByAgentId: agentId,
    });
    return { companyId, agentId, issueId };
  }

  function uploadAsset(companyId: string, issueId: string, filename: string, body: string) {
    return request(app)
      .post(`/api/companies/${companyId}/issues/${issueId}/attachments`)
      .attach("file", Buffer.from(body, "utf8"), { filename, contentType: "text/plain" });
  }

  async function postComment(issueId: string, body: Record<string, unknown>) {
    return request(app).post(`/api/issues/${issueId}/comments`).send({ body: "bind check", ...body });
  }

  async function attachmentRowFor(issueId: string, assetId: string) {
    const rows = await db
      .select()
      .from(issueAttachments)
      .where(and(eq(issueAttachments.issueId, issueId), eq(issueAttachments.assetId, assetId)));
    return rows[0] ?? null;
  }

  async function createStandaloneAsset(companyId: string, objectKey: string): Promise<string> {
    const created = await svc.createStandaloneAsset({
      companyId,
      provider: "local",
      objectKey,
      contentType: "text/plain",
      byteSize: 4,
      sha256: createHash("sha256").update(objectKey).digest("hex"),
      originalFilename: objectKey,
      createdByAgentId: null,
    });
    return created.id;
  }

  it("binds an upload-first asset to the comment that references it (upload route → comment route → attachments list)", async () => {
    const { companyId, issueId } = await seedCompanyWithIssue("upload then comment");

    const uploadRes = await uploadAsset(companyId, issueId, "notes.txt", "hello bind");
    expect(uploadRes.status).toBe(201);
    const assetId = uploadRes.body.assetId as string;
    expect(assetId).toBeTruthy();

    // Before the comment, the uploaded row is unbound.
    const before = await attachmentRowFor(issueId, assetId);
    expect(before?.issueCommentId ?? null).toBeNull();

    const commentRes = await postComment(issueId, { attachmentIds: [assetId] });
    expect(commentRes.status).toBe(201);
    const commentId = commentRes.body.id as string;

    const listRes = await request(app).get(`/api/issues/${issueId}/attachments`);
    expect(listRes.status).toBe(200);
    const row = listRes.body.find((item: { assetId: string }) => item.assetId === assetId);
    expect(row?.issueCommentId).toBe(commentId);
  });

  it("binds a standalone artifacts.create asset to the comment that references it", async () => {
    const { companyId, issueId } = await seedCompanyWithIssue("standalone bind");
    const assetId = await createStandaloneAsset(companyId, "worker-output.bin");

    const commentRes = await postComment(issueId, { attachmentIds: [assetId] });
    expect(commentRes.status).toBe(201);

    const listRes = await request(app).get(`/api/issues/${issueId}/attachments`);
    const row = listRes.body.find((item: { assetId: string }) => item.assetId === assetId);
    expect(row?.issueCommentId).toBe(commentRes.body.id);
  });

  it("rejects a comment that references an asset already bound to another comment, leaving the earlier bind intact", async () => {
    const { companyId, issueId } = await seedCompanyWithIssue("foreign comment conflict");
    const assetId = await createStandaloneAsset(companyId, "already-bound.bin");

    const first = await postComment(issueId, { attachmentIds: [assetId] });
    expect(first.status).toBe(201);

    const second = await postComment(issueId, { attachmentIds: [assetId] });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain(assetId);

    // No comment row was left behind by the rejected POST, and the asset stays
    // bound to the first comment only.
    const comments = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0].id).toBe(first.body.id);
    const row = await attachmentRowFor(issueId, assetId);
    expect(row?.issueCommentId).toBe(first.body.id);
  });

  it("rejects a comment on another issue that references an asset uploaded to a different issue", async () => {
    const { companyId, agentId, issueId: issueA } = await seedCompanyWithIssue("upload target");
    const other = await db
      .insert(issues)
      .values({
        id: randomUUID(),
        companyId,
        title: "other issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      })
      .returning({ id: issues.id });
    const issueB = other[0].id;

    const uploadRes = await uploadAsset(companyId, issueA, "owned.txt", "owned bytes");
    expect(uploadRes.status).toBe(201);
    const assetId = uploadRes.body.assetId as string;

    const commentRes = await postComment(issueB, { attachmentIds: [assetId] });
    expect(commentRes.status).toBe(409);

    const row = await attachmentRowFor(issueA, assetId);
    expect(row?.issueCommentId ?? null).toBeNull();
  });

  it("rolls back the whole multi-asset bind when one asset conflicts", async () => {
    const { companyId, issueId } = await seedCompanyWithIssue("multi asset rollback");
    const freeAssetId = await createStandaloneAsset(companyId, "free.bin");
    const boundAssetId = await createStandaloneAsset(companyId, "bound.bin");

    const first = await postComment(issueId, { attachmentIds: [boundAssetId] });
    expect(first.status).toBe(201);

    const second = await postComment(issueId, { attachmentIds: [freeAssetId, boundAssetId] });
    expect(second.status).toBe(409);

    // The free asset must NOT have been bound by the rolled-back call.
    const freeRow = await attachmentRowFor(issueId, freeAssetId);
    expect(freeRow).toBeNull();
    const boundRow = await attachmentRowFor(issueId, boundAssetId);
    expect(boundRow?.issueCommentId).toBe(first.body.id);
  });

  it("keeps rebinding an asset to the same comment an idempotent no-op", async () => {
    const { companyId, issueId } = await seedCompanyWithIssue("same comment idempotent");
    const assetId = await createStandaloneAsset(companyId, "idem.bin");

    const commentRes = await postComment(issueId, { body: "seed comment" });
    expect(commentRes.status).toBe(201);
    const commentId = commentRes.body.id as string;

    await svc.attachAssetsToComment({ issueId, issueCommentId: commentId, assetIds: [assetId] });
    await svc.attachAssetsToComment({ issueId, issueCommentId: commentId, assetIds: [assetId] });

    const rows = await db.select().from(issueAttachments).where(eq(issueAttachments.assetId, assetId));
    expect(rows).toHaveLength(1);
    expect(rows[0].issueCommentId).toBe(commentId);
  });

  it("keeps rejecting cross-company assets as unprocessable", async () => {
    const { companyId, issueId } = await seedCompanyWithIssue("own company");
    const foreign = await seedCompanyWithIssue("foreign company");
    const foreignAssetId = await createStandaloneAsset(foreign.companyId, "foreign.bin");

    await expect(
      svc.attachAssetsToComment({ issueId, issueCommentId: randomUUID(), assetIds: [foreignAssetId] }),
    ).rejects.toThrow("same company");
    expect(await attachmentRowFor(issueId, foreignAssetId)).toBeNull();
  });
});
