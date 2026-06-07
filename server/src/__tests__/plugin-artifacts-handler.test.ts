/**
 * PLA-574 — tests for the host-mediated `artifacts.fetch` handler.
 * Covers SecurityEngineer's seven-point checklist:
 *  1. runContext validation (deny-by-default, no JWT fallback)
 *  2. Dispatching-agent authorization (NOT worker JWT)
 *  3. Single-resource enforcement / shape validation
 *  4. Dual-bucket rate limit (global + per-(agent, company))
 *  5. Six-field audit log on every call
 *  6. Typed errors including not_found collapsing existence/no-access
 *  7. No bytes in audit log details
 */

import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

const { logActivity } = await import("../services/activity-log.js");
const { createPluginRunContextRegistry } = await import(
  "../services/plugin-run-context-registry.js"
);
const {
  createPluginArtifactsHandler,
  ArtifactsError,
} = await import("../services/plugin-artifacts-handler.js");

type AttachmentRow = {
  id: string;
  companyId: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  originalFilename: string | null;
};

function makeBytes(content: string) {
  return Buffer.from(content, "utf8");
}

function makeStreamForBytes(bytes: Buffer) {
  return Readable.from([bytes]);
}

interface BuildOptions {
  attachment?: AttachmentRow | null;
  bytes?: Buffer;
  maxByteSize?: number;
  globalRateLimit?: { maxAttempts: number; windowMs: number };
  perCompanyRateLimit?: { maxAttempts: number; windowMs: number };
  writeRateLimit?: { maxAttempts: number; windowMs: number };
  companyMaxBytes?: number;
}

type StoredAsset = {
  id: string;
  companyId: string;
  sha256: string;
  attached: boolean;
};

function buildHandler(opts: BuildOptions = {}) {
  const attachment =
    opts.attachment === undefined
      ? {
          id: "att-1",
          companyId: "dpr-company",
          objectKey: "objects/att-1",
          contentType: "image/png",
          byteSize: 11,
          originalFilename: "screenshot.png",
        }
      : opts.attachment;
  const bytes = opts.bytes ?? makeBytes("hello world");
  const registry = createPluginRunContextRegistry({ ttlMs: 60_000, sweepIntervalMs: 60_000 });
  const sha256Of = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

  // In-memory asset store backing the create() idempotency + write path.
  const assetStore: StoredAsset[] = [];
  const putFileCalls: Array<{ companyId: string; namespace: string; byteSize: number }> = [];
  let assetSeq = 0;

  const handler = createPluginArtifactsHandler({
    db: {} as never,
    pluginDbId: "plugin-db-1",
    pluginKey: "acme.support",
    storage: {
      provider: "local",
      async putFile(input: { companyId: string; namespace: string; originalFilename: string | null; contentType: string; body: Buffer }) {
        putFileCalls.push({ companyId: input.companyId, namespace: input.namespace, byteSize: input.body.length });
        return {
          provider: "local",
          objectKey: `${input.companyId}/${input.namespace}/${randomUUID()}-${input.originalFilename ?? "file"}`,
          contentType: input.contentType,
          byteSize: input.body.length,
          sha256: sha256Of(input.body),
          originalFilename: input.originalFilename,
        };
      },
      async getObject(_companyId: string, _key: string) {
        return {
          stream: makeStreamForBytes(bytes),
          contentType: attachment?.contentType,
          contentLength: bytes.length,
        };
      },
      async headObject() {
        throw new Error("not used");
      },
      async deleteObject() {
        // no-op
      },
    } as never,
    attachments: {
      async getAttachmentById(id: string) {
        return attachment && attachment.id === id ? attachment : null;
      },
    },
    assetWriter: {
      async findReusableUnattachedAsset(companyId: string, sha256: string) {
        const found = assetStore.find(
          (a) => a.companyId === companyId && a.sha256 === sha256 && !a.attached,
        );
        return found ? { id: found.id } : null;
      },
      async createStandaloneAsset(input: { companyId: string; sha256: string }) {
        const id = `asset-${++assetSeq}`;
        assetStore.push({ id, companyId: input.companyId, sha256: input.sha256, attached: false });
        return { id };
      },
    },
    async resolveCompanyMaxBytes() {
      return opts.companyMaxBytes ?? 10 * 1024 * 1024;
    },
    runContextRegistry: registry,
    maxByteSize: opts.maxByteSize,
    globalRateLimit: opts.globalRateLimit,
    perCompanyRateLimit: opts.perCompanyRateLimit,
    writeRateLimit: opts.writeRateLimit,
  });
  return { handler, registry, bytes, assetStore, putFileCalls, sha256Of };
}

