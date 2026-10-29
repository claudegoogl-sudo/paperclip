import { describe, expect, it } from "vitest";
import {
  collectSecretRefPaths,
  collectUriConfigPaths,
  isUuidSecretRef,
  parseSecretRefBindingObject,
  readConfigValueAtPath,
  writeConfigValueAtPath,
} from "./json-schema-secret-refs.js";

const UUID = "0cf2a8b0-4e6a-4d7a-9a9a-1a2b3c4d5e6f";

describe("isUuidSecretRef", () => {
  it("accepts a lowercase UUID", () => {
    expect(isUuidSecretRef(UUID)).toBe(true);
  });

  it("accepts an uppercase UUID", () => {
    expect(isUuidSecretRef(UUID.toUpperCase())).toBe(true);
  });

  it("rejects a non-UUID string", () => {
    expect(isUuidSecretRef("not-a-uuid")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isUuidSecretRef("")).toBe(false);
  });
});

describe("parseSecretRefBindingObject", () => {
  it("parses a binding with an explicit numeric version", () => {
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId: UUID, version: 3 })).toEqual({
      secretId: UUID,
      version: 3,
    });
  });

  it("defaults to latest when version is omitted", () => {
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId: UUID })).toEqual({
      secretId: UUID,
      version: "latest",
    });
  });

  it("accepts an explicit version: 'latest'", () => {
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId: UUID, version: "latest" })).toEqual({
      secretId: UUID,
      version: "latest",
    });
  });

  it("trims whitespace around the secretId", () => {
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId: `  ${UUID}  ` })).toEqual({
      secretId: UUID,
      version: "latest",
    });
  });

  it("returns null for a raw string value", () => {
    expect(parseSecretRefBindingObject(UUID)).toBeNull();
  });

  it("returns null for a bare secret-id string shaped like the old format", () => {
    expect(parseSecretRefBindingObject({ secretId: UUID })).toBeNull();
  });

  it("returns null for the wrong type discriminator", () => {
    expect(parseSecretRefBindingObject({ type: "plain", secretId: UUID })).toBeNull();
  });

  it("returns null for a non-UUID secretId", () => {
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId: "not-a-uuid" })).toBeNull();
  });

  it("returns null for a zero or negative version", () => {
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId: UUID, version: 0 })).toBeNull();
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId: UUID, version: -1 })).toBeNull();
  });

  it("returns null for a non-integer version", () => {
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId: UUID, version: 1.5 })).toBeNull();
  });

  it("returns null for an array", () => {
    expect(parseSecretRefBindingObject([{ type: "secret_ref", secretId: UUID }])).toBeNull();
  });

  it("returns null for null and undefined", () => {
    expect(parseSecretRefBindingObject(null)).toBeNull();
    expect(parseSecretRefBindingObject(undefined)).toBeNull();
  });
});

describe("collectSecretRefPaths / collectUriConfigPaths", () => {
  it("returns an empty set for a null or non-object schema", () => {
    expect(collectSecretRefPaths(null)).toEqual(new Set());
    expect(collectSecretRefPaths(undefined)).toEqual(new Set());
  });

  it("collects a top-level secret-ref field", () => {
    const schema = { properties: { apiKey: { type: "string", format: "secret-ref" } } };
    expect(collectSecretRefPaths(schema)).toEqual(new Set(["apiKey"]));
  });

  it("collects a nested secret-ref field with a dotted path", () => {
    const schema = {
      properties: {
        auth: {
          type: "object",
          properties: { token: { type: "string", format: "secret-ref" } },
        },
      },
    };
    expect(collectSecretRefPaths(schema)).toEqual(new Set(["auth.token"]));
  });

  it("recurses into allOf/anyOf/oneOf branches without adding a path prefix", () => {
    const schema = {
      allOf: [{ properties: { a: { format: "secret-ref" } } }],
      anyOf: [{ properties: { b: { format: "secret-ref" } } }],
      oneOf: [{ properties: { c: { format: "secret-ref" } } }],
    };
    expect(collectSecretRefPaths(schema)).toEqual(new Set(["a", "b", "c"]));
  });

  it("ignores a malformed allOf/anyOf/oneOf branch entry", () => {
    const schema = { allOf: [null, "not-an-object", { properties: { a: { format: "secret-ref" } } }] };
    expect(collectSecretRefPaths(schema)).toEqual(new Set(["a"]));
  });

  it("keeps secret-ref and uri collection independent", () => {
    const schema = {
      properties: {
        apiKey: { format: "secret-ref" },
        endpoint: { format: "uri" },
      },
    };
    expect(collectSecretRefPaths(schema)).toEqual(new Set(["apiKey"]));
    expect(collectUriConfigPaths(schema)).toEqual(new Set(["endpoint"]));
  });
});

describe("readConfigValueAtPath", () => {
  it("reads a nested value", () => {
    expect(readConfigValueAtPath({ auth: { token: "abc" } }, "auth.token")).toBe("abc");
  });

  it("returns undefined when an intermediate key is missing", () => {
    expect(readConfigValueAtPath({ auth: {} }, "auth.token")).toBeUndefined();
  });

  it("returns undefined when an intermediate value is not an object", () => {
    expect(readConfigValueAtPath({ auth: "not-an-object" }, "auth.token")).toBeUndefined();
  });

  it("returns undefined when an intermediate value is an array", () => {
    expect(readConfigValueAtPath({ auth: [] }, "auth.token")).toBeUndefined();
  });
});

describe("writeConfigValueAtPath", () => {
  it("writes a nested value, creating intermediate objects as needed", () => {
    expect(writeConfigValueAtPath({}, "auth.token", "abc")).toEqual({ auth: { token: "abc" } });
  });

  it("overwrites a non-object intermediate value with a fresh object", () => {
    expect(writeConfigValueAtPath({ auth: "stale" }, "auth.token", "abc")).toEqual({
      auth: { token: "abc" },
    });
  });

  it("deletes the key when value is undefined", () => {
    expect(writeConfigValueAtPath({ auth: { token: "abc", other: 1 } }, "auth.token", undefined)).toEqual({
      auth: { other: 1 },
    });
  });

  it("does not mutate the input config", () => {
    const input = { auth: { token: "abc" } };
    writeConfigValueAtPath(input, "auth.token", "changed");
    expect(input).toEqual({ auth: { token: "abc" } });
  });
});
