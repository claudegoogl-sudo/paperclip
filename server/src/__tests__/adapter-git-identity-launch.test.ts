// Launch-path contract: agent-run commits carry the agent git identity.
//
// This drives the REAL launch path — the process adapter's `execute`, the same
// module the server registry invokes for every local agent run — and asserts
// that a `git commit` performed by the launched process is authored AND
// committed as the derived agent identity, both from a fallback-style plain
// directory and from a project/execution-workspace style repo cwd.
//
// The test fails if the GIT_* injection line is removed from
// `buildPaperclipEnv` (packages/adapter-utils/src/server-utils.ts): git then
// falls back to the repo config identity asserted in the "without injection"
// control case below.

import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { execute } from "../adapters/process/execute.js";
import { deriveAgentGitIdentity } from "@paperclipai/adapter-utils";

const execFileAsync = promisify(execFileCallback);

const AGENT = {
  id: "558b662c-0f1f-473a-ab7d-d4e56fb3c29b",
  name: "Coder",
  companyId: "d49b266c-50dc-42c5-b45e-308c7f3ffc1f",
  adapterType: "process",
  adapterConfig: {},
};

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createAgentRepo(label: string, options: { setRepoIdentity?: boolean } = {}) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-git-identity-${label}-`));
  tmpDirs.push(repoRoot);
  const run = async (args: string[]) => {
    await execFileAsync("git", args, { cwd: repoRoot });
  };
  await run(["init"]);
  if (options.setRepoIdentity !== false) {
    // A checkout whose own config carries some other identity — the exact
    // Copperworks failure mode the feature fixes.
    await run(["config", "user.name", "CopperCTO"]);
    await run(["config", "user.email", "coppercto@copperworks.local"]);
  }
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await run(["add", "README.md"]);
  await run(["config", "user.name", "Repo Relic"]);
  await run(["config", "user.email", "relic@example.com"]);
  await run(["commit", "-m", "seed"]);
  return repoRoot;
}

async function commitAuthorAndCommitter(repoRoot: string) {
  const { stdout } = await execFileAsync(
    "git",
    ["log", "-1", "--format=%an%n%ae%n%cn%n%ce"],
    { cwd: repoRoot },
  );
  const [an, ae, cn, ce] = stdout.trim().split("\n");
  return { authorName: an, authorEmail: ae, committerName: cn, committerEmail: ce };
}

function adapterContext(repoRoot: string) {
  return {
    runId: "run-test-git-identity",
    agent: AGENT,
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      command: "git",
      args: ["commit", "--allow-empty", "-m", "agent work"],
      cwd: repoRoot,
    },
    context: {},
    onLog: async () => {},
  } as Parameters<typeof execute>[0];
}

describe("process adapter launch injects the per-agent git identity", () => {
  it("attributes agent-run commits to the agent from a plain fallback-style cwd", async () => {
    const repoRoot = await createAgentRepo("fallback", { setRepoIdentity: false });
    const result = await execute(adapterContext(repoRoot));
    expect(result.exitCode).toBe(0);

    const identity = deriveAgentGitIdentity(AGENT);
    const observed = await commitAuthorAndCommitter(repoRoot);
    expect(observed.authorName).toBe(identity.name);
    expect(observed.authorEmail).toBe(identity.email);
    expect(observed.committerName).toBe(identity.name);
    expect(observed.committerEmail).toBe(identity.email);
    expect(observed.authorEmail).toContain(AGENT.id);
    expect(observed.authorEmail).toContain(`${AGENT.companyId}.`);
  });

  it("attributes agent-run commits to the agent from a project/execution-workspace cwd with a competing repo identity", async () => {
    const repoRoot = await createAgentRepo("workspace");
    const result = await execute(adapterContext(repoRoot));
    expect(result.exitCode).toBe(0);

    const identity = deriveAgentGitIdentity(AGENT);
    const observed = await commitAuthorAndCommitter(repoRoot);
    // Env injection wins over the checkout's own configured identity.
    expect(observed.authorName).toBe(identity.name);
    expect(observed.authorEmail).toBe(identity.email);
    expect(observed.committerName).toBe(identity.name);
    expect(observed.committerEmail).toBe(identity.email);
    expect(observed.authorEmail).not.toBe("coppercto@copperworks.local");
  });

  it("control: without injected env the commit would carry the repo identity", async () => {
    const repoRoot = await createAgentRepo("control");
    await execFileAsync("git", ["commit", "--allow-empty", "-m", "no env"], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    const observed = await commitAuthorAndCommitter(repoRoot);
    expect(observed.authorName).toBe("Repo Relic");
    expect(observed.authorEmail).toBe("relic@example.com");
  });
});
