import { afterEach, describe, expect, it } from "vitest";

import {
  CHILD_ENV_INHERITED_ONLY_DENYLIST,
  CHILD_ENV_SIGNING_KEY_DENYLIST,
  buildChildEnv,
  runChildProcess,
  sanitizeInheritedPaperclipEnv,
} from "./server-utils.js";

// Regression: signing-capable secrets must never reach a child process, whether
// they come from the server env or from a caller-supplied env. The server's
// DATABASE_URL must not be inherited, but a caller's own value is kept.
const FAKE = "fake-signing-value-for-test";
const CALLER_DB = "caller-db-url-for-test";
const ALWAYS = [...CHILD_ENV_SIGNING_KEY_DENYLIST];
const allFake = (): Record<string, string> => Object.fromEntries(ALWAYS.map((k) => [k, FAKE]));

describe("child env signing-key denylist", () => {
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const key of [...ALWAYS, ...CHILD_ENV_INHERITED_ONLY_DENYLIST]) {
      if (!(key in saved)) continue;
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
      delete saved[key];
    }
  });

  it("names every required signing-capable key", () => {
    expect(ALWAYS).toEqual(
      expect.arrayContaining([
        "PAPERCLIP_AGENT_JWT_SECRET",
        "BETTER_AUTH_SECRET",
        "PAPERCLIP_SECRETS_MASTER_KEY",
        "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
        "PAPERCLIP_DECISION_SIGNING_SECRET",
        "PAPERCLIP_WORKSPACE_HANDOFF_SECRET",
        "PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN",
        "PAPERCLIP_DEV_SERVER_STATUS_TOKEN",
        "PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET",
        "PAPERCLIP_TELEMETRY_BACKEND_TOKEN",
      ]),
    );
    expect(ALWAYS).not.toContain("PAPERCLIP_API_KEY");
    expect([...CHILD_ENV_INHERITED_ONLY_DENYLIST]).toEqual(["DATABASE_URL"]);
  });

  it("sanitizeInheritedPaperclipEnv strips signing keys and DATABASE_URL", () => {
    const env = sanitizeInheritedPaperclipEnv({ ...allFake(), DATABASE_URL: FAKE, PATH: "/usr/bin" });
    for (const key of ALWAYS) expect(key in env).toBe(false);
    expect("DATABASE_URL" in env).toBe(false);
    expect(env.PATH).toBe("/usr/bin");
  });

  it.each([true, false])(
    "buildChildEnv strips signing keys from processEnv and caller env (inheritServerEnv=%s)",
    (inherit) => {
      const env = buildChildEnv(
        { ...allFake(), KEEP: "1" },
        { inheritServerEnv: inherit, processEnv: { ...allFake(), PATH: "/usr/bin" } },
      );
      for (const key of ALWAYS) expect(key in env).toBe(false);
      expect(env.KEEP).toBe("1");
    },
  );

  it.each([true, false])(
    "buildChildEnv drops inherited DATABASE_URL but keeps a caller value (inheritServerEnv=%s)",
    (inherit) => {
      const inheritedOnly = buildChildEnv({}, { inheritServerEnv: inherit, processEnv: { DATABASE_URL: FAKE, PATH: "/usr/bin" } });
      expect("DATABASE_URL" in inheritedOnly).toBe(false);
      const withCaller = buildChildEnv(
        { DATABASE_URL: CALLER_DB },
        { inheritServerEnv: inherit, processEnv: { DATABASE_URL: FAKE, PATH: "/usr/bin" } },
      );
      expect(withCaller.DATABASE_URL).toBe(CALLER_DB);
    },
  );

  it("runChildProcess spawns a child without them (process.env and opts.env both set)", async () => {
    for (const key of [...ALWAYS, "DATABASE_URL"]) {
      saved[key] = process.env[key];
      process.env[key] = FAKE;
    }
    const names = [...ALWAYS, "DATABASE_URL"];
    const script = `process.stdout.write(JSON.stringify(${JSON.stringify(names)}.map((k) => k in process.env)))`;
    const result = await runChildProcess(`denylist-${Date.now()}`, process.execPath, ["-e", script], {
      cwd: process.cwd(),
      env: allFake(),
      timeoutSec: 30,
      graceSec: 1,
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(names.map(() => false));
  });
});
