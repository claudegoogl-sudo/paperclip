import { PROJECT_ICON_NAMES } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { getProjectIcon, PROJECT_ICONS } from "./project-icons";

describe("getProjectIcon", () => {
  it("maps every known project icon name to its registered icon component", () => {
    for (const name of PROJECT_ICON_NAMES) {
      expect(getProjectIcon(name)).toBe(PROJECT_ICONS[name]);
    }
  });

  it("falls back to the folder icon for null", () => {
    expect(getProjectIcon(null)).toBe(PROJECT_ICONS.folder);
  });

  it("falls back to the folder icon for undefined", () => {
    expect(getProjectIcon(undefined)).toBe(PROJECT_ICONS.folder);
  });

  it("falls back to the folder icon for an empty string", () => {
    expect(getProjectIcon("")).toBe(PROJECT_ICONS.folder);
  });

  it("falls back to the folder icon for an unrecognized name", () => {
    expect(getProjectIcon("not-a-real-icon")).toBe(PROJECT_ICONS.folder);
  });

  it("is case-sensitive and falls back for a differently-cased known name", () => {
    expect(getProjectIcon("Folder")).toBe(PROJECT_ICONS.folder);
    expect(getProjectIcon("ROCKET")).toBe(PROJECT_ICONS.folder);
  });
});
