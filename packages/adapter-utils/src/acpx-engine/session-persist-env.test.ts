import { describe, expect, it } from "vitest";
import {
  buildPersistedSessionEnv,
  findPersistedEnvValueLeaks,
  PERSISTED_ENV_REF_PREFIX,
} from "./session-persist-env.js";

// Session-record env redaction regression tests. All values here are DUMMY
// strings, never real credentials (secret-handling directive).

const SPAWN_ENV = {
  PAPERCLIP_AGENT_ID: "agent-dummy-1",
  PAPERCLIP_API_KEY: "pcp_dummy_not_a_real_key",
  ANTHROPIC_AUTH_TOKEN: "dummy-zai-token-not-a-secret",
  ANTHROPIC_MODEL: "claude-dummy-model",
} as const;

describe("session-persist-env", () => {
  it("maps every env key to a secret-ref marker naming the key, never the value", () => {
    const persisted = buildPersistedSessionEnv(SPAWN_ENV);
    expect(Object.keys(persisted).sort()).toEqual(Object.keys(SPAWN_ENV).sort());
    for (const [key, value] of Object.entries(persisted)) {
      expect(value).toBe(PERSISTED_ENV_REF_PREFIX + key);
    }
    expect(Object.values(persisted)).not.toContain(SPAWN_ENV.PAPERCLIP_API_KEY);
    expect(Object.values(persisted)).not.toContain(SPAWN_ENV.ANTHROPIC_AUTH_TOKEN);
  });

  it("is idempotent and value-independent: same key set -> same persisted map", () => {
    const rotated = { ...SPAWN_ENV, ANTHROPIC_AUTH_TOKEN: "dummy-rotated-2" };
    expect(buildPersistedSessionEnv(SPAWN_ENV)).toEqual(buildPersistedSessionEnv(rotated));
    expect(buildPersistedSessionEnv(buildPersistedSessionEnv(SPAWN_ENV))).toEqual(
      buildPersistedSessionEnv(SPAWN_ENV),
    );
  });

  it("the leak detector returns no leaks for the marker map", () => {
    expect(findPersistedEnvValueLeaks(SPAWN_ENV, buildPersistedSessionEnv(SPAWN_ENV))).toEqual([]);
  });

  it("the leak detector flags a persisted map that carries a real value", () => {
    const leaky = buildPersistedSessionEnv(SPAWN_ENV);
    leaky.ANTHROPIC_AUTH_TOKEN = SPAWN_ENV.ANTHROPIC_AUTH_TOKEN;
    expect(findPersistedEnvValueLeaks(SPAWN_ENV, leaky)).toEqual(["ANTHROPIC_AUTH_TOKEN"]);
  });
});
