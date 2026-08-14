import { describe, expect, it } from "vitest";
import { applyMcpTimeoutDefaults } from "./execute.js";

describe("applyMcpTimeoutDefaults", () => {
  it("injects safe MCP tool-call and startup ceilings when unset", () => {
    const env: Record<string, string> = {};
    applyMcpTimeoutDefaults(env, {});
    expect(env.MCP_TOOL_TIMEOUT).toBe("300000");
    expect(env.MCP_TIMEOUT).toBe("30000");
  });

  it("does not override a value already present in the CLI env", () => {
    const env: Record<string, string> = { MCP_TOOL_TIMEOUT: "45000" };
    applyMcpTimeoutDefaults(env, {});
    expect(env.MCP_TOOL_TIMEOUT).toBe("45000");
  });

  it("does not override an explicit host process env value", () => {
    const env: Record<string, string> = {};
    applyMcpTimeoutDefaults(env, { MCP_TOOL_TIMEOUT: "90000" });
    expect(env.MCP_TOOL_TIMEOUT).toBeUndefined();
  });

  it("honors a tunable default via PAPERCLIP_MCP_TOOL_TIMEOUT_MS", () => {
    const env: Record<string, string> = {};
    applyMcpTimeoutDefaults(env, { PAPERCLIP_MCP_TOOL_TIMEOUT_MS: "180000" });
    expect(env.MCP_TOOL_TIMEOUT).toBe("180000");
  });

  it("falls back to the default when the tunable is invalid", () => {
    const env: Record<string, string> = {};
    applyMcpTimeoutDefaults(env, { PAPERCLIP_MCP_TOOL_TIMEOUT_MS: "not-a-number" });
    expect(env.MCP_TOOL_TIMEOUT).toBe("300000");
  });
});
