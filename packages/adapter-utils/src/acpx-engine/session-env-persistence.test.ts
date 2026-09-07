import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpRuntime,
} from "acpx/runtime";

/**
 * Regression tests for the fork.37 claude_local ensure_session failure
 * (acpx persisted-key policy vs per-session env; parent incident ticket on
 * the company board).
 *
 * Production failure: adapter-utils passes `sessionOptions: { env }` with
 * SCREAMING_CASE keys into acpx's `ensureSession`; acpx persists that env map
 * as `acpx.session_options.env` on the runtime record, but acpx's
 * `assertPersistedKeyPolicy` (FileSessionStore.save) rejects every
 * non-snake_case key because `acpx.session_options.env` is missing from its
 * `MAP_OBJECT_PATHS` exemption set. Every cold `claude_local` start died in
 * ~5s with `Persisted key policy violation`.
 *
 * The fork carries the fix as `patches/acpx@0.12.0.patch` (adds
 * `acpx.session_options.env` to `MAP_OBJECT_PATHS`). pnpm applies that patch
 * in this workspace — but plain `npm install` of the published fork closure
 * resolves PRISTINE acpx from the registry, which is why the shipped fork.37
 * artifact still failed. These tests pin the behavior end to end:
 *
 *  - AC1: a fresh `ensureSession` with SCREAMING_CASE `sessionOptions.env`
 *    completes and persists the env through the real save path
 *    (ensureSession -> createAndSaveRuntimeRecord -> FileSessionStore.save).
 *  - AC1b: the cold-restart reuse path re-saves the persisted record (env
 *    included) through the same validation without throwing — this is the
 *    exact stack from the incident.
 *  - AC2: a resumed turn relaunches the agent process with the recorded env
 *    (record -> sessionOptionsFromRecord -> AcpClient spawn env).
 *  - AC3: keys under paths that are NOT exempted still fail validation.
 *  - guard: the workspace acpx copy actually carries the patch marker, and
 *    the patch file is present — so an install/lockfile drift fails here
 *    instead of on a production host at 3am.
 *
 * Verified red on the pre-fix state: with pristine acpx 0.12.0 dist swapped
 * into node_modules, AC1 fails with the exact production error:
 * `Persisted key policy violation (expected snake_case keys):
 * acpx.session_options.env.PAPERCLIP_AGENT_ID, ...` thrown from
 * assertPersistedKeyPolicy <- FileSessionStore.save <-
 * AcpRuntimeManager.createAndSaveRuntimeRecord <- AcpRuntimeManager.ensureSession.
 */

const SCREAMING_ENV = {
  PAPERCLIP_AGENT_ID: "agent-regression-1",
  PAPERCLIP_API_KEY: "sk-test-not-a-secret",
  ANTHROPIC_MODEL: "claude-test-model",
};

const tempRoots: string[] = [];
const openHandles: Array<{ runtime: AcpRuntime; handle: Awaited<ReturnType<AcpRuntime["ensureSession"]>> }> = [];

let stubAgentPath = "";
let stateRoot = "";

