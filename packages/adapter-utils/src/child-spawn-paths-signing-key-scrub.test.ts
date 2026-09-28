import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CHILD_ENV_SIGNING_KEY_DENYLIST } from "./child-env-scrub.js";
import { getProcessSessionRemoteSource } from "./execution-target.js";
import { createNetworkProxyBridge } from "./local-process-sandbox.js";
import { buildSshSpawnTarget, runSshCommand } from "./ssh.js";

// Every child-process spawn path in adapter-utils must drop signing-capable
// server secrets, whether they come from the server env or a caller env.
// Synthetic values only; assertions compare variable NAMES, never values.
const FAKE = "fake-signing-value-for-test";
const DENY = [...CHILD_ENV_SIGNING_KEY_DENYLIST];
const allFake = (): Record<string, string> => Object.fromEntries(DENY.map((k) => [k, FAKE]));
// Prints the child's env names as JSON on stdout.
const PRINT_ENV_NAMES = "process.stdout.write(JSON.stringify(Object.keys(process.env)))";

describe("signing-key scrub on every adapter-utils spawn path", () => {
  const dirs: string[] = [];
  const saved: Record<string, string | undefined> = {};
  const savedPath = process.env.PATH;

  function setServerSecrets() {
    for (const key of DENY) {
      saved[key] = process.env[key];
      process.env[key] = FAKE;
    }
  }

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete saved[key];
    }
    process.env.PATH = savedPath;
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
  });

  async function tempDir(prefix: string) {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function runNode(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [file, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err.slice(0, 500)}`))));
    });
  }

  it("local-process-sandbox proxy bridge does not pass signing keys to the sandboxed child", async () => {
    const dir = await tempDir("pc-scrub-sandbox-");
    const bridge = path.join(dir, "bridge.cjs");
    await writeFile(bridge, await createNetworkProxyBridge(), "utf8");
    // Server env and the env bwrap hands the bridge both carry the keys.
    const out = await runNode(
      bridge,
      [path.join(dir, "unused.sock"), process.execPath, "-e", PRINT_ENV_NAMES],
      { ...process.env, ...allFake(), KEEP_ME: "1" },
    );
    const names: string[] = JSON.parse(out);
    for (const key of DENY) expect(names).not.toContain(key);
    expect(names).toContain("KEEP_ME");
  });

  it("execution-target process-session wrapper does not pass signing keys to the child", async () => {
    for (const outputToStdout of [true, false]) {
      const dir = await tempDir("pc-scrub-session-");
      await mkdir(path.join(dir, "stdin"), { recursive: true });
      const outFile = path.join(dir, "names.json");
      const wrapper = path.join(dir, "wrapper.mjs");
      await writeFile(wrapper, getProcessSessionRemoteSource({ outputToStdout }), "utf8");
      const config = {
        command: process.execPath,
        args: ["-e", `require("fs").writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(Object.keys(process.env)))`],
        cwd: dir,
        env: { ...allFake(), KEEP_ME: "1" },
      };
      await runNode(wrapper, [], {
        ...process.env,
        ...allFake(),
        PAPERCLIP_PROCESS_SESSION_DIR: dir,
        PAPERCLIP_PROCESS_SESSION_COMMAND_B64: Buffer.from(JSON.stringify(config)).toString("base64"),
      }).catch(() => undefined);
      const names: string[] = JSON.parse(await readFile(outFile, "utf8"));
      for (const key of DENY) expect(names, `outputToStdout=${outputToStdout}`).not.toContain(key);
      expect(names).toContain("KEEP_ME");
    }
  });

  it("ssh: neither the local ssh env nor the remote argv carries signing keys", async () => {
    const dir = await tempDir("pc-scrub-ssh-");
    const record = path.join(dir, "record.json");
    const fakeSsh = path.join(dir, "ssh");
    await writeFile(
      fakeSsh,
      `#!${process.execPath}\nrequire("fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ env: Object.keys(process.env), argv: process.argv.slice(2) }));\n`,
      "utf8",
    );
    await chmod(fakeSsh, 0o755);
    process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ""}`;
    setServerSecrets();
    const config = { host: "example.invalid", port: 22, username: "u", privateKey: null, knownHosts: null, strictHostKeyChecking: false };

    for (const stdin of [undefined, "input"]) {
      await rm(record, { force: true });
      await runSshCommand(config as never, "true", { env: { ...allFake(), KEEP_ME: "1" }, stdin });
      const seen = JSON.parse(await readFile(record, "utf8")) as { env: string[]; argv: string[] };
      const argv = seen.argv.join(" ");
      for (const key of DENY) {
        expect(seen.env, `stdin=${stdin}`).not.toContain(key);
        expect(argv.includes(key), `argv stdin=${stdin}`).toBe(false);
      }
      expect(argv).toContain("KEEP_ME=");
    }

    const target = await buildSshSpawnTarget({
      spec: { ...config, remoteCwd: "/tmp" } as never,
      command: "true",
      args: [],
      env: { ...allFake(), KEEP_ME: "1" },
    });
    await target.cleanup();
    const targetArgv = target.args.join(" ");
    for (const key of DENY) expect(targetArgv.includes(key)).toBe(false);
    expect(targetArgv).toContain("KEEP_ME=");
  });
});
