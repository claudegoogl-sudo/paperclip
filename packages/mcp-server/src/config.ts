export interface PaperclipMcpConfig {
  apiUrl: string;
  apiKey: string;
  companyId: string | null;
  agentId: string | null;
  runId: string | null;
  /** Hard wall-clock ceiling for a single outbound API request (ms). */
  fetchTimeoutMs?: number;
  /** Hard wall-clock ceiling for a single MCP tool-call dispatch (ms). */
  toolTimeoutMs?: number;
}

/** Default per-request fetch deadline (ms). Overridable via PAPERCLIP_MCP_FETCH_TIMEOUT_MS. */
export const DEFAULT_MCP_FETCH_TIMEOUT_MS = 60_000;
/** Default per-tool-call dispatch deadline (ms). Overridable via PAPERCLIP_MCP_TOOL_TIMEOUT_MS. */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 120_000;

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function positiveIntEnv(value: string | undefined, fallback: number): number {
  const raw = nonEmpty(value);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeApiUrl(apiUrl: string): string {
  const trimmed = stripTrailingSlash(apiUrl.trim());
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PaperclipMcpConfig {
  const apiUrl = nonEmpty(env.PAPERCLIP_API_URL);
  if (!apiUrl) {
    throw new Error("Missing PAPERCLIP_API_URL");
  }
  const apiKey = nonEmpty(env.PAPERCLIP_API_KEY);
  if (!apiKey) {
    throw new Error("Missing PAPERCLIP_API_KEY");
  }

  return {
    apiUrl: normalizeApiUrl(apiUrl),
    apiKey,
    companyId: nonEmpty(env.PAPERCLIP_COMPANY_ID),
    agentId: nonEmpty(env.PAPERCLIP_AGENT_ID),
    runId: nonEmpty(env.PAPERCLIP_RUN_ID),
    fetchTimeoutMs: positiveIntEnv(env.PAPERCLIP_MCP_FETCH_TIMEOUT_MS, DEFAULT_MCP_FETCH_TIMEOUT_MS),
    toolTimeoutMs: positiveIntEnv(env.PAPERCLIP_MCP_TOOL_TIMEOUT_MS, DEFAULT_MCP_TOOL_TIMEOUT_MS),
  };
}
