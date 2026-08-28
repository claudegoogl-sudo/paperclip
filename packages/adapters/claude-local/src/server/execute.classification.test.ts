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

import { execute } from "./execute.js";

const MODEL = "claude-sonnet-4-6";

// A run that did its work and emitted a clean success envelope, then exited
// non-zero (143 = SIGTERM during teardown). The transcript body includes
// auth-regex-matching assistant prose — exactly the false-positive pattern
// this fix targets: pre-fix, the raw stdout scan flipped this to
// `claude_auth_required`.
function cleanExitWithAuthTextProc(sessionId = "sess-clean"): {
  exitCode: number;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid: number;
  startedAt: string;
} {
  return {
    exitCode: 143,
    signal: "SIGTERM",
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: MODEL }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "Inspecting the auth flow: the response was unauthorized, so the user must run `claude login` to refresh the token.",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: sessionId,
        result: "Shipped the prevention gate for the auth-detector fix.",
        model: MODEL,
        usage: { input_tokens: 4, cache_read_input_tokens: 0, output_tokens: 4 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 321,
    startedAt: new Date().toISOString(),
  };
}

// A genuine auth-required run: the CLI failed before emitting a structured
// result, and the only signal lives in raw stderr. The `!parsed` branch must
// still flag this as auth-required.
function genuineAuthFailureProc(): {
  exitCode: number;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid: number;
  startedAt: string;
} {
  return {
    exitCode: 2,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "Invalid API key · Please run /login",
    pid: 322,
    startedAt: new Date().toISOString(),
  };
}

async function runExecute(cleanupDirs: string[]) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-classify-"));
  cleanupDirs.push(rootDir);
  const workspaceDir = path.join(rootDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });

  return execute({
    runId: "run-classify",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      // These tests pin CLI-semantics via the mocked runChildProcess; the
      // merged adapter default (auto, ACP-preferred) would reroute them onto
      // the ACP executor, which the mock never sees.
      adapterConfig: { engine: "cli" },
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      engine: "cli",
      command: "claude",
      model: MODEL,
    },
    context: {
      paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
    },
    onLog: async () => {},
  });
}

describe("claude_local run classification", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // Positive control: a clean success envelope (is_error:false, subtype:success)
  // that exits 143 during teardown must classify as `succeeded_dirty`, NOT as
  // `failed`/`claude_auth_required`, even when the transcript body contains
  // auth-regex-matching text. Pre-fix, the raw-stdout scan inside
  // detectClaudeLoginRequired flipped this to claude_auth_required.
  it("clean success + auth-text in transcript + exit 143 → succeeded_dirty, not claude_auth_required", async () => {
    runChildProcess.mockResolvedValueOnce(cleanExitWithAuthTextProc());

    const result = await runExecute(cleanupDirs);

    expect(result.completedDirty).toBe(true);
    expect(result.errorCode).toBe("dirty_exit");
    expect(result.errorCode).not.toBe("claude_auth_required");
    // The clean envelope's result text survives into the merged result json
    // so the operator can see what the agent actually did.
    expect(result.resultJson?.subtype).toBe("success");
    expect(result.resultJson?.is_error).toBe(false);
    expect((result.resultJson?.dirtyExit as { exitCode?: unknown } | undefined)?.exitCode).toBe(143);
  });

  // Genuine auth failure (AC 4): when the CLI fails before emitting a
  // structured result and the only signal is raw stderr, the `!parsed` branch
  // of detectClaudeLoginRequired must still classify it as auth-required.
  it("genuine auth failure with no structured envelope → claude_auth_required", async () => {
    runChildProcess.mockResolvedValueOnce(genuineAuthFailureProc());

    const result = await runExecute(cleanupDirs);

    // The no-envelope early-return path does not populate `completedDirty`
    // (it is only set on the envelope path). The meaningful assertion is
    // that the run is classified as auth-required, not as a success/dirty.
    expect(result.errorCode).toBe("claude_auth_required");
    expect(result.resultJson?.subtype).toBeUndefined();
  });
});