async function makeTempRoot(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function makeRuntime(stateDir: string): AcpRuntime {
  return createAcpRuntime({
    cwd: stateDir,
    sessionStore: createFileSessionStore({ stateDir }),
    agentRegistry: createAgentRegistry({
      overrides: { stub: `node ${stubAgentPath}` },
    }),
    permissionMode: "approve-reads",
  });
}

async function ensureAndTrack(
  runtime: AcpRuntime,
  input: Parameters<AcpRuntime["ensureSession"]>[0],
): Promise<Awaited<ReturnType<AcpRuntime["ensureSession"]>>> {
  const handle = await runtime.ensureSession(input);
  openHandles.push({ runtime, handle });
  return handle;
}

async function readPersistedRecord(stateDir: string, sessionKey: string) {
  const recordPath = path.join(stateDir, "sessions", `${sessionKey}.json`);
  return JSON.parse(await fs.readFile(recordPath, "utf8")) as {
    acp_session_id?: string;
    acpx?: { session_options?: { env?: Record<string, string> } };
  };
}

async function closeAll() {
  for (const entry of openHandles.splice(0)) {
    // Best-effort close; individual tests assert their own outcomes.
    await entry.runtime.close({ handle: entry.handle, reason: "test teardown" }).catch(() => undefined);
  }
}

beforeAll(async () => {
  // Write the stub ACP agent at runtime so the test is self-contained: it
  // answers initialize/session-new/load-session/prompt over NDJSON stdio and
  // dumps selected process.env keys to ACPX_STUB_ENV_PROBE at spawn time.
  const stubDir = await makeTempRoot("paperclip-acpx-envpolicy-stub-");
  stubAgentPath = path.join(stubDir, "stub-acp-agent.mjs");
  await fs.writeFile(
    stubAgentPath,
    `import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const probe = process.env.ACPX_STUB_ENV_PROBE;
if (probe) {
  const keys = ["PAPERCLIP_AGENT_ID", "PAPERCLIP_API_KEY", "ANTHROPIC_MODEL", "ACPX_STUB_MARK"];
  const snap = Object.fromEntries(keys.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  writeFileSync(probe, JSON.stringify(snap));
}
const send = (msg) => process.stdout.write(\`\${JSON.stringify(msg)}\\n\`);
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  switch (msg.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
      break;
    case "session/new":
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "stub-acp-session-1" } });
      break;
    case "loadSession":
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params?.sessionId ?? "stub-acp-session-1" } });
      break;
    case "session/prompt":
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      break;
    default:
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
rl.on("close", () => process.exit(0));
`,
    "utf8",
  );
  stateRoot = await makeTempRoot("paperclip-acpx-envpolicy-");
});

afterAll(async () => {
  await closeAll();
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  delete process.env.ACPX_STUB_ENV_PROBE;
});

describe("claude_local session env persistence (fork.37 regression)", () => {
  it("AC1: ensureSession persists SCREAMING_CASE sessionOptions.env through the real save path and spawns the agent with it", { timeout: 30_000 }, async () => {
    const work = await makeTempRoot("paperclip-acpx-envpolicy-ac1-");
    const stateDir = path.join(work, "state");
    const envProbe = path.join(work, "env-snap-fresh.json");
    process.env.ACPX_STUB_ENV_PROBE = envProbe;

    const runtime = makeRuntime(stateDir);
    const handle = await ensureAndTrack(runtime, {
      sessionKey: "env-policy-fresh",
      agent: "stub",
      mode: "persistent",
      cwd: work,
      sessionOptions: { env: { ...SCREAMING_ENV } },
    });

    expect(handle.acpxRecordId).toBe("env-policy-fresh");
    expect(handle.backendSessionId).toBe("stub-acp-session-1");

    // The record on disk (FileSessionStore.save output) carries the env map.
    const record = await readPersistedRecord(stateDir, "env-policy-fresh");
    expect(record.acpx?.session_options?.env).toEqual(SCREAMING_ENV);

    // The spawned stub agent process actually received the env.
    const spawnedEnv = JSON.parse(await fs.readFile(envProbe, "utf8")) as Record<string, string>;
    expect(spawnedEnv).toEqual(SCREAMING_ENV);
  });

  it("AC1b: cold restart reuses the persisted record and re-saves it (env included) without a policy violation", { timeout: 30_000 }, async () => {
    const work = await makeTempRoot("paperclip-acpx-envpolicy-ac1b-");
    const stateDir = path.join(work, "state");
    const envProbe = path.join(work, "env-snap-reuse.json");
    process.env.ACPX_STUB_ENV_PROBE = envProbe;

    const first = makeRuntime(stateDir);
    await ensureAndTrack(first, {
      sessionKey: "env-policy-reuse",
      agent: "stub",
      mode: "persistent",
      cwd: work,
      sessionOptions: { env: { ...SCREAMING_ENV } },
    });
    await closeAll();

    // New runtime = restarted host: no warm handle, nothing in memory. The
    // incident's failing stack was exactly this cold ensure_session.
    const second = makeRuntime(stateDir);
    const handle = await second.ensureSession({
      sessionKey: "env-policy-reuse",
      agent: "stub",
      mode: "persistent",
      cwd: work,
      sessionOptions: { env: { ...SCREAMING_ENV } },
    });
    expect(handle.acpxRecordId).toBe("env-policy-reuse");

    const record = await readPersistedRecord(stateDir, "env-policy-reuse");
    expect(record.acpx?.session_options?.env).toEqual(SCREAMING_ENV);
  });

  it("AC2: a resumed turn relaunches the agent process with the env recorded on the runtime record", { timeout: 30_000 }, async () => {
    const work = await makeTempRoot("paperclip-acpx-envpolicy-ac2-");
    const stateDir = path.join(work, "state");
    const envProbe = path.join(work, "env-snap-resume.json");
    process.env.ACPX_STUB_ENV_PROBE = envProbe;

    const first = makeRuntime(stateDir);
    const original = await ensureAndTrack(first, {
      sessionKey: "env-policy-resume",
      agent: "stub",
      mode: "persistent",
      cwd: work,
      sessionOptions: { env: { ...SCREAMING_ENV } },
    });
    await closeAll();

    // Restarted runtime resumes the persisted session. The resume client is
    // built from the record (acpx sessionOptionsFromRecord), so the recorded
    // env — not caller memory — must relaunch the agent process.
    process.env.ACPX_STUB_ENV_PROBE = envProbe;
    const second = makeRuntime(stateDir);
    const resumed = await second.ensureSession({
      sessionKey: "env-policy-resume",
      agent: "stub",
      mode: "persistent",
      cwd: work,
      resumeSessionId: original.backendSessionId,
      // Deliberately omit sessionOptions here: resume must re-supply env from
      // the persisted record. (adapter-utils passes prepared.env on this path
      // too; the record is the safety net this test pins.)
    });
    expect(resumed.acpxRecordId).toBe("env-policy-resume");

    const turn = second.startTurn({
      handle: resumed,
      text: "resume-env probe",
      mode: "prompt",
      requestId: "resume-env-probe-1",
    });
    const result = await turn.result;
    expect(result).toBeDefined();

    const relaunchedEnv = JSON.parse(await fs.readFile(envProbe, "utf8")) as Record<string, string>;
    expect(relaunchedEnv).toEqual(SCREAMING_ENV);
  });

  it("AC3: the policy still rejects malformed keys under paths that are NOT exempted", { timeout: 30_000 }, async () => {
    const work = await makeTempRoot("paperclip-acpx-envpolicy-ac3-");
    const stateDir = path.join(work, "state");
    delete process.env.ACPX_STUB_ENV_PROBE;

    // Produce a real, well-formed record first (fresh session with a valid
    // exempted env map), then inject one malformed key into a conversation
    // content block — a path the exemption does NOT cover.
    const first = makeRuntime(stateDir);
    await ensureAndTrack(first, {
      sessionKey: "env-policy-negative",
      agent: "stub",
      mode: "persistent",
      cwd: work,
      sessionOptions: { env: { PAPERCLIP_AGENT_ID: "fine-when-exempted" } },
    });
    await closeAll();

    const recordPath = path.join(stateDir, "sessions", "env-policy-negative.json");
    const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as {
      messages: unknown[];
    };
    expect(Array.isArray(record.messages)).toBe(true);
    // A structurally valid Agent message (ZED-tag content entry — what acpx
    // itself persists) whose content block carries one extra malformed key.
    // isAgentContent only requires the Text tag, so the message survives
    // load-side parsing; FileSessionStore round-trips record.messages
    // verbatim, so the key must reach save-time validation and be rejected
    // there. (A non-ZED message shape would be dropped by parseSessionRecord
    // instead, and the reuse path would silently create a fresh record.)
    record.messages.push({
      Agent: {
        content: [{ Text: "seeded", BadKey: "must still be rejected" }],
        tool_results: {},
      },
    });
    await fs.writeFile(recordPath, JSON.stringify(record), "utf8");

    // Cold restart: the reuse path re-saves the loaded record. The env map is
    // exempted now, but the malformed content-block key must still be caught.
    const second = makeRuntime(stateDir);
    await expect(
      second.ensureSession({
        sessionKey: "env-policy-negative",
        agent: "stub",
        mode: "persistent",
        cwd: work,
      }),
    ).rejects.toThrow(/Persisted key policy violation .*messages\.Agent\.content\.BadKey/);
  });

  it("guard: the workspace acpx carries the session_options.env exemption and the pnpm patch is present", async () => {
    const require = createRequire(import.meta.url);
    const acpxPkgJson = require.resolve("acpx/package.json");
    const acpxDist = path.dirname(acpxPkgJson);
    const distDir = path.join(acpxDist, "dist");
    const bundles = (await fs.readdir(distDir)).filter((f) => f.startsWith("live-checkpoint-") && f.endsWith(".js"));
    expect(bundles.length).toBeGreaterThan(0);
    const combined = await Promise.all(
      bundles.map(async (f) => fs.readFile(path.join(distDir, f), "utf8")),
    );
    const marker = combined.some((text) =>
      text.includes('new Set(["request_token_usage", "messages.Agent.tool_results", "acpx.session_options.env"])'),
    );
    expect(marker).toBe(true);

    // Repo root is four levels up from src/acpx-engine/<this file>.
    const repoRoot = path.resolve(fileURLToPath(new URL(import.meta.url)), "..", "..", "..", "..", "..");
    const patchPath = path.join(repoRoot, "patches", "acpx@0.12.0.patch");
    await expect(fs.access(patchPath)).resolves.toBeUndefined();
  });
});
