import { describe, expect, it } from "vitest";
import { isHighRiskConfigKey } from "../services/plugin-config-scope.js";

const wrap = (prop: unknown, extra: Record<string, unknown> = {}) => ({ properties: { k: prop }, ...extra } as never);

describe("isHighRiskConfigKey recursive walk", () => {
  it.each([
    ["top-level format", { format: "uri" }],
    ["nested properties", { properties: { a: { properties: { b: { format: "uri" } } } } }],
    ["items", { items: { format: "secret-ref" } }],
    ["prefixItems", { prefixItems: [{}, { format: "uri" }] }],
    ["additionalProperties", { additionalProperties: { format: "uri" } }],
    ["patternProperties", { patternProperties: { "^x": { format: "uri" } } }],
    ["if/then/else", { if: {}, then: {}, else: { format: "uri" } }],
    ["not", { not: { format: "secret-ref" } }],
    ["dependentSchemas", { dependentSchemas: { a: { format: "uri" } } }],
    ["deep combinators", { oneOf: [{ allOf: [{ anyOf: [{ format: "uri" }] }] }] }],
  ])("detects %s", (_l, prop) => {
    expect(isHighRiskConfigKey(wrap(prop), "k")).toBe(true);
  });

  it("follows $ref into $defs and definitions", () => {
    expect(isHighRiskConfigKey(wrap({ $ref: "#/$defs/u" }, { $defs: { u: { format: "uri" } } }), "k")).toBe(true);
    expect(isHighRiskConfigKey(wrap({ $ref: "#/definitions/u" }, { definitions: { u: { items: { format: "secret-ref" } } } }), "k")).toBe(true);
    expect(isHighRiskConfigKey(wrap({ $ref: "#/$defs/s" }, { $defs: { s: { type: "string" } } }), "k")).toBe(false);
  });

  it("fails closed on unresolvable or external $ref", () => {
    expect(isHighRiskConfigKey(wrap({ $ref: "#/$defs/missing" }), "k")).toBe(true);
    expect(isHighRiskConfigKey(wrap({ $ref: "https://example.com/s.json" }), "k")).toBe(true);
  });

  it("fails closed past the depth bound", () => {
    let node: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 40; i++) node = { properties: { n: node } };
    expect(isHighRiskConfigKey(wrap(node), "k")).toBe(true);
  });

  it("terminates on recursive $ref cycles and stays low-risk when no format", () => {
    const schema = wrap({ $ref: "#/$defs/tree" }, {
      $defs: { tree: { type: "object", properties: { child: { $ref: "#/$defs/tree" } } } },
    });
    expect(isHighRiskConfigKey(schema, "k")).toBe(false);
  });

  it("plain keys stay low-risk", () => {
    expect(isHighRiskConfigKey(wrap({ type: "string" }), "k")).toBe(false);
    expect(isHighRiskConfigKey(wrap({ type: "object", properties: { a: { type: "integer" } } }), "k")).toBe(false);
  });
});
