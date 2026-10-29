import { describe, expect, it } from "vitest";
import {
  AGENT_ACTOR_SOURCES,
  BOARD_ACTOR_SOURCES,
  PLUGIN_CLAIMABLE_BOARD_ACTOR_SOURCES,
  requireAgentActorSource,
  requireBoardActorSource,
  requirePluginBoardActorSource,
} from "./actor-source.js";

describe("requireBoardActorSource", () => {
  it("accepts every known board actor source", () => {
    for (const source of BOARD_ACTOR_SOURCES) {
      expect(requireBoardActorSource(source)).toBe(source);
    }
  });

  it("denies an undefined source instead of falling back to a privileged default", () => {
    expect(() => requireBoardActorSource(undefined)).toThrow(/Board actor source is required/);
  });

  it("denies an unknown string source", () => {
    expect(() => requireBoardActorSource("super_admin")).toThrow(/Board actor source is required/);
  });

  it("denies a non-string source", () => {
    expect(() => requireBoardActorSource(42)).toThrow(/Board actor source is required/);
  });
});

describe("requirePluginBoardActorSource", () => {
  it("accepts every plugin-claimable board actor source", () => {
    for (const source of PLUGIN_CLAIMABLE_BOARD_ACTOR_SOURCES) {
      expect(requirePluginBoardActorSource(source)).toBe(source);
    }
  });

  it("denies the server-internal local_implicit source even though it is a valid board source", () => {
    expect(() => requirePluginBoardActorSource("local_implicit")).toThrow(
      /cannot be claimed by plugins/,
    );
  });

  it("denies an undefined source", () => {
    expect(() => requirePluginBoardActorSource(undefined)).toThrow(
      /requires an explicit board actor source/,
    );
  });

  it("denies an unknown source", () => {
    expect(() => requirePluginBoardActorSource("cloud_root")).toThrow(
      /requires an explicit board actor source/,
    );
  });
});

describe("requireAgentActorSource", () => {
  it("accepts every known agent actor source", () => {
    for (const source of AGENT_ACTOR_SOURCES) {
      expect(requireAgentActorSource(source)).toBe(source);
    }
  });

  it("denies an undefined source", () => {
    expect(() => requireAgentActorSource(undefined)).toThrow(/Agent actor source is required/);
  });

  it("denies a board source presented as an agent source", () => {
    expect(() => requireAgentActorSource("session")).toThrow(/Agent actor source is required/);
  });
});
