import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperclipConfig } from "../config/schema.js";
import { LLM_CHECK_TIMEOUT_MS, llmCheck } from "../checks/llm-check.js";

function configFor(provider: "claude" | "openai"): PaperclipConfig {
  return { llm: { provider, apiKey: "test-key" } } as unknown as PaperclipConfig;
}

function hangingFetch() {
  return vi.fn((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
    }),
  );
}

describe("llmCheck outbound timeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["claude", "openai"] as const)("passes an abort signal to the %s request", async (provider) => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await llmCheck(configFor(provider));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(["claude", "openai"] as const)("warns instead of hanging when the %s API never answers", async (provider) => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(10));
    vi.stubGlobal("fetch", hangingFetch());

    const result = await llmCheck(configFor(provider));

    expect(spy).toHaveBeenCalledWith(LLM_CHECK_TIMEOUT_MS);
    expect(result.status).toBe("warn");
    expect(result.message).toBe("Could not reach API to validate key");
  });
});
