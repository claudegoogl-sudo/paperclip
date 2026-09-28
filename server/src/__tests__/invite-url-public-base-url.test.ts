/**
 * TDD: authPublicBaseUrl takes precedence over request-derived host when building invite URLs.
 * These tests are written first (will fail until the implementation lands).
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logActivityMock = vi.fn();

// Hoisted module mocks, not per-test vi.doMock + vi.resetModules: the mock
// registry must be in place before ANY import of the routes module, in every
// test. createApp concurrently imports middleware and route modules whose
// graphs both contain services/index.js. With doMock-registered mocks that
// first evaluation could race the registry under load and bind the REAL
// services module, rejecting the request under test with a 500 (observed on
// CI in the serialized shard; see PRs #381/#383). A hoisted vi.mock applies
// to every import graph deterministically.
vi.mock("../services/index.js", () => ({
  accessService: () => ({
    isInstanceAdmin: vi.fn(),
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  boardAuthService: () => ({
    createChallenge: vi.fn(),
    resolveBoardAccess: vi.fn(),
    assertCurrentBoardKey: vi.fn(),
    revokeBoardApiKey: vi.fn(),
  }),
  deduplicateAgentName: vi.fn(),
  logActivity: (...args: unknown[]) => logActivityMock(...args),
  notifyHireApproved: vi.fn(),
}));

function createDbStub() {
  const createdInvite = {
    id: "invite-1",
    companyId: "company-1",
    inviteType: "company_join",
    allowedJoinTypes: "human",
    tokenHash: "hash",
    defaultsPayload: { humanRole: "viewer" },
    expiresAt: new Date("2027-03-10T00:00:00.000Z"),
    invitedByUserId: null,
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date("2026-03-07T00:00:00.000Z"),
    updatedAt: new Date("2026-03-07T00:00:00.000Z"),
  };

  return {
    insert() {
      return {
        values() {
          return {
            returning() {
              return Promise.resolve([createdInvite]);
            },
          };
        },
      };
    },
    select(_shape?: unknown) {
      return {
        from() {
          const query = {
            leftJoin() {
              return query;
            },
            where() {
              return Promise.resolve([{
                name: "Acme Robotics",
                logoAssetId: null,
              }]);
            },
          };
          return query;
        },
      };
    },
  };
}

async function createApp(authPublicBaseUrl?: string) {
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/access.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "local_implicit",
      userId: null,
      companyIds: ["company-1"],
    };
    next();
  });
  app.use(
    "/api",
    accessRoutes(createDbStub() as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
      authPublicBaseUrl,
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("invite URL: authPublicBaseUrl precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logActivityMock.mockReset();
  });

  it("uses authPublicBaseUrl for inviteUrl when configured, ignoring request host", async () => {
    const app = await createApp(
      "http://gus-pinsoneault-framework.tail302fee.ts.net:3100",
    );

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .set("host", "127.0.0.1:3100")
      .set("x-forwarded-proto", "http")
      .send({ allowedJoinTypes: "human", humanRole: "viewer" });

    expect(res.status).toBe(201);
    expect(res.body.inviteUrl).toMatch(
      /^http:\/\/gus-pinsoneault-framework\.tail302fee\.ts\.net:3100\/invite\/pcp_invite_/,
    );
    expect(res.body.inviteUrl).not.toContain("127.0.0.1");
  });

  it("keeps the public invite URL when an agent-run loopback base is configured", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_API_URL", "http://127.0.0.1:3100");
    try {
      const app = await createApp("https://paperclip.example.com");
      const res = await request(app)
        .post("/api/companies/company-1/invites")
        .set("host", "127.0.0.1:3100")
        .send({ allowedJoinTypes: "human", humanRole: "viewer" });
      expect(res.status).toBe(201);
      expect(res.body.inviteUrl).toMatch(/^https:\/\/paperclip\.example\.com\/invite\/pcp_invite_/);
      expect(res.body.inviteUrl).not.toContain("127.0.0.1");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("falls back to request-derived host when authPublicBaseUrl is not configured", async () => {
    const app = await createApp(undefined);

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .set("host", "paperclip.example")
      .set("x-forwarded-proto", "https")
      .send({ allowedJoinTypes: "human", humanRole: "viewer" });

    expect(res.status).toBe(201);
    expect(res.body.inviteUrl).toMatch(
      /^https:\/\/paperclip\.example\/invite\/pcp_invite_/,
    );
  });

  it("strips trailing slash from authPublicBaseUrl before joining with invite path", async () => {
    const app = await createApp(
      "http://gus-pinsoneault-framework.tail302fee.ts.net:3100/",
    );

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .set("host", "127.0.0.1:3100")
      .send({ allowedJoinTypes: "human", humanRole: "viewer" });

    expect(res.status).toBe(201);
    expect(res.body.inviteUrl).not.toContain("//invite/");
    expect(res.body.inviteUrl).toMatch(
      /^http:\/\/gus-pinsoneault-framework\.tail302fee\.ts\.net:3100\/invite\/pcp_invite_/,
    );
  });
});
