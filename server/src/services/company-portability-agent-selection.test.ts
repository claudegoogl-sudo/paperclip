import { describe, expect, it } from "vitest";
import { withBuiltInAgentMarker } from "../lib/built-in-agent-metadata.js";
import { resolvePortableExportAgentSelection } from "./company-portability-agent-selection.js";

const researchBot = { id: "a1", name: "Research Bot", status: "active", metadata: {} };
const ceoAgent = {
  id: "a2",
  name: "CEO",
  status: "active",
  metadata: withBuiltInAgentMarker({}, { key: "ceo", featureKeys: ["heartbeat"] }),
};
const terminatedBot = { id: "a3", name: "Terminated Bot", status: "terminated", metadata: {} };

const allAgents = [researchBot, ceoAgent, terminatedBot];

describe("resolvePortableExportAgentSelection", () => {
  it("returns no agents and no warnings when includeAgents is false and no selectors are given", () => {
    const result = resolvePortableExportAgentSelection(allAgents, undefined, false);
    expect(result).toEqual({ agents: [], warnings: [] });
  });

  it("falls back to every portable (live, non-built-in) agent when includeAgents is true with no effective selectors", () => {
    const result = resolvePortableExportAgentSelection(allAgents, undefined, true);
    expect(result.agents).toEqual([researchBot]);
    expect(result.warnings).toEqual([
      "Skipped 1 terminated agent from export.",
      "Skipped 1 built-in managed agent from export.",
    ]);
  });

  it("selects an agent by exact id", () => {
    const result = resolvePortableExportAgentSelection(allAgents, ["a1"], false);
    expect(result.agents).toEqual([researchBot]);
    expect(result.warnings).toEqual([]);
  });

  it("selects an agent by its exact name", () => {
    const result = resolvePortableExportAgentSelection(allAgents, ["Research Bot"], false);
    expect(result.agents).toEqual([researchBot]);
  });

  it("selects an agent by a differently-cased/spaced normalized name", () => {
    const result = resolvePortableExportAgentSelection(allAgents, ["research bot"], false);
    expect(result.agents).toEqual([researchBot]);
  });

  it("warns and skips a selector naming a built-in managed agent instead of selecting it", () => {
    const result = resolvePortableExportAgentSelection(allAgents, ["CEO"], false);
    expect(result.agents).toEqual([]);
    expect(result.warnings).toEqual(['Agent selector "CEO" is a built-in managed agent and was skipped.']);
  });

  it("warns and skips a selector that matches no agent", () => {
    const result = resolvePortableExportAgentSelection(allAgents, ["Nonexistent"], false);
    expect(result.agents).toEqual([]);
    expect(result.warnings).toEqual(['Agent selector "Nonexistent" was not found and was skipped.']);
  });

  it("deduplicates repeated selectors matching the same agent", () => {
    const result = resolvePortableExportAgentSelection(allAgents, ["a1", "Research Bot"], false);
    expect(result.agents).toEqual([researchBot]);
  });

  it("skips empty or whitespace-only selector entries without a warning", () => {
    const result = resolvePortableExportAgentSelection(allAgents, ["", "   ", "a1"], false);
    expect(result.agents).toEqual([researchBot]);
    expect(result.warnings).toEqual([]);
  });

  it("does not fall back to all portable agents when an effective explicit selection already exists", () => {
    const result = resolvePortableExportAgentSelection(allAgents, ["a1"], true);
    expect(result.agents).toEqual([researchBot]);
  });

  it("does not warn about terminated or built-in agents when includeAgents is false", () => {
    const result = resolvePortableExportAgentSelection(allAgents, [], false);
    expect(result.warnings).toEqual([]);
  });
});
