/**
 * PLA-574 — SDK-side tests for `ctx.artifacts.fetch(attachmentId)` inside a
 * tool handler. The worker must send ONLY `{ attachmentId, runId }` on the
 * RPC (no agentId / companyId — those are host-derived to keep the worker
 * untrusted) and must decode the host's base64 response back to a Uint8Array.
 */

import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { definePlugin } from "../src/define-plugin.js";
import {
  createErrorResponse,
  createRequest,
  createSuccessResponse,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseMessage,
  serializeMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../src/protocol.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";
import type { ToolResult, ToolRunContext } from "../src/types.js";

interface ArtifactsFetchCapture {
  attachmentId: unknown;
  runId: unknown;
  /** Any extra fields the worker tried to send (should be empty per spec). */
  extra: Record<string, unknown>;
}

interface BridgeResult {
  artifactsCalls: ArtifactsFetchCapture[];
  toolResults: ToolResult[];
  toolErrors: unknown[];
}

interface FetchInvocation {
  attachmentId: string;
  hostResponse: {
    filename: string;
    contentType: string;
    byteSize: number;
    contentBase64: string;
  };
  capturedBytes?: Uint8Array;
  capturedMeta?: { filename: string; contentType: string; byteSize: number };
}

/**
 * Boot a worker, register a single tool that invokes `ctx.artifacts.fetch`
 * with each entry in `invocations`, then drive an `executeTool` host→worker
 * call and collect what was sent.
 */
async function runWorkerToolFetch(
  invocations: FetchInvocation[],
  runContext: ToolRunContext = {
    agentId: "agent-dpr-1",
    runId: "run-XYZ",
    companyId: "dpr-company",
    projectId: "proj-1",
    // `artifacts` is server-injected at executeTool dispatch — the wire
    // payload doesn't include it.
  } as ToolRunContext,
): Promise<BridgeResult> {
  const hostToWorker = new PassThrough();
  const workerToHost = new PassThrough();
  const hostReadline = createInterface({ input: workerToHost });
  const pending = new Map<string | number, (response: JsonRpcResponse) => void>();
  let nextRequestId = 1;

  const artifactsCalls: ArtifactsFetchCapture[] = [];
  const toolResults: ToolResult[] = [];
  const toolErrors: unknown[] = [];

  const plugin = definePlugin({
    async setup(ctx) {
      ctx.tools.register(
        "fetch-artifact",
        {
          displayName: "Fetch artifact",
          description: "PLA-574 test tool",
          parametersSchema: { type: "object" },
        },
        async (_params, runCtx) => {
          for (const inv of invocations) {
            try {
              const result = await runCtx.artifacts.fetch(inv.attachmentId);
              inv.capturedBytes = result.bytes;
              inv.capturedMeta = {
                filename: result.filename,
                contentType: result.contentType,
                byteSize: result.byteSize,
              };
            } catch (err) {
              toolErrors.push(err);
            }
          }
          return { content: "ok" };
        },
      );
    },
  });

  const worker = startWorkerRpcHost({
    plugin,
    stdin: hostToWorker,
    stdout: workerToHost,
  });

  function callWorker(method: string, params: unknown): Promise<unknown> {
    const id = `host-${nextRequestId++}`;
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(id, (response) => {
        if ("error" in response && response.error) {
          reject(new Error(response.error.message));
          return;
        }
        resolve((response as { result?: unknown }).result);
      });
    });
    hostToWorker.write(serializeMessage(createRequest(method, params, id)));
    return result;
  }

  let invocationIdx = 0;
  hostReadline.on("line", (line) => {
    let message: unknown;
    try {
      message = parseMessage(line);
    } catch {
      return;
    }
    if (isJsonRpcResponse(message)) {
      const id = (message as JsonRpcResponse).id as string | number | null;
      if (id !== null && id !== undefined) {
        const cb = pending.get(id);
        if (cb) {
          pending.delete(id);
          cb(message as JsonRpcResponse);
        }
      }
      return;
    }
    if (isJsonRpcRequest(message)) {
      const req = message as JsonRpcRequest;
      if (req.method === "artifacts.fetch") {
        const params = (req.params ?? {}) as Record<string, unknown>;
        const { attachmentId, runId, ...extra } = params;
        artifactsCalls.push({ attachmentId, runId, extra });
        const inv = invocations[invocationIdx++];
        hostToWorker.write(
          serializeMessage(
            createSuccessResponse(req.id, inv?.hostResponse ?? {
              filename: "fallback",
              contentType: "application/octet-stream",
              byteSize: 0,
              contentBase64: "",
            }),
          ),
        );
      } else {
        hostToWorker.write(serializeMessage(createSuccessResponse(req.id, null)));
      }
    }
  });

  try {
    await callWorker("initialize", {
      manifest: {
        id: "paperclip.test-artifacts",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Artifacts Test",
        description: "PLA-574 test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: {},
      },
      config: {},
      databaseNamespace: null,
    });

    const result = (await callWorker("executeTool", {
      toolName: "fetch-artifact",
      parameters: {},
      runContext,
    })) as ToolResult;
    toolResults.push(result);
  } finally {
    worker.stop();
    hostReadline.close();
    hostToWorker.destroy();
    workerToHost.destroy();
  }

  return { artifactsCalls, toolResults, toolErrors };
}

