import { describe, expect, it } from "vitest";
import {
  collectSecretRefPaths,
  describeSecretRefValue,
  InvalidSecretRefAtPathError,
  validateSecretRefsAtPaths,
} from "../services/json-schema-secret-refs.ts";

describe("collectSecretRefPaths", () => {
  it("collects nested secret-ref paths from object properties", () => {
    expect(Array.from(collectSecretRefPaths({
      type: "object",
      properties: {
        credentials: {
          type: "object",
          properties: {
            apiKey: { type: "string", format: "secret-ref" },
          },
        },
      },
    }))).toEqual(["credentials.apiKey"]);
  });

  it("collects secret-ref paths from JSON Schema composition keywords", () => {
    expect(Array.from(collectSecretRefPaths({
      type: "object",
      allOf: [
        {
          properties: {
            apiKey: { type: "string", format: "secret-ref" },
          },
        },
        {
          properties: {
            nested: {
              oneOf: [
                {
                  properties: {
                    token: { type: "string", format: "secret-ref" },
                  },
                },
              ],
            },
          },
        },
      ],
    })).sort()).toEqual(["apiKey", "nested.token"]);
  });
});

/**
 * Regression tests for PLA-198 AC1/AC2:
 * caller-side secret-ref validation must surface the offending JSON path
 * with the documented `path=<dot.path> kind=opaque len=<N>` shape, and must
 * never echo the raw value into the message, fields, or stack trace text.
 *
 * Synthetic, shape-valid fixtures only — never use real PAT prefixes.
 */
describe("validateSecretRefsAtPaths (PLA-198 AC1/AC2)", () => {
  const schema = {
    type: "object",
    properties: {
      credentials: {
        type: "object",
        properties: {
          apiKey: { type: "string", format: "secret-ref" },
        },
      },
    },
  } as const;

  it("returns the UUID-shaped sentinel set for well-formed config", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    const refs = validateSecretRefsAtPaths(
      { credentials: { apiKey: uuid } },
      schema as unknown as Record<string, unknown>,
    );
    expect(Array.from(refs)).toEqual([uuid]);
  });

  it("treats unset / blank / null at secret-ref paths as 'no ref configured'", () => {
    expect(
      Array.from(
        validateSecretRefsAtPaths({}, schema as unknown as Record<string, unknown>),
      ),
    ).toEqual([]);
    expect(
      Array.from(
        validateSecretRefsAtPaths(
          { credentials: { apiKey: "" } },
          schema as unknown as Record<string, unknown>,
        ),
      ),
    ).toEqual([]);
    expect(
      Array.from(
        validateSecretRefsAtPaths(
          { credentials: { apiKey: "   " } },
          schema as unknown as Record<string, unknown>,
        ),
      ),
    ).toEqual([]);
    expect(
      Array.from(
        validateSecretRefsAtPaths(
          { credentials: { apiKey: null } },
          schema as unknown as Record<string, unknown>,
        ),
      ),
    ).toEqual([]);
  });

  it("rejects a ghp_-shaped value with path context and no value leak", () => {
    // Synthetic, shape-valid GitHub PAT — never use a real one in fixtures.
    const value = "ghp_" + "A".repeat(36);

    let captured: unknown;
    try {
      validateSecretRefsAtPaths(
        { credentials: { apiKey: value } },
        schema as unknown as Record<string, unknown>,
      );
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(InvalidSecretRefAtPathError);
    const err = captured as InvalidSecretRefAtPathError;
    expect(err.path).toBe("credentials.apiKey");
    expect(err.descriptor).toBe(`kind=opaque len=${value.length}`);
    expect(err.message).toBe(
      `path=credentials.apiKey kind=opaque len=${value.length}`,
    );

    // The full value, the prefix, and any partial token suffix must stay out
    // of every field that might surface to logs, audit comments, or HTTP
    // responses.
    expect(err.message).not.toContain(value);
    expect(err.message).not.toContain("ghp_");
    expect(err.descriptor).not.toContain(value);
    expect(err.descriptor).not.toContain("ghp_");
    expect((err.stack ?? "")).not.toContain(value);
  });

  it("rejects a non-string value with type descriptor and no echo", () => {
    let captured: unknown;
    try {
      validateSecretRefsAtPaths(
        { credentials: { apiKey: 42 } },
        schema as unknown as Record<string, unknown>,
      );
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(InvalidSecretRefAtPathError);
    const err = captured as InvalidSecretRefAtPathError;
    expect(err.path).toBe("credentials.apiKey");
    expect(err.descriptor).toBe("kind=non-string type=number");
    expect(err.message).not.toContain("42");
  });

  it("rejects deeply-nested non-UUID values with the full dot.path", () => {
    const deepSchema = {
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: {
            inner: {
              type: "object",
              properties: {
                token: { type: "string", format: "secret-ref" },
              },
            },
          },
        },
      },
    };
    const value = "github_pat_" + "A".repeat(22) + "_" + "B".repeat(59);
    let captured: unknown;
    try {
      validateSecretRefsAtPaths(
        { outer: { inner: { token: value } } },
        deepSchema as unknown as Record<string, unknown>,
      );
    } catch (err) {
      captured = err;
    }
    const err = captured as InvalidSecretRefAtPathError;
    expect(err).toBeInstanceOf(InvalidSecretRefAtPathError);
    expect(err.path).toBe("outer.inner.token");
    expect(err.descriptor).toBe(`kind=opaque len=${value.length}`);
    expect(err.message).not.toContain(value);
    expect(err.message).not.toContain("github_pat_");
  });
});

describe("describeSecretRefValue", () => {
  it("never echoes opaque secret-shaped strings", () => {
    const value = "ghp_" + "C".repeat(36);
    const descriptor = describeSecretRefValue(value);
    expect(descriptor).toBe(`kind=opaque len=${value.length}`);
    expect(descriptor).not.toContain("ghp_");
    expect(descriptor).not.toContain(value);
  });

  it("describes UUID sentinels as themselves (they are not secret material)", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    expect(describeSecretRefValue(uuid)).toBe(`kind=uuid value=${uuid}`);
  });

  it("describes empty / null / undefined / non-string without leaking", () => {
    expect(describeSecretRefValue(undefined)).toBe("kind=undefined");
    expect(describeSecretRefValue(null)).toBe("kind=null");
    expect(describeSecretRefValue("")).toBe("kind=empty");
    expect(describeSecretRefValue("  ")).toBe("kind=whitespace len=2");
    expect(describeSecretRefValue(42)).toBe("kind=non-string type=number");
    expect(describeSecretRefValue(42)).not.toContain("42");
  });
});
