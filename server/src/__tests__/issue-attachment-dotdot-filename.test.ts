import { createHash } from "node:crypto";
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as objectKeyModule from "../storage/object-key.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";

// Route-level regression coverage: a stored filename may
// never contain a ".." run, because the read guard refuses such keys. These
// tests drive the REAL upload route with the REAL storage service backed by a
// real local-disk provider, then read back through the content endpoint.

const mockIssueService = vi.hoisted(() => ({
  clearOrphanCheckoutLocksIfTerminal: vi.fn(async () => false),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  createAttachment: vi.fn(),
  getAttachmentById: vi.fn(),
}));
const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockWorkProductService = vi.hoisted(() => ({
  createForIssue: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(async () => ({
    allowed: true,
    explanation: "Allowed by test mock",
  })),
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(),
    }),
    companySkillService: () => ({}),
    companyService: () => mockCompanyService,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueThreadInteractionService: () => ({
      listForIssue: vi.fn(async () => []),
      expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
      expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => mockWorkProductService,
  }));
}

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "company-1";

let attachmentSeq = 0;
let currentAttachment: Record<string, unknown> | null = null;

async function createAppWithRealStorage() {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-dotdot-route-"));
  const storage: StorageService = createStorageService(createLocalDiskStorageProvider(root));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, storage));
  app.use(errorHandler);
  return { app, root, storage };
}

async function readBody(res: request.Response): Promise<Buffer> {
  return Buffer.from(res.body as unknown as Uint8Array);
}

describe("issue attachment routes: dot-dot filenames round-trip", () => {
  let tmpRoots: string[];

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      explanation: "Allowed by test mock",
    });
    mockLogActivity.mockResolvedValue(undefined);
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      projectId: null,
      parentId: null,
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      identifier: "PAP-1",
    });
    mockCompanyService.getById.mockResolvedValue({ id: COMPANY_ID });
    attachmentSeq = 0;
    currentAttachment = null;
    mockIssueService.createAttachment.mockImplementation(async (input: any) => {
      attachmentSeq += 1;
      const now = new Date("2026-09-13T00:00:00.000Z");
      currentAttachment = {
        id: `attachment-${attachmentSeq}`,
        companyId: COMPANY_ID,
        issueId: input.issueId,
        issueCommentId: input.issueCommentId ?? null,
        assetId: `asset-${attachmentSeq}`,
        provider: input.provider,
        objectKey: input.objectKey,
        contentType: input.contentType,
        byteSize: input.byteSize,
        sha256: input.sha256,
        originalFilename: input.originalFilename,
        createdByAgentId: null,
        createdByUserId: "local-board",
        createdAt: now,
        updatedAt: now,
      };
      return currentAttachment;
    });
    mockIssueService.getAttachmentById.mockImplementation(async (id: string) =>
      currentAttachment && currentAttachment.id === id ? currentAttachment : null,
    );
    tmpRoots = [];
  });

  async function upload(body: Buffer, filename: string) {
    const { app, root, storage } = await createAppWithRealStorage();
    tmpRoots.push(root);
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/issues/${ISSUE_ID}/attachments`)
      .attach("file", body, { filename, contentType: "application/octet-stream" });
    return { app, storage, res };
  }

  it("round-trips ProPrj_driver_v2_mirco_OP_edit..epro byte-identically incl. Range", async () => {
    const body = Buffer.from(`epro-bytes-${"x".repeat(64)}`, "utf8");
    const { app, res } = await upload(body, "ProPrj_driver_v2_mirco_OP_edit..epro");
    expect(res.status).toBe(201);
    const attachmentId = res.body.id as string;
    expect(res.body.originalFilename).toBe("ProPrj_driver_v2_mirco_OP_edit..epro");
    expect(String(res.body.objectKey)).not.toContain("..");
    expect(objectKeyModule.isObjectKeyReadable(String(res.body.objectKey))).toBe(true);

    const full = await request(app).get(`/api/attachments/${attachmentId}/content`);
    expect(full.status).toBe(200);
    const fullBody = await readBody(full);
    expect(createHash("sha256").update(fullBody).digest("hex")).toBe(
      createHash("sha256").update(body).digest("hex"),
    );

    const ranged = await request(app)
      .get(`/api/attachments/${attachmentId}/content`)
      .set("Range", "bytes=0-9");
    expect(ranged.status).toBe(206);
    expect(ranged.headers["content-range"]).toBe(`bytes 0-9/${body.length}`);
    expect(await readBody(ranged)).toEqual(body.subarray(0, 10));
  });

  it("round-trips a..b.txt", async () => {
    const body = Buffer.from("a-dot-dot-b", "utf8");
    const { app, res } = await upload(body, "a..b.txt");
    expect(res.status).toBe(201);
    expect(String(res.body.objectKey)).not.toContain("..");
    const got = await request(app).get(`/api/attachments/${res.body.id}/content`);
    expect(got.status).toBe(200);
    expect(await readBody(got)).toEqual(body);
  });

  it("round-trips a trailing-dot filename x.", async () => {
    const body = Buffer.from("trailing-dot", "utf8");
    const { app, res } = await upload(body, "x.");
    expect(res.status).toBe(201);
    expect(String(res.body.objectKey)).not.toContain("..");
    const got = await request(app).get(`/api/attachments/${res.body.id}/content`);
    expect(got.status).toBe(200);
    expect(await readBody(got)).toEqual(body);
  });

  it("sanitizes a traversal-shaped upload name instead of storing it", async () => {
    const body = Buffer.from("escape-attempt", "utf8");
    const { app, res } = await upload(body, "../../escape.txt");
    expect(res.status).toBe(201);
    expect(String(res.body.objectKey)).not.toContain("..");
    expect(String(res.body.objectKey)).not.toContain("../");
    const got = await request(app).get(`/api/attachments/${res.body.id}/content`);
    expect(got.status).toBe(200);
    expect(await readBody(got)).toEqual(body);
  });

  it("asserts the built key through the shared predicate on the write path (AC4 wiring)", async () => {
    const spy = vi.spyOn(objectKeyModule, "assertObjectKeyReadable");
    const { res } = await upload(Buffer.from("wiring", "utf8"), "a..b.txt");
    expect(res.status).toBe(201);
    expect(spy).toHaveBeenCalledWith(res.body.objectKey);
  });
});
