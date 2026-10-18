import { describe, expect, it } from "vitest";
import { redactEventPayload, redactSensitiveText } from "../redaction.js";

describe("public Executor selectors and secret redaction", () => {
  it("preserves dotted helper addresses without treating them as credentials", () => {
    const path = "executor.coreTools.integrations.list";
    expect(redactEventPayload({ path, text: `Call tools.${path}({})` })).toEqual({ path, text: `Call tools.${path}({})` });
    expect(redactSensitiveText(path)).toBe(path);
    // Fork hardening: a longer address that only shares the selector's prefix may be a
    // secret, so it is redacted rather than preserved (upstream preserves it).
    expect(redactSensitiveText(`${path}.privateSecretSuffix`)).toContain("REDACTED");
    // Fork hardening: any three-segment dotted event value is treated as JWT-shaped (upstream preserves it).
    expect(redactEventPayload({ path: "arbitrary.provider.path" })?.path).toBe("***REDACTED***");
  });
  it("still redacts secret fields, bearer values, and JWT-shaped strings", () => {
    const value = "executor.coreTools.integrations.list";
    expect(redactEventPayload({ token: value })?.token).toContain("REDACTED");
    expect(redactSensitiveText(`Authorization: Bearer ${value}`)).not.toContain(value);
    expect(redactSensitiveText(`TOKEN=${value}`)).not.toContain(value);
    expect(redactSensitiveText("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345678")).toContain("REDACTED");
  });
});
