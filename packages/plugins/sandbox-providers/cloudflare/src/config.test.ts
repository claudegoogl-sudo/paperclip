import { describe, expect, it } from "vitest";
import type { CloudflareDriverConfig } from "./types.js";
import { validateCloudflareDriverConfig } from "./config.js";

const validConfig: CloudflareDriverConfig = {
  bridgeBaseUrl: "https://bridge.example.workers.dev",
  bridgeAuthToken: "secret-ref://bridge-token",
  reuseLease: false,
  keepAlive: false,
  sleepAfter: "10m",
  normalizeId: true,
  requestedCwd: "/workspace/paperclip",
  sessionStrategy: "named",
  sessionId: "paperclip",
  timeoutMs: 300_000,
  bridgeRequestTimeoutMs: 30_000,
  previewHostname: null,
};

describe("validateCloudflareDriverConfig", () => {
  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "allows plain HTTP for the local bridge host %s",
    (host) => {
      const errors = validateCloudflareDriverConfig({
        ...validConfig,
        bridgeBaseUrl: `http://${host}:8787`,
      });

      expect(errors).toEqual([]);
    },
  );

  it("still rejects a non-local plain HTTP bridgeBaseUrl", () => {
    const errors = validateCloudflareDriverConfig({
      ...validConfig,
      bridgeBaseUrl: "http://bridge.example.workers.dev",
    });

    expect(errors).toContain("bridgeBaseUrl must use HTTPS unless it points at localhost.");
  });
});
