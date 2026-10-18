import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListReviewCases = vi.hoisted(() => vi.fn());

vi.mock("../services/pipelines.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/pipelines.js")>()),
  pipelineService: () => ({ listReviewCases: mockListReviewCases }),
}));

const companyId = "11111111-1111-4111-8111-111111111111";
const uuidA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const uuidB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function createApp() {
  const [{ pipelineRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/pipelines.js"),
    import("../middleware/error-handler.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true };
    next();
  });
  app.use("/api", pipelineRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("GET /companies/:companyId/review-cases filters", () => {
  const url = `/api/companies/${companyId}/review-cases`;

  beforeEach(() => {
    mockListReviewCases.mockReset();
    mockListReviewCases.mockResolvedValue([]);
  });

  it.each([
    ["pipelineId", "x"],
    ["parentCaseId", "x"],
    ["pipelineId", ` ${uuidA}`],
  ])("rejects malformed %s=%j with 400 before listing", async (name, value) => {
    const res = await request(await createApp()).get(url).query({ [name]: value });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(mockListReviewCases).not.toHaveBeenCalled();
  });

  it("passes valid UUID filters through", async () => {
    const res = await request(await createApp()).get(url).query({ pipelineId: uuidA, parentCaseId: uuidB });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockListReviewCases).toHaveBeenCalledWith({ companyId, pipelineId: uuidA, parentCaseId: uuidB });
  });

  it("lists unfiltered when no filter is given", async () => {
    const res = await request(await createApp()).get(url);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockListReviewCases).toHaveBeenCalledWith({ companyId, pipelineId: undefined, parentCaseId: undefined });
  });
});
