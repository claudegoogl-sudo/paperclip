/**
 * Tests for `ctx.http.fetch` body serialization across the worker→host RPC.
 *
 * Covers PLA-516 / PLA-518 — binary and FormData bodies must round-trip
 * end-to-end without `String()` corruption.
 *
 * The tests drive the worker through an in-memory bridge: they `initialize`
 * the worker with a plugin whose `setup` invokes `ctx.http.fetch`, then
 * inspect the `http.fetch` RPC params the worker emits to the host. The host
 * is mocked — we never make a real network request.
 */

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

interface HostFetchCapture {
  url: string;
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    bodyEncoding?: "utf8" | "base64";
  };
}

interface BridgeResult {
  fetchCalls: HostFetchCapture[];
  pluginSetupError: unknown;
}

/**
 * Run the worker with the given plugin setup, capturing every `http.fetch`
 * RPC call the worker emits. The mock host always responds with a 200 OK so
 * the plugin's `setup` completes deterministically.
 */
async function runWorkerCapturingFetch(
  setupFn: (ctx: import("../src/types.js").PluginContext) => Promise<void> | void,
): Promise<BridgeResult> {
  const hostToWorker = new PassThrough();
  const workerToHost = new PassThrough();
  const hostReadline = createInterface({ input: workerToHost });
  const pending = new Map<string | number, (response: JsonRpcResponse) => void>();
  let nextRequestId = 1;

  const fetchCalls: HostFetchCapture[] = [];
  let pluginSetupError: unknown = null;

  const plugin = definePlugin({
    async setup(ctx) {
      try {
        await setupFn(ctx);
      } catch (err) {
        pluginSetupError = err;
      }
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

  // Inbound from the worker. Two kinds of messages:
  //   - JSON-RPC responses to host→worker calls (e.g. initialize response)
  //   - JSON-RPC requests for worker→host methods (events.subscribe, http.fetch, ...)
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
        fetchCalls.push(req.params as HostFetchCapture);
        // Respond with a benign 200 so the worker's fetch promise resolves.
        hostToWorker.write(
          serializeMessage(
            createSuccessResponse(req.id, {
              status: 200,
              statusText: "OK",
              headers: {},
              body: "",
            }),
          ),
        );
      } else {
        // Default: acknowledge every other worker→host call with a stub null
        // result so we don't block on e.g. events.subscribe.
        hostToWorker.write(serializeMessage(createSuccessResponse(req.id, null)));
      }
    }
  });

  try {
    await callWorker("initialize", {
      manifest: {
        id: "paperclip.test-http-fetch",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "HTTP Fetch Test",
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: {},
      },
      config: {},
      databaseNamespace: null,
    });

    // setup() ran inline during initialize. Give the event loop a tick so
    // any post-fetch microtasks settle before the test inspects the capture.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    worker.stop();
    hostReadline.close();
    hostToWorker.destroy();
    workerToHost.destroy();
  }

  return { fetchCalls, pluginSetupError };
}

