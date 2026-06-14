/**
 * Regression tests for `ctx.http.fetch` RESPONSE body decoding (PLA-1063).
 *
 * The host serializes every response body as a string over the JSON-RPC wire
 * and tags it with `bodyEncoding`. Binary responses (images/docs) are sent as
 * base64; the worker MUST decode base64 back to bytes when reconstructing the
 * Response. Before the fix the host emitted UTF-8 (corrupting binary) and the
 * worker built `new Response(result.body)` from the raw string regardless of
 * `bodyEncoding` — so inbound media (e.g. Telegram images) was irreversibly
 * mangled. These tests round-trip known binary fixtures and assert the sha256
 * of the bytes the plugin reads equals the source.
 *
 * Harness: the worker runs for real over an in-memory stdio bridge. The test
 * plays the host, answering the worker's `http.fetch` RPC with a configurable
 * response. This exercises the real worker reconstruction path; it does not
 * make a network request.
 *
 * These FAIL on the pre-fix worker: it would hand the base64 STRING to
 * `new Response(...)`, so `arrayBuffer()` returns the UTF-8 bytes of the base64
 * text, not the decoded image bytes — sha256 mismatch.
 */

import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { definePlugin } from "../src/define-plugin.js";
import {
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

interface HostResponse {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body: string;
  bodyEncoding?: "utf8" | "base64";
}

interface DownloadResult {
  sha256: string;
  byteLength: number;
  text: string;
}

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

/**
 * Run the worker. Its plugin `setup` performs a single `ctx.http.fetch`, reads
 * the response as bytes, and records the sha256 + decoded text into a closure
 * the test inspects. The mock host answers that fetch with `hostResponse`.
 */
async function fetchThroughWorker(hostResponse: HostResponse): Promise<DownloadResult> {
  const hostToWorker = new PassThrough();
  const workerToHost = new PassThrough();
  const hostReadline = createInterface({ input: workerToHost });
  const pending = new Map<string | number, (response: JsonRpcResponse) => void>();
  let nextRequestId = 1;

  let download: DownloadResult | null = null;
  let setupError: unknown = null;

  const plugin = definePlugin({
    async setup(ctx) {
      try {
        const res = await ctx.http.fetch("https://example.com/asset");
        const buf = Buffer.from(await res.arrayBuffer());
        download = {
          sha256: sha256(buf),
          byteLength: buf.byteLength,
          text: buf.toString("utf8"),
        };
      } catch (err) {
        setupError = err;
      }
    },
  });

  const worker = startWorkerRpcHost({ plugin, stdin: hostToWorker, stdout: workerToHost });

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
      if (req.method === "http.fetch") {
        hostToWorker.write(
          serializeMessage(
            createSuccessResponse(req.id, {
              status: hostResponse.status ?? 200,
              statusText: hostResponse.statusText ?? "OK",
              headers: hostResponse.headers ?? {},
              body: hostResponse.body,
              ...(hostResponse.bodyEncoding ? { bodyEncoding: hostResponse.bodyEncoding } : {}),
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
        id: "paperclip.test-http-fetch-response",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "HTTP Fetch Response Test",
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: {},
      },
      config: {},
      databaseNamespace: null,
    });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    worker.stop();
    hostReadline.close();
    hostToWorker.destroy();
    workerToHost.destroy();
  }

  if (setupError) throw setupError;
  if (!download) throw new Error("plugin setup did not complete the fetch");
  return download;
}

// A fake-but-realistic JPEG: SOI/EOI markers wrapping bytes that are NOT valid
// UTF-8 (0x80-0xFF run + nulls), so a UTF-8 round-trip would corrupt them.
function fakeJpeg(): Buffer {
  const middle = Buffer.alloc(512);
  for (let i = 0; i < middle.length; i++) middle[i] = (i * 37 + 129) & 0xff;
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), middle, Buffer.from([0xff, 0xd9])]);
}

// PNG magic header + non-UTF-8 payload.
function fakePng(): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.alloc(256);
  for (let i = 0; i < body.length; i++) body[i] = (255 - i) & 0xff;
  return Buffer.concat([sig, body]);
}

describe("ctx.http.fetch response body decoding (PLA-1063)", () => {
  it("round-trips a binary JPEG via base64 with exact sha256", async () => {
    const jpeg = fakeJpeg();
    const result = await fetchThroughWorker({
      headers: { "content-type": "image/jpeg" },
      body: jpeg.toString("base64"),
      bodyEncoding: "base64",
    });
    expect(result.byteLength).toBe(jpeg.byteLength);
    expect(result.sha256).toBe(sha256(jpeg));
  });

  it("round-trips a binary PNG via base64 with exact sha256", async () => {
    const png = fakePng();
    const result = await fetchThroughWorker({
      headers: { "content-type": "image/png" },
      body: png.toString("base64"),
      bodyEncoding: "base64",
    });
    expect(result.byteLength).toBe(png.byteLength);
    expect(result.sha256).toBe(sha256(png));
  });

  it("decodes base64 to bytes, not the base64 string itself", async () => {
    // Guards the precise pre-fix bug: building Response from the raw base64
    // string. The decoded bytes must differ from the UTF-8 bytes of the b64 text.
    const jpeg = fakeJpeg();
    const b64 = jpeg.toString("base64");
    const result = await fetchThroughWorker({ body: b64, bodyEncoding: "base64" });
    expect(result.byteLength).toBe(jpeg.byteLength);
    expect(result.byteLength).not.toBe(Buffer.byteLength(b64, "utf8"));
    expect(result.sha256).not.toBe(sha256(Buffer.from(b64, "utf8")));
  });

  it("returns text unchanged for an explicit utf8 JSON response (no regression)", async () => {
    const json = '{"hello":"world","n":42}';
    const result = await fetchThroughWorker({
      headers: { "content-type": "application/json" },
      body: json,
      bodyEncoding: "utf8",
    });
    expect(result.text).toBe(json);
    expect(JSON.parse(result.text)).toEqual({ hello: "world", n: 42 });
  });

  it("defaults to utf8 when bodyEncoding is absent (back-compat with old hosts)", async () => {
    const json = '{"legacy":true}';
    const result = await fetchThroughWorker({ body: json });
    expect(result.text).toBe(json);
    expect(JSON.parse(result.text)).toEqual({ legacy: true });
  });
});
