import { formatErrorResponse } from "./format.js";

type McpTextResponse = {
  content: Array<{ type: "text"; text: string }>;
};

type ToolExecute = (input: Record<string, unknown>) => Promise<McpTextResponse>;

/**
 * Extra headroom added on top of a per-call `timeoutSeconds` so the generic
 * dispatch deadline never fires before a tool's own honored wait completes.
 */
const DEADLINE_GRACE_MS = 5_000;

function readTimeoutSecondsOverride(input: Record<string, unknown> | undefined): number | null {
  const raw = input?.["timeoutSeconds"];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * Resolve the effective dispatch deadline for a tool call. Honors an optional
 * per-call `timeoutSeconds` (as `tools.ts` exposes) by extending — never
 * shortening — the default ceiling.
 */
export function resolveToolDeadlineMs(
  input: Record<string, unknown> | undefined,
  defaultTimeoutMs: number,
): number {
  const perCall = readTimeoutSecondsOverride(input);
  if (perCall == null) return defaultTimeoutMs;
  return Math.max(defaultTimeoutMs, perCall * 1000 + DEADLINE_GRACE_MS);
}

/**
 * Wrap a tool's execute with a dispatch deadline. If the underlying call does
 * not settle within the deadline the race resolves to a clear tool error
 * instead of hanging, so the model's turn continues and the run can terminate
 * normally (releasing its execution lock). The in-flight I/O itself is aborted
 * at the fetch layer (see the AbortController in `client.ts`).
 */
export function withToolDeadline(
  toolName: string,
  execute: ToolExecute,
  defaultTimeoutMs: number,
): ToolExecute {
  return async (input) => {
    const timeoutMs = resolveToolDeadlineMs(input, defaultTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(`MCP tool "${toolName}" exceeded ${timeoutMs}ms deadline and was aborted`),
        );
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    try {
      return await Promise.race([execute(input), deadline]);
    } catch (error) {
      return formatErrorResponse(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
