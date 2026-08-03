import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deploymentAuthCheck } from "../checks/deployment-auth-check.js";
import type { PaperclipConfig } from "../config/schema.js";

const AUTH_SECRET_ENV_KEYS = ["BETTER_AUTH_SECRET", "PAPERCLIP_AGENT_JWT_SECRET"] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of AUTH_SECRET_ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of AUTH_SECRET_ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

// deploymentAuthCheck only reads server.{deploymentMode,exposure,host,bind} and auth.
function authenticatedConfig(): PaperclipConfig {
  return {
    server: {
      deploymentMode: "authenticated",
      exposure: "private",
      host: "0.0.0.0",
      bind: "all",
    },
    auth: {
      baseUrlMode: "auto",
      publicBaseUrl: undefined,
    },
  } as unknown as PaperclipConfig;
}

describe("deploymentAuthCheck weak auth secret rejection", () => {
  it("fails when a strong BETTER_AUTH_SECRET hides a denylisted PAPERCLIP_AGENT_JWT_SECRET", () => {
    // Mirror bypass: agent-auth-jwt prefers PAPERCLIP_AGENT_JWT_SECRET, so doctor must
    // inspect every signing-capable variable, not just the one better-auth resolves.
    process.env.BETTER_AUTH_SECRET = "b".repeat(64);
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "secret";
    const result = deploymentAuthCheck(authenticatedConfig());
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/PAPERCLIP_AGENT_JWT_SECRET/);
  });

  it("passes when both signing-capable secrets are strong", () => {
    process.env.BETTER_AUTH_SECRET = "b".repeat(64);
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "c".repeat(64);
    const result = deploymentAuthCheck(authenticatedConfig());
    expect(result.status).toBe("pass");
  });
});
