/**
 * PLA-1459 — `ctx.http.fetch` response-body encoding.
 *
 * The host's `executePinnedHttpRequest` must return byte-exact base64 when the
 * SDK worker opts in (`acceptResponseBodyEncoding: "base64"`), and keep the
 * legacy lossy utf8 decode with NO `bodyEncoding` field when it doesn't. Before
 * this fix the host always did `Buffer.concat(chunks).toString("utf8")`, which
 * collapsed every byte >=0x80 to U+FFFD and corrupted binary responses (the
 * first real inbound Telegram photo, PLA-1458).
 */

import { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  executePinnedHttpRequest,
  type ValidatedFetchTarget,
} from "../services/plugin-host-services.js";

// JPEG SOI + APP0 marker: every byte here is >=0x80 except the "JFIF" ASCII —
// exactly the shape a lossy utf8 decode destroys.
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
]);
const TEXT_BODY = "hello, wörld — ünïcode ✓";

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/binary") {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(JPEG_BYTES);
    } else {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(TEXT_BODY);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function targetFor(path: string): ValidatedFetchTarget {
  const parsedUrl = new URL(`http://127.0.0.1:${port}${path}`);
  return {
    parsedUrl,
    resolvedAddress: "127.0.0.1",
    hostHeader: `127.0.0.1:${port}`,
    useTls: false,
  };
}

describe("executePinnedHttpRequest response encoding (PLA-1459)", () => {
  it("returns byte-exact base64 for a binary response when opted in", async () => {
    const res = await executePinnedHttpRequest(
      targetFor("/binary"),
      undefined,
      new AbortController().signal,
      true,
    );
    expect(res.bodyEncoding).toBe("base64");
    expect(Buffer.from(res.body, "base64").equals(JPEG_BYTES)).toBe(true);
  });

  it("returns base64 that decodes to the original text when opted in", async () => {
    const res = await executePinnedHttpRequest(
      targetFor("/text"),
      undefined,
      new AbortController().signal,
      true,
    );
    expect(res.bodyEncoding).toBe("base64");
    expect(Buffer.from(res.body, "base64").toString("utf8")).toBe(TEXT_BODY);
  });

  it("legacy path: no opt-in returns a utf8 string body and NO bodyEncoding", async () => {
    const res = await executePinnedHttpRequest(
      targetFor("/text"),
      undefined,
      new AbortController().signal,
      false,
    );
    expect(res.bodyEncoding).toBeUndefined();
    expect(res.body).toBe(TEXT_BODY);
  });

  it("legacy path corrupts binary (documents why the opt-in is required)", async () => {
    const res = await executePinnedHttpRequest(
      targetFor("/binary"),
      undefined,
      new AbortController().signal,
      false,
    );
    expect(res.bodyEncoding).toBeUndefined();
    // Lossy utf8 decode: the high bytes are gone, so re-encoding does NOT
    // reproduce the original JPEG. This is the bug the opt-in avoids.
    expect(Buffer.from(res.body, "utf8").equals(JPEG_BYTES)).toBe(false);
  });
});
