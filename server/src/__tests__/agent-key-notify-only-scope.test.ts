import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { agentApiKeys, agents, boardApiKeys } from "@paperclipai/db";
import { notifyOnlyAgentKeyScopeSchema, normalizeAgentApiKeyScope } from "@paperclipai/shared";
import { enforceAgentKeyScopeMiddleware, registerActorContext } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";

// A `notify_only` agent key (run-less pager credential) may only
// GET /api/issues/:id and POST /api/issues/:id/interactions for the issue ids
// on its allow-list. Everything else is 403 agent_key_scope_violation, and any
// run-id header it sends is dropped. Other agent-key scopes are unaffected.

const companyId = randomUUID();
const agentId = randomUUID();
const keyId = randomUUID();
const listedIssueId = randomUUID();
const otherIssueId = randomUUID();

function mountStandInRoutes(app: express.Express) {
  const ok = (route: string) => (req: express.Request, res: express.Response) =>
    res.json({ ok: true, route, runId: (req.actor as { runId?: string }).runId ?? null });
  app.get("/api/issues/:id", ok("issue.get"));
  app.patch("/api/issues/:id", ok("issue.patch"));
  app.post("/api/issues/:id/comments", ok("comment.create"));
  app.get("/api/issues/:id/comments", ok("comment.list"));
  app.post("/api/issues/:id/interactions", ok("interaction.create"));
  app.post("/api/issues/:id/interactions/:iid/accept", ok("interaction.accept"));
  app.post("/api/issues/:id/interactions/:iid/resolve", ok("interaction.resolve"));
  app.post("/api/companies/:cid/issues", ok("issue.create"));
  app.get("/api/companies/:cid/issues", ok("issue.list"));
  app.get("/api/companies/:cid/secrets", ok("secrets.list"));
  app.get("/api/companies/:cid/agents", ok("agents.list"));
  app.post("/api/agents/:id/keys", ok("agent.key.create"));
  app.get("/api/board-api-keys", ok("board-keys.list"));
  app.post("/api/board-api-keys", ok("board-keys.create"));
}

function appWithActor(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use(enforceAgentKeyScopeMiddleware());
  mountStandInRoutes(app);
  app.use(errorHandler);
  return app;
}

const notifyOnlyActor = {
  type: "agent",
  agentId,
  companyId,
  keyId,
  source: "agent_key",
  keyScope: { kind: "notify_only", issueIds: [listedIssueId] },
};

describe("notify_only agent key scope schema", () => {
  it("accepts 1..10 issue uuids and rejects empty, oversize, and extra fields", () => {
    expect(notifyOnlyAgentKeyScopeSchema.safeParse({ kind: "notify_only", issueIds: [listedIssueId] }).success).toBe(true);
    expect(notifyOnlyAgentKeyScopeSchema.safeParse({ kind: "notify_only", issueIds: [] }).success).toBe(false);
    expect(
      notifyOnlyAgentKeyScopeSchema.safeParse({
        kind: "notify_only",
        issueIds: Array.from({ length: 11 }, () => randomUUID()),
      }).success,
    ).toBe(false);
    expect(notifyOnlyAgentKeyScopeSchema.safeParse({ kind: "notify_only", issueIds: ["ABC-1"] }).success).toBe(false);
    expect(
      notifyOnlyAgentKeyScopeSchema.safeParse({ kind: "notify_only", issueIds: [listedIssueId], extra: 1 }).success,
    ).toBe(false);
  });

  it("never degrades a malformed stored notify_only scope to standard", () => {
    expect(normalizeAgentApiKeyScope({ kind: "notify_only", issueIds: [] })).toEqual({ kind: "notify_only", issueIds: [] });
    expect(normalizeAgentApiKeyScope({ kind: "notify_only" })).toEqual({ kind: "notify_only", issueIds: [] });
    expect(normalizeAgentApiKeyScope(null)).toEqual({ kind: "standard" });
  });
});

