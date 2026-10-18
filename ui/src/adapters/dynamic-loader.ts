/**
 * Dynamic UI parser loading for external adapters — sandboxed execution.
 *
 * When the Paperclip UI encounters an adapter type that doesn't have a
 * built-in parser (e.g., an external adapter loaded via the plugin system),
 * it fetches the parser JS from `/api/adapters/:type/ui-parser.js` and
 * executes it **inside a dedicated Web Worker** so it cannot access the
 * board UI's same-origin state (cookies, localStorage, DOM, authenticated
 * fetch, etc.).
 *
 * The worker communicates via a narrow postMessage protocol:
 *   Main → Worker:  { type: "init", source }
 *   Worker → Main:  { type: "ready" } | { type: "error", message }
 *   Main → Worker:  { type: "parse", id, line, ts }
 *   Worker → Main:  { type: "result", id, entries }
 *
 * Because the parse call is async (cross-thread postMessage), but the
 * existing `parseStdoutLine` contract is synchronous, we cache completed
 * worker results and ask the adapter registry to recompute transcripts when
 * a new result arrives.
 *
 * **Synchronous fast-path**: After init, parse requests are sent to the
 * worker which responds asynchronously.  The `parseStdoutLine` wrapper
 * returns cached results synchronously on the next transcript recomputation.
 * In practice this adds ~1 frame of latency which is imperceptible.
 *
 * Security: see `sandboxed-parser-worker.ts` for the full lockdown.
 *
 * **Worker-init fallback**: on devices where the sandboxed worker can never
 * initialise (Blob-URL workers blocked, worker CSP violations, …) the loader
 * does not give up permanently. Failed loads are negative-cached for a
 * bounded TTL (retry allowed afterwards), and while the worker path is
 * failing the parser is evaluated in-page (see `buildInPageFallbackParser`)
 * so run transcripts keep rendering structured output instead of degrading
 * to raw process fallback text forever.
 */

import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import type { StdoutLineParser, StdoutParserFactory } from "./types";
import { createSandboxedWorker } from "./sandboxed-parser-worker";
import type { SandboxRequest, SandboxResponse } from "./sandboxed-parser-worker";

// ── Types ───────────────────────────────────────────────────────────────────

interface DynamicParserModule {
  parseStdoutLine: StdoutLineParser;
  createStdoutParser?: StdoutParserFactory;
}

interface SandboxedParser {
  worker: Worker;
  ready: boolean;
  nextId: number;
  pendingResolves: Map<number, (entries: TranscriptEntry[]) => void>;
}

// ── State ───────────────────────────────────────────────────────────────────

/** Cache of fully initialised sandboxed parsers by adapter type. */
const sandboxedParsers = new Map<string, SandboxedParser>();

/** Cache of the public DynamicParserModule wrappers. */
const dynamicParserCache = new Map<string, DynamicParserModule>();

/**
 * Negative cache of adapter types whose parser load recently failed, mapped to
 * the epoch-ms time after which a retry is allowed. Entries are never
 * permanent: a failed load (parser 404, worker-init failure, unusable
 * fallback) is retried after {@link FAILED_LOAD_RETRY_MS}.
 */
const failedLoadRetryAt = new Map<string, number>();

/** How long a failed load stays negative-cached before a retry is allowed. */
const FAILED_LOAD_RETRY_MS = 60_000;

function isLoadNegativeCached(adapterType: string): boolean {
  const retryAt = failedLoadRetryAt.get(adapterType);
  if (retryAt === undefined) return false;
  if (Date.now() >= retryAt) {
    failedLoadRetryAt.delete(adapterType);
    return false;
  }
  return true;
}

function negativeCacheLoad(adapterType: string): void {
  failedLoadRetryAt.set(adapterType, Date.now() + FAILED_LOAD_RETRY_MS);
}

/** In-flight init promises so concurrent callers share the same load. */
const loadPromises = new Map<string, Promise<DynamicParserModule | null>>();

let resultNotifier: (() => void) | null = null;

