/**
 * Operator-only review + set-allowlist + enforce-flip HTTP routes
 * for the plugin config-key egress allowlist, against a real DB. Mirrors
 * the per-binding `secret-egress-operator-routes.test.ts`.
 *
 *   AC1  operator-authenticated only — an agent JWT is rejected (403,
 *        EG1-provenance) on every route, and no write leaks through.
 *   AC2  the enforce route's plugin-wide effect (A2): flipping company A's
 *        row also flips the runtime decision for company B's traffic, and
 *        the route response says so explicitly (`pluginWideEnforced: true`).
 *   AC3  harvested would-deny origins are UNCHECKED suggestions on the
 *        review response, never merged into `allowedEgress`.
 *   AC5  company-scoped (BOLA) on every read/write.
 *   —    the set-allowlist route rejects a `configKey` that isn't a declared
 *        `format:"uri"` instance-config key (400).
 */

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  plugins,
  pluginCompanySettings,
  pluginConfigEgressAllowlist,
  pluginConfigEgressWouldDenyObservations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pluginConfigEgressRoutes } from "../routes/plugin-config-egress.js";
import { errorHandler } from "../middleware/index.js";
import { recordPluginConfigEgressWouldDeny } from "../services/plugin-config-egress-harvest.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping plugin config-egress operator route tests: ${support.reason ?? "unsupported environment"}`);
}

const MOONRAKER_MANIFEST = {
  id: "test.klipper",
  name: "Klipper (test)",
  version: "0.0.1",
  instanceConfigSchema: {
    type: "object",
    properties: {
      moonrakerBaseUrl: { type: "string", format: "uri" },
    },
  },
} as const;

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "operator-user",
    userName: null,
    userEmail: null,
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "admin", status: "active" }],
  } as Express.Request["actor"];
}

function agentActor(companyId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: "agent-1",
    companyId,
    runId: randomUUID(),
  } as Express.Request["actor"];
}

