import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Record the env of every execFile child, then delegate to the real execFile.
const execFileEnvs = vi.hoisted(() => [] as Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv | undefined }>);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = ((file: string, args: string[], options: { env?: NodeJS.ProcessEnv }, callback: unknown) => {
    execFileEnvs.push({ file, args: [...args], env: options?.env });
    return (actual.execFile as unknown as (...a: unknown[]) => unknown)(file, args, options, callback);
  }) as unknown as typeof actual.execFile;
  return { ...actual, execFile };
});

import { deriveAgentGitIdentity } from "./git-identity.js";
import { restoreWorkspaceFromSshExecution } from "./ssh.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";

// Regression guard: execFileText must pass a CALLER-supplied env (the agent
// git identity env, built from process.env) through scrubSigningKeys. A merge
// once let `env: options.env` override the scrub. Synthetic value only;
// assertions check variable NAMES and identity values, never the fake secret.
const FAKE = "fake-signing-value-for-test";
const SECRET = "PAPERCLIP_AGENT_JWT_SECRET";

async function git(cwd: string, args: string[]): Promise<string> {
  // execFileSync is not wrapped by the recorder above.
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

describe("ssh execFileText caller env signing-key scrub", () => {
  const dirs: string[] = [];
  const savedSecret = process.env[SECRET];
  const savedPath = process.env.PATH;

  afterEach(async () => {
    if (savedSecret === undefined) delete process.env[SECRET];
    else process.env[SECRET] = savedSecret;
    process.env.PATH = savedPath;
    execFileEnvs.length = 0;
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
  });

  it("scrubs the agent identity env passed to the SSH sync merge commit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-ssh-scrub-"));
    dirs.push(root);

    // Fake `ssh`: run the remote script (last argument) on this host. The
    // "remote" workspace is a local directory, so no sshd is needed.
    const binDir = path.join(root, "bin");
    await mkdir(binDir);
    await writeFile(path.join(binDir, "ssh"), '#!/bin/sh\nfor a; do last=$a; done\nexec /bin/sh -c "$last"\n');
    await chmod(path.join(binDir, "ssh"), 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;

    const localDir = path.join(root, "local");
    const remoteDir = path.join(root, "remote");
    await mkdir(localDir);
    await git(localDir, ["init", "-q", "-b", "main"]);
    await git(localDir, ["config", "user.name", "Paperclip Test"]);
    await git(localDir, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localDir, "base.txt"), "base\n");
    await git(localDir, ["add", "base.txt"]);
    await git(localDir, ["commit", "-q", "-m", "base"]);
    execFileSync("git", ["clone", "-q", localDir, remoteDir]);
    await git(remoteDir, ["config", "user.name", "Paperclip Test"]);
    await git(remoteDir, ["config", "user.email", "test@paperclip.dev"]);

    const baselineSnapshot = await captureDirectorySnapshot(localDir, { exclude: [".git", ".paperclip-runtime"] });

    // Diverge both sides so the restore must create a merge commit
    // (integrateImportedGitHead -> runLocalGit commit-tree with the agent env).
    await writeFile(path.join(remoteDir, "remote.txt"), "remote\n");
    await git(remoteDir, ["add", "remote.txt"]);
    await git(remoteDir, ["commit", "-q", "-m", "remote"]);
    await writeFile(path.join(localDir, "local.txt"), "local\n");
    await git(localDir, ["add", "local.txt"]);
    await git(localDir, ["commit", "-q", "-m", "local"]);

    // Set the server secret only now: agentCommitIdentityEnv copies process.env.
    process.env[SECRET] = FAKE;
    const agent = { id: "agent-scrub-1", name: "Coder", companyId: "company-scrub-1" };
    await restoreWorkspaceFromSshExecution({
      spec: {
        host: "fake-host",
        port: 22,
        username: "tester",
        remoteWorkspacePath: remoteDir,
        remoteCwd: remoteDir,
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: false,
      },
      localDir,
      remoteDir,
      baselineSnapshot,
      restoreGitHistory: true,
      agent,
    });

    const commitTree = execFileEnvs.filter((call) => call.file === "git" && call.args.includes("commit-tree"));
    expect(commitTree).toHaveLength(1);
    const env = commitTree[0]!.env;
    expect(env).toBeDefined();
    expect(Object.keys(env!)).not.toContain(SECRET);
    const identity = deriveAgentGitIdentity(agent);
    expect(env).toMatchObject({
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    });
    // The merge commit really carries the agent identity.
    expect(await git(localDir, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"])).toBe(
      `${identity.name} <${identity.email}>|${identity.name} <${identity.email}>`,
    );
    // No execFile child in the whole restore saw the secret.
    for (const call of execFileEnvs) {
      if (call.env) expect(Object.keys(call.env)).not.toContain(SECRET);
    }
  });
});
