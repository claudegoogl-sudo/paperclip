import { describe, expect, it } from "vitest";
import type { CloudflareDriverConfig } from "./types.js";
import { parseCloudflareDriverConfig, validateCloudflareDriverConfig } from "./config.js";

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

describe("parseCloudflareDriverConfig", () => {
  it("applies every documented default for an empty input", () => {
    const config = parseCloudflareDriverConfig({});

    expect(config).toEqual<CloudflareDriverConfig>({
      bridgeBaseUrl: "",
      bridgeAuthToken: "",
      reuseLease: false,
      keepAlive: false,
      sleepAfter: "1h",
      normalizeId: true,
      requestedCwd: "/workspace/paperclip",
      sessionStrategy: "named",
      sessionId: "paperclip",
      timeoutMs: 300_000,
      bridgeRequestTimeoutMs: 300_000,
      previewHostname: null,
    });
  });

  it("trims string fields and drops whitespace-only values back to their default", () => {
    const config = parseCloudflareDriverConfig({
      bridgeBaseUrl: "  https://bridge.example.workers.dev  ",
      bridgeAuthToken: "  token-123  ",
      sleepAfter: "   ",
      requestedCwd: "   ",
      sessionId: "   ",
      previewHostname: "   ",
    });

    expect(config.bridgeBaseUrl).toBe("https://bridge.example.workers.dev");
    expect(config.bridgeAuthToken).toBe("token-123");
    expect(config.sleepAfter).toBe("1h");
    expect(config.requestedCwd).toBe("/workspace/paperclip");
    expect(config.sessionId).toBe("paperclip");
    expect(config.previewHostname).toBeNull();
  });

  it("passes through explicit boolean and numeric overrides", () => {
    const config = parseCloudflareDriverConfig({
      reuseLease: true,
      keepAlive: true,
      normalizeId: false,
      timeoutMs: 120_000,
      bridgeRequestTimeoutMs: 45_000,
    });

    expect(config.reuseLease).toBe(true);
    expect(config.keepAlive).toBe(true);
    expect(config.normalizeId).toBe(false);
    expect(config.timeoutMs).toBe(120_000);
    expect(config.bridgeRequestTimeoutMs).toBe(45_000);
  });

  it("falls back to the default for a non-finite numeric override", () => {
    const config = parseCloudflareDriverConfig({ timeoutMs: "not-a-number" });

    expect(config.timeoutMs).toBe(300_000);
  });

  it("truncates a fractional numeric override toward zero", () => {
    const config = parseCloudflareDriverConfig({ timeoutMs: 1_500.9 });

    expect(config.timeoutMs).toBe(1_500);
  });

  it("only accepts the literal string \"default\" for sessionStrategy, otherwise falling back to named", () => {
    expect(parseCloudflareDriverConfig({}).sessionStrategy).toBe("named");
    expect(parseCloudflareDriverConfig({ sessionStrategy: "default" }).sessionStrategy).toBe("default");
    expect(parseCloudflareDriverConfig({ sessionStrategy: "named" }).sessionStrategy).toBe("named");
    expect(parseCloudflareDriverConfig({ sessionStrategy: "bogus" }).sessionStrategy).toBe("named");
  });

  it("preserves a provided previewHostname and trims it", () => {
    const config = parseCloudflareDriverConfig({ previewHostname: "  preview.example.dev  " });

    expect(config.previewHostname).toBe("preview.example.dev");
  });
});

