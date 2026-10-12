import { describe, expect, it } from "vitest";
import { redactEventPayload } from "../redaction.js";

describe("approval version redaction", () => {
  it("keeps plugin versions visible but still redacts secrets", () => {
    const out = redactEventPayload({
      kind: "plugin_capability_escalation",
      fromVersion: "0.2.24",
      toVersion: "0.2.27",
      apiToken: "abc",
      note: "aaa.bbb.ccc",
    })!;
    expect(out.fromVersion).toBe("0.2.24");
    expect(out.toVersion).toBe("0.2.27");
    expect(out.apiToken).toBe("***REDACTED***");
    expect(out.note).toBe("***REDACTED***");
  });
});
