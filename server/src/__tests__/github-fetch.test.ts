import { afterEach, describe, expect, it, vi } from "vitest";
import { GH_FETCH_TIMEOUT_MS, ghFetch } from "../services/github-fetch.js";

function hangingFetch() {
  return vi.fn((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }),
  );
}

describe("ghFetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("passes the response through when fetch succeeds", async () => {
    const response = new Response("ok");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(ghFetch("https://api.github.com/repos/a/b")).resolves.toBe(response);
  });

  it("aborts a stalled request after the default timeout", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const result = ghFetch("https://api.github.com/repos/a/b");
    const assertion = expect(result).rejects.toThrow(/Could not connect to api\.github\.com/);
    expect(timeoutSpy).toHaveBeenCalledWith(GH_FETCH_TIMEOUT_MS);
    timeoutController.abort(new DOMException("timed out", "TimeoutError"));
    await assertion;
    timeoutSpy.mockRestore();
  });

  it("still honours a caller-supplied abort signal", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const controller = new AbortController();
    const result = ghFetch("https://api.github.com/repos/a/b", { signal: controller.signal });
    const assertion = expect(result).rejects.toThrow(/Could not connect/);
    controller.abort();
    await assertion;
  });
});
