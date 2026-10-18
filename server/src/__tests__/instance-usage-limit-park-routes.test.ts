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
  getUsageLimitParkState: vi.fn(),
  clearUsageLimitPark: vi.fn(),
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

const PARKED = {
  parked: true,
  parkedUntil: "2027-07-30T08:01:00.000Z",
  reason: "usage_limit",
  rawLimitText: "resets Jul 30, 8am (UTC)",
  sourceRunId: "run-1",
  updatedAt: "2026-07-31T00:00:00.000Z",
};
const UNPARKED = { ...PARKED, parked: false, parkedUntil: null, reason: "manual_unpark" };

describe("instance usage-limit park unpark routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1", "company-2"]);
    mockHeartbeatService.getUsageLimitParkState.mockResolvedValue(PARKED);
    mockHeartbeatService.clearUsageLimitPark.mockResolvedValue(UNPARKED);
  });

  it.each([["post"], ["delete"]] as const)("rejects an agent key with 403 on %s", async (method) => {
    const app = await createApp(AGENT);
    const res = await (request(app) as any)[method]("/api/instance/usage-limit-park");
    expect(res.status).toBe(403);
    expect(mockHeartbeatService.clearUsageLimitPark).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it.each([["post"], ["delete"]] as const)("rejects a non-admin board user with 403 on %s", async (method) => {
    const app = await createApp(NON_ADMIN_BOARD);
    const res = await (request(app) as any)[method]("/api/instance/usage-limit-park");
    expect(res.status).toBe(403);
    expect(mockHeartbeatService.clearUsageLimitPark).not.toHaveBeenCalled();
  });

  it.each([["post"], ["delete"]] as const)("%s clears the park and logs the actor once per company", async (method) => {
    const app = await createApp(ADMIN);
    const res = await (request(app) as any)[method]("/api/instance/usage-limit-park");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(UNPARKED);
    expect(mockHeartbeatService.clearUsageLimitPark).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
    for (const call of mockLogActivity.mock.calls) {
      expect(call[1]).toMatchObject({
        action: "instance.usage_limit_park.cleared",
        actorType: "user",
        actorId: "admin-1",
        entityType: "instance_usage_limit_park",
        details: { wasParked: true, previousParkedUntil: PARKED.parkedUntil, previousReason: "usage_limit" },
      });
    }
    expect(mockLogActivity.mock.calls.map((call) => call[1].companyId)).toEqual(["company-1", "company-2"]);
  });
});
