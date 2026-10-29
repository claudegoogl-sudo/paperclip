import { describe, expect, it } from "vitest";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "./default-agent-instructions.js";

describe("resolveDefaultAgentInstructionsBundleRole", () => {
  it("resolves the literal 'ceo' role to 'ceo'", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("ceo")).toBe("ceo");
  });

  it("falls back to 'default' for any other role, including case variants and empty string", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("admin")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("CEO")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("default")).toBe("default");
  });
});

describe("loadDefaultAgentInstructionsBundle", () => {
  it("loads the single-file default bundle with non-empty content", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("default");
    expect(Object.keys(bundle)).toEqual(["AGENTS.md"]);
    expect(bundle["AGENTS.md"]!.length).toBeGreaterThan(0);
  });

  it("loads the ceo bundle (AGENTS.md only, per upstream #14985) with non-empty content", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("ceo");
    expect(Object.keys(bundle).sort()).toEqual(
      ["AGENTS.md"],
    );
    for (const fileName of Object.keys(bundle)) {
      expect(bundle[fileName]!.length).toBeGreaterThan(0);
    }
  });
});