describeDb("plugin config-egress operator routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-config-egress-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(pluginConfigEgressAllowlist);
    await db.delete(pluginConfigEgressWouldDenyObservations);
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
    app.use("/api", pluginConfigEgressRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedPlugin(): Promise<string> {
    const id = randomUUID();
    await db.insert(plugins).values({
      id,
      pluginKey: `test.klipper.${id.slice(0, 8)}`,
      packageName: "@test/klipper",
      version: "0.0.1",
      manifestJson: MOONRAKER_MANIFEST as never,
    });
    return id;
  }

  async function seedCompany(prefix: string): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `co-${prefix}`, issuePrefix: prefix.toUpperCase().slice(0, 6) });
    return companyId;
  }

  /** Give `companyId` an explicit `enabled = true` settings row for the plugin — the write routes require it. */
  async function enablePlugin(pluginId: string, companyId: string): Promise<void> {
    await db.insert(pluginCompanySettings).values({ pluginId, companyId, enabled: true, settingsJson: {} });
  }

  it("AC1: rejects an agent JWT on read and both writes (403, EG1-provenance)", async () => {
    const pluginId = await seedPlugin();
    const companyId = await seedCompany("aaa");
    const app = appFor(agentActor(companyId));

    const review = await request(app).get(`/api/companies/${companyId}/plugins/${pluginId}/config-egress`);
    const setList = await request(app)
      .post(`/api/companies/${companyId}/plugins/${pluginId}/config-egress/moonrakerBaseUrl/allowlist`)
      .send({ allowedEgress: ["https://secondary.example"] });
    const enforce = await request(app)
      .post(`/api/companies/${companyId}/plugins/${pluginId}/config-egress/moonrakerBaseUrl/enforce`)
      .send({});

    expect(review.status, JSON.stringify(review.body)).toBe(403);
    expect(setList.status, JSON.stringify(setList.body)).toBe(403);
    expect(enforce.status, JSON.stringify(enforce.body)).toBe(403);

    const rows = await db.select().from(pluginConfigEgressAllowlist).where(eq(pluginConfigEgressAllowlist.pluginId, pluginId));
    expect(rows).toHaveLength(0);
  });

  it("AC3: review returns harvested origins as separate UNCHECKED suggestions, allowlist untouched", async () => {
    const pluginId = await seedPlugin();
    const companyId = await seedCompany("bbb");
    await recordPluginConfigEgressWouldDeny(db, { pluginId, origin: "https://harvested.example" });
    await recordPluginConfigEgressWouldDeny(db, { pluginId, origin: "https://harvested.example" });

    const res = await request(appFor(boardActor(companyId))).get(
      `/api/companies/${companyId}/plugins/${pluginId}/config-egress`,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = res.body.rows.find((r: { configKey: string }) => r.configKey === "moonrakerBaseUrl");
    expect(row).toBeDefined();
    expect(row.allowedEgress).toEqual([]);
    expect(res.body.suggestions).toHaveLength(1);
    expect(res.body.suggestions[0].origin).toBe("https://harvested.example");
    expect(res.body.suggestions[0].count).toBe(2);
  });

  it("set-allowlist rejects a configKey that isn't a declared format:uri instance-config key", async () => {
    const pluginId = await seedPlugin();
    const companyId = await seedCompany("ccc");
    await enablePlugin(pluginId, companyId);

    const res = await request(appFor(boardActor(companyId)))
      .post(`/api/companies/${companyId}/plugins/${pluginId}/config-egress/notARealKey/allowlist`)
      .send({ allowedEgress: ["https://secondary.example"] });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
  });

  it("AC2: enforce flips ONE company's row but the response and effect are PLUGIN-WIDE", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany("ddd");
    const companyB = await seedCompany("eee");
    await enablePlugin(pluginId, companyA);
    const appA = appFor(boardActor(companyA));

    const setRes = await request(appA)
      .post(`/api/companies/${companyA}/plugins/${pluginId}/config-egress/moonrakerBaseUrl/allowlist`)
      .send({ allowedEgress: ["https://secondary-printer.example"] });
    expect(setRes.status, JSON.stringify(setRes.body)).toBe(200);
    expect(setRes.body.egressAllowlistEnforced).toBe(false);

    const enforceRes = await request(appA)
      .post(`/api/companies/${companyA}/plugins/${pluginId}/config-egress/moonrakerBaseUrl/enforce`)
      .send({});
    expect(enforceRes.status, JSON.stringify(enforceRes.body)).toBe(200);
    expect(enforceRes.body.pluginWideEnforced).toBe(true);

    const rowA = await db
      .select()
      .from(pluginConfigEgressAllowlist)
      .where(eq(pluginConfigEgressAllowlist.companyId, companyA))
      .then((rows) => rows[0]);
    expect(rowA.egressAllowlistEnforced).toBe(true);

    // Company B never wrote a row of its own, but the review surface must
    // still report the effective (plugin-wide) posture as enforcing per A2 —
    // an operator checking company B's own dashboard must not be told it's
    // safe/log-only when the whole plugin is actually enforcing.
    const reviewB = await request(appFor(boardActor(companyB))).get(
      `/api/companies/${companyB}/plugins/${pluginId}/config-egress`,
    );
    expect(reviewB.status, JSON.stringify(reviewB.body)).toBe(200);
    const rowB = reviewB.body.rows.find((r: { configKey: string }) => r.configKey === "moonrakerBaseUrl");
    expect(rowB.egressAllowlistEnforced).toBe(false);
    expect(rowB.pluginWideEnforced).toBe(true);
  });

  it("AC5: a board user cannot reach another company's config-egress surface (BOLA)", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany("fff");
    const companyB = await seedCompany("ggg");
    const appA = appFor(boardActor(companyA));

    const crossCompany = await request(appA).get(`/api/companies/${companyB}/plugins/${pluginId}/config-egress`);
    expect(crossCompany.status, JSON.stringify(crossCompany.body)).toBe(403);
  });

  it("least-privilege: a board user of a company that doesn't run the plugin is rejected on both writes, no row created", async () => {
    const pluginId = await seedPlugin();
    // companyNoRow: default-available plugin, never explicitly enabled (no settings row).
    const companyNoRow = await seedCompany("hhh");
    // companyDisabled: an explicit enabled=false row — the plugin is turned OFF for it.
    const companyDisabled = await seedCompany("iii");
    await db.insert(pluginCompanySettings).values({ pluginId, companyId: companyDisabled, enabled: false, settingsJson: {} });

    for (const companyId of [companyNoRow, companyDisabled]) {
      const appC = appFor(boardActor(companyId));

      const setList = await request(appC)
        .post(`/api/companies/${companyId}/plugins/${pluginId}/config-egress/moonrakerBaseUrl/allowlist`)
        .send({ allowedEgress: ["https://secondary.example"] });
      const enforce = await request(appC)
        .post(`/api/companies/${companyId}/plugins/${pluginId}/config-egress/moonrakerBaseUrl/enforce`)
        .send({});

      expect(setList.status, JSON.stringify(setList.body)).toBe(403);
      expect(enforce.status, JSON.stringify(enforce.body)).toBe(403);
    }

    const rows = await db.select().from(pluginConfigEgressAllowlist).where(eq(pluginConfigEgressAllowlist.pluginId, pluginId));
    expect(rows).toHaveLength(0);
  });
});