describe("notify_only agent key route allow-list", () => {
  it("allows GET issue and POST interactions on a listed issue, and drops the run-id", async () => {
    const app = appWithActor({ ...notifyOnlyActor, runId: randomUUID() });
    const get = await request(app).get(`/api/issues/${listedIssueId}`);
    expect(get.status, JSON.stringify(get.body)).toBe(200);
    expect(get.body.runId).toBeNull();
    const post = await request(app).post(`/api/issues/${listedIssueId.toUpperCase()}/interactions`).send({});
    expect(post.status, JSON.stringify(post.body)).toBe(200);
    expect(post.body.route).toBe("interaction.create");
  });

  it.each([
    ["GET", () => `/api/issues/${otherIssueId}`],
    ["POST", () => `/api/issues/${otherIssueId}/interactions`],
    ["GET", () => "/api/issues/ABC-1"],
    ["POST", () => `/api/issues/${listedIssueId}/comments`],
    ["GET", () => `/api/issues/${listedIssueId}/comments`],
    ["PATCH", () => `/api/issues/${listedIssueId}`],
    ["POST", () => `/api/companies/${companyId}/issues`],
    ["GET", () => `/api/companies/${companyId}/issues`],
    ["GET", () => `/api/companies/${companyId}/secrets`],
    ["GET", () => `/api/companies/${companyId}/agents`],
    ["POST", () => `/api/agents/${agentId}/keys`],
    ["GET", () => "/api/board-api-keys"],
    ["POST", () => "/api/board-api-keys"],
    ["POST", () => `/api/issues/${listedIssueId}/interactions/${randomUUID()}/accept`],
    ["POST", () => `/api/issues/${listedIssueId}/interactions/${randomUUID()}/resolve`],
  ])("denies %s %s with 403", async (method, path) => {
    const app = appWithActor(notifyOnlyActor);
    const agent = request(app);
    const url = path();
    const res = method === "GET"
      ? await agent.get(url)
      : method === "PATCH"
        ? await agent.patch(url).send({})
        : await agent.post(url).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details?.code ?? res.body.code).toBe("agent_key_scope_violation");
  });

  it("denies everything when the stored allow-list is empty (malformed scope)", async () => {
    const app = appWithActor({ ...notifyOnlyActor, keyScope: { kind: "notify_only", issueIds: [] } });
    const res = await request(app).get(`/api/issues/${listedIssueId}`);
    expect(res.status).toBe(403);
  });

  it("leaves standard, task_bridge, and board actors unchanged", async () => {
    for (const actor of [
      { type: "agent", agentId, companyId, keyId, source: "agent_key", keyScope: { kind: "standard" }, runId: "r1" },
      { type: "agent", agentId, companyId, source: "agent_jwt", runId: "r1" },
      { type: "board", userId: "u1", source: "session" },
    ]) {
      const res = await request(appWithActor(actor)).post(`/api/issues/${otherIssueId}/comments`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
  });
});

describe("registerActorContext wires the notify_only enforcement", () => {
  it("403s a real DB-resolved notify_only agent key outside its allow-list", async () => {
    const token = `pcp_${randomUUID()}`;
    const keyHash = createHash("sha256").update(token).digest("hex");
    const keyRow = {
      id: keyId,
      agentId,
      companyId,
      keyHash,
      responsibleUserId: "user-1",
      revokedAt: null,
      expiresAt: null,
      scopeConfig: { kind: "notify_only", issueIds: [listedIssueId] },
    };
    const agentRow = { id: agentId, companyId, status: "active" };
    const chain = (rows: unknown[]) => {
      const p: any = Promise.resolve(rows);
      p.where = () => chain(rows);
      p.limit = () => chain(rows);
      p.innerJoin = () => chain(rows);
      p.leftJoin = () => chain(rows);
      p.orderBy = () => chain(rows);
      return p;
    };
    const db: any = {
      select: () => ({
        from: (table: unknown) =>
          chain(table === agentApiKeys ? [keyRow] : table === agents ? [agentRow] : table === boardApiKeys ? [] : []),
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
      insert: () => ({ values: () => Promise.resolve([]) }),
    };
    const app = express();
    app.use(express.json());
    registerActorContext(app, db, { deploymentMode: "authenticated", resolveSession: async () => null } as any);
    mountStandInRoutes(app);
    app.use(errorHandler);

    const denied = await request(app)
      .post(`/api/issues/${listedIssueId}/comments`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    const allowed = await request(app)
      .post(`/api/issues/${listedIssueId}/interactions`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", randomUUID())
      .send({});
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(allowed.body.runId).toBeNull();
  });
});
