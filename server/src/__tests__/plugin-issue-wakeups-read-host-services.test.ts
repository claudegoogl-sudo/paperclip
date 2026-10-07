import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, plugins } from "@paperclipai/db";
import {
  CapabilityDeniedError,
  createHostClientHandlers,
} from "../../../packages/plugins/sdk/src/host-client-factory.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const PLUGIN_KEY = "paperclip.liveness-test";

function createEventBusStub() {
  return { forPlugin() { return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }; } } as any;
}

describe("issues.listWakeupRequests capability gate", () => {
  it("denies a plugin without issue.wakeups.read (issues.read does not imply it)", async () => {
    const listWakeupRequests = vi.fn(async () => []);
    const handlers = createHostClientHandlers({
      pluginId: PLUGIN_KEY,
      capabilities: ["issues.read", "issue.subtree.read"],
      services: { issues: { listWakeupRequests } } as any,
    });
    await expect(
      (handlers as any)["issues.listWakeupRequests"]({ companyId: randomUUID(), issueIds: [randomUUID()] }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(listWakeupRequests).not.toHaveBeenCalled();
  });
});

describeEmbeddedPostgres("issues.listWakeupRequests host handler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-wakeups-read-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture() {
    const [companyA, companyB] = await Promise.all(["WKA", "WKB"].map((prefix) =>
      db.insert(companies)
        .values({ name: `${prefix} ${randomUUID()}`, issuePrefix: `${prefix}${randomUUID().slice(0, 5).toUpperCase()}` })
        .returning().then((rows) => rows[0]!)));
    const [agentA, agentB] = await Promise.all([companyA, companyB].map((company) =>
      db.insert(agents).values({ companyId: company.id, name: `agent-${randomUUID().slice(0, 6)}`, role: "engineer" })
        .returning().then((rows) => rows[0]!)));
    const plugin = await db.insert(plugins).values({
      pluginKey: PLUGIN_KEY, packageName: "@paperclipai/plugin-liveness-test", version: "0.1.0",
      manifestJson: { id: PLUGIN_KEY } as any, status: "ready",
    }).returning().then((rows) => rows[0]!);
    const issueX = randomUUID();
    const issueY = randomUUID();
    const now = Date.now();
    const ago = (minutes: number) => new Date(now - minutes * 60_000);
    await db.insert(agentWakeupRequests).values([
      { companyId: companyA.id, agentId: agentA.id, source: "assignment", reason: "issue_assigned", status: "queued",
        payload: { issueId: issueX, secretish: "never-returned" }, idempotencyKey: "idem-1", requestedAt: ago(1) },
      { companyId: companyA.id, agentId: agentA.id, source: "automation", reason: "deferred", status: "deferred_issue_execution",
        payload: { issueId: issueY }, requestedAt: ago(5) },
      { companyId: companyA.id, agentId: agentA.id, source: "recovery", reason: "issue_recovery", status: "completed",
        payload: { issueId: issueX }, requestedAt: ago(30) },
      { companyId: companyA.id, agentId: agentA.id, source: "recovery", reason: "old", status: "completed",
        payload: { issueId: issueX }, requestedAt: ago(600) },
      // Same issue id under another company: must never leak into company A reads.
      { companyId: companyB.id, agentId: agentB.id, source: "assignment", reason: "other_company", status: "queued",
        payload: { issueId: issueX }, requestedAt: ago(2) },
    ]);
    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());
    return { companyA, companyB, agentA, issueX, issueY, services, ago };
  }

  it("defaults to queued + deferred_issue_execution, allow-listed fields, company-scoped", async () => {
    const { companyA, agentA, issueX, issueY, services } = await fixture();
    const rows = await services.issues.listWakeupRequests({ companyId: companyA.id, issueIds: [issueX, issueY] });
    services.dispose();
    expect(rows.map((row) => row.status)).toEqual(["queued", "deferred_issue_execution"]);
    expect(rows[0]).toEqual({
      id: expect.any(String), issueId: issueX, agentId: agentA.id, status: "queued",
      reason: "issue_assigned", source: "assignment", requestedAt: expect.any(String),
    });
    expect(Object.keys(rows[0]!).sort()).toEqual(["agentId", "id", "issueId", "reason", "requestedAt", "source", "status"]);
    expect(JSON.stringify(rows)).not.toContain("never-returned");
    expect(rows.some((row) => row.reason === "other_company")).toBe(false);
  });

  it("filters by explicit statuses", async () => {
    const { companyA, issueX, issueY, services } = await fixture();
    const rows = await services.issues.listWakeupRequests({
      companyId: companyA.id, issueIds: [issueX, issueY], statuses: ["completed"],
    });
    services.dispose();
    expect(rows.map((row) => row.reason)).toEqual(["issue_recovery", "old"]);
  });

  it("since without statuses returns recent rows of any status", async () => {
    const { companyA, companyB, issueX, services, ago } = await fixture();
    const rows = await services.issues.listWakeupRequests({
      companyId: companyA.id, issueIds: [issueX], since: ago(120).toISOString(),
    });
    const other = await services.issues.listWakeupRequests({
      companyId: companyB.id, issueIds: [issueX], since: ago(120).toISOString(),
    });
    services.dispose();
    expect(rows.map((row) => row.reason)).toEqual(["issue_assigned", "issue_recovery"]);
    expect(other.map((row) => row.reason)).toEqual(["other_company"]);
  });

  it("requires companyId and bounds issueIds and rows", async () => {
    const { companyA, issueX, services } = await fixture();
    await expect(services.issues.listWakeupRequests({ issueIds: [issueX] } as any)).rejects.toThrow(/companyId is required/);
    await expect(services.issues.listWakeupRequests({
      companyId: companyA.id, issueIds: Array.from({ length: 201 }, () => randomUUID()),
    })).rejects.toThrow(/exceeds limit of 200/);
    await expect(services.issues.listWakeupRequests({
      companyId: companyA.id, issueIds: [issueX], since: "not-a-date",
    })).rejects.toThrow(/since/);
    const limited = await services.issues.listWakeupRequests({
      companyId: companyA.id, issueIds: [issueX], statuses: ["queued", "completed"], limit: 1,
    });
    services.dispose();
    expect(limited).toHaveLength(1);
  });
});
