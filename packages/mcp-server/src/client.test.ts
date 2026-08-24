import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperclipApiClient, PaperclipApiError } from "./client.js";

function makeClient(overrides: Record<string, unknown> = {}) {
  return new PaperclipApiClient({
    apiUrl: "http://localhost:3100/api",
    apiKey: "token-123",
    companyId: null,
    agentId: null,
    runId: null,
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PaperclipApiClient fetch timeout", () => {
  it("aborts a never-resolving request at the deadline and throws a timeout error", async () => {
    // fetch that never resolves on its own, but rejects with AbortError when the signal fires.
    vi.stubGlobal("fetch", (_url: unknown, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      }),
    );

    const client = makeClient({ fetchTimeoutMs: 25 });

    await expect(client.requestJson("GET", "/agents/me")).rejects.toMatchObject({
      status: 504,
    });
  });

  it("surfaces the timeout as a PaperclipApiError with a clear message", async () => {
    vi.stubGlobal("fetch", (_url: unknown, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      }),
    );

    const client = makeClient({ fetchTimeoutMs: 25 });

    const error = await client.requestJson("GET", "/agents/me").catch((err) => err);
    expect(error).toBeInstanceOf(PaperclipApiError);
    expect((error as PaperclipApiError).message).toContain("timed out after 25ms");
  });
});
