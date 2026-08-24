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
      // Pin to an internal (allowlisted) provider. This test exercises the
      // env-inheritance / least-privilege path, which is orthogonal to the
      // bound-key posture; under the default-deny key logic an unresolved
      // provider ("auto") fails closed before reaching runChildProcess, so we
      // must select a provider that keeps the authToken-fallback path live.
      provider: "anthropic",
      env: { OPENROUTER_API_KEY: "sk-or-agent-own-key" },
    });

    await execute(ctx);

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const opts = (runChildProcess.mock.calls[0] as unknown[])[3] as {
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

/**
 * execute()-level regression for the hermes bound-key wiring.
 *
 * The unit tests for `resolveSpawnApiKey` (paperclip-task-bridge.test.ts) cover
 * the helper in isolation. These tests cover the *call-site wiring* inside
 * `execute()` that the helper depends on:
 *
 *  1. `boundBridgeKey` is read from `config.env` (userEnv) ONLY — never from the
 *     merged `env` (which spreads `allowlistedProcessEnv()` / process.env) nor
 *     from a stray host `process.env.PAPERCLIP_API_KEY`. A host key must not be
 *     mistaken for an operator-bound task_bridge key and must not downgrade the
 *     fail-closed behavior for an external-logging target.
 *  2. The `else { delete env.PAPERCLIP_API_KEY }` scrub actually fires, so when
 *     nothing is authorized to inject, no stray value survives into the child
 *     env — even if one leaked in via the base env.
 *
 * Vulnerability class: Sensitive Information Disclosure / Excessive Agency
 * (OWASP LLM06 / broad credential leak into a prompt-logging upstream).
 * Synthetic fixtures only — no live keys.
 */
describe("hermes execute() bound-key wiring", () => {
  const HOST_STRAY_KEY = "pat-host-stray-NEVER-a-bound-key";

  beforeEach(() => {
    runChildProcess.mockClear();
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_API_KEY;
    vi.restoreAllMocks();
  });

  it("fails closed for an external-logging target even when a stray host process.env.PAPERCLIP_API_KEY is set (host key is never the bound key)", async () => {
    // A stray broad key in the server's own env must NOT be treated as the
    // operator-bound task_bridge key. boundBridgeKey reads config.env only.
    process.env.PAPERCLIP_API_KEY = HOST_STRAY_KEY;

    const ctx = makeCtx({
      cwd: process.cwd(),
      provider: "openrouter", // external-logging target
      // NOTE: adapterConfig.env has NO PAPERCLIP_API_KEY / PAPERCLIP_BRIDGE_API_KEY.
      // ctx.authToken (the broad run-scoped key) is set by makeCtx, mirroring reality.
    });

    // Fail closed: refuse to spawn rather than leak a broad key upstream.
    await expect(execute(ctx)).rejects.toThrow(/Refusing to spawn/i);
    // The child is never spawned.
    expect(runChildProcess).not.toHaveBeenCalled();
  });

  it("spawns an external-logging target using the operator-bound PAPERCLIP_BRIDGE_API_KEY from config.env (bound key wins)", async () => {
    // The server delivers the operator-bound task_bridge credential into
    // adapterConfig.env.PAPERCLIP_BRIDGE_API_KEY. It must authorize an external
    // provider and be injected as the child's PAPERCLIP_API_KEY.
    const ctx = makeCtx({
      cwd: process.cwd(),
      provider: "openrouter", // external-logging target
      env: { PAPERCLIP_BRIDGE_API_KEY: "pat-operator-bound-task-bridge" },
    });

    await execute(ctx);

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const opts = (runChildProcess.mock.calls[0] as unknown[])[3] as {
      env: Record<string, string>;
    };
    expect(opts.env.PAPERCLIP_API_KEY).toBe("pat-operator-bound-task-bridge");
  });

  it("does NOT accept config.env.PAPERCLIP_API_KEY as the bridge key — external target still fails closed (INV-6)", async () => {
    // The PAPERCLIP_API_KEY fallback was removed: only PAPERCLIP_BRIDGE_API_KEY is
    // a bound key. A PAPERCLIP_API_KEY in adapterConfig.env must not smuggle the
    // run-identity slot into the bridge path for a non-allowlisted provider.
    const ctx = makeCtx({
      cwd: process.cwd(),
      provider: "openrouter", // external-logging target
      env: { PAPERCLIP_API_KEY: "pat-not-a-bridge-key" },
    });

    await expect(execute(ctx)).rejects.toThrow(/Refusing to spawn/i);
    expect(runChildProcess).not.toHaveBeenCalled();
  });

  it("scrubs PAPERCLIP_API_KEY from the child env for an internal provider with no bound key and no authToken", async () => {
    // Even a stray host value must not survive into the spawned env when there
    // is nothing authorized to inject (the delete-scrub branch must fire).
    process.env.PAPERCLIP_API_KEY = HOST_STRAY_KEY;

    const ctx = makeCtx({
      cwd: process.cwd(),
      provider: "anthropic", // internal, allowlisted target → no fail-closed
    });
    // No run-scoped key available: nothing to fall back to.
    delete (ctx as { authToken?: string }).authToken;

    await execute(ctx);

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const opts = (runChildProcess.mock.calls[0] as unknown[])[3] as {
      env: Record<string, string>;
    };
    // The scrub fired: no PAPERCLIP_API_KEY leaks into the child.
    expect(opts.env.PAPERCLIP_API_KEY).toBeUndefined();
  });
});
