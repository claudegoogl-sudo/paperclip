import { describe, expect, it } from "vitest";

import { buildChildEnv } from "./server-utils.js";

/**
 * Security regression test at the ACTUAL spawn boundary.
 *
 * Threat (OWASP LLM06, sensitive-information disclosure): the Paperclip server
 * process holds every company's/agent's secrets. An adapter whose child runs on a prompt-logging
 * inference provider must not leak those into the child env — a shell toolset
 * could `printenv` them into a third-party-retained log.
 *
 * The earlier fix restricted only the object the hermes adapter *hands to*
 * `runChildProcess` (its `opts.env`). But `runChildProcess` merged the full
 * server `process.env` (minus PAPERCLIP_*) UNDERNEATH that object, re-leaking
 * every non-PAPERCLIP_ secret. These tests exercise `buildChildEnv` — the exact
 * merge `runChildProcess` now performs to produce the env passed to `spawn` —
 * so the invariant is verified where mediation actually happens, not one layer
 * above it.
 */
describe("buildChildEnv", () => {
  // A faithful stand-in for the server process env: unrelated secrets plus the
  // non-secret runtime essentials the child legitimately needs.
  const serverEnv: NodeJS.ProcessEnv = {
    MAC_PW: "s3cret-mac",
    ZAI_API_KEY: "zai-leak",
    TELEGRAM_BOT_TOKEN: "tg-leak",
    ANTHROPIC_API_KEY: "anthropic-leak",
    OPENROUTER_API_KEY: "another-agents-openrouter-key",
    PAPERCLIP_API_KEY: "some-other-agents-token",
    PATH: "/usr/bin:/bin",
    HOME: "/home/server",
  };

  // The least-privilege env the hermes adapter builds (allowlist + userEnv +
  // buildPaperclipEnv + explicit PAPERCLIP_* injections), collapsed to the
  // keys that matter for this assertion.
  const hermesEnv: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/agent",
    OPENROUTER_API_KEY: "sk-or-agent-own-key", // adapterConfig.env (userEnv)
    PAPERCLIP_API_KEY: "pat-agent-least-privilege", // injected authToken
  };

  it("inheritServerEnv:false — no unlisted server secret reaches the child (the vuln)", () => {
    const child = buildChildEnv(hermesEnv, {
      inheritServerEnv: false,
      processEnv: serverEnv,
    });

    // (a) Secrets that live only in the server env are ABSENT from the child.
    //     This assertion FAILS against the pre-fix code (which always merged
    //     process.env underneath opts.env).
    expect(child.MAC_PW).toBeUndefined();
    expect(child.ZAI_API_KEY).toBeUndefined();
    expect(child.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(child.ANTHROPIC_API_KEY).toBeUndefined();

    // Even a var whose NAME the agent legitimately owns must resolve to the
    // agent's own value, never another agent's server-env value.
    expect(child.OPENROUTER_API_KEY).toBe("sk-or-agent-own-key");
    expect(child.PAPERCLIP_API_KEY).toBe("pat-agent-least-privilege");

    // (b)/(c) The agent's own env and non-secret essentials are PRESENT.
    expect(child.PATH).toBe("/usr/bin:/bin");
    expect(child.HOME).toBe("/home/agent");
  });

  it("default (inheritServerEnv omitted) preserves historical inherit-minus-PAPERCLIP_ behavior", () => {
    const child = buildChildEnv(hermesEnv, { processEnv: serverEnv });

    // Historical behavior for claude-local/gemini-local/etc: non-PAPERCLIP_
    // server vars are inherited (this is exactly what hermes must opt OUT of).
    expect(child.MAC_PW).toBe("s3cret-mac");
    expect(child.ZAI_API_KEY).toBe("zai-leak");
    // PAPERCLIP_* from the server env is stripped by sanitizeInheritedPaperclipEnv,
    // then re-supplied by opts.env with the agent's own least-privilege token.
    expect(child.PAPERCLIP_API_KEY).toBe("pat-agent-least-privilege");
    // opts.env still wins the overlap.
    expect(child.OPENROUTER_API_KEY).toBe("sk-or-agent-own-key");
    expect(child.HOME).toBe("/home/agent");
  });

  it("strips CLAUDE_CODE_* nesting vars regardless of inheritance mode", () => {
    const withNesting = { ...hermesEnv, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" };

    const inherited = buildChildEnv(withNesting, { processEnv: serverEnv });
    const isolated = buildChildEnv(withNesting, {
      inheritServerEnv: false,
      processEnv: serverEnv,
    });

    for (const child of [inherited, isolated]) {
      expect(child.CLAUDECODE).toBeUndefined();
      expect(child.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    }
  });

  it("ensures PATH even when the caller's env omits it and inheritance is off", () => {
    const noPath = { HOME: "/home/agent" };
    const child = buildChildEnv(noPath, {
      inheritServerEnv: false,
      processEnv: serverEnv,
    });
    expect(typeof child.PATH).toBe("string");
    expect((child.PATH ?? "").length).toBeGreaterThan(0);
  });
});
