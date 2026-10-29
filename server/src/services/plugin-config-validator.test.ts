import { describe, expect, it } from "vitest";
import { validateInstanceConfig } from "./plugin-config-validator.js";
import type { JsonSchema } from "@paperclipai/shared";

describe("validateInstanceConfig", () => {
  it("passes a config that matches its schema", () => {
    const schema = {
      type: "object",
      properties: { apiUrl: { type: "string" } },
      required: ["apiUrl"],
    } as JsonSchema;
    expect(validateInstanceConfig({ apiUrl: "https://example.com" }, schema)).toEqual({ valid: true });
  });

  it("reports a structured field error for a missing required field", () => {
    const schema = {
      type: "object",
      properties: { apiUrl: { type: "string" } },
      required: ["apiUrl"],
    } as JsonSchema;
    const result = validateInstanceConfig({}, schema);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("reports a field error with the instancePath for a type mismatch", () => {
    const schema = {
      type: "object",
      properties: { retries: { type: "number" } },
    } as JsonSchema;
    const result = validateInstanceConfig({ retries: "not-a-number" }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({ field: "/retries" }),
    ]);
  });

  it("reports multiple errors at once (allErrors: true)", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    } as JsonSchema;
    const result = validateInstanceConfig({}, schema);
    expect(result.valid).toBe(false);
    expect(result.errors!.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts the secret-ref format as a no-op annotation, not a validation failure", () => {
    const schema = {
      type: "object",
      properties: { apiKey: { type: "string", format: "secret-ref" } },
    } as JsonSchema;
    expect(validateInstanceConfig({ apiKey: "anything-at-all" }, schema)).toEqual({ valid: true });
  });

  it("accepts the x-paperclip-scope annotation keyword without rejecting the schema", () => {
    const schema = {
      type: "object",
      properties: {
        apiKey: { type: "string", "x-paperclip-scope": "per-tenant" },
      },
    } as JsonSchema;
    expect(validateInstanceConfig({ apiKey: "value" }, schema)).toEqual({ valid: true });
  });

  it("uses the root instancePath ('/') when the top-level config itself is the wrong type", () => {
    const schema = { type: "object" } as JsonSchema;
    // @ts-expect-error - intentionally passing a non-object config to exercise the root-path branch
    const result = validateInstanceConfig("not-an-object", schema);
    expect(result.valid).toBe(false);
    expect(result.errors![0]!.field).toBe("/");
  });
});
