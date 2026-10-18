import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadHostConfig } from "./config.js";

/**
 * `loadHostConfig` fails closed on bad input, so most branches throw before
 * any filesystem check runs. The one branch that does touch the filesystem
 * (the registry-path safety check, delegated to `registryPathUnsafeReason`)
 * is exercised here against real, test-owned temp directories rather than a
 * mocked `fs`, matching this package's existing test style (see
 * `serve-config.test.ts`, which also drives real temp paths through
 * `saveRegistry`).
 */

function freshTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "broker-config-test-"));
}

function baseEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    BROKER_NODE_IDENTITY: "node-a",
    BROKER_SERVICE_UID: "100",
    BROKER_SERVICE_GID: "100",
    BROKER_RUNTIME_UID: "1000",
    ...overrides,
  };
}

describe("loadHostConfig", () => {
  it("throws when a required env var is missing", () => {
    const env = baseEnv();
    delete env.BROKER_NODE_IDENTITY;
    expect(() => loadHostConfig(env)).toThrow(/missing required env: BROKER_NODE_IDENTITY/);
  });

  it("throws when a uid env var is not a non-negative integer", () => {
    expect(() => loadHostConfig(baseEnv({ BROKER_SERVICE_UID: "not-a-number" }))).toThrow(
      /BROKER_SERVICE_UID must be a non-negative integer/,
    );
  });

  it("throws when BROKER_TAILSCALE_BIN is not an absolute path", () => {
    const dir = freshTmpDir();
    const env = baseEnv({
      BROKER_TAILSCALE_BIN: "tailscale",
      BROKER_REGISTRY_PATH: join(dir, "nested", "registry.json"),
    });
    expect(() => loadHostConfig(env)).toThrow(/BROKER_TAILSCALE_BIN must be an absolute path/);
  });

  it("builds a config from valid env, defaulting optional paths and ports", () => {
    const dir = freshTmpDir();
    const env = baseEnv({ BROKER_REGISTRY_PATH: join(dir, "nested", "registry.json") });
    const config = loadHostConfig(env);
    expect(config).toMatchObject({
      nodeIdentity: "node-a",
      serviceUid: 100,
      serviceGid: 100,
      runtimeUid: 1000,
      tailscaleBinPath: "/usr/bin/tailscale",
      protectedPorts: [],
    });
    expect(config.socketPath).toBe("/run/paperclip-tailscale-broker/broker.sock");
  });

  it("parses and sorts BROKER_PROTECTED_PORTS", () => {
    const dir = freshTmpDir();
    const env = baseEnv({
      BROKER_REGISTRY_PATH: join(dir, "nested", "registry.json"),
      BROKER_PROTECTED_PORTS: "8080, 22",
    });
    expect(loadHostConfig(env).protectedPorts).toEqual([22, 8080]);
  });

  it("fails closed when BROKER_PROTECTED_PORTS is malformed", () => {
    const dir = freshTmpDir();
    const env = baseEnv({
      BROKER_REGISTRY_PATH: join(dir, "nested", "registry.json"),
      BROKER_PROTECTED_PORTS: "not-a-port",
    });
    expect(() => loadHostConfig(env)).toThrow(/non-numeric entry/);
  });

  it("refuses to start when the registry parent directory is group/world writable", () => {
    const dir = freshTmpDir();
    chmodSync(dir, 0o777);
    const env = baseEnv({ BROKER_REGISTRY_PATH: join(dir, "registry.json") });
    expect(() => loadHostConfig(env)).toThrow(/registry parent directory is group\/world writable/);
  });

  it("allows a registry path whose parent directory does not exist yet", () => {
    const dir = freshTmpDir();
    const env = baseEnv({ BROKER_REGISTRY_PATH: join(dir, "does-not-exist-yet", "registry.json") });
    expect(() => loadHostConfig(env)).not.toThrow();
  });
});
