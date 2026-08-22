import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

/**
 * Wiring regression test for the critical child-process env-exfil fix.
 *
 * `execute()` builds a least-privilege child env (allowlist + userEnv +
 * buildPaperclipEnv + PAPERCLIP_* injections) and MUST call `runChildProcess`
 * with `inheritServerEnv: false` so the shared runner does not re-merge the
 * full server `process.env` underneath it. Without that flag the runner
 * defaults to inheriting the server env (minus PAPERCLIP_*), re-leaking every
 * non-PAPERCLIP_ secret to a child that may run on a prompt-logging provider.
 *
 * This test captures the exact opts passed to `runChildProcess` and asserts:
 *  - `inheritServerEnv === false` (the fix line — drop it and this fails)
 *  - the least-privilege `env` excludes an unrelated server secret
 *  - the agent's own userEnv key and PAPERCLIP_API_KEY are present
 *  - PATH/HOME pass through
 */

const runChildProcess = vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: "",
  stderr: "",
  pid: 1234,
  startedAt: "2026-01-01T00:00:00.000Z",
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importActual) => {
  const actual = await importActual<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return { ...actual, runChildProcess };
});

// Import AFTER the mock is registered so execute() picks up the spy.
const { execute } = await import("./execute.js");

const LEAK_KEY = "PLA3808_TEST_SERVER_SECRET";

function makeCtx(config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "pc-run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: config,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: { issueId: "issue-1", wakeReason: "manual" },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    // authToken is read off ctx and injected as PAPERCLIP_API_KEY.
    authToken: "pat-agent-least-privilege",
  } as unknown as AdapterExecutionContext;
}

describe("hermes execute() child-env wiring", () => {
  beforeEach(() => {
    runChildProcess.mockClear();
    process.env[LEAK_KEY] = "should-never-reach-child";
  });

  afterEach(() => {
    delete process.env[LEAK_KEY];
    vi.restoreAllMocks();
  });

  it("calls runChildProcess with inheritServerEnv:false and a secret-free env", async () => {
    const ctx = makeCtx({
      cwd: process.cwd(),
      env: { OPENROUTER_API_KEY: "sk-or-agent-own-key" },
    });

    await execute(ctx);

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const opts = runChildProcess.mock.calls[0][3] as {
      env: Record<string, string>;
      inheritServerEnv?: boolean;
    };

    // The fix line: server-env inheritance is explicitly disabled.
    expect(opts.inheritServerEnv).toBe(false);

    // The unrelated server secret is not in the least-privilege env.
    expect(opts.env[LEAK_KEY]).toBeUndefined();

    // The agent's own bound key and least-privilege token ARE present.
    expect(opts.env.OPENROUTER_API_KEY).toBe("sk-or-agent-own-key");
    expect(opts.env.PAPERCLIP_API_KEY).toBe("pat-agent-least-privilege");

    // Non-secret runtime essentials pass through the allowlist.
    expect(typeof opts.env.PATH).toBe("string");
    expect((opts.env.PATH ?? "").length).toBeGreaterThan(0);
  });
});
