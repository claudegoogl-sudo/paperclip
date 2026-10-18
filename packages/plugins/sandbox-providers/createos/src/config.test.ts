import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig, resolveApiKey } from "./config.js";

const valid = { apiUrl: "https://createos.example.test", apiKey: "test-secret", shape: "test-shape" };

describe("parseConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires an apiUrl", () => {
    expect(() => parseConfig({ shape: "test-shape" })).toThrow("CreateOS requires an API URL.");
  });

  it("rejects a malformed apiUrl", () => {
    expect(() => parseConfig({ ...valid, apiUrl: "not a url" })).toThrow("CreateOS API URL is invalid.");
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("allows plain HTTP on loopback host %s", (host) => {
    const config = parseConfig({ ...valid, apiUrl: `http://${host}:4000` });
    expect(config.apiUrl).toBe(`http://${host}:4000`);
  });

  it("rejects an apiUrl with a fragment", () => {
    expect(() => parseConfig({ ...valid, apiUrl: `${valid.apiUrl}#frag` })).toThrow("API URL");
  });

  it.each(["", "/", "/v1", "/v1/"])("accepts an apiUrl with pathname %s and normalizes to origin", (pathname) => {
    const config = parseConfig({ ...valid, apiUrl: `${valid.apiUrl}${pathname}` });
    expect(config.apiUrl).toBe(valid.apiUrl);
  });

  it("rejects an apiUrl with a non-v1 path segment", () => {
    expect(() => parseConfig({ ...valid, apiUrl: `${valid.apiUrl}/v2` })).toThrow("API URL");
  });

  it("requires a non-empty shape", () => {
    expect(() => parseConfig({ ...valid, shape: undefined })).toThrow("CreateOS requires a shape from its shape catalog.");
  });

  it("rejects a whitespace-only shape as a non-string-shaped value", () => {
    expect(() => parseConfig({ ...valid, shape: "   " })).toThrow("shape must be a non-empty string.");
  });

  it("rejects a non-string text field", () => {
    expect(() => parseConfig({ ...valid, shape: 123 })).toThrow("shape must be a non-empty string.");
  });

  it("rejects a text field containing a null byte", () => {
    expect(() => parseConfig({ ...valid, rootfs: "abc\0def" })).toThrow("rootfs must be a non-empty string.");
  });

  it("trims surrounding whitespace on text fields", () => {
    const config = parseConfig({ ...valid, shape: "  test-shape  ", rootfs: "  my-rootfs  ", region: "  us-east  " });
    expect(config.shape).toBe("test-shape");
    expect(config.rootfs).toBe("my-rootfs");
    expect(config.region).toBe("us-east");
  });

  it("defaults optional fields to null", () => {
    const config = parseConfig(valid);
    expect(config.rootfs).toBeNull();
    expect(config.region).toBeNull();
  });

  it("defaults timeoutMs to 300000 when omitted", () => {
    expect(parseConfig(valid).timeoutMs).toBe(300_000);
  });

  it.each([0, -1, NaN, 1.5, 86_400_001, "500"])("rejects an invalid timeoutMs value %s", (timeoutMs) => {
    expect(() => parseConfig({ ...valid, timeoutMs })).toThrow("timeoutMs must be an integer between 1 and 86400000.");
  });

  it("treats a null timeoutMs the same as omitted and applies the default", () => {
    expect(parseConfig({ ...valid, timeoutMs: null }).timeoutMs).toBe(300_000);
  });

  it("accepts a valid timeoutMs at the boundaries", () => {
    expect(parseConfig({ ...valid, timeoutMs: 1 }).timeoutMs).toBe(1);
    expect(parseConfig({ ...valid, timeoutMs: 86_400_000 }).timeoutMs).toBe(86_400_000);
  });

  it("defaults reuseLease to false and only accepts a strict boolean true", () => {
    expect(parseConfig(valid).reuseLease).toBe(false);
    expect(parseConfig({ ...valid, reuseLease: true }).reuseLease).toBe(true);
    expect(parseConfig({ ...valid, reuseLease: false }).reuseLease).toBe(false);
  });

  it("rejects a non-boolean reuseLease", () => {
    expect(() => parseConfig({ ...valid, reuseLease: "true" })).toThrow("reuseLease must be a boolean.");
  });

  it("returns apiKey as null when omitted", () => {
    expect(parseConfig({ ...valid, apiKey: undefined }).apiKey).toBeNull();
  });
});

describe("resolveApiKey", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the configured apiKey for a custom endpoint", () => {
    const config = parseConfig(valid);
    expect(resolveApiKey(config)).toBe("test-secret");
  });

  it("requires an explicit apiKey for a custom endpoint even if a fallback env key exists", () => {
    vi.stubEnv("CREATEOS_API_KEY", "fallback-secret");
    const config = parseConfig({ ...valid, apiKey: undefined });
    expect(() => resolveApiKey(config)).toThrow(
      "Custom CreateOS API endpoints require an explicit environment API key; the host fallback is only available for https://api.sb.createos.sh.",
    );
  });

  it("falls back to CREATEOS_API_KEY only for the official host", () => {
    vi.stubEnv("CREATEOS_API_KEY", "  fallback-secret  ");
    const config = parseConfig({ ...valid, apiUrl: "https://api.sb.createos.sh/v1", apiKey: undefined });
    expect(resolveApiKey(config)).toBe("fallback-secret");
  });

  it("throws when the official host has neither an explicit key nor an env fallback", () => {
    vi.stubEnv("CREATEOS_API_KEY", "");
    const config = parseConfig({ ...valid, apiUrl: "https://api.sb.createos.sh", apiKey: undefined });
    expect(() => resolveApiKey(config)).toThrow(
      "CreateOS requires an API key in the environment config or CREATEOS_API_KEY.",
    );
  });

  it("throws when the env fallback is whitespace-only", () => {
    vi.stubEnv("CREATEOS_API_KEY", "   ");
    const config = parseConfig({ ...valid, apiUrl: "https://api.sb.createos.sh", apiKey: undefined });
    expect(() => resolveApiKey(config)).toThrow("CreateOS requires an API key");
  });

  it("rejects a configured apiKey containing a carriage return or newline", () => {
    const config = { ...parseConfig(valid), apiKey: "secret\nInjected-Header: evil" };
    expect(() => resolveApiKey(config)).toThrow("CreateOS requires an API key in the environment config or CREATEOS_API_KEY.");
  });

  it("rejects an env fallback key containing a newline", () => {
    vi.stubEnv("CREATEOS_API_KEY", "secret\r\nInjected-Header: evil");
    const config = parseConfig({ ...valid, apiUrl: "https://api.sb.createos.sh", apiKey: undefined });
    expect(() => resolveApiKey(config)).toThrow("CreateOS requires an API key");
  });
});
