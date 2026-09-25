import { afterEach, describe, expect, it } from "vitest";

import {
  CHILD_ENV_SIGNING_KEY_DENYLIST,
  buildChildEnv,
  runChildProcess,
  sanitizeInheritedPaperclipEnv,
} from "./server-utils.js";

// Regression: signing-capable secrets must never reach a child process, whether
// they come from the server env or from a caller-supplied env.
const FAKE = "fake-signing-value-for-test";

describe("child env signing-key denylist", () => {
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const key of CHILD_ENV_SIGNING_KEY_DENYLIST) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("names both signing keys", () => {
    expect([...CHILD_ENV_SIGNING_KEY_DENYLIST]).toEqual(
      expect.arrayContaining(["PAPERCLIP_AGENT_JWT_SECRET", "BETTER_AUTH_SECRET"]),
    );
  });

  it("sanitizeInheritedPaperclipEnv strips them", () => {
    const env = sanitizeInheritedPaperclipEnv({
      PAPERCLIP_AGENT_JWT_SECRET: FAKE,
      BETTER_AUTH_SECRET: FAKE,
      PATH: "/usr/bin",
    });
    for (const key of CHILD_ENV_SIGNING_KEY_DENYLIST) expect(key in env).toBe(false);
  });

  it.each([true, false])("buildChildEnv strips them from processEnv and caller env (inheritServerEnv=%s)", (inherit) => {
    const env = buildChildEnv(
      { PAPERCLIP_AGENT_JWT_SECRET: FAKE, BETTER_AUTH_SECRET: FAKE, KEEP: "1" },
      { inheritServerEnv: inherit, processEnv: { PAPERCLIP_AGENT_JWT_SECRET: FAKE, BETTER_AUTH_SECRET: FAKE, PATH: "/usr/bin" } },
    );
    for (const key of CHILD_ENV_SIGNING_KEY_DENYLIST) expect(key in env).toBe(false);
    expect(env.KEEP).toBe("1");
  });

  it("runChildProcess spawns a child without them (process.env and opts.env both set)", async () => {
    for (const key of CHILD_ENV_SIGNING_KEY_DENYLIST) {
      saved[key] = process.env[key];
      process.env[key] = FAKE;
    }
    const script = `process.stdout.write(JSON.stringify(${JSON.stringify([...CHILD_ENV_SIGNING_KEY_DENYLIST])}.map((k) => k in process.env)))`;
    const result = await runChildProcess(`denylist-${Date.now()}`, process.execPath, ["-e", script], {
      cwd: process.cwd(),
      env: { PAPERCLIP_AGENT_JWT_SECRET: FAKE, BETTER_AUTH_SECRET: FAKE },
      timeoutSec: 30,
      graceSec: 1,
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([false, false]);
  });
});
