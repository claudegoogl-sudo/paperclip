import { describe, expect, it } from "vitest";
import { createKvDemoConfig, readConfigFromEnv } from "./config.js";

describe("createKvDemoConfig", () => {
  it("applies defaults when no input is given", () => {
    expect(createKvDemoConfig({})).toEqual({
      port: 8848,
      host: "127.0.0.1",
      token: null,
    });
  });

  it("falls back to the default port for null, undefined, or empty string", () => {
    expect(createKvDemoConfig({ port: null }).port).toBe(8848);
    expect(createKvDemoConfig({ port: undefined }).port).toBe(8848);
    expect(createKvDemoConfig({ port: "" }).port).toBe(8848);
  });

  it("accepts a numeric or numeric-string port", () => {
    expect(createKvDemoConfig({ port: 3000 }).port).toBe(3000);
    expect(createKvDemoConfig({ port: "3000" }).port).toBe(3000);
  });

  it("throws on a non-integer, negative, or out-of-range port", () => {
    expect(() => createKvDemoConfig({ port: "not-a-number" })).toThrow("Invalid port");
    expect(() => createKvDemoConfig({ port: -1 })).toThrow("Invalid port");
    expect(() => createKvDemoConfig({ port: 65536 })).toThrow("Invalid port");
    expect(() => createKvDemoConfig({ port: 1.5 })).toThrow("Invalid port");
  });

  it("trims a provided host and falls back to the default when blank", () => {
    expect(createKvDemoConfig({ host: "  0.0.0.0  " }).host).toBe("0.0.0.0");
    expect(createKvDemoConfig({ host: "   " }).host).toBe("127.0.0.1");
    expect(createKvDemoConfig({ host: null }).host).toBe("127.0.0.1");
  });

  it("trims a provided token and reports null when blank or absent", () => {
    expect(createKvDemoConfig({ token: "  secret  " }).token).toBe("secret");
    expect(createKvDemoConfig({ token: "   " }).token).toBeNull();
    expect(createKvDemoConfig({ token: null }).token).toBeNull();
    expect(createKvDemoConfig({}).token).toBeNull();
  });
});

describe("readConfigFromEnv", () => {
  it("applies defaults when no relevant env vars are set", () => {
    expect(readConfigFromEnv({} as NodeJS.ProcessEnv)).toEqual({
      port: 8848,
      host: "127.0.0.1",
      token: null,
    });
  });

  it("prefers PORT over KV_DEMO_PORT when both are set", () => {
    const config = readConfigFromEnv({ PORT: "4000", KV_DEMO_PORT: "5000" } as NodeJS.ProcessEnv);
    expect(config.port).toBe(4000);
  });

  it("falls back to KV_DEMO_PORT when PORT is unset", () => {
    const config = readConfigFromEnv({ KV_DEMO_PORT: "5000" } as NodeJS.ProcessEnv);
    expect(config.port).toBe(5000);
  });

  it("reads host and token from their respective env vars", () => {
    const config = readConfigFromEnv({
      KV_DEMO_HOST: "0.0.0.0",
      KV_DEMO_TOKEN: "env-secret",
    } as NodeJS.ProcessEnv);
    expect(config.host).toBe("0.0.0.0");
    expect(config.token).toBe("env-secret");
  });
});
