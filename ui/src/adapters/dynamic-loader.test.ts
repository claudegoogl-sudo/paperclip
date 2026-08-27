import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  invalidateDynamicParser,
  loadDynamicParser,
} from "./dynamic-loader";
import { createSandboxedWorker } from "./sandboxed-parser-worker";

vi.mock("./sandboxed-parser-worker", () => ({
  createSandboxedWorker: vi.fn(),
}));

const createWorkerMock = vi.mocked(createSandboxedWorker);

/** A minimal Worker stand-in that answers init with ready and parse with entries. */
function makeReadyWorker() {
  const worker = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    onerror: null as ((ev: { message: string }) => void) | null,
    terminated: false,
    postMessage(msg: { type: string; id?: number; line?: string; ts?: string }) {
      if (msg.type === "init") {
        queueMicrotask(() => worker.onmessage?.({ data: { type: "ready" } }));
      } else if (msg.type === "parse") {
        queueMicrotask(() =>
          worker.onmessage?.({
            data: { type: "result", id: msg.id, entries: [{ kind: "stdout", ts: msg.ts, text: msg.line }] },
          }),
        );
      }
    },
    terminate() {
      worker.terminated = true;
    },
  };
  return worker;
}

/** CJS parser source used by the fallback tests. */
const CJS_PARSER_SOURCE = `
module.exports = {
  parseStdoutLine: (line, ts) => [{ kind: "stdout", ts, text: "parsed:" + line }],
};
`;

function mockFetchOk(source: string) {
  return vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(source) });
}

describe("loadDynamicParser", () => {
  const TYPE = "test_external";

  beforeEach(() => {
    vi.useFakeTimers();
    createWorkerMock.mockReset();
  });

  afterEach(() => {
    invalidateDynamicParser(TYPE);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("prefers the sandboxed worker when it initialises", async () => {
    createWorkerMock.mockReturnValue(makeReadyWorker() as unknown as Worker);
    const fetchMock = mockFetchOk("void 0");
    vi.stubGlobal("fetch", fetchMock);

    const mod = await loadDynamicParser(TYPE);

    expect(mod).not.toBeNull();
    expect(createWorkerMock).toHaveBeenCalledTimes(1);
    expect(mod?.parseStdoutLine("hello", "t1")).toEqual([]); // async result not ready yet
    await vi.advanceTimersByTimeAsync(10);
    expect(mod?.parseStdoutLine("hello", "t1")).toEqual([
      { kind: "stdout", ts: "t1", text: "hello" },
    ]);
  });

  it("falls back to in-page evaluation when worker init fails", async () => {
    // Simulates devices where Worker construction throws (Blob-URL workers blocked).
    createWorkerMock.mockImplementation(() => {
      throw new Error("Worker is not defined");
    });
    vi.stubGlobal("fetch", mockFetchOk(CJS_PARSER_SOURCE));
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const mod = await loadDynamicParser(TYPE);

    expect(mod).not.toBeNull();
    // Synchronous, in-page: results are immediate rather than one frame late.
    expect(mod?.parseStdoutLine("hello", "t2")).toEqual([
      { kind: "stdout", ts: "t2", text: "parsed:hello" },
    ]);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[adapter-ui-loader] in-page fallback parser active"),
    );
    // Cached: a second load returns the same fallback without another fetch.
    await loadDynamicParser(TYPE);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("degrades fallback parse errors to empty entries", async () => {
    createWorkerMock.mockImplementation(() => {
      throw new Error("Worker is not defined");
    });
    vi.stubGlobal(
      "fetch",
      mockFetchOk(
        "module.exports = { parseStdoutLine: () => { throw new Error('boom'); } };",
      ),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const mod = await loadDynamicParser(TYPE);

    expect(mod).not.toBeNull();
    expect(mod?.parseStdoutLine("x", "t3")).toEqual([]);
  });

  it("negative-caches 404s only until the TTL expires", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);

    expect(await loadDynamicParser(TYPE)).toBeNull();
    // Within the TTL: no retry.
    expect(await loadDynamicParser(TYPE)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // After 60s the negative cache entry expires and a retry is allowed.
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await loadDynamicParser(TYPE)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("negative-caches worker+fallback failure only until the TTL expires", async () => {
    createWorkerMock.mockImplementation(() => {
      throw new Error("Worker is not defined");
    });
    // Source that exports nothing usable -> fallback returns null too.
    const fetchMock = mockFetchOk("void 0;");
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await loadDynamicParser(TYPE)).toBeNull();
    expect(await loadDynamicParser(TYPE)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_001);
    expect(await loadDynamicParser(TYPE)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidateDynamicParser clears the negative cache immediately", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);

    expect(await loadDynamicParser(TYPE)).toBeNull();
    expect(invalidateDynamicParser(TYPE)).toBe(false);
    expect(await loadDynamicParser(TYPE)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
