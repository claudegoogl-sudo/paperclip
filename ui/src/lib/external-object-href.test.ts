import { describe, expect, it } from "vitest";
import { normalizeExternalObjectHref } from "./external-object-href";

describe("normalizeExternalObjectHref", () => {
  it("normalizes a well-formed absolute https URL unchanged", () => {
    expect(normalizeExternalObjectHref("https://example.com/foo/bar")).toBe(
      "https://example.com/foo/bar",
    );
  });

  it("normalizes a well-formed absolute http URL unchanged", () => {
    expect(normalizeExternalObjectHref("http://example.com/foo")).toBe("http://example.com/foo");
  });

  it("lowercases the host but leaves the path case alone", () => {
    expect(normalizeExternalObjectHref("https://Example.COM/Foo/Bar")).toBe(
      "https://example.com/Foo/Bar",
    );
  });

  it("drops the query string and fragment", () => {
    expect(normalizeExternalObjectHref("https://example.com/foo?bar=baz#frag")).toBe(
      "https://example.com/foo",
    );
  });

  it("defaults an empty pathname to /", () => {
    expect(normalizeExternalObjectHref("https://example.com")).toBe("https://example.com/");
  });

  it("preserves a non-default port", () => {
    expect(normalizeExternalObjectHref("https://example.com:8443/foo")).toBe(
      "https://example.com:8443/foo",
    );
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(normalizeExternalObjectHref("   https://example.com/foo  \n")).toBe(
      "https://example.com/foo",
    );
  });

  it("returns null for a relative path with no scheme", () => {
    expect(normalizeExternalObjectHref("/foo/bar")).toBeNull();
  });

  it("returns null for a protocol-relative URL with no scheme", () => {
    expect(normalizeExternalObjectHref("//example.com/foo")).toBeNull();
  });

  it("returns null for a non-URL string", () => {
    expect(normalizeExternalObjectHref("not a url")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(normalizeExternalObjectHref("")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(normalizeExternalObjectHref("   ")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(normalizeExternalObjectHref(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(normalizeExternalObjectHref(undefined)).toBeNull();
  });

  it("rejects non-http(s) schemes such as javascript:", () => {
    expect(normalizeExternalObjectHref("javascript:alert(1)")).toBeNull();
  });

  it("rejects non-http(s) schemes such as ftp:", () => {
    expect(normalizeExternalObjectHref("ftp://example.com/foo")).toBeNull();
  });

  it("rejects a mailto: URL", () => {
    expect(normalizeExternalObjectHref("mailto:a@example.com")).toBeNull();
  });

  it("rejects a URL containing userinfo (username only)", () => {
    expect(normalizeExternalObjectHref("https://user@example.com/foo")).toBeNull();
  });

  it("rejects a URL containing userinfo (username and password)", () => {
    expect(normalizeExternalObjectHref("https://user:pass@example.com/foo")).toBeNull();
  });
});
