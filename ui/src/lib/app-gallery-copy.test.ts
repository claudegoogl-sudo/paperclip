import { describe, expect, it } from "vitest";
import { sanitizeProsumerCopy } from "./app-gallery-copy";

describe("sanitizeProsumerCopy", () => {
  it("strips the irregular plural 'policies' of the banned word 'policy'", () => {
    expect(sanitizeProsumerCopy("Review our pricing policies.")).toBe("Review our pricing.");
  });

  it("still strips the regular singular 'policy'", () => {
    expect(sanitizeProsumerCopy("Review our pricing policy.")).toBe("Review our pricing.");
  });

  it("still strips a regular plural formed with a trailing 's' (e.g. 'servers')", () => {
    expect(sanitizeProsumerCopy("Multiple servers are supported.")).toBe(
      "Multiple are supported.",
    );
  });
});
