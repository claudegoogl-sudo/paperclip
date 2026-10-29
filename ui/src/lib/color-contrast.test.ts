// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  hexToRgb,
  pickTextColorForPillBg,
  READABLE_TEXT_DARK,
  READABLE_TEXT_LIGHT,
} from "./color-contrast";

describe("hexToRgb", () => {
  it("parses a 6-digit hex with a leading #", () => {
    expect(hexToRgb("#336699")).toEqual({ r: 51, g: 102, b: 153 });
  });

  it("parses a 6-digit hex without a leading #", () => {
    expect(hexToRgb("336699")).toEqual({ r: 51, g: 102, b: 153 });
  });

  it("is case-insensitive for 6-digit hex", () => {
    expect(hexToRgb("#AABBCC")).toEqual(hexToRgb("#aabbcc"));
    expect(hexToRgb("#AaBbCc")).toEqual({ r: 170, g: 187, b: 204 });
  });

  it("expands a 3-digit hex by duplicating each nibble, with or without #", () => {
    // #abc -> each digit doubled -> #aabbcc -> (170, 187, 204).
    // This is the CSS shorthand-hex expansion, and it is the mathematically
    // correct one: a prior audit suspected hexToRgb might mis-parse 3-digit
    // hex (e.g. treat "abc" as if it were a 6-digit string), but tracing the
    // implementation shows value.split("").map(c => `${c}${c}`).join("")
    // on "abc" correctly produces "aabbcc" before the hex is parsed.
    expect(hexToRgb("#abc")).toEqual({ r: 170, g: 187, b: 204 });
    expect(hexToRgb("abc")).toEqual({ r: 170, g: 187, b: 204 });
    expect(hexToRgb("#ABC")).toEqual({ r: 170, g: 187, b: 204 });
  });

  it("trims surrounding whitespace", () => {
    expect(hexToRgb("  #336699  ")).toEqual({ r: 51, g: 102, b: 153 });
  });

  it("returns null for hex strings of an unsupported length", () => {
    expect(hexToRgb("#12")).toBeNull();
    expect(hexToRgb("#1234")).toBeNull();
    expect(hexToRgb("#12345")).toBeNull();
    expect(hexToRgb("#1234567")).toBeNull();
  });

  it("returns null for non-hex characters", () => {
    expect(hexToRgb("#gggggg")).toBeNull();
    expect(hexToRgb("not-a-color")).toBeNull();
    expect(hexToRgb("")).toBeNull();
  });
});

describe("pickTextColorForPillBg", () => {
  it("falls back to light text for an unparseable color", () => {
    expect(pickTextColorForPillBg("not-a-color")).toBe(READABLE_TEXT_LIGHT);
  });

  it("picks dark text for a clearly light background (alpha=1 bypasses page-bg compositing)", () => {
    expect(pickTextColorForPillBg("#ffffff", 1)).toBe(READABLE_TEXT_DARK);
  });

  it("picks light text for a clearly dark background (alpha=1 bypasses page-bg compositing)", () => {
    expect(pickTextColorForPillBg("#000000", 1)).toBe(READABLE_TEXT_LIGHT);
  });

  it("switches from light to dark text exactly at the contrast-ratio crossover", () => {
    // With alpha=1 the pill color is used as-is (no page-bg compositing), so
    // the contrast comparison is deterministic. Gray level 121 sits just
    // below the white/black contrast-ratio crossover and 122 just above it
    // (computed from the WCAG relative-luminance formula this module uses).
    expect(pickTextColorForPillBg("#797979", 1)).toBe(READABLE_TEXT_LIGHT); // gray(121,121,121)
    expect(pickTextColorForPillBg("#7a7a7a", 1)).toBe(READABLE_TEXT_DARK); // gray(122,122,122)
  });

  it("composites a translucent dark pill over a light page background", () => {
    document.documentElement.classList.remove("dark");
    // black pill at the default 0.22 alpha over a white page background
    // composites to light gray (199,199,199), which reads better with dark text.
    expect(pickTextColorForPillBg("#000000")).toBe(READABLE_TEXT_DARK);
  });

  it("composites a translucent light pill over a dark page background", () => {
    document.documentElement.classList.add("dark");
    try {
      // white pill at the default 0.22 alpha over the dark page background
      // composites to near-black (75,75,77), which reads better with light text.
      expect(pickTextColorForPillBg("#ffffff")).toBe(READABLE_TEXT_LIGHT);
    } finally {
      document.documentElement.classList.remove("dark");
    }
  });
});