export function setDynamicParserResultNotifier(fn: (() => void) | null): void {
  resultNotifier = fn;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function sendToWorker(sandbox: SandboxedParser, msg: SandboxRequest): void {
  sandbox.worker.postMessage(msg);
}

function nextRequestId(sandbox: SandboxedParser): number {
  return sandbox.nextId++;
}

function lineCacheKey(line: string, ts: string): string {
  return `${ts}\u0000${line}`;
}

function notifyResultReady(): void {
  resultNotifier?.();
}

/**
 * Parse a single line synchronously by delegating to the worker.
 * Returns a Promise that resolves with the TranscriptEntry[] from the worker.
 */
function parseLineAsync(sandbox: SandboxedParser, line: string, ts: string): Promise<TranscriptEntry[]> {
  return new Promise((resolve) => {
    const id = nextRequestId(sandbox);
    sandbox.pendingResolves.set(id, resolve);
    sendToWorker(sandbox, { type: "parse", id, line, ts });
  });
}

function drainPendingRequests(sandbox: SandboxedParser): void {
  for (const resolver of sandbox.pendingResolves.values()) {
    resolver([]);
  }
  sandbox.pendingResolves.clear();
}

/**
 * Create a sandboxed worker, send the parser source, and wait for init.
 */
function initSandboxedWorker(source: string): Promise<SandboxedParser> {
  return new Promise((resolve, reject) => {
    const worker = createSandboxedWorker();
    const sandbox: SandboxedParser = {
      worker,
      ready: false,
      nextId: 1,
      pendingResolves: new Map(),
    };

    // Timeout if the worker doesn't respond within 5s
    const timeout = setTimeout(() => {
      drainPendingRequests(sandbox);
      worker.terminate();
      reject(new Error("Parser worker init timed out"));
    }, 5000);

    worker.onmessage = (e: MessageEvent<SandboxResponse>) => {
      const msg = e.data;

      if (msg.type === "ready") {
        clearTimeout(timeout);
        sandbox.ready = true;

        // Switch to the steady-state message handler.
        worker.onmessage = (ev: MessageEvent<SandboxResponse>) => {
          const resp = ev.data;
          if (resp.type === "result") {
            const resolver = sandbox.pendingResolves.get(resp.id);
            if (resolver) {
              sandbox.pendingResolves.delete(resp.id);
              resolver(resp.entries as TranscriptEntry[]);
            }
          } else if (resp.type === "error") {
            console.error("[adapter-ui-loader] Worker reported error:", resp.message);
            drainPendingRequests(sandbox);
          }
        };

        resolve(sandbox);
        return;
      }

      if (msg.type === "error") {
        clearTimeout(timeout);
        drainPendingRequests(sandbox);
        worker.terminate();
        reject(new Error(msg.message));
        return;
      }
    };

    worker.onerror = (ev) => {
      clearTimeout(timeout);
      drainPendingRequests(sandbox);
      worker.terminate();
      reject(new Error(`Worker error: ${ev.message}`));
    };

    // Send the parser source to the worker for evaluation.
    sendToWorker(sandbox, { type: "init", source });
  });
}

/**
 * Build a DynamicParserModule that delegates all calls to the sandboxed worker.
 *
 * The parseStdoutLine wrapper is **synchronous** to match the existing contract.
 * Cache misses send a parse request to the worker and return `[]`; when the
 * worker responds, the registry notification path recomputes transcripts and
 * this wrapper returns the cached result synchronously.
 *
 * In practice, because the existing codebase already handles the "bridge"
 * pattern where parseStdoutLine returns [] until the dynamic parser loads,
 * the same UX applies here: the first render may show raw lines, and a
 * subsequent render shows the parsed entries.
 */
function buildParserModule(sandbox: SandboxedParser): DynamicParserModule {
  const parseCache = new Map<string, TranscriptEntry[]>();
  const pendingParseKeys = new Set<string>();

  const parseStdoutLine: StdoutLineParser = (line: string, ts: string) => {
    const key = lineCacheKey(line, ts);
    const cached = parseCache.get(key);
    if (cached) return cached.slice();

    if (!pendingParseKeys.has(key)) {
      pendingParseKeys.add(key);
      parseLineAsync(sandbox, line, ts).then((entries) => {
        pendingParseKeys.delete(key);
        parseCache.set(key, entries);
        notifyResultReady();
      });
    }

    return [];
  };

  return { parseStdoutLine };
}

/**
 * Evaluate the parser source in-page (main thread) as a fallback when the
 * sandboxed worker cannot be initialised on this device.
 *
 * Trust argument: the parser source is board-served, display-only code
 * fetched from `/api/adapters/:type/ui-parser.js` — the same origin and the
 * same trust level as the UI bundle that is evaluating it here. This is
 * strictly weaker isolation than the sandboxed worker, but it is only
 * reached after the worker path already failed, and without it those
 * devices render raw process-fallback output forever.
 *
 * Evaluation semantics mirror the worker bootstrap: CJS-style `exports` /
 * `module` shims, `self` and `globalThis` shadowed to `undefined`, source
 * wrapped in a strict-mode block so hoisted declarations cannot leak. Only
 * `parseStdoutLine` is wired up; parse errors degrade to `[]` exactly like
 * the worker's own error handling.
 */
function buildInPageFallbackParser(source: string, adapterType: string): DynamicParserModule | null {
  try {
    const exports: Record<string, unknown> = {};
    const module = { exports };

    const factory = new Function(
      "exports", "module", "self", "globalThis",
      `"use strict";\n{\n` + source + `\n}`,
    );
    factory(exports, module, undefined, undefined);

    // Resolve exports — module.exports first (CJS), then named exports.
    const resolved =
      module.exports && typeof module.exports === "object" && Object.keys(module.exports).length > 0
        ? (module.exports as Record<string, unknown>)
        : exports;

    if (typeof resolved.parseStdoutLine !== "function") {
      console.warn(`[adapter-ui-loader] in-page fallback for "${adapterType}" exports no usable parseStdoutLine`);
      return null;
    }

    const parse = resolved.parseStdoutLine as StdoutLineParser;
    const parserModule: DynamicParserModule = {
      parseStdoutLine: (line: string, ts: string) => {
        try {
          return parse(line, ts) ?? [];
        } catch {
          return [];
        }
      },
    };

    console.info(`[adapter-ui-loader] in-page fallback parser active for "${adapterType}"`);
    return parserModule;
  } catch (err) {
    console.warn(`[adapter-ui-loader] in-page fallback failed for "${adapterType}":`, err);
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Dynamically load a UI parser for an adapter type from the server API,
 * executing it inside a sandboxed Web Worker.
 *
 * @returns A DynamicParserModule, or null if unavailable.
 */
export async function loadDynamicParser(adapterType: string): Promise<DynamicParserModule | null> {
  // Return cached parser if already loaded.
  const cached = dynamicParserCache.get(adapterType);
  if (cached) return cached;

  // Don't retry types that failed recently (bounded negative cache).
  if (isLoadNegativeCached(adapterType)) return null;

  // Coalesce concurrent loads.
  const inflight = loadPromises.get(adapterType);
  if (inflight) return inflight;

  const loadPromise = (async (): Promise<DynamicParserModule | null> => {
    // Captured outside the try so the worker-failure path can still attempt
    // in-page evaluation of the already-fetched source.
    let source: string | null = null;
    try {
      const response = await fetch(`/api/adapters/${encodeURIComponent(adapterType)}/ui-parser.js`);
      if (!response.ok) {
        negativeCacheLoad(adapterType);
        return null;
      }

      source = await response.text();

      // Initialise the sandboxed worker with the parser source.
      const sandbox = await initSandboxedWorker(source);
      sandboxedParsers.set(adapterType, sandbox);

      const parserModule = buildParserModule(sandbox);
      dynamicParserCache.set(adapterType, parserModule);

      console.info(`[adapter-ui-loader] Loaded sandboxed UI parser for "${adapterType}"`);
      return parserModule;
    } catch (err) {
      console.warn(`[adapter-ui-loader] sandboxed worker failed for "${adapterType}"; trying in-page fallback:`, err);
      if (source !== null) {
        const fallback = buildInPageFallbackParser(source, adapterType);
        if (fallback) {
          dynamicParserCache.set(adapterType, fallback);
          return fallback;
        }
      }
      // Neither the worker nor the in-page fallback is usable — negative-cache
      // with a TTL so a later attempt can retry instead of failing forever.
      negativeCacheLoad(adapterType);
      return null;
    } finally {
      loadPromises.delete(adapterType);
    }
  })();

  loadPromises.set(adapterType, loadPromise);
  return loadPromise;
}

/**
 * Invalidate a cached dynamic parser, removing it from the parser cache and
 * the negative cache so that the next load attempt will try again.
 * Also terminates the sandboxed worker if one exists.
 */
export function invalidateDynamicParser(adapterType: string): boolean {
  const wasCached = dynamicParserCache.has(adapterType);
  dynamicParserCache.delete(adapterType);
  failedLoadRetryAt.delete(adapterType);
  loadPromises.delete(adapterType);

  // Terminate the worker to free resources.
  const sandbox = sandboxedParsers.get(adapterType);
  if (sandbox) {
    drainPendingRequests(sandbox);
    sandbox.worker.terminate();
    sandboxedParsers.delete(adapterType);
  }

  if (wasCached) {
    console.info(`[adapter-ui-loader] Invalidated sandboxed UI parser for "${adapterType}"`);
  }
  return wasCached;
}
