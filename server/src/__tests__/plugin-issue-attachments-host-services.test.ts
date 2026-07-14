import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assets,
  companies,
  createDb,
  issueAttachments,
  issues,
  plugins,
  pluginCompanySettings,
} from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
    },
  } as any;
}

const PLUGIN_KEY = "paperclip.messenger";

// The host bridge issues.listAttachments underpins outbound media relay. A prior
// SDK reset silently dropped it, which killed the relay across every company.
// These tests lock in the tenant scoping and the deliberate field-minimization
// (raw storage addressing withheld).
describeEmbeddedPostgres("plugin issues.listAttachments host services", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-attachments-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(issues);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix: string) {
    return db
      .insert(companies)
      .values({
        name: `${prefix} ${randomUUID()}`,
        issuePrefix: `${prefix}${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function installPlugin() {
    return db
      .insert(plugins)
      .values({
        pluginKey: PLUGIN_KEY,
        packageName: "@paperclipai/plugin-messenger",
        version: "0.1.0",
        manifestJson: { id: PLUGIN_KEY } as any,
        status: "ready",
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function createIssue(companyId: string, title: string) {
    return db.insert(issues).values({ companyId, title }).returning().then((rows) => rows[0]!);
  }

  async function attachAsset(
    companyId: string,
    issueId: string,
    overrides: Partial<{ originalFilename: string; contentType: string; byteSize: number }> = {},
  ) {
    const asset = await db
      .insert(assets)
      .values({
        companyId,
        provider: "local_disk",
        objectKey: `issues/${issueId}/${randomUUID()}`,
        contentType: overrides.contentType ?? "application/zip",
        byteSize: overrides.byteSize ?? 2048,
        sha256: "sha256-sample-secret",
        originalFilename: overrides.originalFilename ?? "gerber-bom-cpl.zip",
      })
      .returning()
      .then((rows) => rows[0]!);
    const attachment = await db
      .insert(issueAttachments)
      .values({ companyId, issueId, assetId: asset.id })
      .returning()
      .then((rows) => rows[0]!);
    return { asset, attachment };
  }

  it("returns attachment rows for an in-company issue, withholding raw storage addressing", async () => {
    const company = await createCompany("ATT");
    const plugin = await installPlugin();
    const issue = await createIssue(company.id, "Deliverable relay");
    const { asset } = await attachAsset(company.id, issue.id, {
      originalFilename: "COP-47-gerbers.zip",
      contentType: "application/zip",
      byteSize: 4096,
    });

    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());
    const result = await services.issues.listAttachments({ issueId: issue.id, companyId: company.id });
    services.dispose();

    expect(result).toHaveLength(1);
    const [row] = result;
    expect(row.assetId).toBe(asset.id);
    expect(row.issueId).toBe(issue.id);
    expect(row.companyId).toBe(company.id);
    expect(row.issueCommentId).toBeNull();
    expect(row.contentType).toBe("application/zip");
    expect(row.byteSize).toBe(4096);
    expect(row.originalFilename).toBe("COP-47-gerbers.zip");
    // Field minimization: raw storage addressing and creator identity are withheld.
    expect(row).not.toHaveProperty("provider");
    expect(row).not.toHaveProperty("objectKey");
    expect(row).not.toHaveProperty("sha256");
    expect(row).not.toHaveProperty("createdByAgentId");
    expect(row).not.toHaveProperty("createdByUserId");
    expect(row).not.toHaveProperty("updatedAt");
    expect(JSON.stringify(result)).not.toContain("sha256-sample-secret");
  });

  it("is tenant-scoped: returns [] for an issue outside the requested company", async () => {
    const companyA = await createCompany("ATTA");
    const companyB = await createCompany("ATTB");
    const plugin = await installPlugin();
    const issue = await createIssue(companyA.id, "Company A issue");
    await attachAsset(companyA.id, issue.id);

    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());
    const foreign = await services.issues.listAttachments({ issueId: issue.id, companyId: companyB.id });
    services.dispose();

    expect(foreign).toEqual([]);
  });

  it("fails closed on a missing/empty companyId", async () => {
    const plugin = await installPlugin();
    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());

    await expect(
      services.issues.listAttachments({ issueId: randomUUID(), companyId: "" }),
    ).rejects.toThrow();
    services.dispose();
  });
});
