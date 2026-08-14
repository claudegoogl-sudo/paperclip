import { describe, expect, it } from "vitest";
import { resolveToolDeadlineMs, withToolDeadline } from "./deadline.js";

type McpTextResponse = { content: Array<{ type: "text"; text: string }> };

const okResponse: McpTextResponse = { content: [{ type: "text", text: "ok" }] };

describe("resolveToolDeadlineMs", () => {
  it("uses the default when no per-call override is present", () => {
    expect(resolveToolDeadlineMs({}, 120_000)).toBe(120_000);
    expect(resolveToolDeadlineMs(undefined, 120_000)).toBe(120_000);
  });

  it("extends (never shortens) the deadline for a per-call timeoutSeconds", () => {
    // Larger than default -> honored with grace headroom.
    expect(resolveToolDeadlineMs({ timeoutSeconds: 300 }, 120_000)).toBe(305_000);
    // Smaller than default -> default wins (never shortened).
    expect(resolveToolDeadlineMs({ timeoutSeconds: 10 }, 120_000)).toBe(120_000);
  });

  it("ignores invalid overrides", () => {
    expect(resolveToolDeadlineMs({ timeoutSeconds: -5 }, 1000)).toBe(1000);
    expect(resolveToolDeadlineMs({ timeoutSeconds: "20" }, 1000)).toBe(1000);
  });
});

describe("withToolDeadline", () => {
  it("aborts a never-resolving tool call at the deadline and yields an error result", async () => {
    const neverResolves = () => new Promise<McpTextResponse>(() => {});
    const guarded = withToolDeadline("hangingTool", neverResolves, 20);

    const result = await guarded({});

    expect(result.content).toHaveLength(1);
    const payload = JSON.parse(result.content[0].text) as { error: string };
    expect(payload.error).toContain("hangingTool");
    expect(payload.error).toContain("deadline");
  });

  it("returns the tool result untouched when it settles before the deadline", async () => {
    const guarded = withToolDeadline("fastTool", async () => okResponse, 1000);
    const result = await guarded({});
    expect(result).toEqual(okResponse);
  });
});