function registerCtx(
  registry: ReturnType<typeof createPluginRunContextRegistry>,
  overrides: Partial<{
    agentId: string;
    companyId: string;
    runId: string;
    projectId: string;
    toolName: string;
  }> = {},
) {
  registry.register("plugin-db-1", {
    agentId: overrides.agentId ?? "agent-dpr-1",
    companyId: overrides.companyId ?? "dpr-company",
    runId: overrides.runId ?? "run-1",
    projectId: overrides.projectId ?? "proj-1",
    toolName: overrides.toolName ?? "lookup-screenshot",
    registeredAt: Date.now(),
  });
}

describe("plugin-artifacts-handler — PLA-574", () => {
  beforeEach(() => {
    vi.mocked(logActivity).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Gate 1: throws runcontext_invalid when no registry entry matches the runId", async () => {
    const { handler } = buildHandler();
    await expect(
      handler.fetch({ attachmentId: "att-1", runId: "missing-run" }),
    ).rejects.toBeInstanceOf(ArtifactsError);
    await expect(
      handler.fetch({ attachmentId: "att-1", runId: "missing-run" }),
    ).rejects.toMatchObject({ code: "runcontext_invalid" });
    // No audit log when we have no agent identity to attribute it to.
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("Gate 0: rejects empty/invalid attachmentId before runContext lookup", async () => {
    const { handler } = buildHandler();
    await expect(
      handler.fetch({ attachmentId: "", runId: "run-1" } as never),
    ).rejects.toMatchObject({ code: "runcontext_invalid" });
    await expect(
      handler.fetch({ attachmentId: null as never, runId: "run-1" } as never),
    ).rejects.toMatchObject({ code: "runcontext_invalid" });
  });

  it("happy path: returns base64-encoded bytes + metadata and audits success", async () => {
    const { handler, registry, bytes } = buildHandler();
    registerCtx(registry);
    const result = await handler.fetch({ attachmentId: "att-1", runId: "run-1" });
    expect(result).toEqual({
      filename: "screenshot.png",
      contentType: "image/png",
      byteSize: bytes.length,
      contentBase64: bytes.toString("base64"),
    });
    expect(logActivity).toHaveBeenCalledTimes(1);
    const call = vi.mocked(logActivity).mock.calls[0]![1];
    expect(call.companyId).toBe("dpr-company");
    expect(call.actorType).toBe("plugin");
    expect(call.action).toBe("artifact.fetched");
    expect(call.agentId).toBe("agent-dpr-1");
    expect(call.runId).toBe("run-1");
    // No bytes / base64 in details.
    expect(JSON.stringify(call.details)).not.toContain(bytes.toString("base64"));
    expect(call.details).toMatchObject({
      outcome: "allowed",
      dispatchingAgentId: "agent-dpr-1",
      dispatchingCompanyId: "dpr-company",
      attachmentCompanyId: "dpr-company",
      attachmentId: "att-1",
      pluginKey: "acme.support",
      // Six-field audit (PLA-574): toolName comes from the registered
      // runContext, not from worker-supplied params.
      toolName: "lookup-screenshot",
    });
  });

  it("Gate 4: collapses cross-company access denial into not_found (no existence oracle)", async () => {
    const { handler, registry } = buildHandler();
    // Dispatching agent is in a DIFFERENT company than the attachment.
    registerCtx(registry, { agentId: "agent-plat-1", companyId: "platform-company" });
    await expect(
      handler.fetch({ attachmentId: "att-1", runId: "run-1" }),
    ).rejects.toMatchObject({ code: "not_found" });
    const call = vi.mocked(logActivity).mock.calls[0]![1];
    expect(call.details).toMatchObject({
      outcome: "denied",
      deniedReason: "not_found",
      dispatchingAgentId: "agent-plat-1",
      dispatchingCompanyId: "platform-company",
      attachmentCompanyId: "dpr-company",
      // Six-field audit (PLA-574): deny paths still carry toolName.
      toolName: "lookup-screenshot",
    });
  });

  it("Gate 3: returns not_found when attachment does not exist (same shape as no-access)", async () => {
    const { handler, registry } = buildHandler({ attachment: null });
    registerCtx(registry);
    await expect(
      handler.fetch({ attachmentId: "att-1", runId: "run-1" }),
    ).rejects.toMatchObject({ code: "not_found" });
    const call = vi.mocked(logActivity).mock.calls[0]![1];
    expect(call.details).toMatchObject({
      outcome: "denied",
      deniedReason: "not_found",
      attachmentCompanyId: null,
    });
  });

  it("Gate 2a: global per-agent rate limit triggers rate_limited and audits", async () => {
    const { handler, registry } = buildHandler({
      globalRateLimit: { maxAttempts: 2, windowMs: 60_000 },
    });
    registerCtx(registry);
    await handler.fetch({ attachmentId: "att-1", runId: "run-1" });
    await handler.fetch({ attachmentId: "att-1", runId: "run-1" });
    await expect(
      handler.fetch({ attachmentId: "att-1", runId: "run-1" }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    // Third call should have logged a denied rate_limit audit.
    const last = vi.mocked(logActivity).mock.calls.at(-1)![1];
    expect(last.details).toMatchObject({
      outcome: "denied",
      deniedReason: "rate_limited",
    });
  });

  it("Gate 2b: per-(agent, attachment-company) sub-bucket rate limit triggers rate_limited", async () => {
    const { handler, registry } = buildHandler({
      // Lift the global cap so we only exercise the sub-bucket.
      globalRateLimit: { maxAttempts: 100, windowMs: 60_000 },
      perCompanyRateLimit: { maxAttempts: 2, windowMs: 60_000 },
    });
    registerCtx(registry);
    await handler.fetch({ attachmentId: "att-1", runId: "run-1" });
    await handler.fetch({ attachmentId: "att-1", runId: "run-1" });
    await expect(
      handler.fetch({ attachmentId: "att-1", runId: "run-1" }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("Gate 6: rejects oversize payloads with too_large (prevents OOM via base64 inflation)", async () => {
    const bytes = Buffer.alloc(1024, 0x41);
    const { handler, registry } = buildHandler({
      bytes,
      maxByteSize: 512,
    });
    registerCtx(registry);
    await expect(
      handler.fetch({ attachmentId: "att-1", runId: "run-1" }),
    ).rejects.toMatchObject({ code: "too_large" });
    // PLA-578 F1: the oversize deny must still emit a six-field audit so an
    // authorized caller OOM-stressing storage retrieval leaves a signal.
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          outcome: "denied",
          deniedReason: "too_large",
          attachmentCompanyId: "dpr-company",
          toolName: "lookup-screenshot",
        }),
      }),
    );
  });

  it("trust boundary: worker-supplied runId for another plugin's dispatch is rejected", async () => {
    const { handler, registry } = buildHandler();
    // Register the runId against a DIFFERENT plugin (simulating another
    // tenant's worker holding the same opaque runId by chance/forgery).
    registry.register("other-plugin-db", {
      agentId: "agent-attacker",
      companyId: "attacker-company",
      runId: "run-1",
      projectId: "proj-x",
      toolName: "evil",
      registeredAt: Date.now(),
    });
    // Our handler is for plugin-db-1, so the lookup for (plugin-db-1, run-1)
    // must miss even though run-1 exists elsewhere.
    await expect(
      handler.fetch({ attachmentId: "att-1", runId: "run-1" }),
    ).rejects.toMatchObject({ code: "runcontext_invalid" });
  });

  it("runContext is consulted fresh each call (deregister invalidates immediately)", async () => {
    const { handler, registry } = buildHandler();
    registerCtx(registry);
    await handler.fetch({ attachmentId: "att-1", runId: "run-1" });
    registry.deregister("plugin-db-1", "run-1");
    await expect(
      handler.fetch({ attachmentId: "att-1", runId: "run-1" }),
    ).rejects.toMatchObject({ code: "runcontext_invalid" });
  });
});

describe("plugin-artifacts-handler.create — PLA-888", () => {
  beforeEach(() => {
    vi.mocked(logActivity).mockClear();
  });

  const PNG = "image/png";
  function createParams(overrides: Partial<{ companyId: string; filename: string; mimeType: string; contentBase64: string; runId: string }> = {}) {
    return {
      companyId: overrides.companyId ?? "dpr-company",
      filename: overrides.filename ?? "inbound.png",
      mimeType: overrides.mimeType ?? PNG,
      contentBase64: overrides.contentBase64 ?? makeBytes("hello world").toString("base64"),
      runId: overrides.runId ?? "run-1",
    };
  }

  it("Gate 1: throws runcontext_invalid when no registry entry matches the runId", async () => {
    const { handler } = buildHandler();
    await expect(handler.create(createParams({ runId: "missing" }))).rejects.toMatchObject({
      code: "runcontext_invalid",
    });
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("happy path (dispatch ctx): stores bytes, returns assetId, audits artifact.created without bytes", async () => {
    const { handler, registry, putFileCalls } = buildHandler();
    registerCtx(registry);
    const bytesB64 = makeBytes("hello world").toString("base64");
    const result = await handler.create(createParams({ contentBase64: bytesB64 }));
    expect(result.attachmentId).toBe("asset-1");
    expect(putFileCalls).toHaveLength(1);
    expect(putFileCalls[0]!.namespace).toBe("plugin-artifacts");
    expect(logActivity).toHaveBeenCalledTimes(1);
    const call = vi.mocked(logActivity).mock.calls[0]![1];
    expect(call.action).toBe("artifact.created");
    expect(call.companyId).toBe("dpr-company");
    expect(JSON.stringify(call.details)).not.toContain(bytesB64);
    expect(call.details).toMatchObject({ outcome: "allowed", deduped: false, assetId: "asset-1" });
  });

  it("AC3 cross-tenant: dispatch ctx in another company is rejected with forbidden (no store)", async () => {
    const { handler, registry, putFileCalls } = buildHandler();
    registerCtx(registry, { companyId: "platform-company", agentId: "agent-plat-1" });
    await expect(handler.create(createParams({ companyId: "dpr-company" }))).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(putFileCalls).toHaveLength(0);
    const call = vi.mocked(logActivity).mock.calls[0]![1];
    expect(call.details).toMatchObject({ outcome: "denied", deniedReason: "forbidden" });
  });

  it("AC3 service ctx (relay path): no dispatching company → claimed companyId is the write target", async () => {
    const { handler, registry } = buildHandler();
    registry.registerService("plugin-db-1", "svc-run");
    const result = await handler.create(createParams({ companyId: "dpr-company", runId: "svc-run" }));
    expect(result.attachmentId).toBe("asset-1");
    const call = vi.mocked(logActivity).mock.calls[0]![1];
    expect(call.details).toMatchObject({ outcome: "allowed", contextKind: "service" });
  });

  it("AC3 background ctx: triggering company must equal claimed companyId", async () => {
    const { handler, registry } = buildHandler();
    registry.registerBackground("plugin-db-1", "bg-run", "dpr-company");
    await expect(
      handler.create(createParams({ companyId: "other-company", runId: "bg-run" })),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("AC5 mime allowlist: a disallowed type is rejected with forbidden before storing", async () => {
    const { handler, registry, putFileCalls } = buildHandler();
    registerCtx(registry);
    await expect(
      handler.create(createParams({ mimeType: "application/x-msdownload" })),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(putFileCalls).toHaveLength(0);
    const call = vi.mocked(logActivity).mock.calls[0]![1];
    expect(call.details).toMatchObject({ outcome: "denied", deniedReason: "forbidden", mimeType: "application/x-msdownload" });
  });

  it("AC5 mime allowlist: audio/voice (audio/ogg) is allowed for relay voice notes", async () => {
    const { handler, registry } = buildHandler();
    registerCtx(registry);
    const result = await handler.create(
      createParams({ mimeType: "audio/ogg", contentBase64: makeBytes("voice").toString("base64") }),
    );
    expect(result.attachmentId).toBe("asset-1");
  });

  it("AC4 size ceiling: rejects payloads over the per-company ceiling with too_large", async () => {
    const big = Buffer.alloc(2048, 0x41);
    const { handler, registry, putFileCalls } = buildHandler({ companyMaxBytes: 1024 });
    registerCtx(registry);
    await expect(
      handler.create(createParams({ contentBase64: big.toString("base64") })),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(putFileCalls).toHaveLength(0);
    const call = vi.mocked(logActivity).mock.calls[0]![1];
    expect(call.details).toMatchObject({ outcome: "denied", deniedReason: "too_large" });
  });

  it("AC6 idempotency: a retried store (same bytes/company) dedupes to the same asset, no second putFile", async () => {
    const { handler, registry, putFileCalls } = buildHandler();
    registerCtx(registry);
    const params = createParams({ contentBase64: makeBytes("same-bytes").toString("base64") });
    const first = await handler.create(params);
    const second = await handler.create(params);
    expect(second.attachmentId).toBe(first.attachmentId);
    expect(putFileCalls).toHaveLength(1);
    const last = vi.mocked(logActivity).mock.calls.at(-1)![1];
    expect(last.details).toMatchObject({ outcome: "allowed", deduped: true });
  });

  it("AC6 idempotency: an already-attached asset is NOT reused (would violate the unique bind)", async () => {
    const { handler, registry, assetStore, putFileCalls } = buildHandler();
    registerCtx(registry);
    const params = createParams({ contentBase64: makeBytes("twice").toString("base64") });
    const first = await handler.create(params);
    // Simulate the asset getting bound to a comment.
    assetStore.find((a) => a.id === first.attachmentId)!.attached = true;
    const second = await handler.create(params);
    expect(second.attachmentId).not.toBe(first.attachmentId);
    expect(putFileCalls).toHaveLength(2);
  });

  it("write rate limit: per-company ceiling triggers rate_limited and audits", async () => {
    const { handler, registry } = buildHandler({ writeRateLimit: { maxAttempts: 1, windowMs: 60_000 } });
    registerCtx(registry);
    await handler.create(createParams({ contentBase64: makeBytes("a").toString("base64") }));
    await expect(
      handler.create(createParams({ contentBase64: makeBytes("b").toString("base64") })),
    ).rejects.toMatchObject({ code: "rate_limited" });
    const last = vi.mocked(logActivity).mock.calls.at(-1)![1];
    expect(last.details).toMatchObject({ outcome: "denied", deniedReason: "rate_limited" });
  });

  it("review F1: rejects an over-ceiling encoded string BEFORE decoding (no decode, no putFile)", async () => {
    // companyMaxBytes 64 → pre-decode bound 64*1.4+8 ≈ 97 chars. A 400-char
    // base64 string trips the bound before Buffer.from runs.
    const { handler, registry, putFileCalls } = buildHandler({ companyMaxBytes: 64 });
    registerCtx(registry);
    const oversizeEncoded = "A".repeat(400);
    await expect(
      handler.create(createParams({ contentBase64: oversizeEncoded })),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(putFileCalls).toHaveLength(0);
    const call = vi.mocked(logActivity).mock.calls[0]![1];
    expect(call.details).toMatchObject({ outcome: "denied", deniedReason: "too_large" });
  });

  it("review F2: text/html and text/csv are rejected for plugin artifacts (forbidden)", async () => {
    for (const mimeType of ["text/html", "text/csv"]) {
      const { handler, registry, putFileCalls } = buildHandler();
      registerCtx(registry);
      await expect(
        handler.create(createParams({ mimeType, contentBase64: makeBytes("x").toString("base64") })),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(putFileCalls).toHaveLength(0);
    }
  });
});

describe("plugin-run-context-registry — PLA-574", () => {
  it("registers and retrieves by composite key", () => {
    const reg = createPluginRunContextRegistry();
    reg.register("p1", {
      agentId: "a1",
      companyId: "c1",
      runId: "r1",
      projectId: "pr1",
      toolName: "t",
      registeredAt: Date.now(),
    });
    expect(reg.get("p1", "r1")?.agentId).toBe("a1");
    expect(reg.get("p2", "r1")).toBeNull();
    reg.dispose();
  });

  it("TTL-expires entries between sweeps as a belt-and-braces guard", () => {
    let t = 1_000;
    const reg = createPluginRunContextRegistry({
      ttlMs: 10,
      sweepIntervalMs: 1_000_000, // effectively disabled
      now: () => t,
    });
    reg.register("p1", {
      agentId: "a1",
      companyId: "c1",
      runId: "r1",
      projectId: "pr1",
      toolName: "t",
      registeredAt: t,
    });
    expect(reg.get("p1", "r1")).not.toBeNull();
    t += 100;
    expect(reg.get("p1", "r1")).toBeNull();
    reg.dispose();
  });
});
