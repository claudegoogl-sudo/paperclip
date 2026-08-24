/**
 * PluginWorkerManager — spawns and manages out-of-process plugin worker child
 * processes, routes JSON-RPC 2.0 calls over stdio, and handles lifecycle
 * management including crash recovery with exponential backoff.
 *
 * Each installed plugin gets one dedicated worker process. The host sends
 * JSON-RPC requests over the child's stdin and reads responses from stdout.
 * Worker stderr is captured and forwarded to the host logger.
 *
 * Process Model (from PLUGIN_SPEC.md §12):
 * - One worker process per installed plugin
 * - Failure isolation: plugin crashes do not affect the host
 * - Graceful shutdown: 10-second drain, then SIGTERM, then SIGKILL
 * - Automatic restart with exponential backoff on unexpected exits
 *
 * @see PLUGIN_SPEC.md §12 — Process Model
 * @see PLUGIN_SPEC.md §12.5 — Graceful Shutdown Policy
 * @see PLUGIN_SPEC.md §13 — Host-Worker Protocol
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  JSONRPC_VERSION,
  JSONRPC_ERROR_CODES,
  PLUGIN_RPC_ERROR_CODES,
  createRequest,
  createErrorResponse,
  parseMessage,
  serializeMessage,
  isJsonRpcResponse,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcSuccessResponse,
  JsonRpcParseError,
  JsonRpcCallError,
  SETUP_TOKEN_PTY_OUTPUT_NOTIFICATION,
  SETUP_TOKEN_PTY_EXIT_NOTIFICATION,
} from "@paperclipai/plugin-sdk";
import type {
  JsonRpcId,
  PluginInvocationContext,
  PluginInvocationScope,
  JsonRpcResponse,
  JsonRpcRequest,
  JsonRpcNotification,
  WorkerHostCallContext,
  HostToWorkerMethodName,
  HostToWorkerMethods,
  WorkerToHostMethodName,
  WorkerToHostMethods,
  InitializeParams,
} from "@paperclipai/plugin-sdk";
import { getActiveStepContext } from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import { CLAUDE_SETUP_TOKEN_COMMAND } from "@paperclipai/adapter-claude-local/server";
import { logger } from "../middleware/logger.js";
import type { PluginRunContextRegistry } from "./plugin-run-context-registry.js";
import { clearRunSecretValues } from "../run-secret-registry.js";
import { redactSensitiveText } from "../redaction.js";
import { traceparentFromContextToken } from "../instrumentation.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for RPC calls in milliseconds. */
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/**
 * Upper bound for the *default* RPC timeout path (15 minutes). Explicit
 * caller-supplied timeouts are not subject to this cap: execute-class RPCs such
 * as `environmentExecute` run entire sandboxed agent sessions in one call and
 * their callers deliberately request multi-hour budgets (see
 * `resolvePluginExecuteRpcTimeoutMs` in plugin-environment-driver.ts).
 * Clamping those explicit budgets here killed long sandboxed runs mid-work.
 */
const MAX_RPC_TIMEOUT_MS = 15 * 60 * 1_000;

/**
 * Maximum delay accepted by Node timers before Node clamps the timeout to 1ms.
 * Keep accepted explicit RPC budgets inside this range before calling
 * setTimeout, otherwise a huge timeout can expire almost immediately.
 */
const MAX_NODE_TIMER_TIMEOUT_MS = 2_147_483_647;

/** Timeout for the initialize RPC call. */
const INITIALIZE_TIMEOUT_MS = 15_000;

/** Timeout for the shutdown RPC call before escalating to SIGTERM. */
const SHUTDOWN_DRAIN_MS = 10_000;

/** Time to wait after SIGTERM before sending SIGKILL. */
const SIGTERM_GRACE_MS = 5_000;

/** Minimum backoff delay for crash recovery (1 second). */
const MIN_BACKOFF_MS = 1_000;

/** Maximum backoff delay for crash recovery (5 minutes). */
const MAX_BACKOFF_MS = 5 * 60 * 1_000;

/** Backoff multiplier on each consecutive crash. */
const BACKOFF_MULTIPLIER = 2;

/** Maximum number of consecutive crashes before giving up on auto-restart. */
const MAX_CONSECUTIVE_CRASHES = 10;

/** Time window in which crashes are considered consecutive (10 minutes). */
const CRASH_WINDOW_MS = 10 * 60 * 1_000;

/** Maximum number of stderr characters retained for worker failure context. */
const MAX_STDERR_EXCERPT_CHARS = 8_000;

/** Maximum characters accepted for one `execute.log` chunk. A larger chunk is
 * dropped, so a faulty or hostile worker cannot flood the host with one
 * unbounded notification. */
const MAX_EXECUTE_LOG_CHUNK_CHARS = 1_000_000;

/**
 * Maximum characters accepted for one incoming worker stdout line before the
 * host parses it as JSON. The host drops a longer line without a parse, so a
 * faulty or hostile worker cannot force the host to parse an unbounded document
 * and exhaust memory. The bound sits far above the largest legitimate framed
 * message, so a real large command result still passes. A worker can override
 * it through `WorkerStartOptions.executeLogLimits`.
 */
const MAX_WORKER_MESSAGE_CHARS = 128 * 1024 * 1024;

/**
 * Default ceiling for the total characters one execute call may stream through
 * `execute.log`. The host counts the delivered characters for each active
 * execute route and drops further chunks past this bound, so one runaway or
 * hostile execution cannot flood the host and the run-log sink without limit.
 * The final command result still delivers the complete output through its own
 * capture path. A worker can override it through
 * `WorkerStartOptions.executeLogLimits`.
 */
const MAX_EXECUTE_LOG_TOTAL_CHARS = 128 * 1024 * 1024;

/** Maximum characters for one live login pseudo-terminal output notification. */
const MAX_SETUP_TOKEN_PTY_CHUNK_CHARS = 1_000_000;
/** Maximum cumulative output characters for one login pseudo-terminal route. */
const MAX_SETUP_TOKEN_PTY_TOTAL_CHARS = 8 * 1024 * 1024;
/** The default open timeout for one login pseudo-terminal route, in milliseconds. */
const SETUP_TOKEN_PTY_OPEN_TIMEOUT_MS = 30_000;
/** The default close timeout for one login pseudo-terminal route, in milliseconds. */
const SETUP_TOKEN_PTY_CLOSE_TIMEOUT_MS = 10_000;
/**
 * The fixed non-secret error a disallowed login command returns. The manager
 * forwards only the compile-time `CLAUDE_SETUP_TOKEN_COMMAND` to the worker
 * pseudo-terminal. It rejects any other command before the worker call, so a
 * future caller cannot spawn an arbitrary process in the sandbox.
 */
const SETUP_TOKEN_PTY_COMMAND_NOT_ALLOWED = "SETUP_TOKEN_PTY_COMMAND_NOT_ALLOWED";
/** The fixed non-secret error a rejected second credential open returns. */
const SETUP_TOKEN_PTY_ROUTE_BUSY = "SETUP_TOKEN_PTY_ROUTE_BUSY";
/** The fixed non-secret error a failed open returns. */
const SETUP_TOKEN_PTY_OPEN_FAILED = "SETUP_TOKEN_PTY_OPEN_FAILED";

/** Minimum time between two dropped-`execute.log` debug records. The router
 * rate-limits the record so a flood of dropped chunks writes at most one line
 * per window with a running count. */
const EXECUTE_LOG_DROP_LOG_INTERVAL_MS = 1_000;
/**
 * SECURITY-CRITICAL: hard cap on a single worker→host IPC frame (one NDJSON line) in
 * bytes. The transport is node child-process stdio and the worker controls how many
 * bytes it writes before a newline. Without a cap the host buffers an entire
 * line into memory *before* any application-level size gate runs (e.g. the
 * artifacts `create` byte ceiling in plugin-artifacts-handler.ts), so a
 * compromised or buggy worker can OOM the host with one oversized frame. Plugin
 * workers are global/shared across tenants, so one bad frame is a host-wide
 * transient. This default sits well above the largest legitimate frame — a
 * base64 artifact `create` at the 25 MiB ceiling is ≈35 MiB plus a small JSON
 * envelope — while bounding catastrophic allocation. Override per deployment via
 * `PAPERCLIP_PLUGIN_MAX_IPC_FRAME_BYTES`.
 */
const DEFAULT_MAX_IPC_FRAME_BYTES = 64 * 1024 * 1024;

/**
 * Resolve the per-frame IPC byte cap, preferring an explicit override (used by
 * tests and per-deployment tuning), then the env var, then the safe default.
 */
export function resolveMaxIpcFrameBytes(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const fromEnv = Number(process.env.PAPERCLIP_PLUGIN_MAX_IPC_FRAME_BYTES);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return DEFAULT_MAX_IPC_FRAME_BYTES;
}

/**
 * Options for {@link createBoundedFrameReader}.
 */
export interface BoundedFrameReaderOptions {
  /** Hard cap on a single newline-delimited frame, in bytes (inclusive). */
  maxFrameBytes: number;
  /** Invoked with each complete frame (newline stripped, decoded as UTF-8). */
  onFrame: (line: string) => void;
  /**
   * Invoked once per oversized frame, as soon as the accumulated bytes for the
   * current (still newline-less) frame would exceed `maxFrameBytes` — i.e.
   * BEFORE the whole payload is buffered. `bytesSeen` is how many bytes of the
   * offending frame had been observed at the trip point (≤ maxFrameBytes plus
   * one transport chunk); the host never allocates the full payload. After this
   * fires the reader discards bytes up to the next newline to resynchronize, so
   * subsequent valid frames still parse. The caller decides whether to also
   * terminate the worker.
   */
  onOversize: (info: { bytesSeen: number; limit: number }) => void;
}

/**
 * A pushed-bytes line reader. Unlike node `readline`, it enforces a hard byte
 * ceiling on a single newline-delimited frame and never buffers more than
 * `maxFrameBytes` of an in-flight frame. Feed it raw stdout/stderr chunks via
 * {@link BoundedFrameReader.push}.
 */
export interface BoundedFrameReader {
  /** Feed the next chunk of bytes read from the worker stream. */
  push(chunk: Buffer): void;
}

