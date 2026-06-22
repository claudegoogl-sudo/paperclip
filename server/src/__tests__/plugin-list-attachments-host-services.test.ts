import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  assets,
  companies,
  createDb,
  issueAttachments,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: async () => {}, subscribe: () => {} };
    },
  } as any;
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin listAttachments tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin issues.listAttachments host service (PLA-1050)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-listattachments-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedIssue(companyId: string, identifier: string) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: `Issue ${identifier}`,
      status: "in_progress",
      priority: "medium",
      identifier,
    });
    return id;
  }

  async function seedComment(companyId: string, issueId: string, body: string) {
    const id = randomUUID();
    await db.insert(issueComments).values({ id, companyId, issueId, authorType: "system", body });
    return id;
  }

  async function seedAttachment(input: {
    companyId: string;
    issueId: string;
    issueCommentId: string | null;
    filename: string;
    contentType: string;
    byteSize: number;
  }) {
    const assetId = randomUUID();
    await db.insert(assets).values({
      id: assetId,
      companyId: input.companyId,
      provider: "plugin-artifacts",
      objectKey: `plugin-artifacts/${assetId}`,
      contentType: input.contentType,
      byteSize: input.byteSize,
      sha256: randomUUID().replace(/-/g, ""),
      originalFilename: input.filename,
    });
    await db.insert(issueAttachments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      assetId,
      issueCommentId: input.issueCommentId,
    });
    return assetId;
  }

  it("projects the curated attachment shape and lets a worker filter by issueCommentId", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, `${issuePrefix(companyId)}-1`);
    const commentA = await seedComment(companyId, issueId, "operator: see attached");
    const commentB = await seedComment(companyId, issueId, "operator: voice note");
    const assetA = await seedAttachment({
      companyId,
      issueId,
      issueCommentId: commentA,
      filename: "a.png",
      contentType: "image/png",
      byteSize: 11,
    });
    const assetVoice = await seedAttachment({
      companyId,
      issueId,
      issueCommentId: commentB,
      filename: "voice.ogg",
      contentType: "audio/ogg",
      byteSize: 22,
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.messenger", createEventBusStub());
    const rows = await services.issues.listAttachments({ issueId, companyId } as any);

    expect(rows.length).toBe(2);
    // Curated projection — storage internals are withheld.
    const sample = rows.find((row) => row.assetId === assetA)!;
    expect(sample).toMatchObject({
      companyId,
      issueId,
      issueCommentId: commentA,
      assetId: assetA,
      contentType: "image/png",
      byteSize: 11,
      originalFilename: "a.png",
    });
    expect((sample as Record<string, unknown>).objectKey).toBeUndefined();
    expect((sample as Record<string, unknown>).sha256).toBeUndefined();
    expect((sample as Record<string, unknown>).provider).toBeUndefined();

    // The comment-created consumer maps a comment to its asset id by filtering.
    const forCommentB = rows.filter((row) => row.issueCommentId === commentB).map((row) => row.assetId);
    expect(forCommentB).toEqual([assetVoice]);
  });

  it("is company-scoped: returns [] for an issue outside the caller's company", async () => {
    const tenantA = await seedCompany();
    const tenantB = await seedCompany();
    const issueB = await seedIssue(tenantB, `${issuePrefix(tenantB)}-1`);
    const commentB = await seedComment(tenantB, issueB, "tenant B note");
    await seedAttachment({
      companyId: tenantB,
      issueId: issueB,
      issueCommentId: commentB,
      filename: "secret.pdf",
      contentType: "application/pdf",
      byteSize: 99,
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.messenger", createEventBusStub());
    // Tenant A asks for tenant B's issue — the reach-check must yield nothing.
    const rows = await services.issues.listAttachments({ issueId: issueB, companyId: tenantA } as any);
    expect(rows).toEqual([]);
  });
});
