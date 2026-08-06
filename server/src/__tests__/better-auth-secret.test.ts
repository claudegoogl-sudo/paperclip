import { afterEach, describe, expect, it } from "vitest";
import { createBetterAuthInstance } from "../auth/better-auth.js";

const ORIGINAL_BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;
const ORIGINAL_PAPERCLIP_AGENT_JWT_SECRET = process.env.PAPERCLIP_AGENT_JWT_SECRET;

afterEach(() => {
  if (ORIGINAL_BETTER_AUTH_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = ORIGINAL_BETTER_AUTH_SECRET;

  if (ORIGINAL_PAPERCLIP_AGENT_JWT_SECRET === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
  else process.env.PAPERCLIP_AGENT_JWT_SECRET = ORIGINAL_PAPERCLIP_AGENT_JWT_SECRET;
});

describe("better-auth secret strength validation", () => {
  // Mock Db - createBetterAuthInstance only needs it for type checking
  const mockDb = {} as never;

  // Minimal Config interface - only deploymentMode matters for our test
  function buildConfig(deploymentMode: "authenticated" | "local_trusted") {
    return {
      deploymentMode,
      deploymentExposure: "private" as const,
      authBaseUrlMode: "auto" as const,
      authPublicBaseUrl: null,
    } as const;
  }

  describe("authenticated mode rejects weak secrets", () => {
    it("throws on known-weak BETTER_AUTH_SECRET 'paperclip-dev-secret' (caught by length check)", () => {
      process.env.BETTER_AUTH_SECRET = "paperclip-dev-secret";
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;

      const config = buildConfig("authenticated");

      expect(() => createBetterAuthInstance(mockDb, config, [])).toThrow(
        /Auth secret must be at least 32 characters/,
      );
    });

    it("throws on known-weak BETTER_AUTH_SECRET 'secret' (caught by length check)", () => {
      process.env.BETTER_AUTH_SECRET = "secret";
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;

      const config = buildConfig("authenticated");

      expect(() => createBetterAuthInstance(mockDb, config, [])).toThrow(
        /Auth secret must be at least 32 characters/,
      );
    });

    it("throws on secret shorter than 32 characters", () => {
      process.env.BETTER_AUTH_SECRET = "short";
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;

      const config = buildConfig("authenticated");

      expect(() => createBetterAuthInstance(mockDb, config, [])).toThrow(
        /Auth secret must be at least 32 characters/,
      );
    });

    it("throws on weak PAPERCLIP_AGENT_JWT_SECRET when BETTER_AUTH_SECRET is unset (AC3 bypass - caught by length)", () => {
      delete process.env.BETTER_AUTH_SECRET;
      process.env.PAPERCLIP_AGENT_JWT_SECRET = "secret";

      const config = buildConfig("authenticated");

      expect(() => createBetterAuthInstance(mockDb, config, [])).toThrow(
        /Auth secret must be at least 32 characters/,
      );
    });

    it("throws on weak PAPERCLIP_AGENT_JWT_SECRET when BETTER_AUTH_SECRET is empty (caught by length)", () => {
      process.env.BETTER_AUTH_SECRET = "";
      process.env.PAPERCLIP_AGENT_JWT_SECRET = "weak-secret";

      const config = buildConfig("authenticated");

      expect(() => createBetterAuthInstance(mockDb, config, [])).toThrow(
        /Auth secret must be at least 32 characters/,
      );
    });
  });

  describe("authenticated mode accepts strong secrets", () => {
    it("boots with strong 64-character BETTER_AUTH_SECRET", () => {
      process.env.BETTER_AUTH_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4";
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;

      const config = buildConfig("authenticated");

      expect(() => createBetterAuthInstance(mockDb, config, [])).not.toThrow();
    });

    it("boots with strong PAPERCLIP_AGENT_JWT_SECRET fallback when BETTER_AUTH_SECRET is empty (AC2 regression)", () => {
      process.env.BETTER_AUTH_SECRET = "";
      process.env.PAPERCLIP_AGENT_JWT_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4";

      const config = buildConfig("authenticated");

      expect(() => createBetterAuthInstance(mockDb, config, [])).not.toThrow();
    });

    it("boots with strong PAPERCLIP_AGENT_JWT_SECRET fallback when BETTER_AUTH_SECRET is unset", () => {
      delete process.env.BETTER_AUTH_SECRET;
      process.env.PAPERCLIP_AGENT_JWT_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4";

      const config = buildConfig("authenticated");

      expect(() => createBetterAuthInstance(mockDb, config, [])).not.toThrow();
    });
  });

  describe("local_trusted mode permits weak secrets (dev convenience)", () => {
    it("boots with paperclip-dev-secret in local_trusted mode", () => {
      process.env.BETTER_AUTH_SECRET = "paperclip-dev-secret";
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;

      const config = buildConfig("local_trusted");

      expect(() => createBetterAuthInstance(mockDb, config, [])).not.toThrow();
    });

    it("boots with short secret in local_trusted mode", () => {
      process.env.BETTER_AUTH_SECRET = "short";
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;

      const config = buildConfig("local_trusted");

      expect(() => createBetterAuthInstance(mockDb, config, [])).not.toThrow();
    });
  });

  describe("fallback behavior (AC2 normalization)", () => {
    it("uses PAPERCLIP_AGENT_JWT_SECRET when BETTER_AUTH_SECRET is whitespace-only", () => {
      process.env.BETTER_AUTH_SECRET = "   ";
      process.env.PAPERCLIP_AGENT_JWT_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4";

      const config = buildConfig("authenticated");

      expect(() => createBetterAuthInstance(mockDb, config, [])).not.toThrow();
    });

    it("throws when both secrets are empty", () => {
      process.env.BETTER_AUTH_SECRET = "";
      process.env.PAPERCLIP_AGENT_JWT_SECRET = "";

      const config = buildConfig("authenticated");

      expect(() => createBetterAuthInstance(mockDb, config, [])).toThrow(
        /BETTER_AUTH_SECRET.*must be set/,
      );
    });

    it("throws when both secrets are unset", () => {
      delete process.env.BETTER_AUTH_SECRET;
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;

      const config = buildConfig("authenticated");

      expect(() => createBetterAuthInstance(mockDb, config, [])).toThrow(
        /BETTER_AUTH_SECRET.*must be set/,
      );
    });

    it("prefers BETTER_AUTH_SECRET over PAPERCLIP_AGENT_JWT_SECRET", () => {
      // Set a weak JWT secret - should be ignored if BETTER_AUTH_SECRET is set
      process.env.BETTER_AUTH_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4";
      process.env.PAPERCLIP_AGENT_JWT_SECRET = "weak";

      const config = buildConfig("authenticated");

      expect(() => createBetterAuthInstance(mockDb, config, [])).not.toThrow();
    });
  });
});
