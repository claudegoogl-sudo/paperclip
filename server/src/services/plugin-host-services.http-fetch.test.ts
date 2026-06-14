/**
 * Regression test for the host side of `ctx.http.fetch` binary safety (PLA-1063).
 *
 * The outbound proxy used to serialize every upstream response body as UTF-8
 * (`Buffer.concat(chunks).toString("utf8")`), irreversibly corrupting binary
 * payloads (inbound Telegram images/docs). The fix base64-encodes the body and
 * tags it `bodyEncoding: "base64"`, mirroring the request-body path so bytes
 * round-trip exactly. The worker half (decoding base64 back to bytes) is covered
 * in `packages/plugins/sdk/tests/http-fetch-response.test.ts`.
 *
 * This drives the real `executePinnedHttpRequest` against a loopback server so
 * we exercise the actual socket read + serialization, then asserts the decoded
 * bytes match the source sha256.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { executePinnedHttpRequest, type ValidatedFetchTarget } from "./plugin-host-services.js";

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

let server: Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

async function startServer(
  handler: (path: string) => { contentType: string; body: Buffer },
): Promise<number> {
  server = createServer((req, res) => {
    const { contentType, body } = handler(req.url ?? "/");
    res.writeHead(200, { "content-type": contentType, "content-length": String(body.length) });
    res.end(body);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  return (server!.address() as AddressInfo).port;
}

// Loopback target — bypasses SSRF validation (which blocks 127.0.0.1) on
// purpose: we are unit-testing the post-validation serialization, not the guard.
function loopbackTarget(port: number, path: string): ValidatedFetchTarget {
  const parsedUrl = new URL(`http://127.0.0.1:${port}${path}`);
  return {
    parsedUrl,
    resolvedAddress: "127.0.0.1",
    hostHeader: `127.0.0.1:${port}`,
    useTls: false,
  };
}

function fakeJpeg(): Buffer {
  const middle = Buffer.alloc(1024);
  for (let i = 0; i < middle.length; i++) middle[i] = (i * 31 + 200) & 0xff;
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), middle, Buffer.from([0xff, 0xd9])]);
}

describe("host http.fetch response serialization (PLA-1063)", () => {
  it("returns binary bodies as byte-exact base64 when the worker opts in", async () => {
    const jpeg = fakeJpeg();
    const port = await startServer(() => ({ contentType: "image/jpeg", body: jpeg }));
    const controller = new AbortController();

    const result = await executePinnedHttpRequest(
      loopbackTarget(port, "/image.jpg"),
      undefined,
      controller.signal,
      "base64",
    );

    expect(result.status).toBe(200);
    expect(result.bodyEncoding).toBe("base64");
    const decoded = Buffer.from(result.body, "base64");
    expect(decoded.byteLength).toBe(jpeg.byteLength);
    expect(sha256(decoded)).toBe(sha256(jpeg));
  });

  it("round-trips a JSON body through base64 without text corruption (opt-in)", async () => {
    const json = Buffer.from('{"hello":"world","emoji":"éü"}', "utf8");
    const port = await startServer(() => ({ contentType: "application/json", body: json }));
    const controller = new AbortController();

    const result = await executePinnedHttpRequest(
      loopbackTarget(port, "/data.json"),
      undefined,
      controller.signal,
      "base64",
    );

    expect(result.bodyEncoding).toBe("base64");
    const decoded = Buffer.from(result.body, "base64");
    expect(decoded.toString("utf8")).toBe(json.toString("utf8"));
    expect(sha256(decoded)).toBe(sha256(json));
  });

  // Old-worker / new-host case (PLA-1064 review): a legacy SDK never sends
  // acceptResponseBodyEncoding. The host MUST keep returning a utf8 string with
  // no bodyEncoding so not-yet-rebuilt plugins (klipper/vault, JSON-only) are
  // byte-for-byte unaffected by the host upgrade — no lockstep deploy required.
  it("returns a legacy utf8 string with no bodyEncoding when the worker does NOT opt in", async () => {
    const json = Buffer.from('{"legacy":true,"emoji":"éü"}', "utf8");
    const port = await startServer(() => ({ contentType: "application/json", body: json }));
    const controller = new AbortController();

    const result = await executePinnedHttpRequest(
      loopbackTarget(port, "/legacy.json"),
      undefined,
      controller.signal,
      // no acceptResponseBodyEncoding — simulates an old SDK
    );

    expect(result.bodyEncoding).toBeUndefined();
    expect(result.body).toBe(json.toString("utf8"));
    expect(JSON.parse(result.body)).toEqual({ legacy: true, emoji: "éü" });
  });
});