describe("validateCloudflareDriverConfig", () => {
  it("returns no errors for a fully valid config", () => {
    expect(validateCloudflareDriverConfig(validConfig)).toEqual([]);
  });

  it("requires bridgeBaseUrl", () => {
    const errors = validateCloudflareDriverConfig({ ...validConfig, bridgeBaseUrl: "" });

    expect(errors).toContain("Cloudflare sandbox environments require bridgeBaseUrl.");
  });

  it("rejects a bridgeBaseUrl that is not a valid URL", () => {
    const errors = validateCloudflareDriverConfig({ ...validConfig, bridgeBaseUrl: "not a url" });

    expect(errors).toContain("bridgeBaseUrl must be a valid URL.");
  });

  it("rejects a non-HTTPS bridgeBaseUrl for a non-localhost host", () => {
    const errors = validateCloudflareDriverConfig({
      ...validConfig,
      bridgeBaseUrl: "http://bridge.example.workers.dev",
    });

    expect(errors).toContain("bridgeBaseUrl must use HTTPS unless it points at localhost.");
  });

  it.each(["localhost", "127.0.0.1"])(
    "allows plain HTTP for the local bridge host %s",
    (host) => {
      const errors = validateCloudflareDriverConfig({
        ...validConfig,
        bridgeBaseUrl: `http://${host}:8787`,
      });

      expect(errors).toEqual([]);
    },
  );

  it("documents that an IPv6 loopback bridgeBaseUrl is not currently recognized as local", () => {
    // URL#hostname renders an IPv6 host with brackets (e.g. "[::1]"), but the
    // local-host allowlist only contains the bracket-free "::1", so this
    // never matches today and HTTPS is still required. See the Cloudflare
    // sandbox config bugfix follow-up PR for the real-world impact.
    const errors = validateCloudflareDriverConfig({
      ...validConfig,
      bridgeBaseUrl: "http://[::1]:8787",
    });

    expect(errors).toContain("bridgeBaseUrl must use HTTPS unless it points at localhost.");
  });

  it("requires bridgeAuthToken", () => {
    const errors = validateCloudflareDriverConfig({ ...validConfig, bridgeAuthToken: "" });

    expect(errors).toContain("Cloudflare sandbox environments require bridgeAuthToken.");
  });

  it("requires keepAlive when reuseLease is enabled", () => {
    const errors = validateCloudflareDriverConfig({
      ...validConfig,
      reuseLease: true,
      keepAlive: false,
    });

    expect(errors).toContain("reuseLease requires keepAlive for Cloudflare sandboxes.");
  });

  it("allows reuseLease when keepAlive is also enabled", () => {
    const errors = validateCloudflareDriverConfig({
      ...validConfig,
      reuseLease: true,
      keepAlive: true,
    });

    expect(errors).not.toContain("reuseLease requires keepAlive for Cloudflare sandboxes.");
  });

  it.each([0, -1, 86_400_001])("rejects an out-of-range timeoutMs of %d", (timeoutMs) => {
    const errors = validateCloudflareDriverConfig({ ...validConfig, timeoutMs });

    expect(errors).toContain("timeoutMs must be between 1 and 86400000.");
  });

  it.each([1, 86_400_000])("accepts a boundary timeoutMs of %d", (timeoutMs) => {
    const errors = validateCloudflareDriverConfig({ ...validConfig, timeoutMs });

    expect(errors).not.toContain("timeoutMs must be between 1 and 86400000.");
  });

  it.each([0, -1, 86_400_001])(
    "rejects an out-of-range bridgeRequestTimeoutMs of %d",
    (bridgeRequestTimeoutMs) => {
      const errors = validateCloudflareDriverConfig({ ...validConfig, bridgeRequestTimeoutMs });

      expect(errors).toContain("bridgeRequestTimeoutMs must be between 1 and 86400000.");
    },
  );

  it("requires requestedCwd to be an absolute POSIX path", () => {
    const errors = validateCloudflareDriverConfig({ ...validConfig, requestedCwd: "workspace/paperclip" });

    expect(errors).toContain("requestedCwd must be an absolute POSIX path.");
  });

  it("requires a non-blank sessionId when sessionStrategy is named", () => {
    const errors = validateCloudflareDriverConfig({
      ...validConfig,
      sessionStrategy: "named",
      sessionId: "   ",
    });

    expect(errors).toContain("sessionId is required when sessionStrategy is named.");
  });

  it("does not require sessionId when sessionStrategy is default", () => {
    const errors = validateCloudflareDriverConfig({
      ...validConfig,
      sessionStrategy: "default",
      sessionId: "",
    });

    expect(errors).not.toContain("sessionId is required when sessionStrategy is named.");
  });

  it("accumulates multiple errors at once", () => {
    const errors = validateCloudflareDriverConfig({
      ...validConfig,
      bridgeBaseUrl: "",
      bridgeAuthToken: "",
      requestedCwd: "relative/path",
    });

    expect(errors).toHaveLength(3);
  });
});
