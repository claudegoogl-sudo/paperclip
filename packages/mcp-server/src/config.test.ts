import { describe, expect, it } from "vitest";
import {
  DEFAULT_MCP_FETCH_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  normalizeApiUrl,
  readConfigFromEnv,
} from "./config.js";

describe("normalizeApiUrl", () => {
  it("appends /api when the URL does not already end with it", () => {
    expect(normalizeApiUrl("https://example.com")).toBe("https://example.com/api");
  });

  it("strips trailing slashes before checking the /api suffix", () => {
    expect(normalizeApiUrl("https://example.com/")).toBe("https://example.com/api");
    expect(normalizeApiUrl("https://example.com///")).toBe("https://example.com/api");
  });

  it("leaves a URL that already ends with /api unchanged", () => {
    expect(normalizeApiUrl("https://example.com/api")).toBe("https://example.com/api");
  });

  it("trims surrounding whitespace before normalizing", () => {
    expect(normalizeApiUrl("  https://example.com/api/  ")).toBe("https://example.com/api");
  });
});

describe("readConfigFromEnv", () => {
  const baseEnv = {
    PAPERCLIP_API_URL: "https://example.com",
    PAPERCLIP_API_KEY: "key-123",
  };

  it("builds a config from the minimal required env vars, applying defaults", () => {
    const config = readConfigFromEnv(baseEnv as NodeJS.ProcessEnv);
    expect(config).toEqual({
      apiUrl: "https://example.com/api",
      apiKey: "key-123",
      companyId: null,
      agentId: null,
      runId: null,
      fetchTimeoutMs: DEFAULT_MCP_FETCH_TIMEOUT_MS,
      toolTimeoutMs: DEFAULT_MCP_TOOL_TIMEOUT_MS,
    });
  });

  it("throws when PAPERCLIP_API_URL is missing or blank", () => {
    expect(() => readConfigFromEnv({ PAPERCLIP_API_KEY: "key-123" } as NodeJS.ProcessEnv)).toThrow(
      "Missing PAPERCLIP_API_URL",
    );
    expect(() =>
      readConfigFromEnv({ PAPERCLIP_API_URL: "   ", PAPERCLIP_API_KEY: "key-123" } as NodeJS.ProcessEnv),
    ).toThrow("Missing PAPERCLIP_API_URL");
  });

  it("throws when PAPERCLIP_API_KEY is missing or blank", () => {
    expect(() => readConfigFromEnv({ PAPERCLIP_API_URL: "https://example.com" } as NodeJS.ProcessEnv)).toThrow(
      "Missing PAPERCLIP_API_KEY",
    );
  });

  it("passes through optional scoping vars when set", () => {
    const config = readConfigFromEnv({
      ...baseEnv,
      PAPERCLIP_COMPANY_ID: "company-1",
      PAPERCLIP_AGENT_ID: "agent-1",
      PAPERCLIP_RUN_ID: "run-1",
    } as NodeJS.ProcessEnv);
    expect(config.companyId).toBe("company-1");
    expect(config.agentId).toBe("agent-1");
    expect(config.runId).toBe("run-1");
  });

  it("uses a valid positive-integer timeout override and falls back on an invalid one", () => {
    const withOverride = readConfigFromEnv({
      ...baseEnv,
      PAPERCLIP_MCP_FETCH_TIMEOUT_MS: "5000",
    } as NodeJS.ProcessEnv);
    expect(withOverride.fetchTimeoutMs).toBe(5000);

    const withInvalid = readConfigFromEnv({
      ...baseEnv,
      PAPERCLIP_MCP_TOOL_TIMEOUT_MS: "not-a-number",
    } as NodeJS.ProcessEnv);
    expect(withInvalid.toolTimeoutMs).toBe(DEFAULT_MCP_TOOL_TIMEOUT_MS);

    const withNonPositive = readConfigFromEnv({
      ...baseEnv,
      PAPERCLIP_MCP_FETCH_TIMEOUT_MS: "-1",
    } as NodeJS.ProcessEnv);
    expect(withNonPositive.fetchTimeoutMs).toBe(DEFAULT_MCP_FETCH_TIMEOUT_MS);
  });
});
