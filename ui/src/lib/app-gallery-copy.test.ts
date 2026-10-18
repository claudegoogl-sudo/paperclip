import { describe, expect, it } from "vitest";
import { appCopyFor, credentialFieldLabel, sanitizeProsumerCopy } from "./app-gallery-copy";

describe("sanitizeProsumerCopy", () => {
  it("strips a banned word and collapses the resulting double space", () => {
    expect(sanitizeProsumerCopy("Zapier MCP token")).toBe("Zapier token");
  });

  it("strips multiple banned words, including a hyphen-adjacent one", () => {
    expect(sanitizeProsumerCopy("Connect Zapier-hosted MCP actions")).toBe(
      "Connect Zapier-hosted actions",
    );
  });

  it("is case-insensitive and matches a simple plural (singular + s)", () => {
    expect(sanitizeProsumerCopy("This has a Gateway and an endpoint, really.")).toBe(
      "This has a and an, really.",
    );
  });

  it("leaves text with no banned vocabulary untouched", () => {
    expect(sanitizeProsumerCopy("No banned words here.")).toBe("No banned words here.");
  });

  it("returns an empty string when the input is only a banned word", () => {
    expect(sanitizeProsumerCopy("  Server  ")).toBe("");
  });

  it("returns an empty string for empty input", () => {
    expect(sanitizeProsumerCopy("")).toBe("");
  });

  it("trims leading/trailing whitespace left after stripping", () => {
    expect(sanitizeProsumerCopy("  Zapier MCP token  ")).toBe("Zapier token");
  });
});

describe("appCopyFor", () => {
  it("returns the curated copy for a known app id", () => {
    expect(appCopyFor("zapier")).toEqual({
      tagline: "Reach 9,000+ apps your team already uses.",
      short: "Reach 9,000+ apps from your agents.",
    });
  });

  it("returns another known app's distinct curated copy", () => {
    expect(appCopyFor("github")).toEqual({
      tagline: "Read code and pull requests, comment on issues.",
      short: "Read code and pull requests, comment on issues.",
    });
  });

  it("falls back to the generic copy for an unknown app id with no fallback tagline", () => {
    expect(appCopyFor("totally-unknown-app")).toEqual({
      tagline: "Give your agents access to this app.",
      short: "Give your agents access to this app.",
    });
  });

  it("sanitizes and uses a fallback tagline for an unknown app id", () => {
    expect(appCopyFor("totally-unknown-app", "Zapier MCP server integration")).toEqual({
      tagline: "Zapier integration",
      short: "Zapier integration",
    });
  });

  it("falls back to generic copy when the fallback tagline is only banned vocabulary", () => {
    expect(appCopyFor("totally-unknown-app", "MCP")).toEqual({
      tagline: "Give your agents access to this app.",
      short: "Give your agents access to this app.",
    });
  });

  it("falls back to generic copy when the fallback tagline is an empty string", () => {
    expect(appCopyFor("totally-unknown-app", "")).toEqual({
      tagline: "Give your agents access to this app.",
      short: "Give your agents access to this app.",
    });
  });

  it("falls back to generic copy when no fallback tagline is passed", () => {
    expect(appCopyFor("totally-unknown-app", null)).toEqual({
      tagline: "Give your agents access to this app.",
      short: "Give your agents access to this app.",
    });
  });

  it("prefers curated copy over a fallback tagline when the key is known", () => {
    expect(appCopyFor("zapier", "Some other MCP server fallback")).toEqual({
      tagline: "Reach 9,000+ apps your team already uses.",
      short: "Reach 9,000+ apps from your agents.",
    });
  });
});

describe("credentialFieldLabel", () => {
  it("returns the generic single-field label regardless of the raw manifest label", () => {
    expect(credentialFieldLabel("Zapier", "Zapier MCP token", 1)).toBe("Your Zapier key");
  });

  it("returns the generic single-field label when fieldCount is 0", () => {
    expect(credentialFieldLabel("Zapier", "Zapier MCP token", 0)).toBe("Your Zapier key");
  });

  it("sanitizes and returns the raw label for a multi-field app", () => {
    expect(credentialFieldLabel("Zapier", "Zapier MCP token", 2)).toBe("Zapier token");
  });

  it("returns a multi-field label untouched when it has no banned vocabulary", () => {
    expect(credentialFieldLabel("Figma", "Personal access token", 2)).toBe(
      "Personal access token",
    );
  });

  it("falls back to the generic key label when sanitizing a multi-field label empties it", () => {
    expect(credentialFieldLabel("Zapier", "MCP", 2)).toBe("Your Zapier key");
  });
});