describe("ctx.artifacts.fetch — PLA-574 worker→host wire", () => {
  it("sends only attachmentId + runId (worker never asserts agent/company identity)", async () => {
    const bytes = Buffer.from("hello bytes", "utf8");
    const inv: FetchInvocation = {
      attachmentId: "att-1",
      hostResponse: {
        filename: "screenshot.png",
        contentType: "image/png",
        byteSize: bytes.length,
        contentBase64: bytes.toString("base64"),
      },
    };
    const { artifactsCalls, toolErrors, toolResults } = await runWorkerToolFetch([inv]);

    expect(toolErrors).toEqual([]);
    expect(toolResults[0]).toEqual({ content: "ok" });
    expect(artifactsCalls).toHaveLength(1);
    const call = artifactsCalls[0]!;
    expect(call.attachmentId).toBe("att-1");
    expect(call.runId).toBe("run-XYZ");
    // Trust boundary: no identity fields on the wire — host derives those.
    expect(call.extra).toEqual({});
  });

  it("decodes the host's base64 payload back to a Uint8Array with metadata", async () => {
    // Use bytes with non-ASCII values to make sure base64 round-trip is exact.
    const raw = new Uint8Array([0x00, 0xff, 0x42, 0x7f, 0x80]);
    const inv: FetchInvocation = {
      attachmentId: "att-binary",
      hostResponse: {
        filename: "blob.bin",
        contentType: "application/octet-stream",
        byteSize: raw.length,
        contentBase64: Buffer.from(raw).toString("base64"),
      },
    };
    const { artifactsCalls, toolErrors } = await runWorkerToolFetch([inv]);

    expect(toolErrors).toEqual([]);
    expect(artifactsCalls).toHaveLength(1);
    expect(inv.capturedBytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(inv.capturedBytes!)).toEqual(Array.from(raw));
    expect(inv.capturedMeta).toEqual({
      filename: "blob.bin",
      contentType: "application/octet-stream",
      byteSize: raw.length,
    });
  });

  it("PLA-888 create: base64-encodes bytes and sends companyId/filename/mimeType/runId only", async () => {
    const raw = new Uint8Array([0x00, 0xff, 0x10, 0x7f, 0x80]);
    let captured: Record<string, unknown> | undefined;
    let returned: { attachmentId: string } | undefined;

    const plugin = definePlugin({
      async setup(ctx) {
        ctx.tools.register(
          "create-artifact",
          { displayName: "x", description: "x", parametersSchema: { type: "object" } },
          async (_p, runCtx) => {
            returned = await runCtx.artifacts.create({
              companyId: "dpr-company",
              filename: "voice.ogg",
              mimeType: "audio/ogg",
              bytes: raw,
            });
            return { content: "ok" };
          },
        );
      },
    });

    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string | number, (response: JsonRpcResponse) => void>();
    let nextRequestId = 1;

    function callWorker(method: string, params: unknown): Promise<unknown> {
      const id = `host-${nextRequestId++}`;
      const p = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) reject(new Error(response.error.message));
          else resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(createRequest(method, params, id)));
      return p;
    }

    hostReadline.on("line", (line) => {
      let message: unknown;
      try {
        message = parseMessage(line);
      } catch {
        return;
      }
      if (isJsonRpcResponse(message)) {
        const id = (message as JsonRpcResponse).id as string | number | null;
        if (id != null) {
          const cb = pending.get(id);
          if (cb) {
            pending.delete(id);
            cb(message as JsonRpcResponse);
          }
        }
        return;
      }
      if (isJsonRpcRequest(message)) {
        const req = message as JsonRpcRequest;
        if (req.method === "artifacts.create") {
          captured = (req.params ?? {}) as Record<string, unknown>;
          hostToWorker.write(serializeMessage(createSuccessResponse(req.id, { attachmentId: "asset-99" })));
        } else {
          hostToWorker.write(serializeMessage(createSuccessResponse(req.id, null)));
        }
      }
    });

    const worker = startWorkerRpcHost({ plugin, stdin: hostToWorker, stdout: workerToHost });
    try {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.test-artifacts-create",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "x",
          description: "x",
          author: "x",
          categories: ["automation"],
          capabilities: ["issue.attachments.create"],
          entrypoints: {},
        },
        config: {},
        databaseNamespace: null,
      });
      await callWorker("executeTool", {
        toolName: "create-artifact",
        parameters: {},
        runContext: { agentId: "a", runId: "run-XYZ", companyId: "dpr-company", projectId: "p" } as ToolRunContext,
      });
      expect(returned).toEqual({ attachmentId: "asset-99" });
      expect(captured).toBeDefined();
      const { companyId, filename, mimeType, contentBase64, runId, ...extra } = captured!;
      expect(companyId).toBe("dpr-company");
      expect(filename).toBe("voice.ogg");
      expect(mimeType).toBe("audio/ogg");
      expect(runId).toBe("run-XYZ");
      // Bytes travel as base64 and round-trip exactly.
      expect(Array.from(Buffer.from(contentBase64 as string, "base64"))).toEqual(Array.from(raw));
      // No bytes field or stray identity fields leak onto the wire.
      expect(extra).toEqual({});
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });

  it("PLA-888 create: rejects empty bytes at the SDK boundary (no RPC sent)", async () => {
    const captured: { errorMessage?: string } = {};
    const calls: unknown[] = [];
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.tools.register(
          "create-bad",
          { displayName: "x", description: "x", parametersSchema: { type: "object" } },
          async (_p, runCtx) => {
            try {
              await runCtx.artifacts.create({
                companyId: "c",
                filename: "f",
                mimeType: "image/png",
                bytes: new Uint8Array(0),
              });
              return { content: "should not reach" };
            } catch (err) {
              captured.errorMessage = (err as Error).message;
              return { content: "rejected" };
            }
          },
        );
      },
    });

    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string | number, (response: JsonRpcResponse) => void>();
    let nextRequestId = 1;
    function callWorker(method: string, params: unknown): Promise<unknown> {
      const id = `host-${nextRequestId++}`;
      const p = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) reject(new Error(response.error.message));
          else resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(createRequest(method, params, id)));
      return p;
    }
    hostReadline.on("line", (line) => {
      let message: unknown;
      try {
        message = parseMessage(line);
      } catch {
        return;
      }
      if (isJsonRpcResponse(message)) {
        const id = (message as JsonRpcResponse).id as string | number | null;
        if (id != null) {
          const cb = pending.get(id);
          if (cb) {
            pending.delete(id);
            cb(message as JsonRpcResponse);
          }
        }
        return;
      }
      if (isJsonRpcRequest(message)) {
        const req = message as JsonRpcRequest;
        if (req.method === "artifacts.create") calls.push(req.params);
        hostToWorker.write(serializeMessage(createSuccessResponse(req.id, null)));
      }
    });
    const worker = startWorkerRpcHost({ plugin, stdin: hostToWorker, stdout: workerToHost });
    try {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.test-artifacts-create-bad",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "x",
          description: "x",
          author: "x",
          categories: ["automation"],
          capabilities: ["issue.attachments.create"],
          entrypoints: {},
        },
        config: {},
        databaseNamespace: null,
      });
      const result = (await callWorker("executeTool", {
        toolName: "create-bad",
        parameters: {},
        runContext: { agentId: "a", runId: "r", companyId: "c", projectId: "p" } as ToolRunContext,
      })) as ToolResult;
      expect(result.content).toBe("rejected");
      expect(calls).toHaveLength(0);
      expect(captured.errorMessage).toContain("bytes");
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });

  it("rejects empty attachmentId at the SDK boundary (no RPC sent)", async () => {
    // Build an invocation with empty id — the SDK should throw before any
    // wire activity, so the host never sees the call.
    const captured: { errorMessage?: string } = {};
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.tools.register(
          "fetch-bad",
          { displayName: "x", description: "x", parametersSchema: { type: "object" } },
          async (_p, runCtx) => {
            try {
              await runCtx.artifacts.fetch("");
              return { content: "should not reach" };
            } catch (err) {
              captured.errorMessage = (err as Error).message;
              return { content: "rejected" };
            }
          },
        );
      },
    });

    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string | number, (response: JsonRpcResponse) => void>();
    const artifactsCalls: unknown[] = [];
    let nextRequestId = 1;

    function callWorker(method: string, params: unknown): Promise<unknown> {
      const id = `host-${nextRequestId++}`;
      const p = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) reject(new Error(response.error.message));
          else resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(createRequest(method, params, id)));
      return p;
    }

    hostReadline.on("line", (line) => {
      let message: unknown;
      try {
        message = parseMessage(line);
      } catch {
        return;
      }
      if (isJsonRpcResponse(message)) {
        const id = (message as JsonRpcResponse).id as string | number | null;
        if (id != null) {
          const cb = pending.get(id);
          if (cb) {
            pending.delete(id);
            cb(message as JsonRpcResponse);
          }
        }
        return;
      }
      if (isJsonRpcRequest(message)) {
        const req = message as JsonRpcRequest;
        if (req.method === "artifacts.fetch") {
          artifactsCalls.push(req.params);
        }
        hostToWorker.write(serializeMessage(createSuccessResponse(req.id, null)));
      }
    });

    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    try {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.test-artifacts-bad",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "x",
          description: "x",
          author: "x",
          categories: ["automation"],
          capabilities: [],
          entrypoints: {},
        },
        config: {},
        databaseNamespace: null,
      });
      const result = (await callWorker("executeTool", {
        toolName: "fetch-bad",
        parameters: {},
        runContext: {
          agentId: "a",
          runId: "r",
          companyId: "c",
          projectId: "p",
        } as ToolRunContext,
      })) as ToolResult;
      expect(result.content).toBe("rejected");
      expect(artifactsCalls).toHaveLength(0);
      expect(captured.errorMessage).toContain("attachmentId");
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});

