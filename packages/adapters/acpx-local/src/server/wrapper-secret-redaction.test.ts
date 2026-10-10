import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AcpRuntimeOptions } from "acpx/runtime";
import { createAcpxLocalExecutor, writeAgentWrapper } from "./execute.js";

// Wrapper artifact secret-redaction regression tests.
//
// The agent wrapper used to persist every spawn env entry — including
// server-resolved secret values (adapter config.env bindings, run auth
// tokens) — as plaintext `KEY='value'` lines into a `.env` sidecar under the
// instance state dir, readable by any host-level agent session. The wrapper
// must stay value-free: env values reach the spawned agent as process env
// supplied at spawn time (memory-only), and nothing derived from values may
// be written to disk.
//
// All secret-looking values here are DUMMY strings, never real credentials
// (secret-handling directive).

const MARKER_PREFIX = "__paperclip_secret_ref:";
const DUMMY_ENV = {
  PAPERCLIP_AGENT_ID: "agent-dummy-1",
  PAPERCLIP_RUN_ID: "run-dummy-42",
  PAPERCLIP_API_KEY: "pcp_dummy_not_a_real_key",
  OPENAI_API_KEY: "sk-dummy-openai-token-not-a-secret",
  ANTHROPIC_AUTH_TOKEN: "dummy-zai-token-not-a-secret",
} as const;

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-wrapper-redaction-"));
  tempRoots.push(root);
  return root;
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(candidate);
      else out.push(candidate);
    }
  };
  await walk(root).catch(() => {});
  return out;
}

describe("writeAgentWrapper secret redaction", () => {
  it("writes no env sidecar file and no artifact contains the dummy secret values", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");

    const { wrapperPath } = await writeAgentWrapper({
      stateDir,
      acpxAgent: "custom-a",
      agentCommandShell: "node ./fake-acp.js",
      env: { ...DUMMY_ENV },
      childStderrDir: path.join(stateDir, "run-stderr"),
    });

    const wrappersDir = path.join(stateDir, "wrappers");
    const wrapperFiles = await fs.readdir(wrappersDir);
    expect(wrapperFiles.filter((name) => name.endsWith(".env"))).toHaveLength(0);
    expect(wrapperFiles.filter((name) => name.endsWith(".sh"))).toHaveLength(1);

    for (const file of await listFilesRecursive(stateDir)) {
      const contents = await fs.readFile(file, "utf8");
      for (const value of Object.values(DUMMY_ENV)) {
        expect({ file, contains: contents.includes(value) }).toEqual({ file, contains: false });
      }
    }

    const wrapper = await fs.readFile(wrapperPath, "utf8");
    expect(wrapper).toContain("node ./fake-acp.js");
    expect(wrapper).not.toContain("source");
    expect(wrapper).not.toContain(MARKER_PREFIX);
    for (const value of Object.values(DUMMY_ENV)) {
      expect(wrapper).not.toContain(value);
    }
  });

  it("is value-independent: rotated dummy credentials reuse the same wrapper file", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const input = {
      stateDir,
      acpxAgent: "custom-a",
      agentCommandShell: "node ./fake-acp.js",
      childStderrDir: path.join(stateDir, "run-stderr"),
    };

    const first = await writeAgentWrapper({ ...input, env: { ...DUMMY_ENV } });
    const rotated = await writeAgentWrapper({
      ...input,
      env: { ...DUMMY_ENV, OPENAI_API_KEY: "sk-dummy-rotated-token-not-a-secret" },
    });

    expect(rotated.wrapperPath).toBe(first.wrapperPath);
    const wrapperFiles = (await fs.readdir(path.join(stateDir, "wrappers"))).filter((name) =>
      name.endsWith(".sh"),
    );
    expect(wrapperFiles).toHaveLength(1);
  });

  it("an added env key produces a fresh wrapper (key set still shapes identity)", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const input = {
      stateDir,
      acpxAgent: "custom-a",
      agentCommandShell: "node ./fake-acp.js",
      childStderrDir: path.join(stateDir, "run-stderr"),
    };

    const first = await writeAgentWrapper({ ...input, env: { ...DUMMY_ENV } });
    const second = await writeAgentWrapper({
      ...input,
      env: { ...DUMMY_ENV, EXTRA_DUMMY_VAR: "dummy-extra" },
    });
    expect(second.wrapperPath).not.toBe(first.wrapperPath);
  });
});

describe("acpx_local executor env redaction end to end", () => {
  it("supplies secret values as memory-only spawn env and persists only ref markers", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const ensureSessionInputs: Record<string, unknown>[] = [];
    const execute = createAcpxLocalExecutor({
      createRuntime: (_options: AcpRuntimeOptions) =>
        ({
          ensureSession: async (input: Record<string, unknown>) => {
            ensureSessionInputs.push(input);
            return {
              backendSessionId: "backend-session",
              agentSessionId: "agent-session",
              runtimeSessionName: "runtime-session",
            };
          },
          startTurn: () => ({
            events: (async function* () {
              yield { type: "done", stopReason: "end_turn" };
            })(),
            result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
            cancel: async () => {},
          }),
          close: async () => {},
        }) as never,
    });

    const result = await execute({
      runId: "run-dummy-42",
      agent: { id: "agent-dummy-1", companyId: "company-dummy" },
      runtime: {},
      config: {
        agent: "custom-a",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        env: {
          OPENAI_API_KEY: "sk-dummy-openai-token-not-a-secret",
          ANTHROPIC_AUTH_TOKEN: "dummy-zai-token-not-a-secret",
        },
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);

    // The runtime received the real values (memory-only spawn env) ...
    const sessionOptions = ensureSessionInputs[0]?.sessionOptions as {
      env?: Record<string, string>;
      persistedEnv?: Record<string, string>;
    };
    expect(sessionOptions?.env?.OPENAI_API_KEY).toBe("sk-dummy-openai-token-not-a-secret");
    expect(sessionOptions?.env?.ANTHROPIC_AUTH_TOKEN).toBe("dummy-zai-token-not-a-secret");
    // ... while everything persisted carries key-naming markers only.
    expect(sessionOptions?.persistedEnv?.OPENAI_API_KEY).toBe(`${MARKER_PREFIX}OPENAI_API_KEY`);
    expect(sessionOptions?.persistedEnv?.ANTHROPIC_AUTH_TOKEN).toBe(
      `${MARKER_PREFIX}ANTHROPIC_AUTH_TOKEN`,
    );
    expect(sessionOptions?.persistedEnv?.PAPERCLIP_RUN_ID).toBe(`${MARKER_PREFIX}PAPERCLIP_RUN_ID`);
    for (const [key, value] of Object.entries(sessionOptions?.persistedEnv ?? {})) {
      expect(value).toBe(`${MARKER_PREFIX}${key}`);
    }

    // Nothing anywhere under the state dir carries a dummy secret value.
    for (const file of await listFilesRecursive(stateDir)) {
      const contents = await fs.readFile(file, "utf8");
      expect(contents).not.toContain("sk-dummy-openai-token-not-a-secret");
      expect(contents).not.toContain("dummy-zai-token-not-a-secret");
    }

    const wrappersDir = path.join(stateDir, "wrappers");
    expect((await fs.readdir(wrappersDir)).filter((name) => name.endsWith(".env"))).toHaveLength(0);
  });
});
