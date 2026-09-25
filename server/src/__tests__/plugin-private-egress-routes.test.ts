/**
 * Instance-admin private-origin opt-in routes (R1 authority, R6 audit),
 * against a real DB.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, pluginCompanySettings, plugins } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pluginPrivateEgressRoutes } from "../routes/plugin-private-egress.js";
import { errorHandler } from "../middleware/index.js";
import { loadPluginPrivateEgressOrigins } from "../services/plugin-private-egress.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping plugin private-egress route tests: ${support.reason ?? "unsupported environment"}`);
}

const PRINTER = "http://192.168.2.86:8898";

function boardActor(companyId: string, isInstanceAdmin: boolean): Express.Request["actor"] {
  return {
    type: "board",
    userId: isInstanceAdmin ? "instance-admin" : "company-admin",
    userName: null,
    userEmail: null,
    source: "session",
    isInstanceAdmin,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "admin", status: "active" }],
  } as Express.Request["actor"];
}

function agentActor(companyId: string): Express.Request["actor"] {
  return { type: "agent", agentId: "agent-1", companyId, runId: randomUUID() } as Express.Request["actor"];
}

describeDb("plugin private-egress instance-admin routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-private-egress-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", pluginPrivateEgressRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seed(): Promise<{ pluginId: string; pluginKey: string; companyA: string; companyB: string }> {
    const pluginId = randomUUID();
    const pluginKey = `test.klipper.${pluginId.slice(0, 8)}`;
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: "@test/klipper",
      version: "0.0.1",
      manifestJson: { id: pluginKey, name: "k", version: "0.0.1" } as never,
    });
    const companyA = randomUUID();
    const companyB = randomUUID();
    await db.insert(companies).values([
      { id: companyA, name: "co-a", issuePrefix: `A${pluginId.slice(0, 4)}`.toUpperCase() },
      { id: companyB, name: "co-b", issuePrefix: `B${pluginId.slice(0, 4)}`.toUpperCase() },
    ]);
    await db.insert(pluginCompanySettings).values([
      { pluginId, companyId: companyA, enabled: true, settingsJson: {} },
      { pluginId, companyId: companyB, enabled: true, settingsJson: {} },
    ]);
    return { pluginId, pluginKey, companyA, companyB };
  }

  it("R1: a company board admin (not instance admin) and an agent get 403; nothing is written", async () => {
    const { pluginId, companyA } = await seed();
    for (const actor of [boardActor(companyA, false), agentActor(companyA)]) {
      const put = await request(appFor(actor)).put(`/api/plugins/${pluginId}/private-egress`).send({ origins: [PRINTER] });
      const get = await request(appFor(actor)).get(`/api/plugins/${pluginId}/private-egress`);
      expect(put.status, JSON.stringify(put.body)).toBe(403);
      expect(get.status).toBe(403);
    }
    expect(await loadPluginPrivateEgressOrigins(db, pluginId)).toEqual([]);
  });

  it("instance admin sets, re-sets idempotently and rolls back; audit has actor + added/removed", async () => {
    const { pluginId, pluginKey, companyA, companyB } = await seed();
    const app = appFor(boardActor(companyA, true));

    const put = await request(app).put(`/api/plugins/${pluginKey}/private-egress`).send({ origins: [PRINTER] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ pluginId, origins: [PRINTER], added: [PRINTER], removed: [] });
    expect(await loadPluginPrivateEgressOrigins(db, pluginId)).toEqual([PRINTER]);

    const again = await request(app).put(`/api/plugins/${pluginId}/private-egress`).send({ origins: [PRINTER] });
    expect(again.body).toMatchObject({ origins: [PRINTER], added: [], removed: [] });

    const rollback = await request(app).put(`/api/plugins/${pluginId}/private-egress`).send({ origins: [] });
    expect(rollback.body).toMatchObject({ origins: [], added: [], removed: [PRINTER] });
    expect(await loadPluginPrivateEgressOrigins(db, pluginId)).toEqual([]);

    const events = await db.select().from(activityLog);
    // 2 effective changes (add, remove) x 2 companies running the plugin; the no-op re-set logs nothing.
    expect(events).toHaveLength(4);
    expect(new Set(events.map((e) => e.companyId))).toEqual(new Set([companyA, companyB]));
    for (const e of events) {
      expect(e.action).toBe("plugin.private_egress_updated");
      expect(e.actorId).toBe("instance-admin");
    }
    const added = events.find((e) => (e.details as { added: string[] }).added.length === 1)!;
    expect(added.details).toMatchObject({ pluginId, added: [PRINTER], removed: [] });
  });

  it("rejects metadata, loopback and hostname entries with 400 and writes nothing", async () => {
    const { pluginId, companyA } = await seed();
    const app = appFor(boardActor(companyA, true));
    for (const entry of ["http://169.254.169.254:80", "http://127.0.0.1:3100", "http://printer.lan:8898", "http://192.168.2.86"]) {
      const res = await request(app).put(`/api/plugins/${pluginId}/private-egress`).send({ origins: [PRINTER, entry] });
      expect(res.status, entry).toBe(400);
    }
    expect(await loadPluginPrivateEgressOrigins(db, pluginId)).toEqual([]);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("404 for an unknown plugin", async () => {
    const { companyA } = await seed();
    const res = await request(appFor(boardActor(companyA, true))).put(`/api/plugins/${randomUUID()}/private-egress`).send({ origins: [] });
    expect(res.status).toBe(404);
  });
});
