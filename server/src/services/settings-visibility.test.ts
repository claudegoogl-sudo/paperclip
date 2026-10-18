import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLogger = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({ logger: mockLogger }));

import { getHiddenSettings, HIDDEN_SETTINGS_ENV_KEY } from "./settings-visibility.js";

describe("getHiddenSettings", () => {
  beforeEach(() => {
    mockLogger.warn.mockClear();
  });

  it("returns an empty set when the env var is unset", () => {
    expect(getHiddenSettings({})).toEqual(new Set());
  });

  it("returns a set with every known hidden key, deduplicated", () => {
    const hidden = getHiddenSettings({
      [HIDDEN_SETTINGS_ENV_KEY]: "workspaces.isolation,workspaces.isolation",
    });
    expect(hidden).toEqual(new Set(["workspaces.isolation"]));
  });

  it("warns once about unknown keys and omits them from the result", () => {
    const hidden = getHiddenSettings({
      [HIDDEN_SETTINGS_ENV_KEY]: "workspaces.isolation,not_a_real_setting_key_1",
    });
    expect(hidden).toEqual(new Set(["workspaces.isolation"]));
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0]![0]).toMatchObject({
      unknownKeys: ["not_a_real_setting_key_1"],
    });
  });

  it("does not warn when there are no unknown keys", () => {
    getHiddenSettings({ [HIDDEN_SETTINGS_ENV_KEY]: "workspaces.isolation" });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("caches the parsed set for an unchanged raw value instead of reparsing", () => {
    const raw = "workspaces.isolation,not_a_real_setting_key_2";
    const first = getHiddenSettings({ [HIDDEN_SETTINGS_ENV_KEY]: raw });
    const second = getHiddenSettings({ [HIDDEN_SETTINGS_ENV_KEY]: raw });
    expect(second).toBe(first);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });

  it("reparses when the raw value changes", () => {
    const first = getHiddenSettings({ [HIDDEN_SETTINGS_ENV_KEY]: "workspaces.isolation" });
    const second = getHiddenSettings({ [HIDDEN_SETTINGS_ENV_KEY]: "" });
    expect(second).not.toBe(first);
    expect(second).toEqual(new Set());
  });

  it("defaults to reading process.env when no env argument is given", () => {
    const previous = process.env[HIDDEN_SETTINGS_ENV_KEY];
    process.env[HIDDEN_SETTINGS_ENV_KEY] = "workspaces.isolation";
    try {
      expect(getHiddenSettings()).toEqual(new Set(["workspaces.isolation"]));
    } finally {
      if (previous === undefined) delete process.env[HIDDEN_SETTINGS_ENV_KEY];
      else process.env[HIDDEN_SETTINGS_ENV_KEY] = previous;
    }
  });
});
