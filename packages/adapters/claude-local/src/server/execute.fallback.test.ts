import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

import { execute, isAllowedFallbackModel, isSafeguardsLiftedModel } from "./execute.js";

const PRIMARY_MODEL = "claude-fable-5";
const FALLBACK_MODEL = "claude-opus-4-8";

function refusalProc(sessionId = "sess-refusal") {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: PRIMARY_MODEL }),
      JSON.stringify({
        type: "result",
        subtype: "model_refusal",
        is_error: false,
        session_id: sessionId,
        result: "I can't help with that.",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 111,
    startedAt: new Date().toISOString(),
  };
}

function successProc(model: string, sessionId = "sess-success") {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model }),
      JSON.stringify({
        type: "result",
        is_error: false,
        session_id: sessionId,
        result: "done",
        model,
        usage: { input_tokens: 2, cache_read_input_tokens: 0, output_tokens: 2 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 222,
    startedAt: new Date().toISOString(),
  };
}

async function runExecute(adapterConfigModel: {
  model: string;
  fallbackModel?: string;
}, cleanupDirs: string[]) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-fallback-"));
  cleanupDirs.push(rootDir);
  const workspaceDir = path.join(rootDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });

  return execute({
    runId: "run-fallback",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      command: "claude",
      model: adapterConfigModel.model,
      ...(adapterConfigModel.fallbackModel ? { fallbackModel: adapterConfigModel.fallbackModel } : {}),
    },
    context: {
      paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
    },
    onLog: async () => {},
  });
}

function modelArgOf(call: unknown): string | undefined {
  const args = (call as [string, string, string[]] | undefined)?.[2] ?? [];
  const idx = args.indexOf("--model");
  return idx >= 0 ? args[idx + 1] : undefined;
}

describe("claude_local fallback-on-refusal", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("allowlist: accepts a known standard model, rejects unknown + safeguards-lifted", () => {
    expect(isAllowedFallbackModel("claude-opus-4-8")).toBe(true);
    expect(isAllowedFallbackModel("claude-mythos-5")).toBe(false);
    expect(isAllowedFallbackModel("not-a-real-model")).toBe(false);
    expect(isAllowedFallbackModel("")).toBe(false);
    expect(isSafeguardsLiftedModel("claude-mythos-5")).toBe(true);
    expect(isSafeguardsLiftedModel("us.anthropic.claude-mythos-5-v1")).toBe(true);
    expect(isSafeguardsLiftedModel("claude-opus-4-8")).toBe(false);
  });

  it("structured safeguardsLifted flag rejects a fallback target even when its id has no known keyword", () => {
    // A future safeguards-lifted model whose id contains neither "mythos" nor
    // any denylist entry. The name-based checks alone would allowlist it; the
    // structured registry flag must reject it (fail-secure-on-omission).
    const registry = [
      { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
      { id: "claude-nextgen-x", label: "Claude NextGen X", safeguardsLifted: true },
    ];

    expect(isSafeguardsLiftedModel("claude-nextgen-x", registry)).toBe(true);
    expect(isAllowedFallbackModel("claude-nextgen-x", registry)).toBe(false);
    // A non-flagged known model in the same registry stays allowed.
    expect(isAllowedFallbackModel("claude-opus-4-8", registry)).toBe(true);
    // Sanity: without the flag, that id would have been allowed.
    expect(isAllowedFallbackModel("claude-nextgen-x", [{ id: "claude-nextgen-x", label: "X" }])).toBe(true);
    // Real registry: claude-mythos-5 is flagged in src/index.ts, still rejected.
    expect(isSafeguardsLiftedModel("claude-mythos-5")).toBe(true);
    expect(isAllowedFallbackModel("claude-mythos-5")).toBe(false);
  });

  it("refusal + fallbackModel set → exactly one fallback attempt on the fallback model, returns its result", async () => {
    runChildProcess
      .mockResolvedValueOnce(refusalProc())
      .mockResolvedValueOnce(successProc(FALLBACK_MODEL));

    const result = await runExecute({ model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL }, cleanupDirs);

    expect(runChildProcess).toHaveBeenCalledTimes(2);
    expect(modelArgOf(runChildProcess.mock.calls[0])).toBe(PRIMARY_MODEL);
    expect(modelArgOf(runChildProcess.mock.calls[1])).toBe(FALLBACK_MODEL);
    // Returned result is the fallback success, not the refusal.
    expect(result.errorCode).not.toBe("claude_refusal");
    expect(result.model).toBe(FALLBACK_MODEL);
    expect(result.resultJson?.fallbackModelUsed).toBe(true);
    expect(result.resultJson?.primaryRefused).toBe(true);
    expect(result.resultJson?.fallbackModel).toBe(FALLBACK_MODEL);
  });

  it("no fallbackModel → surfaces the refusal as today (single attempt)", async () => {
    runChildProcess.mockResolvedValueOnce(refusalProc());

    const result = await runExecute({ model: PRIMARY_MODEL }, cleanupDirs);

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(result.errorCode).toBe("claude_refusal");
    expect(result.resultJson?.fallbackModelUsed).toBeUndefined();
  });

  it("claude-mythos-5 as fallbackModel → rejected, never invoked, refusal surfaces", async () => {
    runChildProcess.mockResolvedValueOnce(refusalProc());

    const result = await runExecute({ model: PRIMARY_MODEL, fallbackModel: "claude-mythos-5" }, cleanupDirs);

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(result.errorCode).toBe("claude_refusal");
    for (const call of runChildProcess.mock.calls) {
      expect(modelArgOf(call)).not.toBe("claude-mythos-5");
    }
  });

  it("fallbackModel equal to primary → no fallback attempt", async () => {
    runChildProcess.mockResolvedValueOnce(refusalProc());

    const result = await runExecute({ model: PRIMARY_MODEL, fallbackModel: PRIMARY_MODEL }, cleanupDirs);

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(result.errorCode).toBe("claude_refusal");
  });

  it("one-shot only: if the fallback attempt also refuses, surface it without looping", async () => {
    runChildProcess
      .mockResolvedValueOnce(refusalProc("sess-primary"))
      .mockResolvedValueOnce(refusalProc("sess-fallback"));

    const result = await runExecute({ model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL }, cleanupDirs);

    expect(runChildProcess).toHaveBeenCalledTimes(2);
    expect(result.errorCode).toBe("claude_refusal");
  });
});
