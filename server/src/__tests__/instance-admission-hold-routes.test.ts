import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInstanceSettingsService = vi.hoisted(() => ({
  listCompanyIds: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  getInstanceAdmissionHoldState: vi.fn(),
  setInstanceAdmissionHold: vi.fn(),
  clearInstanceAdmissionHold: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

// Hoisted vi.mock (not vi.doMock + resetModules) so the real services module
// can never bind into the routes graph — see instance-settings-routes.test.ts.
vi.mock("../services/index.js", () => ({
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  logActivity: mockLogActivity,
}));
vi.mock("../services/environments.js", () => ({
  environmentService: () => ({}),
}));

async function createApp(actor: any) {
  const [{ errorHandler }, { instanceSettingsRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/instance-settings.js")>("../routes/instance-settings.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", instanceSettingsRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const ADMIN = { type: "board", userId: "admin-1", source: "session", isInstanceAdmin: true };
const AGENT = { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key" };
const NON_ADMIN_BOARD = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-1"],
};

const HELD = {
  held: true,
  holdUntil: "2026-10-10T14:00:00.000Z",
  reason: "core install drain",
  setByActorType: "user",
  setByActorId: "admin-1",
  updatedAt: "2026-10-10T13:00:00.000Z",
};
const CLEARED = { ...HELD, held: false, holdUntil: null };

describe("instance admission hold routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1", "company-2"]);
    mockHeartbeatService.getInstanceAdmissionHoldState.mockResolvedValue(CLEARED);
    mockHeartbeatService.setInstanceAdmissionHold.mockResolvedValue({ ...HELD, holdUntil: new Date(HELD.holdUntil) });
    mockHeartbeatService.clearInstanceAdmissionHold.mockResolvedValue(CLEARED);
  });

  it.each([
    ["GET", "get"],
    ["PUT", "put"],
    ["DELETE", "delete"],
  ] as const)("rejects an agent key with 403 on %s", async (_label, method) => {
    const app = await createApp(AGENT);
    const res = await (request(app) as any)[method]("/api/instance/admission-hold")
      .send({ holdUntil: new Date(Date.now() + 60_000).toISOString(), reason: "x" });
    expect(res.status).toBe(403);
    expect(mockHeartbeatService.setInstanceAdmissionHold).not.toHaveBeenCalled();
    expect(mockHeartbeatService.clearInstanceAdmissionHold).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects a non-admin board user with 403", async () => {
    const app = await createApp(NON_ADMIN_BOARD);
    const res = await request(app)
      .put("/api/instance/admission-hold")
      .send({ holdUntil: new Date(Date.now() + 60_000).toISOString(), reason: "x" });
    expect(res.status).toBe(403);
    expect(mockHeartbeatService.setInstanceAdmissionHold).not.toHaveBeenCalled();
  });

  it("GET returns the hold state for an instance admin", async () => {
    const app = await createApp(ADMIN);
    const res = await request(app).get("/api/instance/admission-hold");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(CLEARED);
  });

  it("PUT sets the hold and logs one activity entry per company", async () => {
    const app = await createApp(ADMIN);
    const holdUntil = new Date(Date.now() + 25 * 60_000).toISOString();
    const res = await request(app)
      .put("/api/instance/admission-hold")
      .send({ holdUntil, reason: "  core install drain  " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(HELD);
    expect(mockHeartbeatService.setInstanceAdmissionHold).toHaveBeenCalledWith(
      expect.objectContaining({ holdUntil: new Date(holdUntil), reason: "core install drain" }),
    );
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
    expect(mockLogActivity.mock.calls.map((call) => call[1].action)).toEqual([
      "instance.admission_hold.set",
      "instance.admission_hold.set",
    ]);
  });

  it.each([
    ["missing holdUntil", { reason: "x" }],
    ["unparseable holdUntil", { holdUntil: "soon", reason: "x" }],
    ["past holdUntil", { holdUntil: "2000-01-01T00:00:00.000Z", reason: "x" }],
    ["missing reason", { holdUntil: "2999-01-01T00:00:00.000Z" }],
    ["blank reason", { holdUntil: "2999-01-01T00:00:00.000Z", reason: "   " }],
  ])("PUT rejects %s with 400", async (_label, body) => {
    const app = await createApp(ADMIN);
    const res = await request(app).put("/api/instance/admission-hold").send(body);
    expect(res.status).toBe(400);
    expect(mockHeartbeatService.setInstanceAdmissionHold).not.toHaveBeenCalled();
  });

  it("DELETE clears the hold (re-runnable) and logs the clear", async () => {
    mockHeartbeatService.getInstanceAdmissionHoldState.mockResolvedValue(HELD);
    const app = await createApp(ADMIN);
    const res = await request(app).delete("/api/instance/admission-hold");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(CLEARED);
    expect(mockHeartbeatService.clearInstanceAdmissionHold).toHaveBeenCalledTimes(1);
    expect(mockLogActivity.mock.calls[0][1]).toMatchObject({
      action: "instance.admission_hold.cleared",
      details: { wasHeld: true },
    });
  });
});