/**
 * PLA-895 — `ctx.artifacts` on the worker `PluginContext`, reachable from a
 * NON-tool-dispatch (service/background) context. Here we exercise it from a
 * `runJob` handler, which the host drives with a `paperclipInvocation`. The
 * worker must:
 *  - send NO `runId` on the wire (the worker ctx has none),
 *  - echo the host's `paperclipInvocationId` so the host can backfill the
 *    active service/background run-context (the same path `secrets.resolve`
 *    uses from a `setup()` poll loop),
 *  - and surface the host's `runcontext_invalid` error verbatim on `fetch`
 *    from a service context (documents the PLA-894-B boundary — this issue
 *    must NOT widen service/background reads).
 */
describe("ctx.artifacts (worker PluginContext) — PLA-895 service/background", () => {
  interface JobHarness {
    captured?: Record<string, unknown>;
    invocationId?: unknown;
    returned?: { attachmentId: string };
    fetchError?: Error;
  }

  async function runJobArtifacts(opts: {
    create?: { companyId: string; filename: string; mimeType: string; bytes: Uint8Array };
    fetchAttachmentId?: string;
    createResponse?: { attachmentId: string };
    fetchError?: { code: number; message: string };
  }): Promise<JobHarness> {
    const harness: JobHarness = {};

    const plugin = definePlugin({
      async setup(ctx) {
        ctx.jobs.register("relay-tick", async () => {
          if (opts.create) {
            harness.returned = await ctx.artifacts.create(opts.create);
          }
          if (opts.fetchAttachmentId !== undefined) {
            try {
              await ctx.artifacts.fetch(opts.fetchAttachmentId);
            } catch (err) {
              harness.fetchError = err as Error;
            }
          }
        });
      },
    });

    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string | number, (response: JsonRpcResponse) => void>();
    let nextRequestId = 1;

    function callWorker(method: string, params: unknown, extra?: Record<string, unknown>): Promise<unknown> {
      const id = `host-${nextRequestId++}`;
      const p = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) reject(new Error(response.error.message));
          else resolve((response as { result?: unknown }).result);
        });
      });
      const req = { ...createRequest(method, params, id), ...(extra ?? {}) };
      hostToWorker.write(serializeMessage(req));
      return p;
    }

    hostReadline.on("line", (line) => {
      let message: unknown;
      try {
        message = parseMessage(line);
      } catch {
        return;
      }
      if (isJsonRpcResponse(message)) {
        const id = (message as JsonRpcResponse).id as string | number | null;
        if (id != null) {
          const cb = pending.get(id);
          if (cb) {
            pending.delete(id);
            cb(message as JsonRpcResponse);
          }
        }
        return;
      }
      if (isJsonRpcRequest(message)) {
        const req = message as JsonRpcRequest & { paperclipInvocationId?: unknown };
        if (req.method === "artifacts.create") {
          harness.captured = (req.params ?? {}) as Record<string, unknown>;
          harness.invocationId = req.paperclipInvocationId;
          hostToWorker.write(
            serializeMessage(
              createSuccessResponse(req.id, opts.createResponse ?? { attachmentId: "asset-svc-1" }),
            ),
          );
        } else if (req.method === "artifacts.fetch") {
          const e = opts.fetchError ?? { code: -32099, message: "runcontext_invalid" };
          hostToWorker.write(serializeMessage(createErrorResponse(req.id, e.code, e.message)));
        } else {
          hostToWorker.write(serializeMessage(createSuccessResponse(req.id, null)));
        }
      }
    });

    const worker = startWorkerRpcHost({ plugin, stdin: hostToWorker, stdout: workerToHost });
    try {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.test-artifacts-worker-ctx",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "x",
          description: "x",
          author: "x",
          categories: ["automation"],
          capabilities: ["issue.attachments.create"],
          entrypoints: {},
        },
        config: {},
        databaseNamespace: null,
      });
      // Drive the background job WITH a host-issued invocation context — this
      // is what lets the worker echo `paperclipInvocationId` for host backfill.
      await callWorker(
        "runJob",
        { job: { jobKey: "relay-tick", runId: "job-run-1", trigger: "schedule", scheduledAt: "2026-06-07T00:00:00Z" } },
        { paperclipInvocation: { id: "inv-svc-1", scope: { companyId: "platform-company" } } },
      );
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
    return harness;
  }

  it("create succeeds from a runJob (background) ctx: no runId on the wire, invocation id echoed", async () => {
    const raw = new Uint8Array([0x00, 0xff, 0x21, 0x7f]);
    const h = await runJobArtifacts({
      create: { companyId: "platform-company", filename: "photo.jpg", mimeType: "image/jpeg", bytes: raw },
      createResponse: { attachmentId: "asset-svc-42" },
    });

    expect(h.returned).toEqual({ attachmentId: "asset-svc-42" });
    expect(h.captured).toBeDefined();
    const { companyId, filename, mimeType, contentBase64, runId, ...extra } = h.captured!;
    expect(companyId).toBe("platform-company");
    expect(filename).toBe("photo.jpg");
    expect(mimeType).toBe("image/jpeg");
    expect(Array.from(Buffer.from(contentBase64 as string, "base64"))).toEqual(Array.from(raw));
    // Worker ctx has no tool dispatch → no runId is asserted by the worker.
    expect(runId).toBeUndefined();
    expect(extra).toEqual({});
    // Host backfill hook: the worker echoed the host-issued invocation id.
    expect(h.invocationId).toBe("inv-svc-1");
  });

  it("fetch from a service/background ctx surfaces runcontext_invalid (PLA-894-B boundary not widened)", async () => {
    const h = await runJobArtifacts({ fetchAttachmentId: "att-svc-1" });
    expect(h.fetchError).toBeDefined();
    expect(h.fetchError!.message).toContain("runcontext_invalid");
  });
});
