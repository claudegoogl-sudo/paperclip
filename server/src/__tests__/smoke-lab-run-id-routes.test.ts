import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSmokeLab = vi.hoisted(() => ({
  assertEnabled: vi.fn(),
  getRun: vi.fn(),
  updateRun: vi.fn(),
  recordStep: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  smokeLabService: () => mockSmokeLab,
  logActivity: mockLogActivity,
}));

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const RUNS_URL = `/api/companies/${COMPANY_ID}/smoke-lab/runs`;

async function createApp() {
  const [{ smokeLabRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/smoke-lab.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user",
      userName: "Board User",
      userEmail: null,
      isInstanceAdmin: true,
      source: "local_implicit",
      companyIds: [COMPANY_ID],
    };
    next();
  });
  app.use("/api", smokeLabRoutes({} as never, { nodeEnv: "test" }));
  app.use(errorHandler);
  return app;
}

function runRequest(app: express.Express, method: "get" | "patch" | "post", runId: string) {
  const encoded = encodeURIComponent(runId);
  if (method === "get") return request(app).get(`${RUNS_URL}/${encoded}`);
  if (method === "patch") return request(app).patch(`${RUNS_URL}/${encoded}`).send({ status: "passed" });
  return request(app)
    .post(`${RUNS_URL}/${encoded}/steps`)
    .send({ path: "P1", scenarioStep: "open", status: "pass" });
}

describe("smoke lab run id validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSmokeLab.assertEnabled.mockResolvedValue(undefined);
    mockSmokeLab.getRun.mockResolvedValue({ run: { id: RUN_ID }, steps: [] });
    mockSmokeLab.updateRun.mockResolvedValue({ id: RUN_ID, status: "passed" });
    mockSmokeLab.recordStep.mockResolvedValue({
      step: { id: "33333333-3333-4333-8333-333333333333", path: "P1", status: "pass" },
    });
    mockLogActivity.mockResolvedValue(undefined);
  });

  describe.each(["get", "patch", "post"] as const)("%s", (method) => {
    it.each(["x", "not-a-uuid", ` ${RUN_ID}`, `${RUN_ID} `])(
      "answers 404 for malformed run id %j without reaching the service",
      async (runId) => {
        const res = await runRequest(await createApp(), method, runId);
        expect(res.status, JSON.stringify(res.body)).toBe(404);
        expect(res.body).toEqual({ error: "Smoke run not found" });
        expect(mockSmokeLab.getRun).not.toHaveBeenCalled();
        expect(mockSmokeLab.updateRun).not.toHaveBeenCalled();
        expect(mockSmokeLab.recordStep).not.toHaveBeenCalled();
      },
    );
  });

  it("keeps the disabled-lab answer ahead of the run id check", async () => {
    const disabled = Object.assign(new Error("Smoke lab is disabled"), { status: 404 });
    mockSmokeLab.assertEnabled.mockRejectedValue(disabled);
    const res = await runRequest(await createApp(), "get", "x");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Smoke lab is disabled" });
  });

  it("passes a valid run id through to the service", async () => {
    const app = await createApp();

    const got = await runRequest(app, "get", RUN_ID);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(mockSmokeLab.getRun).toHaveBeenCalledWith(COMPANY_ID, RUN_ID);

    const patched = await runRequest(app, "patch", RUN_ID);
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(mockSmokeLab.updateRun).toHaveBeenCalledWith(COMPANY_ID, RUN_ID, { status: "passed" });

    const stepped = await runRequest(app, "post", RUN_ID);
    expect(stepped.status, JSON.stringify(stepped.body)).toBe(201);
    expect(mockSmokeLab.recordStep).toHaveBeenCalledWith(COMPANY_ID, RUN_ID, {
      path: "P1",
      scenarioStep: "open",
      status: "pass",
    });
  });
});
