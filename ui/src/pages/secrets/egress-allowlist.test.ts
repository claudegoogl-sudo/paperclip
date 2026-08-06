// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { mergeOriginIntoAllowlist } from "./egress-allowlist";

describe("mergeOriginIntoAllowlist (replace-semantics merge)", () => {
  it("appends a new origin to the end of the current allowlist", () => {
    expect(mergeOriginIntoAllowlist(["a.example", "b.example"], "c.example")).toEqual([
      "a.example",
      "b.example",
      "c.example",
    ]);
  });

  it("preserves existing entries when adding one suggestion to a two-entry allowlist", () => {
    // AC5 verbatim: allow one suggestion on a binding that already has two
    // entries; assert the stored allowlist has three.
    const stored = mergeOriginIntoAllowlist(
      ["https://primary.example", "https://secondary.example"],
      "https://suggested.example",
    );
    expect(stored).toHaveLength(3);
    expect(stored).toEqual([
      "https://primary.example",
      "https://secondary.example",
      "https://suggested.example",
    ]);
  });

  it("is idempotent — re-allowing an origin already on the list does not duplicate it", () => {
    expect(mergeOriginIntoAllowlist(["a.example", "b.example"], "a.example")).toEqual([
      "a.example",
      "b.example",
    ]);
  });

  it("trims whitespace before de-dup so a padded duplicate cannot widen the list", () => {
    expect(mergeOriginIntoAllowlist(["a.example"], "  a.example  ")).toEqual(["a.example"]);
  });

  it("does not mutate the input array", () => {
    const input = ["a.example", "b.example"];
    mergeOriginIntoAllowlist(input, "c.example");
    expect(input).toEqual(["a.example", "b.example"]);
  });
});
