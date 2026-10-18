// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isNewAgentAdapterAllowed } from "./new-agent-adapters";

describe("isNewAgentAdapterAllowed", () => {
  describe("paperclip_runner", () => {
    it("is allowed when the native runner is enabled, even in cloud mode", () => {
      expect(
        isNewAgentAdapterAllowed("paperclip_runner", {
          cloud: true,
          nativeRunnerEnabled: true,
        }),
      ).toBe(true);
    });

    it("is allowed when the native runner is enabled outside cloud mode", () => {
      expect(
        isNewAgentAdapterAllowed("paperclip_runner", {
          cloud: false,
          nativeRunnerEnabled: true,
        }),
      ).toBe(true);
    });

    it("is blocked when the native runner is disabled, even outside cloud mode", () => {
      expect(
        isNewAgentAdapterAllowed("paperclip_runner", {
          cloud: false,
          nativeRunnerEnabled: false,
        }),
      ).toBe(false);
    });

    it("is blocked when the native runner is disabled in cloud mode", () => {
      expect(
        isNewAgentAdapterAllowed("paperclip_runner", {
          cloud: true,
          nativeRunnerEnabled: false,
        }),
      ).toBe(false);
    });
  });

  describe("cloud mode allow-list", () => {
    it.each(["claude_local", "codex_local", "opencode_local", "grok_local"])(
      "allows %s in cloud mode",
      (type) => {
        expect(
          isNewAgentAdapterAllowed(type, {
            cloud: true,
            nativeRunnerEnabled: false,
          }),
        ).toBe(true);
      },
    );

    it("blocks an adapter id not on the cloud allow-list", () => {
      expect(
        isNewAgentAdapterAllowed("cursor_local", {
          cloud: true,
          nativeRunnerEnabled: false,
        }),
      ).toBe(false);
    });

    it("blocks an unrecognized adapter id in cloud mode", () => {
      expect(
        isNewAgentAdapterAllowed("some_unknown_adapter", {
          cloud: true,
          nativeRunnerEnabled: false,
        }),
      ).toBe(false);
    });

    it("is case-sensitive, so a differently-cased allowed id is blocked", () => {
      expect(
        isNewAgentAdapterAllowed("Claude_Local", {
          cloud: true,
          nativeRunnerEnabled: false,
        }),
      ).toBe(false);
      expect(
        isNewAgentAdapterAllowed("CLAUDE_LOCAL", {
          cloud: true,
          nativeRunnerEnabled: false,
        }),
      ).toBe(false);
    });
  });

  describe("non-cloud (local) mode", () => {
    it("allows any non-paperclip_runner adapter id by default", () => {
      expect(
        isNewAgentAdapterAllowed("cursor_local", {
          cloud: false,
          nativeRunnerEnabled: false,
        }),
      ).toBe(true);
    });

    it("allows an unrecognized adapter id outside cloud mode", () => {
      expect(
        isNewAgentAdapterAllowed("some_unknown_adapter", {
          cloud: false,
          nativeRunnerEnabled: false,
        }),
      ).toBe(true);
    });

    it("allows adapter ids that are also on the cloud allow-list", () => {
      expect(
        isNewAgentAdapterAllowed("claude_local", {
          cloud: false,
          nativeRunnerEnabled: false,
        }),
      ).toBe(true);
    });
  });
});
