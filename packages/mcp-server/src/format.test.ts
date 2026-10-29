import { describe, expect, it } from "vitest";
import { PaperclipApiError } from "./client.js";
import { formatErrorResponse, formatTextResponse } from "./format.js";

describe("formatTextResponse", () => {
  it("passes a string value through unchanged", () => {
    expect(formatTextResponse("hello")).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("pretty-prints a non-string value as JSON", () => {
    const result = formatTextResponse({ a: 1, b: [2, 3] });
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ a: 1, b: [2, 3] }, null, 2) }],
    });
  });

  it("stringifies null and numeric values as JSON", () => {
    expect(formatTextResponse(null)).toEqual({
      content: [{ type: "text", text: "null" }],
    });
    expect(formatTextResponse(42)).toEqual({
      content: [{ type: "text", text: "42" }],
    });
  });
});

describe("formatErrorResponse", () => {
  it("formats a PaperclipApiError with its status, method, path, and body", () => {
    const error = new PaperclipApiError({
      status: 404,
      method: "GET",
      path: "/api/companies/1",
      body: { message: "not found" },
      message: "Company not found",
    });

    const result = formatErrorResponse(error);
    expect(result.content[0]!.type).toBe("text");
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      error: "Company not found",
      status: 404,
      method: "GET",
      path: "/api/companies/1",
      body: { message: "not found" },
    });
  });

  it("formats a generic Error using only its message", () => {
    const result = formatErrorResponse(new Error("boom"));
    expect(JSON.parse(result.content[0]!.text)).toEqual({ error: "boom" });
  });

  it("formats a non-Error thrown value by stringifying it", () => {
    const result = formatErrorResponse("unexpected string throw");
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      error: "unexpected string throw",
    });
  });
});
