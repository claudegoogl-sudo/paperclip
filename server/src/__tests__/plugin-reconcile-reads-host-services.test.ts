import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  approvals,
  companies,
  createDb,
  issues,
  issueThreadInteractions,
  plugins,
  pluginCompanySettings,
  pluginConfig,
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

describeEmbeddedPostgres("plugin reconcile reads host services", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-reconcile-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(approvals);
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

  async function installPlugin(status: "ready" | "uninstalled" | "disabled" = "ready") {
    return db
      .insert(plugins)
      .values({
        pluginKey: PLUGIN_KEY,
        packageName: "@paperclipai/plugin-messenger",
        version: "0.1.0",
        manifestJson: { id: PLUGIN_KEY } as any,
        status,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function createIssue(companyId: string, title: string) {
    return db
      .insert(issues)
      .values({ companyId, title })
      .returning()
      .then((rows) => rows[0]!);
  }

  it("returns only pending board approvals, field-minimized (drops PII, seeds missed blockers)", async () => {
    const company = await createCompany("REC");
    const plugin = await installPlugin();

    // A blocker created while the plugin was DOWN — never seen on the event
    // stream, so reconcile must surface it.
    await db.insert(approvals).values({
      companyId: company.id,
      type: "budget_overage",
      status: "pending",
      requestedByUserId: "user-private-123",
      decidedByUserId: "decider-private-456",
      decisionNote: "internal note",
      payload: { incidentId: "inc-1" },
    });
    // Already resolved on the board — must be dropped from the snapshot.
    await db.insert(approvals).values({
      companyId: company.id,
      type: "hire_agent",
      status: "approved",
      payload: { agentId: "a-1" },
    });

    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());
    // The fork reconcile contract lives on the fork-only `approvals.listPending`
    // read; upstream's general `approvals.list` surface stays byte-compatible.
    const result = await services.approvals.listPending({ companyId: company.id });
    services.dispose();

    expect(result).toHaveLength(1);
    const [row] = result;
    expect(row.type).toBe("budget_overage");
    expect(row.status).toBe("pending");
    expect(typeof row.createdAt).toBe("string");
    expect(row.payload).toMatchObject({ incidentId: "inc-1" });
    // Field minimization: no requester/decider user ids, no decision note.
    expect(row).not.toHaveProperty("requestedByUserId");
    expect(row).not.toHaveProperty("decidedByUserId");
    expect(row).not.toHaveProperty("decisionNote");
  });

  it("returns only pending issue interactions, field-minimized", async () => {
    const company = await createCompany("REC");
    const plugin = await installPlugin();
    const issue = await createIssue(company.id, "Blocked issue");

    await db.insert(issueThreadInteractions).values({
      companyId: company.id,
      issueId: issue.id,
      kind: "request_confirmation",
      status: "pending",
      title: "Confirm deploy",
      summary: "Operator sign-off needed",
      createdByUserId: "user-private-789",
      payload: { prompt: "ok?" } as any,
    });
    await db.insert(issueThreadInteractions).values({
      companyId: company.id,
      issueId: issue.id,
      kind: "ask_user_questions",
      status: "resolved",
      title: "Resolved one",
      payload: { questions: [] } as any,
    });

    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());
    const result = await services.interactions.list({ companyId: company.id });
    services.dispose();

    expect(result).toHaveLength(1);
    const [row] = result;
    expect(row.issueId).toBe(issue.id);
    expect(row.kind).toBe("request_confirmation");
    expect(row.status).toBe("pending");
    expect(row.title).toBe("Confirm deploy");
    expect(row.summary).toBe("Operator sign-off needed");
    expect(typeof row.createdAt).toBe("string");
    expect(row).not.toHaveProperty("payload");
    expect(row).not.toHaveProperty("createdByUserId");
  });

  it("fails closed on a missing/empty companyId rather than returning an empty list", async () => {
    const plugin = await installPlugin();
    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());

    await expect(services.approvals.listPending({ companyId: "" })).rejects.toThrow();
    await expect(services.interactions.list({ companyId: "   " } as any)).rejects.toThrow();
    services.dispose();
  });

  it("fails closed for an unknown company", async () => {
    const plugin = await installPlugin();
    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());

    await expect(
      services.approvals.listPending({ companyId: randomUUID() }),
    ).rejects.toThrow("Company not found");
    services.dispose();
  });

  it("fails closed when the plugin install record is uninstalled", async () => {
    const company = await createCompany("REC");
    const plugin = await installPlugin("uninstalled");
    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());

    await expect(
      services.approvals.listPending({ companyId: company.id }),
    ).rejects.toThrow("not available");
    services.dispose();
  });

  it("fails closed when the plugin is explicitly disabled for the company", async () => {
    const company = await createCompany("REC");
    const plugin = await installPlugin();
    await db.insert(pluginCompanySettings).values({
      companyId: company.id,
      pluginId: plugin.id,
      enabled: false,
    });
    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());

    await expect(
      services.interactions.list({ companyId: company.id }),
    ).rejects.toThrow("disabled");
    services.dispose();
  });

  it("allows the read when a company settings row exists with enabled=true (default-ON model)", async () => {
    const company = await createCompany("REC");
    const plugin = await installPlugin();
    await db.insert(pluginCompanySettings).values({
      companyId: company.id,
      pluginId: plugin.id,
      enabled: true,
    });
    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());

    await expect(services.approvals.listPending({ companyId: company.id })).resolves.toEqual([]);
    services.dispose();
  });

  it("config.getForServiceScope fails closed for an unprovisioned company (negative test)", async () => {
    // The fork-only background config read runs the same real availability
    // gate as the reconcile reads: unknown company / uninstalled / disabled
    // plugin all deny rather than serve config.
    const company = await createCompany("REC");
    const uninstalled = await installPlugin("uninstalled");
    const services = buildHostServices(db, uninstalled.id, PLUGIN_KEY, createEventBusStub());
    await expect(
      services.config.getForServiceScope({ companyId: company.id }),
    ).rejects.toThrow("not available");
    services.dispose();
  });

  it("config.getForServiceScope serves the effective (override-merged) config for a provisioned company", async () => {
    const company = await createCompany("REC");
    const plugin = await installPlugin();
    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());
    await db.insert(pluginCompanySettings).values({
      companyId: company.id,
      pluginId: plugin.id,
      enabled: true,
    });
    await expect(
      services.config.getForServiceScope({ companyId: company.id }),
    ).resolves.toEqual({});
    services.dispose();
  });

  it("general config.get stays base-only (upstream parity) even when a per-tenant override exists", async () => {
    // Upstream (v2026.824.1) serves `configRow?.configJson ?? {}` on the
    // general `config.get` surface. The override merge is a fork-only behavior
    // and must stay on `config.getForServiceScope`, so pin the general
    // surface to base-only here.
    const company = await createCompany("REC");
    const plugin = await installPlugin();
    await db.insert(pluginConfig).values({
      pluginId: plugin.id,
      companyId: company.id,
      configJson: { label: "base-value" },
    });
    await db.insert(pluginCompanySettings).values({
      companyId: company.id,
      pluginId: plugin.id,
      enabled: true,
      settingsJson: { configOverrides: { label: "override-value" } },
    });
    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());

    await expect(services.config.get({ companyId: company.id })).resolves.toEqual({
      label: "base-value",
    });
    // The merged view remains on the fork-only background read.
    await expect(
      services.config.getForServiceScope({ companyId: company.id }),
    ).resolves.toEqual({ label: "override-value" });
    services.dispose();
  });
});