export function createBoundedFrameReader(
  options: BoundedFrameReaderOptions,
): BoundedFrameReader {
  const { maxFrameBytes, onFrame, onOversize } = options;
  const NEWLINE = 0x0a;

  let pending: Buffer[] = [];
  let pendingBytes = 0;
  // After an oversize frame we drop bytes until the next newline to realign on
  // a frame boundary rather than misparsing the tail of the giant frame.
  let resyncing = false;

  function trip(extraBytes: number): void {
    const bytesSeen = pendingBytes + extraBytes;
    pending = [];
    pendingBytes = 0;
    onOversize({ bytesSeen, limit: maxFrameBytes });
  }

  return {
    push(chunk: Buffer): void {
      let offset = 0;
      while (offset < chunk.length) {
        if (resyncing) {
          const nl = chunk.indexOf(NEWLINE, offset);
          if (nl === -1) return; // whole remainder is still the oversized frame
          resyncing = false;
          offset = nl + 1;
          continue;
        }

        const nl = chunk.indexOf(NEWLINE, offset);
        if (nl === -1) {
          const tail = chunk.subarray(offset);
          if (pendingBytes + tail.length > maxFrameBytes) {
            resyncing = true;
            trip(tail.length);
            return;
          }
          pending.push(tail);
          pendingBytes += tail.length;
          return;
        }

        const frameLen = nl - offset;
        if (pendingBytes + frameLen > maxFrameBytes) {
          // Newline is in this chunk, so we can resync immediately past it.
          trip(frameLen);
          offset = nl + 1;
          continue;
        }

        let frame: Buffer;
        if (pending.length === 0) {
          frame = chunk.subarray(offset, nl);
        } else {
          pending.push(chunk.subarray(offset, nl));
          frame = Buffer.concat(pending);
          pending = [];
          pendingBytes = 0;
        }
        onFrame(frame.toString("utf8"));
        offset = nl + 1;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Status of a managed worker process.
 */
export type WorkerStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "crashed"
  | "backoff";

/**
 * Worker-to-host method handler. The host registers these to service calls
 * that the plugin worker makes back to the host (e.g. state.get, events.emit).
 */
export type WorkerToHostHandler<M extends WorkerToHostMethodName> = (
  params: WorkerToHostMethods[M][0],
  context?: WorkerHostCallContext,
) => Promise<WorkerToHostMethods[M][1]>;

/**
 * A map of all worker-to-host method handlers provided by the host.
 */
export type WorkerToHostHandlers = {
  [M in WorkerToHostMethodName]?: WorkerToHostHandler<M>;
};

/**
 * Events emitted by a PluginWorkerHandle.
 */
export interface WorkerHandleEvents {
  /** Worker process started and is ready (initialize succeeded). */
  "ready": { pluginId: string };
  /** Worker process exited. */
  "exit": { pluginId: string; code: number | null; signal: NodeJS.Signals | null };
  /** Worker process crashed unexpectedly. */
  "crash": { pluginId: string; code: number | null; signal: NodeJS.Signals | null; willRestart: boolean };
  /** Worker process errored (e.g. spawn failure). */
  "error": { pluginId: string; error: Error };
  /** Worker status changed. */
  "status": { pluginId: string; status: WorkerStatus; previousStatus: WorkerStatus };
}

type WorkerHandleEventName = keyof WorkerHandleEvents;

export function appendStderrExcerpt(current: string, chunk: string): string {
  const next = current ? `${current}\n${chunk}` : chunk;
  return next.length <= MAX_STDERR_EXCERPT_CHARS
    ? next
    : next.slice(-MAX_STDERR_EXCERPT_CHARS);
}

export function formatWorkerFailureMessage(message: string, stderrExcerpt: string): string {
  const excerpt = stderrExcerpt.trim();
  if (!excerpt) return message;
  if (message.includes(excerpt)) return message;
  return `${message}\n\nWorker stderr:\n${excerpt}`;
}

/**
 * Resolve the effective timeout for an RPC call.
 *
 * An explicit, positive, finite caller-supplied timeout bypasses the 15-minute
 * RPC cap after normalization to Node's timer-safe integer range. Callers that
 * pass one (e.g. the environment driver for `environmentExecute`) own their
 * budget, and independent inactivity/safety guards bound hung runs. Only the
 * default path (no usable explicit timeout) is clamped to MAX_RPC_TIMEOUT_MS so
 * ordinary plugin calls stay bounded.
 */
export function resolveRpcCallTimeoutMs(
  explicitTimeoutMs: number | undefined,
  defaultTimeoutMs: number,
): number {
  if (
    explicitTimeoutMs !== undefined &&
    Number.isFinite(explicitTimeoutMs) &&
    explicitTimeoutMs > 0
  ) {
    return Math.min(Math.max(Math.trunc(explicitTimeoutMs), 1), MAX_NODE_TIMER_TIMEOUT_MS);
  }
  return Math.min(defaultTimeoutMs, MAX_RPC_TIMEOUT_MS);
}

/**
 * SECURITY-CRITICAL: defense-in-depth redaction for host-handler errors.
 *
 * The host-handler dispatch catch-all in {@link createPluginWorkerHandle} sees
 * errors from every host method and forwards the message to both `log.error`
 * and the JSON-RPC `error.message` returned to the worker. Host handlers must
 * never echo raw caller input into an error message — the secrets handler is
 * already fixed at source — but any future handler that interpolates
 * worker-supplied input would leak it on both egress channels unless we scrub
 * here. `redactSensitiveText` covers gh[pousr]_* classic PATs, fine-grained
 * github_pat_* keys, sk-* keys, 3-segment JWTs, `Authorization: Bearer`
 * headers, env-var-shape *TOKEN/KEY/SECRET*=* and CLI secret flags.
 *
 * Exported so the redaction wrap can be exercised by unit tests without
 * spawning a real worker.
 */
export function redactHostHandlerErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSensitiveText(raw);
}

/**
 * Options for starting a worker process.
 */
export interface WorkerStartOptions {
  /** Absolute path to the plugin worker entrypoint (CJS bundle). */
  entrypointPath: string;
  /** Plugin manifest. */
  manifest: PaperclipPluginManifestV1;
  /** Resolved plugin configuration. */
  config: Record<string, unknown>;
  /** Host instance information for the initialize call. */
  instanceInfo: {
    instanceId: string;
    hostVersion: string;
  };
  /** Host API version. */
  apiVersion: number;
  /** Host-derived plugin database namespace, when declared. */
  databaseNamespace?: string | null;
  /** Handlers for worker→host RPC calls. */
  hostHandlers: WorkerToHostHandlers;
  /** Default timeout for RPC calls (ms). Defaults to 30s. */
  rpcTimeoutMs?: number;
  /**
   * Hard byte cap on a single worker→host IPC frame. Defaults to
   * `PAPERCLIP_PLUGIN_MAX_IPC_FRAME_BYTES` or {@link DEFAULT_MAX_IPC_FRAME_BYTES}.
   * Mainly an injection point for tests; production should use the env var.
   */
  maxIpcFrameBytes?: number;
  /** Whether to auto-restart on crash. Defaults to true. */
  autoRestart?: boolean;
  /** Node.js execArgv passed to the child process. */
  execArgv?: string[];
  /** Environment variables passed to the child process. */
  env?: Record<string, string>;
  /**
   * Companies this worker may act on from proactive (no-invocation) worker→host
   * calls — the plugin's configured companies. Seeded onto the handle at
   * creation, BEFORE the child process spawns, so a proactive plugin that
   * issues host calls during setup() (e.g. the chat gateway's one-shot
   * `events.subscribe`, which runs while `startWorker` is still awaiting the
   * initialize response) is already authorized when those calls arrive. The set
   * can still be replaced at runtime via `setProactiveCompanyScopes` (e.g. on a
   * config change). Never widens access beyond the listed companies (LOOA-695).
   */
  proactiveCompanyScopes?: readonly string[];
  /**
   * Callback for stream notifications from the worker (streams.open/emit/close).
   * The host wires this to the PluginStreamBus to fan out events to SSE clients.
   */
  onStreamNotification?: (method: string, params: Record<string, unknown>) => void;
  /**
   * Framing and flood limits for the `execute.log` route. The defaults bound
   * one incoming line before the JSON parse and the total streamed output for
   * one execute call. A test overrides them to exercise the drop paths without
   * huge inputs.
   */
  executeLogLimits?: {
    /** Max characters for one incoming worker line before the JSON parse. */
    maxIncomingMessageChars?: number;
    /** Max total characters one execute call may stream through `execute.log`. */
    maxTotalCharsPerExecute?: number;
  };

  /**
   * Bounds and timeouts for the login pseudo-terminal route. The
   * defaults bound one output notification, the cumulative output per route, and
   * the open and the close timeouts. A test overrides them to exercise the
   * terminalize paths without huge inputs or long waits.
   */
  setupTokenPtyLimits?: {
    /** Max characters for one login pseudo-terminal output notification. */
    maxChunkChars?: number;
    /** Max cumulative output characters for one login pseudo-terminal route. */
    maxTotalChars?: number;
    /** The open timeout for one login pseudo-terminal route, in milliseconds. */
    openTimeoutMs?: number;
    /** The close timeout for one login pseudo-terminal route, in milliseconds. */
    closeTimeoutMs?: number;
  };
}

/**
 * A pending RPC call waiting for a response from the worker.
 */
interface PendingRequest {
  /** The request ID. */
  id: JsonRpcId;
  /** Method name (for logging). */
  method: string;
  /** Resolve the promise with the response. */
  resolve: (response: JsonRpcResponse) => void;
  /** Timeout timer handle. */
  timer: ReturnType<typeof setTimeout>;
  /** Timestamp when the request was sent. */
  sentAt: number;
  /** Active host-owned invocation id attached to this host→worker call. */
  invocationId?: string;
}

interface ActiveInvocation {
  scope: PluginInvocationScope;
  timer?: ReturnType<typeof setTimeout>;
  /**
   * SECURITY-CRITICAL: when this invocation is a company-scoped background dispatch
   * (`onEvent`), the host-minted per-dispatch run UUID registered in the
   * run-context registry. Deregistered when the invocation clears so the
   * registry stays bounded.
   */
  backgroundRunId?: string;
  // The host-minted W3C `traceparent` for the active startup span, or undefined
  // when no startup span is active. The span host handler reads it to mint the
  // parentage, so a worker never supplies the parent itself.
  traceparent?: string;
}

/**
 * Sink for one incremental output chunk of an active `environmentExecute` call.
 * The host runner passes it to `call` for the execute method, and the manager
 * delivers each `execute.log` chunk to it. The sink may return a promise; the
 * caller owns the ordering.
 */
export type ExecuteLogSink = (
  stream: "stdout" | "stderr",
  chunk: string,
) => void | Promise<void>;

/**
 * The input the manager needs to open one live login pseudo-terminal route
 * The manager mints the host route identifier; the caller supplies
 * only the sandbox scope, the provider lease id, and the fixed command.
 */
export interface SetupTokenPtyOpenInput {
  driverKey: string;
  companyId: string;
  environmentId: string;
  providerLeaseId: string;
  command: string;
}

/**
 * One live login pseudo-terminal session the manager hands to the login
 * transport. The shape matches the sandbox provider setup-token
 * pseudo-terminal session, so the transport consumes it with no adapter.
 */
export interface SetupTokenPtyHostSession {
  /** Registers the one output listener. The session streams each raw chunk in order. */
  onData(listener: (chunk: string) => void): void;
  /** Writes raw input bytes to the pseudo-terminal. */
  write(data: string): void;
  /** Resolves with the child exit code when the command ends or the route terminalizes. */
  wait(): Promise<{ exitCode: number | null }>;
  /** Stops the child process. Safe to call more than one time. */
  kill(): void;
  /** Closes the route and releases the terminal. Safe to call more than one time. */
  close(): Promise<void>;
}

/**
 * Host-owned route for one active execute call. The host mints the invocation
 * id and stores the exact company id and log sink here. A worker never selects
 * this record; the host looks it up by the host-issued invocation id on the
 * message envelope. The company id is the single authority for the delivery
 * target, so an `execute.log` notification never carries a company id.
 */
interface ExecuteLogRoute {
  companyId: string;
  onLog: ExecuteLogSink;
  /**
   * The count of characters delivered through this route. The router bounds the
   * per-execute total and drops chunks past the configured ceiling.
   */
  deliveredChars: number;
  /**
   * Latched when the router cannot bind the shared worker pipe to a single
   * company, because a second company's execute overlapped this one. After the
   * latch the router drops every further chunk for this route and lets the final
   * command result deliver the complete output. The latch keeps the delivered
   * prefix contiguous, so the run log never shows a gap.
   */
  crossCompanyBlocked: boolean;
}

/**
 * SECURITY-CRITICAL: host→worker dispatches that carry a TRIGGERING company but
 * no dispatching agent. For these, the host mints a per-dispatch
 * **company-scoped** run-context (rather than letting the worker→host
 * `secrets.resolve` fall through to the company-agnostic worker-lifetime
 * service path), so a global plugin worker handling company A's event can only
 * resolve secrets company A bound to it. `runJob` is deliberately absent: jobs
 * are instance-wide and carry no triggering company, so they keep using the
 * company-less service path.
 */
const BACKGROUND_DISPATCH_METHODS: ReadonlySet<string> = new Set([
  "onEvent",
  "onWebhook",
]);

// ---------------------------------------------------------------------------
// PluginWorkerHandle — manages a single worker process
// ---------------------------------------------------------------------------

/**
 * Handle for a single plugin worker process.
 *
 * Callers use `start()` to spawn the worker, `call()` to send RPC requests,
 * and `stop()` to gracefully shut down. The handle manages crash recovery
 * with exponential backoff automatically when `autoRestart` is enabled.
 */
export interface PluginWorkerHandle {
  /** The plugin ID this worker serves. */
  readonly pluginId: string;

  /**
   * SECURITY-CRITICAL: host-minted, worker-lifetime service run UUID. Surfaced as
   * `context.serviceScope.runId` on every worker→host call so a background
   * dispatch or a `setup()`-started loop can resolve secrets outside any
   * dispatch. Stable across crash/auto-restart of this handle; never
   * worker-supplied. The manager registers it in the run-context registry as a
   * system actor for the handle's lifetime.
   */
  readonly serviceRunId: string;

  /** Current worker status. */
  readonly status: WorkerStatus;

  /** Start the worker process. Resolves when initialize completes. */
  start(): Promise<void>;

  /**
   * Stop the worker process gracefully.
   *
   * Sends a `shutdown` RPC call, waits up to 10 seconds for the worker to
   * exit, then escalates to SIGTERM, and finally SIGKILL if needed.
   */
  stop(): Promise<void>;

  /**
   * Restart the worker process (stop + start).
   */
  restart(): Promise<void>;

  /**
   * Send a typed host→worker RPC call.
   *
   * @param method - The RPC method name
   * @param params - Method parameters
   * @param timeoutMs - Optional per-call timeout override
   * @returns The method result
   * @throws {JsonRpcCallError} if the worker returns an error response
   * @throws {Error} if the worker is not running or the call times out
   */
  call<M extends HostToWorkerMethodName>(
    method: M,
    params: HostToWorkerMethods[M][0],
    timeoutMs?: number,
    executeLogSink?: ExecuteLogSink,
  ): Promise<HostToWorkerMethods[M][1]>;

  /**
   * Send a fire-and-forget notification to the worker (no response expected).
   */
  notify(method: string, params: unknown): void;

  /**
   * Open one live login pseudo-terminal route on this worker. The
   * manager mints the host route identifier, reserves the route, drives the open,
   * binds the worker session identifier one time, and returns a session the login
   * transport drives. It permits one active credential pseudo-terminal per worker.
   */
  openSetupTokenPtySession(
    input: SetupTokenPtyOpenInput,
  ): Promise<SetupTokenPtyHostSession>;

  /**
   * Authorize the set of companies this worker may act on from proactive
   * (non-invocation) context. Replaces any previously-authorized set. See the
   * proactive-company-scope note in `createPluginWorkerHandle` for rationale.
   */
  setProactiveCompanyScopes(companyIds: readonly string[]): void;

  /** Subscribe to worker events. */
  on<K extends WorkerHandleEventName>(
    event: K,
    listener: (payload: WorkerHandleEvents[K]) => void,
  ): void;

  /** Unsubscribe from worker events. */
  off<K extends WorkerHandleEventName>(
    event: K,
    listener: (payload: WorkerHandleEvents[K]) => void,
  ): void;

  /** Optional methods the worker reported during initialization. */
  readonly supportedMethods: string[];

  /** Get diagnostic info about the worker. */
  diagnostics(): WorkerDiagnostics;
}

/**
 * Diagnostic information about a worker process.
 */
export interface WorkerDiagnostics {
  pluginId: string;
  status: WorkerStatus;
  pid: number | null;
  uptime: number | null;
  consecutiveCrashes: number;
  totalCrashes: number;
  pendingRequests: number;
  lastCrashAt: number | null;
  nextRestartAt: number | null;
}

// ---------------------------------------------------------------------------
// PluginWorkerManager — manages all plugin workers
// ---------------------------------------------------------------------------

/**
 * The top-level manager that holds all plugin worker handles.
 *
 * Provides a registry of workers keyed by plugin ID, with convenience methods
 * for starting/stopping all workers and routing RPC calls.
 */
export interface PluginWorkerManager {
  /**
   * Register and start a worker for a plugin.
   *
   * @returns The worker handle
   * @throws if a worker is already registered for this plugin
   */
  startWorker(pluginId: string, options: WorkerStartOptions): Promise<PluginWorkerHandle>;

  /**
   * Stop and unregister a specific plugin worker.
   */
  stopWorker(pluginId: string): Promise<void>;

  /**
   * Get the worker handle for a plugin.
   */
  getWorker(pluginId: string): PluginWorkerHandle | undefined;

  /**
   * Check if a worker is registered and running for a plugin.
   */
  isRunning(pluginId: string): boolean;

  /**
   * Authorize the companies a plugin's worker may act on from proactive
   * (non-invocation) context. No-op if the worker is not registered.
   */
  setProactiveCompanyScopes(pluginId: string, companyIds: readonly string[]): void;

  /**
   * Stop all managed workers. Called during server shutdown.
   */
  stopAll(): Promise<void>;

  /**
   * Get diagnostic info for all workers.
   */
  diagnostics(): WorkerDiagnostics[];

  /**
   * Send an RPC call to a specific plugin worker.
   *
   * @throws if the worker is not running
   */
  call<M extends HostToWorkerMethodName>(
    pluginId: string,
    method: M,
    params: HostToWorkerMethods[M][0],
    timeoutMs?: number,
    executeLogSink?: ExecuteLogSink,
  ): Promise<HostToWorkerMethods[M][1]>;

  /**
   * Open one live login pseudo-terminal route on a specific plugin worker
   * See {@link PluginWorkerHandle.openSetupTokenPtySession}.
   *
   * @throws if the worker is not registered.
   */
  openSetupTokenPtySession(
    pluginId: string,
    input: SetupTokenPtyOpenInput,
  ): Promise<SetupTokenPtyHostSession>;
}

// ---------------------------------------------------------------------------
// Implementation: createPluginWorkerHandle
// ---------------------------------------------------------------------------

/**
 * Internal dependencies injected by the manager (not part of the caller-facing
 * {@link WorkerStartOptions}).
 */
export interface PluginWorkerHandleDeps {
  /**
   * SECURITY-CRITICAL: the shared run-context registry. When provided, a background
   * dispatch carrying a triggering company (`onEvent`) mints a per-dispatch
   * company-scoped run-context here so its worker→host `secrets.resolve` is
   * scoped to that company rather than falling through to the company-agnostic
   * worker-lifetime service path.
   */
  runContextRegistry?: PluginRunContextRegistry;
}

/**
 * Create a handle for a single plugin worker process.
 *
 * @internal Exported for testing; consumers should use `createPluginWorkerManager`.
 */
export function createPluginWorkerHandle(
  pluginId: string,
  options: WorkerStartOptions,
  deps: PluginWorkerHandleDeps = {},
): PluginWorkerHandle {
  const log = logger.child({ service: "plugin-worker", pluginId });
  const runContextRegistry = deps.runContextRegistry;
  const emitter = new EventEmitter();
  /**
   * Higher than default (10) to accommodate multiple subscribers to
   * crash/ready/exit events during integration tests and runtime monitoring.
   */
  emitter.setMaxListeners(50);

  // Worker process state
  let childProcess: ChildProcess | null = null;
  let status: WorkerStatus = "stopped";
  let startedAt: number | null = null;
  let stderrExcerpt = "";

  // Pending RPC requests awaiting a response
  const pendingRequests = new Map<string | number, PendingRequest>();
  let nextRequestId = 1;
  const activeInvocations = new Map<string, ActiveInvocation>();
  // SECURITY-CRITICAL: stable, host-minted service run-context for this worker's
  // lifetime. Surfaced on every worker→host call so background dispatches /
  // setup() loops can resolve secrets outside any dispatch.
  const serviceRunId = randomUUID();
  // Host-owned execute routes, keyed by the host-issued invocation id. Only an
  // `environmentExecute` call with a log sink registers a route here. The
  // `execute.log` router delivers only through this map — never through the
  // generic `activeInvocations` record — so a non-execute call can never become
  // a log target.
  const activeExecuteRoutes = new Map<string, ExecuteLogRoute>();
  // Rate-limit state for dropped `execute.log` notifications. The debug record
  // never carries chunk bytes.
  let executeLogDropCount = 0;
  let executeLogDropLoggedAtMs = 0;
  // Rate-limit state for dropped oversized worker lines. The warn record carries
  // only the length, never the line bytes.
  let oversizedLineDropCount = 0;
  let oversizedLineLoggedAtMs = 0;

  // Framing and flood limits for the `execute.log` route. The defaults bound one
  // incoming line before the JSON parse and the total streamed output for one
  // execute call. A caller (a test) can lower them.
  const maxIncomingMessageChars =
    options.executeLogLimits?.maxIncomingMessageChars ?? MAX_WORKER_MESSAGE_CHARS;
  const maxExecuteLogTotalChars =
    options.executeLogLimits?.maxTotalCharsPerExecute ?? MAX_EXECUTE_LOG_TOTAL_CHARS;

  // Bounds and timeouts for the login pseudo-terminal route. A caller
  // (a test) can lower them to exercise the terminalize paths.
  const maxSetupTokenPtyChunkChars =
    options.setupTokenPtyLimits?.maxChunkChars ?? MAX_SETUP_TOKEN_PTY_CHUNK_CHARS;
  const maxSetupTokenPtyTotalChars =
    options.setupTokenPtyLimits?.maxTotalChars ?? MAX_SETUP_TOKEN_PTY_TOTAL_CHARS;
  const setupTokenPtyOpenTimeoutMs =
    options.setupTokenPtyLimits?.openTimeoutMs ?? SETUP_TOKEN_PTY_OPEN_TIMEOUT_MS;
  const setupTokenPtyCloseTimeoutMs =
    options.setupTokenPtyLimits?.closeTimeoutMs ?? SETUP_TOKEN_PTY_CLOSE_TIMEOUT_MS;

  // ------------------------------------------------------------------
  // Proactive company scopes (LOOA-629)
  // ------------------------------------------------------------------
  // A proactive plugin (e.g. the chat gateway) does company-scoped work from
  // its own timers/loops — not inside a host-issued top-level invocation
  // (onEvent/performAction/executeTool/configChanged). Those worker→host calls
  // carry no `paperclipInvocationId`, so the governed-access gate
  // (host-client-factory.ts) rejects any company-scoped request with
  // "company context is required" (regression class from #9557). The host
  // authorizes a bounded set of companies — the plugin's configured companies,
  // set by the loader after startup config delivery — for such proactive work.
  // A no-invocation call that references one of these companies resolves to
  // that company's scope; a call referencing any other company stays denied,
  // and in-invocation calls keep their strict single-company match.
  //
  // Seeded from options at handle creation — before the child process is
  // spawned — so a proactive plugin's setup()-time host calls (which land while
  // `startWorker` is still awaiting initialize) are authorized in time. The
  // loader used to call setProactiveCompanyScopes only AFTER startWorker
  // resolved, which was too late for the gateway's one-shot events.subscribe
  // and left outbound push permanently dead (LOOA-695).
  const proactiveCompanyScopes = new Set<string>();
  for (const id of options.proactiveCompanyScopes ?? []) {
    const trimmed = readNonEmptyString(id);
    if (trimmed) proactiveCompanyScopes.add(trimmed);
  }

  // Optional methods reported by the worker during initialization
  let supportedMethods: string[] = [];
  // SECURITY-CRITICAL: whether the worker declared at `initialize` that it echoes
  // `paperclipInvocationId` on dispatch-servicing calls. Reassigned from each
  // successful handshake, so a crash-restarted worker re-declares.
  let echoesInvocationId = false;
  // SECURITY-CRITICAL: host-observed counterpart to `echoesInvocationId`. Method names
  // this worker has been seen calling id-less while NO dispatch was in flight
  // — direct proof that it issues that call outside any dispatch, so
  // "exactly one dispatch is in flight" no longer implies the call belongs to
  // it. Unlike the worker's declaration this needs no plugin rebuild, which is
  // what makes it reach the installed base. Deliberately NOT reset
  // on worker crash-restart: `spawnProcess()` respawns inside this same
  // closure, and the signal describes the plugin's code rather than the
  // process, so it should outlive the child. It does NOT survive a new handle
  // (host restart, or plugin disable→enable), which reopens the learning
  // window until the worker is next observed calling id-less with no dispatch
  // in flight. It can only ever narrow what the worker is granted.
  const idlessCallsSeenWithNoDispatch = new Set<string>();

  // Crash tracking for exponential backoff
  let consecutiveCrashes = 0;
  let totalCrashes = 0;
  let lastCrashAt: number | null = null;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let nextRestartAt: number | null = null;

  // Track open stream channels so we can emit synthetic close on crash.
  // Maps channel → companyId.
  const openStreamChannels = new Map<string, string>();

  // Shutdown coordination
  let intentionalStop = false;

  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const autoRestart = options.autoRestart ?? true;
  const maxIpcFrameBytes = resolveMaxIpcFrameBytes(options.maxIpcFrameBytes);

  // -----------------------------------------------------------------------
  // Status management
  // -----------------------------------------------------------------------

  function setStatus(newStatus: WorkerStatus): void {
    const prev = status;
    if (prev === newStatus) return;
    status = newStatus;
    log.debug({ from: prev, to: newStatus }, "worker status change");
    emitter.emit("status", { pluginId, status: newStatus, previousStatus: prev });
  }

  // -----------------------------------------------------------------------
  // JSON-RPC message sending
  // -----------------------------------------------------------------------

  function sendMessage(message: unknown): void {
    if (!childProcess?.stdin?.writable) {
      throw new Error(`Worker process for plugin "${pluginId}" is not writable`);
    }
    const serialized = serializeMessage(message as any);
    childProcess.stdin.write(serialized);
  }

  function errorCodeForWorkerHostError(err: unknown): number {
    const code = (err as { code?: unknown } | null)?.code;
    const pluginErrorCodes: readonly number[] = Object.values(PLUGIN_RPC_ERROR_CODES);
    return typeof code === "number" && pluginErrorCodes.includes(code)
      ? code
      : JSONRPC_ERROR_CODES.INTERNAL_ERROR;
  }

  // -----------------------------------------------------------------------
  // Incoming message handling
  // -----------------------------------------------------------------------

  function handleLine(line: string): void {
    if (!line.trim()) return;

    // Enforce the framing bound BEFORE the JSON parse. A line longer than the
    // limit is dropped without a parse, so a faulty or hostile worker cannot
    // force the host to parse an unbounded document and exhaust memory.
    if (line.length > maxIncomingMessageChars) {
      dropOversizedLine(line.length);
      return;
    }

    let message: unknown;
    try {
      message = parseMessage(line);
    } catch (err) {
      if (err instanceof JsonRpcParseError) {
        log.warn({ rawLine: line.slice(0, 200) }, "unparseable message from worker");
      } else {
        log.warn({ err }, "error parsing worker message");
      }
      return;
    }

    if (isJsonRpcResponse(message)) {
      handleResponse(message);
    } else if (isJsonRpcRequest(message)) {
      handleWorkerRequest(message as JsonRpcRequest);
    } else if (isJsonRpcNotification(message)) {
      handleWorkerNotification(message as JsonRpcNotification);
    } else {
      log.warn("unknown message type from worker");
    }
  }

  /**
   * Handle a JSON-RPC response from the worker (matching a pending request).
   */
  function handleResponse(response: JsonRpcResponse): void {
    const id = response.id;
    if (id === null || id === undefined) {
      log.warn("received response with null/undefined id");
      return;
    }

    const pending = pendingRequests.get(id);
    if (!pending) {
      log.warn({ id }, "received response for unknown request id");
      return;
    }

    clearTimeout(pending.timer);
    pendingRequests.delete(id);
    pending.resolve(response);
  }

  function readNonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function deriveInvocationScope(
    method: HostToWorkerMethodName | string,
    params: unknown,
  ): PluginInvocationScope | null {
    if (!isRecord(params)) return null;

    const directCompanyId = readNonEmptyString(params.companyId);
    if (directCompanyId) return { companyId: directCompanyId };

    if (method === "performAction" && isRecord(params.actorContext)) {
      const companyId = readNonEmptyString(params.actorContext.companyId);
      if (!companyId) return null;
      // SECURITY-CRITICAL: carry runId/agentId on the scope so a worker→host callback
      // that omits them (e.g. an older SDK's `secrets.resolve(secretRef)`) can be back-
      // filled from the host-validated active invocation rather than failing
      // closed. Values come from the host's params, never from the worker.
      const runId = readNonEmptyString(params.actorContext.runId);
      const agentId = readNonEmptyString(params.actorContext.agentId);
      return {
        companyId,
        ...(runId ? { runId } : {}),
        ...(agentId ? { agentId } : {}),
      };
    }

    if (method === "executeTool" && isRecord(params.runContext)) {
      const companyId = readNonEmptyString(params.runContext.companyId);
      if (!companyId) return null;
      // SECURITY-CRITICAL: thread the outer dispatcher's runId/agentId so worker→host
      // callbacks that didn't include them can be reconstructed by the host.
      // This preserves the security model — the runId is the
      // host's own, taken from the dispatch the host issued, never trusted to
      // the worker.
      const runId = readNonEmptyString(params.runContext.runId);
      const agentId = readNonEmptyString(params.runContext.agentId);
      return {
        companyId,
        ...(runId ? { runId } : {}),
        ...(agentId ? { agentId } : {}),
      };
    }

    if (method === "onEvent" && isRecord(params.event)) {
      const companyId = readNonEmptyString(params.event.companyId);
      return companyId ? { companyId } : null;
    }

    return null;
  }

  function registerInvocation(
    scope: PluginInvocationScope,
    ttlMs?: number,
    method?: HostToWorkerMethodName | string,
  ): PluginInvocationContext {
    // SECURITY-CRITICAL: for a background dispatch carrying a triggering company (and no
    // dispatching agent runId of its own), mint a per-dispatch company-scoped
    // run-context and surface its runId on the scope. The worker echoes it on
    // its `secrets.resolve` callback (or the host back-fills it from this
    // scope), so the resolve is company-scoped instead of falling through to
    // the company-agnostic worker-lifetime service path.
    let effectiveScope = scope;
    let backgroundRunId: string | undefined;
    if (
      method !== undefined &&
      BACKGROUND_DISPATCH_METHODS.has(method) &&
      scope.companyId &&
      !scope.runId &&
      runContextRegistry
    ) {
      backgroundRunId = randomUUID();
      effectiveScope = { ...scope, runId: backgroundRunId };
      runContextRegistry.registerBackground(pluginId, backgroundRunId, scope.companyId);
    }

    const invocation: PluginInvocationContext = {
      id: randomUUID(),
      scope: effectiveScope,
      ...(traceparent ? { traceparent } : {}),
      ...(backgroundRunId ? { backgroundRunId } : {}),
    };
    const entry: ActiveInvocation = { scope: effectiveScope, traceparent, backgroundRunId };
    if (ttlMs !== undefined) {
      entry.timer = setTimeout(() => {
        activeInvocations.delete(invocation.id);
        if (backgroundRunId) runContextRegistry?.deregister(pluginId, backgroundRunId);
      }, ttlMs);
      if (entry.timer.unref) entry.timer.unref();
    }
    activeInvocations.set(invocation.id, entry);
    return invocation;
  }

  function clearInvocation(invocation: PluginInvocationContext | null): void {
    if (!invocation) return;
    const entry = activeInvocations.get(invocation.id);
    if (entry?.timer) clearTimeout(entry.timer);
    if (entry?.backgroundRunId) {
      runContextRegistry?.deregister(pluginId, entry.backgroundRunId);
    }
    activeInvocations.delete(invocation.id);
  }

  // Store the host-owned execute route for one active execute call. The host
  // holds the exact company id and log sink; the worker never supplies them.
  function registerExecuteRoute(
    invocationId: string,
    companyId: string,
    onLog: ExecuteLogSink,
  ): void {
    activeExecuteRoutes.set(invocationId, {
      companyId,
      onLog,
      deliveredChars: 0,
      crossCompanyBlocked: false,
    });
  }

  function clearExecuteRoute(invocationId: string | undefined): void {
    if (invocationId) activeExecuteRoutes.delete(invocationId);
  }

  // Drop an oversized incoming worker line before the JSON parse. Write a
  // rate-limited warn record with the length and a running drop count. The
  // record never carries the line bytes.
  function dropOversizedLine(lineLength: number): void {
    oversizedLineDropCount += 1;
    const nowMs = Date.now();
    if (nowMs - oversizedLineLoggedAtMs >= EXECUTE_LOG_DROP_LOG_INTERVAL_MS) {
      log.warn(
        { lineLength, maxIncomingMessageChars, droppedSinceLastLog: oversizedLineDropCount },
        "dropping oversized worker line before JSON parse",
      );
      oversizedLineLoggedAtMs = nowMs;
      oversizedLineDropCount = 0;
    }
  }

  // Drop an `execute.log` notification. Write a rate-limited debug record with
  // the reason and a running drop count. The record never carries the chunk
  // bytes, the company id, or command data.
  function dropExecuteLogNotification(reason: string): void {
    executeLogDropCount += 1;
    const nowMs = Date.now();
    if (nowMs - executeLogDropLoggedAtMs >= EXECUTE_LOG_DROP_LOG_INTERVAL_MS) {
      log.debug(
        { reason, droppedSinceLastLog: executeLogDropCount },
        "dropping execute.log notification",
      );
      executeLogDropLoggedAtMs = nowMs;
      executeLogDropCount = 0;
    }
  }

  // Route one `execute.log` notification to its host-owned execute route. The
  // route is the single authority for the delivery target and the company
  // binding. This never reads a company id from the notification and never
  // routes through the generic active-invocation record.
  //
  // Complete mediation: the host and the worker share one stdio pipe, and the
  // worker process sees every active invocation id. So the host cannot prove
  // which concurrent invocation produced a notification, and it must NOT treat
  // the worker-supplied `paperclipInvocationId` alone as proof of origin. The
  // host validates the exact company scope instead: it delivers only while every
  // active execute route on this worker belongs to ONE company. When a second
  // company's execute overlaps, the host fails closed — it latches the active
  // routes and drops the chunk — so a worker that runs company A can never forge
  // company B's active id and inject output into B's route. The final command
  // result still delivers the complete output, so no byte is lost; only the live
  // stream pauses while two companies overlap.
  function routeExecuteLogNotification(notification: JsonRpcNotification): void {
    const invocationId = readNonEmptyString(
      (notification as { paperclipInvocationId?: unknown }).paperclipInvocationId,
    );
    const params = isRecord(notification.params) ? notification.params : {};
    const stream = params.stream;
    const chunk = params.chunk;
    // Runtime-validate the payload. Drop invalid input without a throw.
    if (stream !== "stdout" && stream !== "stderr") {
      dropExecuteLogNotification("invalid-stream");
      return;
    }
    if (
      typeof chunk !== "string" ||
      chunk.length === 0 ||
      chunk.length > MAX_EXECUTE_LOG_CHUNK_CHARS
    ) {
      dropExecuteLogNotification("invalid-chunk");
      return;
    }
    if (!invocationId) {
      dropExecuteLogNotification("missing-invocation");
      return;
    }
    const route = activeExecuteRoutes.get(invocationId);
    if (!route) {
      // No active execute route for this id: a late chunk after settlement or
      // timeout, a non-execute invocation, or an unknown id. Drop it.
      dropExecuteLogNotification("no-active-route");
      return;
    }
    // The route already lost single-company attribution earlier in its life, so
    // it stays closed for the rest of the call.
    if (route.crossCompanyBlocked) {
      dropExecuteLogNotification("cross-company-scope");
      return;
    }
    // Validate the exact company scope. Deliver only while every active execute
    // route on this worker belongs to one company. A second company's active
    // route makes the shared pipe ambiguous, so the host fails closed: it
    // latches every active route and drops the chunk.
    let onlyCompanyId: string | null = null;
    let crossCompany = false;
    for (const active of activeExecuteRoutes.values()) {
      if (onlyCompanyId === null) {
        onlyCompanyId = active.companyId;
      } else if (onlyCompanyId !== active.companyId) {
        crossCompany = true;
        break;
      }
    }
    if (crossCompany) {
      for (const active of activeExecuteRoutes.values()) {
        active.crossCompanyBlocked = true;
      }
      dropExecuteLogNotification("cross-company-scope");
      return;
    }
    // Bound the total characters one execute call may stream. Past the ceiling
    // the host drops further chunks, so one runaway or hostile execution cannot
    // flood the host and the run-log sink without limit.
    if (route.deliveredChars + chunk.length > maxExecuteLogTotalChars) {
      dropExecuteLogNotification("execute-output-cap");
      return;
    }
    route.deliveredChars += chunk.length;
    try {
      const delivery = route.onLog(stream, chunk);
      if (delivery && typeof (delivery as Promise<void>).then === "function") {
        void (delivery as Promise<void>).catch((err) => {
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            "execute.log delivery failed",
          );
        });
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "execute.log delivery threw",
      );
    }
  }

  // -----------------------------------------------------------------------
  // Host-owned setup-token login pseudo-terminal route gate
  // -----------------------------------------------------------------------
  // The manager owns one live login pseudo-terminal route per worker. It mints a
  // host-owned opaque route identifier, carries it in the open call, and keys the
  // close on it, so it closes a worker-created terminal even when the open reply
  // was lost and no worker session identifier arrived. It binds the worker
  // session identifier one time while the route is `opening`, for output only. It
  // never trusts a worker-supplied identifier as proof of origin: it delivers
  // output only while the route is `open` and the notification carries the exact
  // bound identifier and valid bounded bytes, and it never logs the raw bytes. It
  // terminalizes the route exactly once on every open failure path, closes the
  // terminal by the host route identifier, and admits a new open only after it
  // verifies a close acknowledgement bound to that identifier; it retires the
  // worker on an unconfirmed close.

  type SetupTokenPtyRouteState = "reserved" | "opening" | "open" | "closed";
  interface SetupTokenPtyRoute {
    hostRouteId: string;
    state: SetupTokenPtyRouteState;
    workerSessionId: string | null;
    listener: ((chunk: string) => void) | null;
    buffered: string[];
    deliveredChars: number;
    terminalized: boolean;
    settleWait: (value: { exitCode: number | null }) => void;
  }
  // At most one active credential pseudo-terminal per worker. A non-null route
  // blocks a second open until the manager confirms the first route's close.
  let setupTokenPtyRoute: SetupTokenPtyRoute | null = null;

  function settleSetupTokenPtyWait(
    route: SetupTokenPtyRoute,
    value: { exitCode: number | null },
  ): void {
    const settle = route.settleWait;
    route.settleWait = () => {};
    settle(value);
  }

  // Close the worker terminal by the host route identifier and verify the bound
  // acknowledgement. Return true only when the worker returns an acknowledgement
  // that carries the exact host route identifier. An absent, malformed,
  // mismatched, or timed-out acknowledgement returns false, so the caller fails
  // closed.
  async function closeSetupTokenPtyTerminal(hostRouteId: string): Promise<boolean> {
    try {
      const ack = await callInternal(
        "setupTokenPtyClose",
        { hostRouteId },
        setupTokenPtyCloseTimeoutMs,
      );
      return isRecord(ack) && readNonEmptyString(ack.hostRouteId) === hostRouteId;
    } catch {
      return false;
    }
  }

  // Terminalize the route exactly once. Resolve the login wait, close the worker
  // terminal by the host route identifier, and free the per-worker slot only
  // after the close resolves. Retire the worker when the close is unconfirmed.
  async function terminalizeSetupTokenPtyRoute(route: SetupTokenPtyRoute): Promise<void> {
    if (route.terminalized) return;
    route.terminalized = true;
    route.state = "closed";
    route.listener = null;
    route.buffered = [];
    // A terminalized route reports a null exit code, which the runner treats as a
    // failure.
    settleSetupTokenPtyWait(route, { exitCode: null });
    const confirmed = await closeSetupTokenPtyTerminal(route.hostRouteId);
    if (setupTokenPtyRoute === route) setupTokenPtyRoute = null;
    if (!confirmed) {
      // The worker did not acknowledge the close, so the host cannot prove the
      // terminal is gone. Fail closed: retire the worker before any reuse.
      log.error(
        { pluginId },
        "setup-token login pseudo-terminal close not acknowledged; retiring worker",
      );
      void killProcess();
    }
  }

  // Route one login pseudo-terminal output notification to the per-session
  // listener. Deliver only while the route is `open` and the notification carries
  // the exact bound worker session identifier and valid bounded bytes. Drop an
  // unknown, late, malformed, or mismatched notification. Never log the raw bytes.
  function routeSetupTokenPtyOutput(notification: JsonRpcNotification): void {
    const route = setupTokenPtyRoute;
    if (!route || route.state !== "open") return;
    const params = isRecord(notification.params) ? notification.params : {};
    const workerSessionId = readNonEmptyString(params.workerSessionId);
    if (!workerSessionId || workerSessionId !== route.workerSessionId) return;
    const chunk = params.chunk;
    if (
      typeof chunk !== "string" ||
      chunk.length === 0 ||
      chunk.length > maxSetupTokenPtyChunkChars
    ) {
      return;
    }
    if (route.deliveredChars + chunk.length > maxSetupTokenPtyTotalChars) {
      // The cumulative output passed the per-route bound. Terminalize the route.
      void terminalizeSetupTokenPtyRoute(route);
      return;
    }
    route.deliveredChars += chunk.length;
    if (route.listener) route.listener(chunk);
    else route.buffered.push(chunk);
  }

  // Route one login pseudo-terminal exit notification to the login wait. Resolve
  // only while the route is `open` and the notification carries the exact bound
  // worker session identifier.
  function routeSetupTokenPtyExit(notification: JsonRpcNotification): void {
    const route = setupTokenPtyRoute;
    if (!route || route.state !== "open") return;
    const params = isRecord(notification.params) ? notification.params : {};
    const workerSessionId = readNonEmptyString(params.workerSessionId);
    if (!workerSessionId || workerSessionId !== route.workerSessionId) return;
    const exitCode = typeof params.exitCode === "number" ? params.exitCode : null;
    settleSetupTokenPtyWait(route, { exitCode });
  }

  // Close the one route on a worker exit. The worker is gone, so the manager
  // resolves the login wait with the fixed non-secret exit and clears the route
  // one time. The pending pseudo-terminal calls reject through `rejectAllPending`.
  function closeSetupTokenPtyRouteOnWorkerExit(): void {
    const route = setupTokenPtyRoute;
    if (!route) return;
    setupTokenPtyRoute = null;
    route.terminalized = true;
    route.state = "closed";
    route.listener = null;
    route.buffered = [];
    settleSetupTokenPtyWait(route, { exitCode: null });
  }

  // Open one live login pseudo-terminal route. Reserve the route
  // before the open call, bind the worker session identifier one time on the
  // first successful open reply, and return a session the login transport drives.
  // Terminalize the route on every open failure path.
  async function openSetupTokenPtySession(
    input: SetupTokenPtyOpenInput,
  ): Promise<SetupTokenPtyHostSession> {
    if (input.command !== CLAUDE_SETUP_TOKEN_COMMAND) {
      // Allowlist the login command. Only the fixed `CLAUDE_SETUP_TOKEN_COMMAND`
      // may run in the sandbox pseudo-terminal. Reject any other command with one
      // fixed non-secret error before the worker call, so a caller cannot spawn
      // an arbitrary process in the sandbox pseudo-terminal.
      throw new Error(SETUP_TOKEN_PTY_COMMAND_NOT_ALLOWED);
    }
    if (setupTokenPtyRoute) {
      // A route for this worker is not yet closed and confirmed. Reject the
      // second open with one fixed non-secret error before it reaches the worker.
      throw new Error(SETUP_TOKEN_PTY_ROUTE_BUSY);
    }
    const hostRouteId = randomUUID();
    let settleWait: (value: { exitCode: number | null }) => void = () => {};
    const waitPromise = new Promise<{ exitCode: number | null }>((resolve) => {
      settleWait = resolve;
    });
    const route: SetupTokenPtyRoute = {
      hostRouteId,
      state: "reserved",
      workerSessionId: null,
      listener: null,
      buffered: [],
      deliveredChars: 0,
      terminalized: false,
      settleWait,
    };
    setupTokenPtyRoute = route;

    route.state = "opening";
    let openResult: HostToWorkerMethods["setupTokenPtyOpen"][1];
    try {
      openResult = await callInternal(
        "setupTokenPtyOpen",
        {
          hostRouteId,
          driverKey: input.driverKey,
          companyId: input.companyId,
          environmentId: input.environmentId,
          providerLeaseId: input.providerLeaseId,
          command: input.command,
        },
        setupTokenPtyOpenTimeoutMs,
      );
    } catch (err) {
      // A send failure, an RPC rejection, or an open timeout. Terminalize the
      // route exactly once and fail closed.
      await terminalizeSetupTokenPtyRoute(route);
      throw err instanceof Error ? err : new Error(SETUP_TOKEN_PTY_OPEN_FAILED);
    }

    const workerSessionId = readNonEmptyString(
      isRecord(openResult) ? openResult.workerSessionId : null,
    );
    if (!workerSessionId || route.state !== "opening" || route.terminalized) {
      // A malformed reply, or a route that already left `opening`. A late or a
      // duplicate reply never binds, revives, or reopens a route.
      await terminalizeSetupTokenPtyRoute(route);
      throw new Error(SETUP_TOKEN_PTY_OPEN_FAILED);
    }
    // Bind the worker session identifier one time and move the route to `open`.
    route.workerSessionId = workerSessionId;
    route.state = "open";

    return {
      onData(listener: (chunk: string) => void): void {
        route.listener = listener;
        if (route.buffered.length > 0) {
          const pending = route.buffered;
          route.buffered = [];
          for (const chunk of pending) listener(chunk);
        }
      },
      write(data: string): void {
        const sid = route.workerSessionId;
        if (route.state !== "open" || !sid) return;
        void callInternal(
          "setupTokenPtyInput",
          { workerSessionId: sid, data },
          setupTokenPtyOpenTimeoutMs,
        ).catch(() => {});
      },
      wait(): Promise<{ exitCode: number | null }> {
        return waitPromise;
      },
      kill(): void {
        const sid = route.workerSessionId;
        if (!sid) return;
        void callInternal(
          "setupTokenPtyStop",
          { workerSessionId: sid },
          setupTokenPtyOpenTimeoutMs,
        ).catch(() => {});
      },
      async close(): Promise<void> {
        await terminalizeSetupTokenPtyRoute(route);
      },
    };
  }

  /**
   * Extract the single company a worker→host call references, mirroring the SDK
   * governed-access gate's own derivation (host-client-factory.ts
   * `requestedCompanyScope`) so a proactive call resolves to exactly the company
   * the gate would require:
   *   - explicit `params.companyId`;
   *   - a company-scoped state key (`scopeKind: "company"` + `scopeId`);
   *   - `events.subscribe`'s `params.filter.companyId` (how the SDK's
   *     `ctx.events.on(name, { companyId }, fn)` issues its subscribe).
   *
   * Returns null whenever the gate treats the call as a wildcard (`companies.list`,
   * a `scopeKind: "company"` key with no `scopeId`) or as referencing no company
   * (instance-scoped state, an unfiltered subscribe). A wildcard is deliberately
   * NOT granted proactively: proactive resolution only ever admits a single,
   * explicit company, never "all". This keeps the resolver and the gate in
   * lockstep in the functional direction (LOOA-693 AC#4 / LOOA-695).
   */
  function referencedCompanyId(method: string, params: unknown): string | null {
    // Gate returns { kind: "all" } for companies.list regardless of params —
    // never a single company — so proactive access declines it here.
    if (method === "companies.list") return null;
    if (!isRecord(params)) return null;
    const direct = readNonEmptyString(params.companyId);
    if (direct) return direct;
    if (params.scopeKind === "company") {
      // scopeId present → that company; absent → wildcard ("all") in the gate,
      // which we never grant proactively → null.
      return readNonEmptyString(params.scopeId);
    }
    if (method === "events.subscribe" && isRecord(params.filter)) {
      return readNonEmptyString(params.filter.companyId);
    }
    return null;
  }

  function contextForWorkerMessage(message: JsonRpcRequest | JsonRpcNotification): WorkerHostCallContext {
    // SECURITY-CRITICAL: ALWAYS attach the worker-lifetime service run-context, on top of
    // whatever dispatch scope (if any) the message resolves to. The service
    // scope grants no company scope by itself; merging it never widens
    // `invocationScope` enforcement for a method that trusts `companyId` as its
    // sole authority.
    //
    // SECURITY-CRITICAL: a NARROW allowlist of company-scoped methods
    // (`SERVICE_SCOPE_COMPANY_METHODS` in the SDK gate) that are server-side
    // `requireInCompany` reach-checked IS authorized under this serviceScope when
    // no dispatch pins a company — including when base context reports
    // `invalidInvocationScope` for the scope-less inbound relay path (the
    // `onWebhook` / `getUpdates` callback carries no resolvable dispatch id). The
    // SDK gate evaluates that allowlist bypass before its `invalidInvocationScope`
    // rejection (a guard-ordering fix). This does not widen reach: the
    // bypass is reach-checked, and the rejection retains full force for every
    // non-allowlisted company-scoped method.
    return {
      ...baseContextForWorkerMessage(message),
      serviceScope: { runId: serviceRunId },
    };
  }

  function baseContextForWorkerMessage(message: JsonRpcRequest | JsonRpcNotification): WorkerHostCallContext {
    const invocationId = readNonEmptyString(
      (message as { paperclipInvocationId?: unknown }).paperclipInvocationId,
    );
    if (!invocationId) {
      // SECURITY-CRITICAL: an older worker SDK (e.g. platform.cad ≤0.1.7) does not
      // echo `paperclipInvocationId` on its worker→host callbacks, so we cannot
      // bind this call to an invocation by id. When EXACTLY ONE host→worker
      // dispatch is in-flight, that dispatch is unambiguously the one the worker
      // is servicing, so we surface its host-validated scope as
      // `singleInFlightScope`. This was originally recorded as feeding the runId
      // back-fill ONLY; that stopped being true once `config.get` started to
      // select a tenant from it, which is why the whole branch is gated on
      // the worker being unable to echo an id in the first place. The runId
      // comes from the host's own runContext, never the worker. We deliberately
      // STILL return `invalidInvocationScope` so company-scope enforcement stays
      // strict — a worker can never name an arbitrary target company off this.
      // With 0 or 2+ dispatches in-flight we cannot attribute the call and fall
      // through to the fail-closed behaviour (no scope surfaced).
      const inFlightInvocationIds = new Set<string>();
      for (const pending of pendingRequests.values()) {
        if (pending.invocationId) inFlightInvocationIds.add(pending.invocationId);
      // Upstream (LOOA-629/695): a proactive plugin (chat gateway) does company-scoped
      // work from its own timers/loops. An id-less call that references one of the
      // plugin's configured companies resolves to that company's scope. This never
      // widens access beyond the loader-seeded allowlist; in-invocation calls keep
      // the strict single-company match below.
      const proactiveCompanyId = referencedCompanyId(
        message.method,
        (message as { params?: unknown }).params,
      );
      if (proactiveCompanyId && proactiveCompanyScopes.has(proactiveCompanyId)) {
        return { invocationScope: { companyId: proactiveCompanyId } };
      }
      }
      const hasActiveInvocation =
        activeInvocations.size > 0 || inFlightInvocationIds.size > 0;
      const method = readNonEmptyString((message as { method?: unknown }).method);
      if (!hasActiveInvocation) {
        // SECURITY-CRITICAL: an id-less call with nothing in flight is unambiguous —
        // this worker makes this call outside any dispatch. Record it so the
        // attribution below is withdrawn for this method from now on. A worker
        // servicing its own dispatch always has that dispatch in flight, so a
        // dispatch-only legacy worker (platform.cad ≤0.1.7, klipper) can never
        // trip this and keeps the single-in-flight attribution above intact.
        if (method) idlessCallsSeenWithNoDispatch.add(method);
        return {};
      }
      // SECURITY-CRITICAL: plugin workers are GLOBAL — one worker process serves every
      // tenant — so "the single in-flight dispatch" is only the caller's own
      // dispatch for a worker that CANNOT echo the id. A worker that declared
      // `echoesInvocationId` at initialize and still sent none is servicing no
      // dispatch at all (a `setup()`-started poll loop, a `runJob`, a timer).
      // Attributing it to whichever tenant happens to be mid-dispatch hands that
      // tenant's effective config — and the secret-refs it carries — to a caller
      // with no claim to it. Such callers use `serviceScope`, which
      // `contextForWorkerMessage` attaches unconditionally.
      //
      // SECURITY-CRITICAL: `echoesInvocationId` is worker-declared, and plugins bundle
      // their own SDK copy in `dist/worker.js`, so it stays false for the whole
      // installed base until each plugin is rebuilt. The second
      // clause is the host's own observation of the same fact and needs no
      // rebuild: once this worker has issued THIS method id-less with nothing
      // in flight, a later id-less call cannot be assumed to own the single
      // dispatch that happens to be open. Per-method rather than per-worker so
      // an unrelated startup `log` cannot withdraw `secrets.resolve`'s binding.
      let singleInFlightScope: PluginInvocationScope | undefined;
      const ownsNoDispatch = method !== null && idlessCallsSeenWithNoDispatch.has(method);
      if (!echoesInvocationId && !ownsNoDispatch && inFlightInvocationIds.size === 1) {
        const [onlyId] = inFlightInvocationIds;
        const entry = onlyId ? activeInvocations.get(onlyId) : undefined;
        if (entry) singleInFlightScope = entry.scope;
      }
      return singleInFlightScope
        ? { invalidInvocationScope: true, singleInFlightScope }
        : { invalidInvocationScope: true };
    }
    const entry = activeInvocations.get(invocationId);
    if (!entry) return { invalidInvocationScope: true };
    return { invocationScope: entry.scope, traceparent: entry.traceparent };
  }

  /**
   * Handle a JSON-RPC request from the worker (worker→host call).
   */
  async function handleWorkerRequest(request: JsonRpcRequest): Promise<void> {
    const method = request.method as WorkerToHostMethodName;
    const handler = options.hostHandlers[method] as
      | ((params: unknown, context?: WorkerHostCallContext) => Promise<unknown>)
      | undefined;

    if (!handler) {
      log.warn({ method }, "worker called unregistered host method");
      try {
        sendMessage(
          createErrorResponse(
            request.id,
            JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
            `Host does not handle method "${method}"`,
          ),
        );
      } catch {
        // Worker may have exited, ignore send error
      }
      return;
    }

    try {
      const result = await handler(request.params, contextForWorkerMessage(request));
      sendMessage({
        jsonrpc: JSONRPC_VERSION,
        id: request.id,
        result: result ?? null,
      });
    } catch (err) {
      // SECURITY-CRITICAL: defense-in-depth redaction happens in the
      // exported redactHostHandlerErrorMessage helper (see its doc comment).
      const safeErrorMessage = redactHostHandlerErrorMessage(err);
      const errorCode = errorCodeForWorkerHostError(err);
      // Surface the JSON-RPC error code and typed error name alongside
      // the message so a denied/failed in-process host call (e.g. an
      // InvocationScopeDeniedError from a background loop) is diagnosable from
      // logs alone, without correlating to source. `safeErrorMessage` already
      // carries the (redacted) human reason; `errorCode`/`errorName` make the
      // failure class queryable.
      log.error(
        {
          method,
          err: safeErrorMessage,
          errorCode,
          errorName: err instanceof Error ? err.name : undefined,
        },
        "host handler error",
      );
      try {
        sendMessage(
          createErrorResponse(
            request.id,
            errorCode,
            safeErrorMessage,
          ),
        );
      } catch {
        // Worker may have exited, ignore send error
      }
    }
  }

  /**
   * Handle a JSON-RPC notification from the worker (fire-and-forget).
   *
   * The `log` notification is the primary case — worker `ctx.logger` calls
   * arrive here. We append structured plugin context (pluginId, timestamp,
   * level) so that every log entry is queryable per the spec (§26.1).
   */
  function handleWorkerNotification(notification: JsonRpcNotification): void {
    if (notification.method === "log") {
      const params = notification.params as {
        level?: string;
        message?: string;
        meta?: Record<string, unknown>;
      } | null;
      const level = params?.level ?? "info";
      const msg = params?.message ?? "";
      const meta = params?.meta;

      // Build a structured log object that includes the plugin context fields
      // required by §26.1: pluginId, timestamp, level, message, and metadata.
      // The child logger already carries `pluginId` in its bindings, but we
      // add explicit `pluginLogLevel` and `pluginTimestamp` so downstream
      // consumers (log storage, UI queries) can filter without parsing.
      const logFields: Record<string, unknown> = {
        ...meta,
        pluginLogLevel: level,
        pluginTimestamp: new Date().toISOString(),
      };

      if (level === "error") {
        log.error(logFields, `[plugin] ${msg}`);
      } else if (level === "warn") {
        log.warn(logFields, `[plugin] ${msg}`);
      } else if (level === "debug") {
        log.debug(logFields, `[plugin] ${msg}`);
      } else {
        log.info(logFields, `[plugin] ${msg}`);
      }
      return;
    }

    // Execute-log notifications: deliver one incremental output chunk to the
    // host-owned execute route for the active execute call.
    if (notification.method === "execute.log") {
      routeExecuteLogNotification(notification);
      return;
    }

    // Setup-token login pseudo-terminal notifications: deliver output
    // and the exit to the one host-owned login route, bound by the worker session
    // identifier while the route is open.
    if (notification.method === SETUP_TOKEN_PTY_OUTPUT_NOTIFICATION) {
      routeSetupTokenPtyOutput(notification);
      return;
    }
    if (notification.method === SETUP_TOKEN_PTY_EXIT_NOTIFICATION) {
      routeSetupTokenPtyExit(notification);
      return;
    }

    // Stream notifications: forward to the stream bus via callback
    if (
      notification.method === "streams.open" ||
      notification.method === "streams.emit" ||
      notification.method === "streams.close"
    ) {
      const params = (notification.params ?? {}) as Record<string, unknown>;
      const companyId = String(params.companyId ?? "");
      const context = contextForWorkerMessage(notification);
      if (context.invalidInvocationScope) {
        log.warn(
          { method: notification.method, companyId },
          "dropping plugin stream notification with invalid invocation scope",
        );
        return;
      }
      const allowedCompanyId = readNonEmptyString(context.invocationScope?.companyId);
      if (companyId) {
        // Fail closed (matches requireInvocationCompanyScope): a company-scoped
        // stream notification with no resolvable invocation scope cannot be
        // tenant-verified — drop it rather than forwarding it under no pin.
        if (!allowedCompanyId) {
          log.warn(
            { method: notification.method, companyId },
            "dropping company-scoped plugin stream notification with no resolvable invocation scope",
          );
          return;
        }
        if (companyId !== allowedCompanyId) {
          log.warn(
            { method: notification.method, companyId, allowedCompanyId },
            "dropping plugin stream notification outside invocation company scope",
          );
          return;
        }
      }

      // Track open channels so we can emit synthetic close on crash
      if (notification.method === "streams.open") {
        const ch = String(params.channel ?? "");
        if (ch) openStreamChannels.set(ch, companyId);
      } else if (notification.method === "streams.close") {
        openStreamChannels.delete(String(params.channel ?? ""));
      }

      if (options.onStreamNotification) {
        try {
          options.onStreamNotification(notification.method, params);
        } catch (err) {
          log.error(
            {
              method: notification.method,
              err: err instanceof Error ? err.message : String(err),
            },
            "stream notification handler failed",
          );
        }
      }
      return;
    }

    log.debug({ method: notification.method }, "received notification from worker");
  }

  // -----------------------------------------------------------------------
  // Process lifecycle
  // -----------------------------------------------------------------------

  function spawnProcess(): ChildProcess {
    // Security: Do NOT spread process.env into the worker. Plugins should only
    // receive a minimal, controlled environment to prevent leaking host
    // secrets (like DATABASE_URL, internal API keys, etc.).
    const workerEnv: Record<string, string> = {
      ...options.env,
      PATH: process.env.PATH ?? "",
      NODE_PATH: process.env.NODE_PATH ?? "",
      PAPERCLIP_PLUGIN_ID: pluginId,
      NODE_ENV: process.env.NODE_ENV ?? "production",
      TZ: process.env.TZ ?? "UTC",
    };

    // SECURITY-CRITICAL: use `spawn` with a 3-fd stdio instead of `fork`. The host↔worker
    // protocol runs entirely over stdin (host→worker requests) and stdout
    // (worker→host NDJSON, byte-capped by the IPC frame cap above). It NEVER uses the node IPC
    // channel: there is no `child.send(...)`/`child.on("message", ...)` anywhere
    // in the host, and the worker SDK transports over `process.stdin`/`stdout`.
    // `fork()` always provisions an IPC channel (fd 3) whose parent-side reader
    // calls `readStart()` and buffers incoming bytes with no application-level
    // cap — a worker→host OOM vector the stdout cap does not cover (a
    // compromised worker could `process.send({huge})` or `fs.writeSync(3, ...)`).
    // `spawn` with `["pipe","pipe","pipe"]` provisions no IPC channel, removing
    // the surface entirely (Minimize Attack Surface / Least Common Mechanism).
    // `fork`'s node args are `execArgv` before the module path; replicate that.
    const child = spawn(
      process.execPath,
      [...(options.execArgv ?? []), options.entrypointPath],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: workerEnv,
        // Don't let the child keep the parent alive
        detached: false,
      },
    );

    // Defense-in-depth: assert no IPC channel exists. `spawn` with a 3-fd stdio
    // never creates one, but if a future change reintroduces it, sever the
    // channel and audit rather than silently leaving the uncapped fd-3 bypass
    // open.
    if (child.channel != null) {
      log.error(
        { audit: "plugin.worker.ipc.unexpected_channel", pid: child.pid },
        "worker spawned with an unexpected node IPC channel; disconnecting to close the uncapped fd-3 OOM vector",
      );
      try {
        child.disconnect();
      } catch {
        // Channel may already be torn down.
      }
    }

    return child;
  }

  function attachStdioHandlers(child: ChildProcess): void {
    // SECURITY-CRITICAL: read NDJSON from stdout through a byte-bounded frame reader.
    // The reader never buffers more than `maxIpcFrameBytes` of an in-flight
    // frame; an oversized frame is dropped before the host allocates the full
    // payload, audited, and the worker is terminated (fail closed).
    if (child.stdout) {
      const stdoutReader = createBoundedFrameReader({
        maxFrameBytes: maxIpcFrameBytes,
        onFrame: handleLine,
        onOversize: ({ bytesSeen, limit }) => {
          log.error(
            {
              audit: "plugin.worker.ipc.oversize_frame",
              stream: "stdout",
              bytesSeen,
              limit,
            },
            "worker IPC frame exceeded hard size cap; dropping frame and terminating worker",
          );
          terminateForOversizeFrame();
        },
      });
      child.stdout.on("data", (chunk: Buffer) => stdoutReader.push(chunk));
    }

    // Capture stderr for logging, also byte-bounded so a worker cannot OOM the
    // host with a giant newline-less stderr line. Oversized stderr is truncated
    // rather than fatal — it is a logging channel, not the IPC transport.
    if (child.stderr) {
      const stderrReader = createBoundedFrameReader({
        maxFrameBytes: maxIpcFrameBytes,
        onFrame: (line: string) => {
          stderrExcerpt = appendStderrExcerpt(stderrExcerpt, line);
          log.warn({ stream: "stderr" }, `[plugin stderr] ${line}`);
        },
        onOversize: ({ bytesSeen, limit }) => {
          log.warn(
            {
              audit: "plugin.worker.ipc.oversize_frame",
              stream: "stderr",
              bytesSeen,
              limit,
            },
            "worker stderr line exceeded hard size cap; truncating",
          );
        },
      });
      child.stderr.on("data", (chunk: Buffer) => stderrReader.push(chunk));
    }

    // Handle process exit
    child.on("exit", (code, signal) => {
      handleProcessExit(code, signal);
    });

    // Handle process errors (e.g. spawn failure)
    child.on("error", (err) => {
      log.error({ err: err.message }, "worker process error");
      if (emitter.listenerCount("error") > 0) {
        emitter.emit("error", { pluginId, error: err });
      }
      if (status === "starting") {
        setStatus("crashed");
        rejectAllPending(
          new Error(formatWorkerFailureMessage(
            `Worker process failed to start: ${err.message}`,
            stderrExcerpt,
          )),
        );
      }
    });
  }

  function handleProcessExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const wasIntentional = intentionalStop;

    // The stdout/stderr readers are plain `data` listeners on the child's
    // streams, which are destroyed when the process exits — no explicit
    // teardown needed.
    childProcess = null;
    startedAt = null;

    // Reject all pending requests
    rejectAllPending(
      new Error(formatWorkerFailureMessage(
        `Worker process exited (code=${code}, signal=${signal})`,
        stderrExcerpt,
      )),
    );

    // Close the one login pseudo-terminal route with a fixed non-secret exit and
    // clear the route one time. The pending pseudo-terminal calls
    // already rejected through `rejectAllPending`.
    closeSetupTokenPtyRouteOnWorkerExit();

    // Emit synthetic close for any orphaned stream channels so SSE clients
    // are notified instead of hanging indefinitely.
    if (openStreamChannels.size > 0 && options.onStreamNotification) {
      for (const [channel, companyId] of openStreamChannels) {
        try {
          options.onStreamNotification("streams.close", { channel, companyId });
        } catch {
          // Best-effort cleanup — don't let it interfere with exit handling
        }
      }
      openStreamChannels.clear();
    }

    emitter.emit("exit", { pluginId, code, signal });

    if (wasIntentional) {
      // Graceful stop — status is already "stopping" or will be set to "stopped"
      setStatus("stopped");
      log.info({ code, signal }, "worker process stopped");
      return;
    }

    // Unexpected exit — crash recovery
    totalCrashes++;
    const now = Date.now();

    // Reset consecutive crash counter if enough time passed
    if (lastCrashAt !== null && now - lastCrashAt > CRASH_WINDOW_MS) {
      consecutiveCrashes = 0;
    }
    consecutiveCrashes++;
    lastCrashAt = now;

    log.error(
      { code, signal, consecutiveCrashes, totalCrashes },
      "worker process crashed",
    );

    const willRestart =
      autoRestart && consecutiveCrashes <= MAX_CONSECUTIVE_CRASHES;

    setStatus("crashed");
    emitter.emit("crash", { pluginId, code, signal, willRestart });

    if (willRestart) {
      scheduleRestart();
    } else {
      log.error(
        { consecutiveCrashes, maxCrashes: MAX_CONSECUTIVE_CRASHES },
        "max consecutive crashes reached, not restarting",
      );
    }
  }

  function rejectAllPending(error: Error): void {
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve(
        createErrorResponse(
          pending.id,
          PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
          error.message,
        ) as JsonRpcResponse,
      );
    }
    pendingRequests.clear();
    for (const invocation of activeInvocations.values()) {
      if (invocation.timer) clearTimeout(invocation.timer);
    }
    activeInvocations.clear();
  }

  // -----------------------------------------------------------------------
  // Crash recovery with exponential backoff
  // -----------------------------------------------------------------------

  function computeBackoffMs(): number {
    // Exponential backoff: MIN_BACKOFF * MULTIPLIER^(consecutiveCrashes - 1)
    const delay =
      MIN_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, consecutiveCrashes - 1);
    // Add jitter: ±25%
    const jitter = delay * 0.25 * (Math.random() * 2 - 1);
    return Math.min(Math.round(delay + jitter), MAX_BACKOFF_MS);
  }

  function scheduleRestart(): void {
    const delay = computeBackoffMs();
    nextRestartAt = Date.now() + delay;

    setStatus("backoff");

    log.info(
      { delayMs: delay, consecutiveCrashes },
      "scheduling restart with backoff",
    );

    backoffTimer = setTimeout(async () => {
      backoffTimer = null;
      nextRestartAt = null;
      try {
        await startInternal();
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "restart after backoff failed",
        );
      }
    }, delay);
  }

  function cancelPendingRestart(): void {
    if (backoffTimer !== null) {
      clearTimeout(backoffTimer);
      backoffTimer = null;
      nextRestartAt = null;
    }
  }

  // -----------------------------------------------------------------------
  // Start / Stop
  // -----------------------------------------------------------------------

  async function startInternal(): Promise<void> {
    if (status === "running" || status === "starting") {
      throw new Error(`Worker for plugin "${pluginId}" is already ${status}`);
    }

    intentionalStop = false;
    setStatus("starting");
    stderrExcerpt = "";

    const child = spawnProcess();
    childProcess = child;
    attachStdioHandlers(child);
    startedAt = Date.now();

    // Send the initialize RPC call
    const initParams: InitializeParams = {
      manifest: options.manifest,
      config: options.config,
      instanceInfo: options.instanceInfo,
      apiVersion: options.apiVersion,
      databaseNamespace: options.databaseNamespace ?? null,
    };

    try {
      const result = await callInternal(
        "initialize",
        initParams,
        INITIALIZE_TIMEOUT_MS,
      ) as
        | { ok?: boolean; supportedMethods?: string[]; echoesInvocationId?: boolean }
        | undefined;
      if (!result || !result.ok) {
        throw new Error("Worker initialize returned ok=false");
      }
      supportedMethods = result.supportedMethods ?? [];
      echoesInvocationId = result.echoesInvocationId === true;
    } catch (err) {
      // Initialize failed — kill the process and propagate
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "worker initialize failed");
      await killProcess();
      setStatus("crashed");
      throw new Error(`Worker initialize failed for "${pluginId}": ${msg}`);
    }

    // Reset crash counter on successful start
    consecutiveCrashes = 0;
    setStatus("running");
    emitter.emit("ready", { pluginId });
    log.info({ pid: child.pid }, "worker process started and initialized");
  }

  async function stopInternal(): Promise<void> {
    cancelPendingRestart();

    if (status === "stopped" || status === "stopping") {
      return;
    }

    intentionalStop = true;
    setStatus("stopping");

    if (!childProcess) {
      setStatus("stopped");
      return;
    }

    // Step 1: Send shutdown RPC and wait for the worker to exit gracefully.
    // We race the shutdown call against a timeout. The worker should process
    // the shutdown and exit on its own within the drain period.
    try {
      await Promise.race([
        callInternal("shutdown", {} as Record<string, never>, SHUTDOWN_DRAIN_MS),
        waitForExit(SHUTDOWN_DRAIN_MS),
      ]);
    } catch {
      // Shutdown call failed or timed out — proceed to kill
      log.warn("shutdown RPC failed or timed out, escalating to SIGTERM");
    }

    // Give the process a brief moment to exit after the shutdown response
    if (childProcess) {
      await waitForExit(500);
    }

    // Check if process already exited
    if (!childProcess) {
      setStatus("stopped");
      return;
    }

    // Step 2: Send SIGTERM and wait
    log.info("worker did not exit after shutdown RPC, sending SIGTERM");
    await killWithSignal("SIGTERM", SIGTERM_GRACE_MS);

    if (!childProcess) {
      setStatus("stopped");
      return;
    }

    // Step 3: Forcefully kill with SIGKILL
    log.warn("worker did not exit after SIGTERM, sending SIGKILL");
    await killWithSignal("SIGKILL", 2_000);

    if (childProcess) {
      log.error("worker process still alive after SIGKILL — this should not happen");
    }

    setStatus("stopped");
  }

  /**
   * Wait for the child process to exit, up to `timeoutMs`.
   * Resolves immediately if the process is already gone.
   */
  function waitForExit(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!childProcess) {
        resolve();
        return;
      }

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve();
      }, timeoutMs);

      childProcess.once("exit", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function killWithSignal(
    signal: NodeJS.Signals,
    waitMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!childProcess) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        resolve();
      }, waitMs);

      childProcess.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });

      try {
        childProcess.kill(signal);
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  /**
   * SECURITY-CRITICAL: SIGKILL a worker that sent an oversized IPC frame. Deliberately
   * does NOT set `intentionalStop`, so {@link handleProcessExit} treats the
   * death as a crash and the normal exponential-backoff / consecutive-crash
   * ceiling applies — a worker that keeps emitting oversized frames is
   * eventually abandoned rather than restarted forever.
   */
  function terminateForOversizeFrame(): void {
    if (!childProcess) return;
    try {
      childProcess.kill("SIGKILL");
    } catch {
      // Process may already be dead.
    }
  }

  async function killProcess(): Promise<void> {
    if (!childProcess) return;
    intentionalStop = true;
    try {
      childProcess.kill("SIGKILL");
    } catch {
      // Process may already be dead
    }
    // Wait briefly for exit event
    await new Promise<void>((resolve) => {
      if (!childProcess) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        resolve();
      }, 1_000);
      childProcess.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // -----------------------------------------------------------------------
  // RPC call implementation
  // -----------------------------------------------------------------------

  function callInternal<M extends HostToWorkerMethodName>(
    method: M,
    params: HostToWorkerMethods[M][0],
    timeoutMs?: number,
    executeLogSink?: ExecuteLogSink,
  ): Promise<HostToWorkerMethods[M][1]> {
    const rpcPromise = new Promise<HostToWorkerMethods[M][1]>((resolve, reject) => {
      if (!childProcess?.stdin?.writable) {
        reject(
          new Error(
            `Cannot call "${method}" — worker for "${pluginId}" is not running`,
          ),
        );
        return;
      }

      const id = nextRequestId++;
      const timeout = resolveRpcCallTimeoutMs(timeoutMs, rpcTimeoutMs);
      const invocationScope = deriveInvocationScope(method, params);
      const invocation = invocationScope ? registerInvocation(invocationScope, undefined, method) : null;
      // Register the host-owned execute route only for an execute call that
      // carries a log sink. The company id comes from the host-derived
      // invocation scope, never from the worker. This binds the sink to the
      // exact company for the life of the call.
      if (invocation && invocationScope && executeLogSink && method === "environmentExecute") {
        registerExecuteRoute(invocation.id, invocationScope.companyId, executeLogSink);
      }

      // Guard against double-settlement. When a process exits all pending
      // requests are rejected via rejectAllPending(), but the timeout timer
      // may still be running. Without this guard the timer's reject fires on
      // an already-settled promise, producing an unhandled rejection.
      let settled = false;

      const settle = <T>(fn: (value: T) => void, value: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingRequests.delete(id);
        clearInvocation(invocation);
        clearExecuteRoute(invocation?.id);
        fn(value);
      };

      const timer = setTimeout(() => {
        settle(
          reject,
          new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.TIMEOUT,
            message: `RPC call "${method}" timed out after ${timeout}ms`,
          }),
        );
      }, timeout);

      const pending: PendingRequest = {
        id,
        method,
        resolve: (response: JsonRpcResponse) => {
          if (isJsonRpcSuccessResponse(response)) {
            settle(resolve, response.result as HostToWorkerMethods[M][1]);
          } else if ("error" in response && response.error) {
            settle(reject, new JsonRpcCallError(response.error));
          } else {
            settle(reject, new Error(`Unexpected response format for "${method}"`));
          }
        },
        timer,
        sentAt: Date.now(),
        invocationId: invocation?.id,
      };

      pendingRequests.set(id, pending);

      try {
        const request = {
          ...createRequest(method, params, id),
          ...(invocation ? { paperclipInvocation: invocation } : {}),
        };
        sendMessage(request);
      } catch (err) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        clearInvocation(invocation);
        clearExecuteRoute(invocation?.id);
        reject(
          new Error(
            `Failed to send "${method}" to worker: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }
    });

    // Some call sites hand these promises across async boundaries before
    // attaching their own handlers. Mark the promise as handled here so a
    // worker-side JSON-RPC error can fail the caller without killing the host
    // process via an unhandled rejection.
    void rpcPromise.catch(() => undefined);

    return rpcPromise;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  const handle: PluginWorkerHandle = {
    get pluginId() {
      return pluginId;
    },

    get serviceRunId() {
      return serviceRunId;
    },

    get status() {
      return status;
    },

    get supportedMethods() {
      return supportedMethods;
    },

    async start() {
      await startInternal();
    },

    async stop() {
      await stopInternal();
    },

    async restart() {
      await stopInternal();
      await startInternal();
    },

    call<M extends HostToWorkerMethodName>(
      method: M,
      params: HostToWorkerMethods[M][0],
      timeoutMs?: number,
      executeLogSink?: ExecuteLogSink,
    ): Promise<HostToWorkerMethods[M][1]> {
      if (status !== "running" && status !== "starting") {
        return Promise.reject(
          new Error(
            `Cannot call "${method}" — worker for "${pluginId}" is ${status}`,
          ),
        );
      }
      return callInternal(method, params, timeoutMs, executeLogSink);
    },

    openSetupTokenPtySession(input: SetupTokenPtyOpenInput) {
      if (status !== "running" && status !== "starting") {
        return Promise.reject(
          new Error(
            `Cannot open a login pseudo-terminal — worker for "${pluginId}" is ${status}`,
          ),
        );
      }
      return openSetupTokenPtySession(input);
    },

    notify(method: string, params: unknown) {
      if (status !== "running") return;
      const invocationScope = deriveInvocationScope(method, params);
      const invocation = invocationScope ? registerInvocation(invocationScope, MAX_RPC_TIMEOUT_MS, method) : null;
      try {
        sendMessage({
          jsonrpc: JSONRPC_VERSION,
          method,
          params,
          ...(invocation ? { paperclipInvocation: invocation } : {}),
        });
      } catch {
        clearInvocation(invocation);
        log.warn({ method }, "failed to send notification to worker");
      }
    },

    on<K extends WorkerHandleEventName>(
      event: K,
      listener: (payload: WorkerHandleEvents[K]) => void,
    ) {
      emitter.on(event, listener);
    },

    off<K extends WorkerHandleEventName>(
      event: K,
      listener: (payload: WorkerHandleEvents[K]) => void,
    ) {
      emitter.off(event, listener);
    },

    setProactiveCompanyScopes(companyIds: readonly string[]): void {
      proactiveCompanyScopes.clear();
      for (const id of companyIds) {
        const trimmed = readNonEmptyString(id);
        if (trimmed) proactiveCompanyScopes.add(trimmed);
      }
    },

    diagnostics(): WorkerDiagnostics {
      return {
        pluginId,
        status,
        pid: childProcess?.pid ?? null,
        uptime:
          startedAt !== null && status === "running"
            ? Date.now() - startedAt
            : null,
        consecutiveCrashes,
        totalCrashes,
        pendingRequests: pendingRequests.size,
        lastCrashAt,
        nextRestartAt,
      };
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Implementation: createPluginWorkerManager
// ---------------------------------------------------------------------------

/**
 * Options for creating a PluginWorkerManager.
 */
export interface PluginWorkerManagerOptions {
  /**
   * Optional callback invoked when a worker emits a lifecycle event
   * (crash, restart). Used by the server to publish global live events.
   */
  onWorkerEvent?: (event: {
    type: "plugin.worker.crashed" | "plugin.worker.restarted";
    pluginId: string;
    code?: number | null;
    signal?: string | null;
    willRestart?: boolean;
  }) => void;
  /**
   * SECURITY-CRITICAL: shared run-context registry. When provided, the manager registers
   * each worker's host-minted service run-context (`handle.serviceRunId`) as a
   * system actor for the worker's lifetime, so background dispatches and
   * `setup()`-started loops can resolve secrets. Deregistered on stop.
   */
  runContextRegistry?: PluginRunContextRegistry;
}

/**
 * Create a new PluginWorkerManager.
 *
 * The manager holds all plugin worker handles and provides a unified API for
 * starting, stopping, and communicating with plugin workers.
 *
 * @example
 * ```ts
 * const manager = createPluginWorkerManager();
 *
 * const handle = await manager.startWorker("acme.linear", {
 *   entrypointPath: "/path/to/worker.cjs",
 *   manifest,
 *   config: resolvedConfig,
 *   instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
 *   apiVersion: 1,
 *   hostHandlers: { "config.get": async () => resolvedConfig, ... },
 * });
 *
 * // Send RPC call to the worker
 * const health = await manager.call("acme.linear", "health", {});
 *
 * // Shutdown all workers on server exit
 * await manager.stopAll();
 * ```
 */
export function createPluginWorkerManager(
  managerOptions?: PluginWorkerManagerOptions,
): PluginWorkerManager {
  const log = logger.child({ service: "plugin-worker-manager" });
  const workers = new Map<string, PluginWorkerHandle>();
  /** Per-plugin startup locks to prevent concurrent spawn races. */
  const startupLocks = new Map<string, Promise<PluginWorkerHandle>>();

  return {
    async startWorker(
      pluginId: string,
      options: WorkerStartOptions,
    ): Promise<PluginWorkerHandle> {
      // Mutex: if a start is already in-flight for this plugin, wait for it
      const inFlight = startupLocks.get(pluginId);
      if (inFlight) {
        log.warn({ pluginId }, "concurrent startWorker call — waiting for in-flight start");
        return inFlight;
      }

      const existing = workers.get(pluginId);
      if (existing && existing.status !== "stopped") {
        throw new Error(
          `Worker already registered for plugin "${pluginId}" (status: ${existing.status})`,
        );
      }

      const handle = createPluginWorkerHandle(pluginId, options, {
        runContextRegistry: managerOptions?.runContextRegistry,
      });
      workers.set(pluginId, handle);

      // SECURITY-CRITICAL: register the worker-lifetime service run-context so background
      // dispatches / setup() loops can resolve secrets (system actor). Stable
      // across crash/auto-restart of this handle; removed on stop. The runId is
      // host-minted — it grants no company scope (company is derived from the
      // operator-created secret binding at resolve time).
      // Observability: make the registration (and any missing-registry
      // misconfiguration) visible. A `registryWired: false` line here means the
      // manager was built without a registry, so service run-contexts will not
      // be resolvable by the secrets handler (a wiring bug).
      const registry = managerOptions?.runContextRegistry;
      if (registry) {
        registry.registerService(pluginId, handle.serviceRunId);
        log.info(
          { pluginId, serviceRunId: handle.serviceRunId, registryWired: true },
          "registered worker-lifetime service run-context",
        );
      } else {
        log.warn(
          { pluginId, serviceRunId: handle.serviceRunId, registryWired: false },
          "no run-context registry wired into worker manager; service/setup() secret resolves will fail",
        );
      }

      // Subscribe to crash/ready events for live event forwarding
      if (managerOptions?.onWorkerEvent) {
        const notify = managerOptions.onWorkerEvent;
        handle.on("crash", (payload) => {
          notify({
            type: "plugin.worker.crashed",
            pluginId: payload.pluginId,
            code: payload.code,
            signal: payload.signal,
            willRestart: payload.willRestart,
          });
        });
        handle.on("ready", (payload) => {
          // Only emit restarted if this was a crash recovery (totalCrashes > 0)
          const diag = handle.diagnostics();
          if (diag.totalCrashes > 0) {
            notify({
              type: "plugin.worker.restarted",
              pluginId: payload.pluginId,
            });
          }
        });
      }

      log.info({ pluginId }, "starting plugin worker");

      // Set the lock before awaiting start() to prevent concurrent spawns
      const startPromise = handle.start().then(() => handle).finally(() => {
        startupLocks.delete(pluginId);
      });
      startupLocks.set(pluginId, startPromise);

      return startPromise;
    },

    async stopWorker(pluginId: string): Promise<void> {
      const handle = workers.get(pluginId);
      if (!handle) {
        log.warn({ pluginId }, "no worker registered for plugin, nothing to stop");
        return;
      }

      log.info({ pluginId }, "stopping plugin worker");
      await handle.stop();
      managerOptions?.runContextRegistry?.deregister(pluginId, handle.serviceRunId);
      // SECURITY-CRITICAL: the service runId is TTL-exempt in the redaction map,
      // so without this its resolved plaintext would linger for the process
      // lifetime (lazy prune only). Clear it on stop.
      clearRunSecretValues(handle.serviceRunId);
      workers.delete(pluginId);
    },

    getWorker(pluginId: string): PluginWorkerHandle | undefined {
      return workers.get(pluginId);
    },

    isRunning(pluginId: string): boolean {
      const handle = workers.get(pluginId);
      return handle?.status === "running";
    },

    setProactiveCompanyScopes(pluginId: string, companyIds: readonly string[]): void {
      workers.get(pluginId)?.setProactiveCompanyScopes(companyIds);
    },

    async stopAll(): Promise<void> {
      log.info({ count: workers.size }, "stopping all plugin workers");
      const promises = Array.from(workers.values()).map(async (handle) => {
        try {
          await handle.stop();
          managerOptions?.runContextRegistry?.deregister(handle.pluginId, handle.serviceRunId);
          clearRunSecretValues(handle.serviceRunId);
        } catch (err) {
          log.error(
            {
              pluginId: handle.pluginId,
              err: err instanceof Error ? err.message : String(err),
            },
            "error stopping worker during shutdown",
          );
        }
      });
      await Promise.all(promises);
      workers.clear();
    },

    diagnostics(): WorkerDiagnostics[] {
      return Array.from(workers.values()).map((h) => h.diagnostics());
    },

    call<M extends HostToWorkerMethodName>(
      pluginId: string,
      method: M,
      params: HostToWorkerMethods[M][0],
      timeoutMs?: number,
      executeLogSink?: ExecuteLogSink,
    ): Promise<HostToWorkerMethods[M][1]> {
      const handle = workers.get(pluginId);
      if (!handle) {
        return Promise.reject(
          new Error(`No worker registered for plugin "${pluginId}"`),
        );
      }
      return handle.call(method, params, timeoutMs, executeLogSink);
    },

    openSetupTokenPtySession(pluginId: string, input: SetupTokenPtyOpenInput) {
      const handle = workers.get(pluginId);
      if (!handle) {
        return Promise.reject(
          new Error(`No worker registered for plugin "${pluginId}"`),
        );
      }
      return handle.openSetupTokenPtySession(input);
    },
  };
}