describe("ctx.http.fetch body serialization", () => {
  it("preserves string bodies as utf8 (no regression)", async () => {
    const { fetchCalls, pluginSetupError } = await runWorkerCapturingFetch(async (ctx) => {
      await ctx.http.fetch("https://example.com/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"hello":"world"}',
      });
    });

    expect(pluginSetupError).toBeNull();
    expect(fetchCalls).toHaveLength(1);
    const init = fetchCalls[0]!.init!;
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"hello":"world"}');
    expect(init.bodyEncoding).toBe("utf8");
    // Caller-supplied Content-Type must be preserved unchanged.
    expect(init.headers?.["Content-Type"]).toBe("application/json");
  });

  it("forwards Uint8Array bodies as exact bytes via base64", async () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x42]);
    const { fetchCalls, pluginSetupError } = await runWorkerCapturingFetch(async (ctx) => {
      await ctx.http.fetch("https://example.com/binary", {
        method: "POST",
        body: bytes,
      });
    });

    expect(pluginSetupError).toBeNull();
    expect(fetchCalls).toHaveLength(1);
    const init = fetchCalls[0]!.init!;
    expect(init.bodyEncoding).toBe("base64");
    expect(typeof init.body).toBe("string");
    const decoded = Buffer.from(init.body!, "base64");
    // Exact byte preservation — no "[object Uint8Array]" or utf-16 coercion.
    expect(Array.from(decoded)).toEqual([0x00, 0xff, 0x42]);
  });

  it("forwards Buffer bodies as exact bytes via base64", async () => {
    const buf = Buffer.from([0x01, 0x02, 0xfe, 0xfd]);
    const { fetchCalls, pluginSetupError } = await runWorkerCapturingFetch(async (ctx) => {
      await ctx.http.fetch("https://example.com/binary", {
        method: "PUT",
        body: buf,
      });
    });

    expect(pluginSetupError).toBeNull();
    const init = fetchCalls[0]!.init!;
    expect(init.bodyEncoding).toBe("base64");
    expect(Array.from(Buffer.from(init.body!, "base64"))).toEqual([0x01, 0x02, 0xfe, 0xfd]);
  });

  it("forwards ArrayBuffer bodies as exact bytes via base64", async () => {
    const ab = new ArrayBuffer(3);
    new Uint8Array(ab).set([0xde, 0xad, 0xbe]);
    const { fetchCalls } = await runWorkerCapturingFetch(async (ctx) => {
      await ctx.http.fetch("https://example.com/binary", { method: "POST", body: ab });
    });
    const init = fetchCalls[0]!.init!;
    expect(init.bodyEncoding).toBe("base64");
    expect(Array.from(Buffer.from(init.body!, "base64"))).toEqual([0xde, 0xad, 0xbe]);
  });

  it("serializes FormData to multipart with matching Content-Type boundary", async () => {
    const form = new FormData();
    form.append("field1", "value1");
    form.append(
      "file",
      new Blob([new Uint8Array([0x00, 0xff, 0x42])], { type: "application/octet-stream" }),
      "payload.bin",
    );

    const { fetchCalls, pluginSetupError } = await runWorkerCapturingFetch(async (ctx) => {
      await ctx.http.fetch("https://example.com/upload", { method: "POST", body: form });
    });

    expect(pluginSetupError).toBeNull();
    const init = fetchCalls[0]!.init!;
    expect(init.bodyEncoding).toBe("base64");
    const ct = init.headers?.["Content-Type"];
    expect(ct).toBeTruthy();
    expect(ct).toMatch(/^multipart\/form-data; boundary=/);
    const boundary = ct!.replace(/^multipart\/form-data; boundary=/, "");
    const decoded = Buffer.from(init.body!, "base64").toString("binary");
    // First bytes of a multipart body must be the boundary marker.
    expect(decoded.startsWith(`--${boundary}\r\n`)).toBe(true);
    // Body should reference both fields and contain the raw binary file byte 0xff.
    expect(decoded).toContain('name="field1"');
    expect(decoded).toContain("value1");
    expect(decoded).toContain('name="file"');
    expect(decoded).toContain('filename="payload.bin"');
    expect(decoded).toContain(`\r\n--${boundary}--\r\n`);
    // The raw 0xff byte (encoded as 0xff in binary string) must be present.
    expect(decoded.includes(String.fromCharCode(0xff))).toBe(true);
  });

  it("does not overwrite a caller-supplied Content-Type for FormData", async () => {
    const form = new FormData();
    form.append("x", "y");

    const { fetchCalls } = await runWorkerCapturingFetch(async (ctx) => {
      await ctx.http.fetch("https://example.com/upload", {
        method: "POST",
        headers: { "Content-Type": "application/x-caller-supplied" },
        body: form,
      });
    });

    const init = fetchCalls[0]!.init!;
    expect(init.headers?.["Content-Type"]).toBe("application/x-caller-supplied");
    // Body still encoded as bytes — caller takes responsibility for the boundary.
    expect(init.bodyEncoding).toBe("base64");
  });
});
