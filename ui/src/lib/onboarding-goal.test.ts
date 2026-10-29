import { describe, expect, it } from "vitest";
import { formatOnboardingGoalInput, parseOnboardingGoalInput } from "./onboarding-goal";

describe("parseOnboardingGoalInput", () => {
  it("returns an empty title and null description for empty input", () => {
    expect(parseOnboardingGoalInput("")).toEqual({ title: "", description: null });
  });

  it("returns an empty title and null description for whitespace-only input", () => {
    expect(parseOnboardingGoalInput("   \n\t  ")).toEqual({ title: "", description: null });
  });

  it("uses a single line of input as the title with no description", () => {
    expect(parseOnboardingGoalInput("Ship the onboarding wizard")).toEqual({
      title: "Ship the onboarding wizard",
      description: null,
    });
  });

  it("trims surrounding whitespace from a single-line title", () => {
    expect(parseOnboardingGoalInput("  Ship the onboarding wizard  \n")).toEqual({
      title: "Ship the onboarding wizard",
      description: null,
    });
  });

  it("splits the first line into the title and the rest into the description", () => {
    expect(parseOnboardingGoalInput("Grow revenue\n\nFocus on enterprise accounts first.")).toEqual({
      title: "Grow revenue",
      description: "Focus on enterprise accounts first.",
    });
  });

  it("treats a title followed only by blank lines as having no description", () => {
    expect(parseOnboardingGoalInput("Grow revenue\n\n\n   \n")).toEqual({
      title: "Grow revenue",
      description: null,
    });
  });

  it("joins multiple remaining lines back together with newlines in the description", () => {
    const result = parseOnboardingGoalInput("Title line\nSecond line\nThird line");
    expect(result).toEqual({
      title: "Title line",
      description: "Second line\nThird line",
    });
  });

  it("preserves blank lines inside a multi-line description", () => {
    const result = parseOnboardingGoalInput("Title\nPara one\n\nPara two");
    expect(result).toEqual({
      title: "Title",
      description: "Para one\n\nPara two",
    });
  });

  it("normalizes CRLF line endings the same way as LF", () => {
    const result = parseOnboardingGoalInput("Title line\r\nBody line one\r\nBody line two");
    expect(result).toEqual({
      title: "Title line",
      description: "Body line one\nBody line two",
    });
  });

  it("does not trim interior whitespace within the title line itself", () => {
    // The title is only trimmed at its edges; internal spacing is preserved.
    const result = parseOnboardingGoalInput("  Grow   revenue  \nmore");
    expect(result.title).toBe("Grow   revenue");
    expect(result.description).toBe("more");
  });

  it("handles very long single-line input without truncation", () => {
    const longTitle = "x".repeat(5000);
    expect(parseOnboardingGoalInput(longTitle)).toEqual({
      title: longTitle,
      description: null,
    });
  });

  it("handles very long multi-line input without truncation", () => {
    const longDescription = "y".repeat(5000);
    const result = parseOnboardingGoalInput(`Title\n${longDescription}`);
    expect(result).toEqual({
      title: "Title",
      description: longDescription,
    });
  });
});

describe("formatOnboardingGoalInput", () => {
  it("returns an empty string when both title and description are empty", () => {
    expect(formatOnboardingGoalInput("", "")).toBe("");
    expect(formatOnboardingGoalInput("   ", "   ")).toBe("");
  });

  it("returns only the trimmed title when there is no description", () => {
    expect(formatOnboardingGoalInput("  Grow revenue  ")).toBe("Grow revenue");
    expect(formatOnboardingGoalInput("Grow revenue", null)).toBe("Grow revenue");
    expect(formatOnboardingGoalInput("Grow revenue", "   ")).toBe("Grow revenue");
  });

  it("returns only the trimmed description when there is no title", () => {
    expect(formatOnboardingGoalInput("", "Focus on enterprise accounts.")).toBe(
      "Focus on enterprise accounts.",
    );
    expect(formatOnboardingGoalInput("   ", "  Focus on enterprise accounts.  ")).toBe(
      "Focus on enterprise accounts.",
    );
  });

  it("joins a title and description with a blank line between them", () => {
    expect(formatOnboardingGoalInput("Grow revenue", "Focus on enterprise accounts.")).toBe(
      "Grow revenue\n\nFocus on enterprise accounts.",
    );
  });

  it("trims the title and description before joining them", () => {
    expect(formatOnboardingGoalInput("  Grow revenue  ", "  Focus on enterprise.  ")).toBe(
      "Grow revenue\n\nFocus on enterprise.",
    );
  });

  it("round-trips a parsed title-only goal back to the same string", () => {
    const original = "Ship the onboarding wizard";
    const parsed = parseOnboardingGoalInput(original);
    expect(formatOnboardingGoalInput(parsed.title, parsed.description)).toBe(original);
  });

  it("round-trips a parsed title-and-description goal back to the same string", () => {
    const original = "Grow revenue\n\nFocus on enterprise accounts first.";
    const parsed = parseOnboardingGoalInput(original);
    expect(formatOnboardingGoalInput(parsed.title, parsed.description)).toBe(original);
  });

  it("round-trips formatted input back through parse", () => {
    const formatted = formatOnboardingGoalInput("Grow revenue", "Focus on enterprise accounts.");
    expect(parseOnboardingGoalInput(formatted)).toEqual({
      title: "Grow revenue",
      description: "Focus on enterprise accounts.",
    });
  });
});
