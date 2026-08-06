import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("better-auth", () => ({
  betterAuth: vi.fn(() => ({ __betterAuth: true })),
}));
vi.mock("better-auth/adapters/drizzle", () => ({
  drizzleAdapter: vi.fn(() => ({ __drizzleAdapter: true })),
}));
vi.mock("better-auth/node", () => ({
  toNodeHandler: vi.fn(() => () => {}),
}));

import { createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";
import type { Db } from "@paperclipai/db";

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

function buildConfig(deploymentMode: Config["deploymentMode"]): Config {
  return {
    deploymentMode,
    deploymentExposure: "private",
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    authDisableSignUp: false,
  } as Config;
}

const fakeDb = {} as Db;

function boot(deploymentMode: Config["deploymentMode"]) {
  return createBetterAuthInstance(fakeDb, buildConfig(deploymentMode), []);
}

describe("createBetterAuthInstance weak auth secret rejection", () => {
  it("throws in authenticated mode when the effective secret is the shipped dev default", () => {
    process.env.BETTER_AUTH_SECRET = "paperclip-dev-secret";
    expect(() => boot("authenticated")).toThrow(/auth secret/i);
  });

  it("throws in authenticated mode when only a weak PAPERCLIP_AGENT_JWT_SECRET is set", () => {
    // AC3 bypass: the check must run on the resolved secret, not BETTER_AUTH_SECRET alone.
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "secret";
    expect(() => boot("authenticated")).toThrow(/auth secret/i);
  });

  it("boots in local_trusted mode even with the dev default secret", () => {
    process.env.BETTER_AUTH_SECRET = "paperclip-dev-secret";
    expect(() => boot("local_trusted")).not.toThrow();
  });

  it("boots in authenticated mode when BETTER_AUTH_SECRET is empty but a strong JWT secret is set", () => {
    // AC2 regression: empty string must fall through to PAPERCLIP_AGENT_JWT_SECRET, not throw.
    process.env.BETTER_AUTH_SECRET = "";
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "a".repeat(64);
    expect(() => boot("authenticated")).not.toThrow();
  });

  it("boots in authenticated mode with a strong 64-char secret", () => {
    process.env.BETTER_AUTH_SECRET = "b".repeat(64);
    expect(() => boot("authenticated")).not.toThrow();
  });

  it("throws in authenticated mode when a strong BETTER_AUTH_SECRET hides a denylisted PAPERCLIP_AGENT_JWT_SECRET", () => {
    // Mirror bypass: better-auth resolves BETTER_AUTH_SECRET first, but agent-auth-jwt
    // resolves PAPERCLIP_AGENT_JWT_SECRET first, so the weak value still signs agent JWTs.
    process.env.BETTER_AUTH_SECRET = "b".repeat(64);
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "secret";
    expect(() => boot("authenticated")).toThrow(/PAPERCLIP_AGENT_JWT_SECRET/);
  });

  it("throws in authenticated mode when a strong BETTER_AUTH_SECRET hides a too-short PAPERCLIP_AGENT_JWT_SECRET", () => {
    process.env.BETTER_AUTH_SECRET = "b".repeat(64);
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "short";
    expect(() => boot("authenticated")).toThrow(/PAPERCLIP_AGENT_JWT_SECRET/);
  });

  it("boots in authenticated mode when both secrets are strong and distinct", () => {
    process.env.BETTER_AUTH_SECRET = "b".repeat(64);
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "c".repeat(64);
    expect(() => boot("authenticated")).not.toThrow();
  });
});
