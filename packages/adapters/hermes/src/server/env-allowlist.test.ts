import { expect, test } from "vitest";

import { allowlistedProcessEnv } from "./execute.js";

/**
 * Security regression tests for the default-deny env allowlist that replaced
 * the blanket `...process.env` spread when building the Hermes child env.
 *
 * The threat: the Paperclip server process holds every company's/agent's
 * secrets. A cloaked/logging inference model with a shell toolset could
 * `printenv` and exfiltrate them. Only non-secret runtime essentials may
 * reach the child from the server env; per-agent credentials arrive via
 * adapterConfig.env (userEnv) and the explicit Paperclip injections.
 */

test("secret vars not in the allowlist are dropped from the base env", () => {
  const source = {
    // Secrets that live in the real server env — must NOT pass through.
    MAC_PW: "s3cret-mac",
    ZAI_API_KEY: "zai-leak",
    TELEGRAM_BOT_TOKEN: "tg-leak",
    GITHUB_PAT: "ghp_leak",
    ANTHROPIC_API_KEY: "anthropic-leak",
    AWS_SECRET_ACCESS_KEY: "aws-leak",
    // Non-secret essentials — must pass through.
    PATH: "/usr/bin:/bin",
    HOME: "/home/agent",
  } as NodeJS.ProcessEnv;

  const base = allowlistedProcessEnv(source);

  expect(base.MAC_PW).toBeUndefined();
  expect(base.ZAI_API_KEY).toBeUndefined();
  expect(base.TELEGRAM_BOT_TOKEN).toBeUndefined();
  expect(base.GITHUB_PAT).toBeUndefined();
  expect(base.ANTHROPIC_API_KEY).toBeUndefined();
  expect(base.AWS_SECRET_ACCESS_KEY).toBeUndefined();
});

test("PATH and HOME (and locale/xdg families) pass through", () => {
  const source = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/agent",
    LANG: "en_US.UTF-8",
    LC_TIME: "en_GB.UTF-8",
    XDG_CACHE_HOME: "/home/agent/.cache",
    TERM: "xterm-256color",
    NODE_ENV: "production",
  } as NodeJS.ProcessEnv;

  const base = allowlistedProcessEnv(source);

  expect(base.PATH).toBe("/usr/bin:/bin");
  expect(base.HOME).toBe("/home/agent");
  expect(base.LANG).toBe("en_US.UTF-8");
  expect(base.LC_TIME).toBe("en_GB.UTF-8"); // LC_* prefix family
  expect(base.XDG_CACHE_HOME).toBe("/home/agent/.cache"); // XDG_* prefix family
  expect(base.TERM).toBe("xterm-256color");
  expect(base.NODE_ENV).toBe("production");
});

test("PYTHONPATH/PYTHONHOME are not allowlisted (shim scrubs them)", () => {
  const source = {
    PYTHONPATH: "/attacker/path",
    PYTHONHOME: "/attacker/home",
  } as NodeJS.ProcessEnv;

  const base = allowlistedProcessEnv(source);

  expect(base.PYTHONPATH).toBeUndefined();
  expect(base.PYTHONHOME).toBeUndefined();
});

test("layered child env: adapterConfig.env and PAPERCLIP_API_KEY win over the base, secrets stay absent", () => {
  // Mirrors the exact spread order in buildHermesChildEnv (execute.ts):
  //   { ...allowlistedProcessEnv(), ...userEnv, ...buildPaperclipEnv(), PAPERCLIP_API_KEY }
  const source = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/agent",
    ZAI_API_KEY: "other-company-secret", // must never reach the child
  } as NodeJS.ProcessEnv;

  const userEnv = { OPENROUTER_API_KEY: "sk-or-agent-own-key" }; // adapterConfig.env
  const authToken = "pat-agent-least-privilege"; // injected as PAPERCLIP_API_KEY

  const childEnv: Record<string, string> = {
    ...allowlistedProcessEnv(source),
    ...userEnv,
  };
  childEnv.PAPERCLIP_API_KEY = authToken;

  // (b) adapterConfig.env var and PAPERCLIP_API_KEY are present
  expect(childEnv.OPENROUTER_API_KEY).toBe("sk-or-agent-own-key");
  expect(childEnv.PAPERCLIP_API_KEY).toBe("pat-agent-least-privilege");
  // (c) PATH/HOME pass through
  expect(childEnv.PATH).toBe("/usr/bin:/bin");
  expect(childEnv.HOME).toBe("/home/agent");
  // (a) an unrelated secret in process.env never reaches the child
  expect(childEnv.ZAI_API_KEY).toBeUndefined();
});
