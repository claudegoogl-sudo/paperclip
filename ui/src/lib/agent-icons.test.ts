import { AGENT_ICON_NAMES } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { AGENT_ICONS, getAgentIcon } from "./agent-icons";

describe("getAgentIcon", () => {
  it("resolves every known AgentIconName to its mapped icon component", () => {
    for (const name of AGENT_ICON_NAMES) {
      expect(getAgentIcon(name)).toBe(AGENT_ICONS[name]);
    }
  });

  it("falls back to the bot icon for an unrecognized icon name", () => {
    expect(getAgentIcon("not-a-real-icon")).toBe(AGENT_ICONS.bot);
  });

  it("falls back to the bot icon for an empty string", () => {
    expect(getAgentIcon("")).toBe(AGENT_ICONS.bot);
  });

  it("falls back to the bot icon for null", () => {
    expect(getAgentIcon(null)).toBe(AGENT_ICONS.bot);
  });

  it("falls back to the bot icon for undefined", () => {
    expect(getAgentIcon(undefined)).toBe(AGENT_ICONS.bot);
  });

  it("defines a mapping entry for every name in AGENT_ICON_NAMES with no extras", () => {
    const mappedKeys = Object.keys(AGENT_ICONS).sort();
    const expectedKeys = [...AGENT_ICON_NAMES].sort();
    expect(mappedKeys).toEqual(expectedKeys);
  });
});
