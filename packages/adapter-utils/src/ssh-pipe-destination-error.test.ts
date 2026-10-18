import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

type FakeChild = EventEmitter & {
  stdin: Writable | null;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

const spawned = vi.hoisted(() => [] as Array<{ file: string; child: unknown }>);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = ((file: string, _args: string[], options: { stdio?: string[] }) => {
    const child = new EventEmitter() as FakeChild;
    const stdinMode = options?.stdio?.[0];
    child.stdin =
      stdinMode === "pipe"
        ? new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
          })
        : null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    spawned.push({ file, child });
    return child;
  }) as unknown as typeof actual.spawn;
  return { ...actual, spawn };
});

import { syncDirectoryFromSsh, syncDirectoryToSsh } from "./ssh.js";

const SPEC = {
  host: "fake-host",
  port: 22,
  username: "tester",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: false,
  remoteWorkspacePath: "/remote/workspace",
  remoteCwd: "/remote/workspace",
};

async function waitForSpawn(file: string): Promise<FakeChild> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = spawned.find((entry) => entry.file === file);
    if (found) return found.child as FakeChild;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`${file} was never spawned`);
}

function epipe(): Error {
  return Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
}

describe("ssh pipe destination stdin errors", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    spawned.length = 0;
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
  });

  it("rejects syncDirectoryToSsh when ssh stdin errors while tar is piping into it", async () => {
    const localDir = await mkdtemp(path.join(tmpdir(), "paperclip-ssh-pipe-to-"));
    dirs.push(localDir);

    const result = syncDirectoryToSsh({ spec: SPEC, localDir, remoteDir: "/remote/dir" });
    const outcome = result.then(
      () => ({ rejected: false as const }),
      (error: Error) => ({ rejected: true as const, message: error.message }),
    );

    const ssh = await waitForSpawn("ssh");
    const tar = await waitForSpawn("tar");
    ssh.stdin!.destroy(epipe());

    expect(await outcome).toEqual({ rejected: true, message: "write EPIPE" });
    expect(tar.kill).toHaveBeenCalledWith("SIGTERM");
    expect(ssh.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects syncDirectoryFromSsh when tar stdin errors while ssh output is piping into it", async () => {
    const localDir = await mkdtemp(path.join(tmpdir(), "paperclip-ssh-pipe-from-"));
    dirs.push(localDir);

    const result = syncDirectoryFromSsh({ spec: SPEC, remoteDir: "/remote/dir", localDir });
    const outcome = result.then(
      () => ({ rejected: false as const }),
      (error: Error) => ({ rejected: true as const, message: error.message }),
    );

    const ssh = await waitForSpawn("ssh");
    const tar = await waitForSpawn("tar");
    tar.stdin!.destroy(epipe());

    expect(await outcome).toEqual({ rejected: true, message: "write EPIPE" });
    expect(tar.kill).toHaveBeenCalledWith("SIGTERM");
    expect(ssh.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
