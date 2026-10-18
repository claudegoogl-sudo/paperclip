import { describe, expect, it } from "vitest";
import {
  getPortableFileContentType,
  getPortableFileDataUrl,
  getPortableFileText,
  isPortableImageFile,
} from "./portable-files";

describe("getPortableFileText", () => {
  it("returns the string entry as-is", () => {
    expect(getPortableFileText("hello world")).toBe("hello world");
  });

  it("returns an empty string entry as-is", () => {
    expect(getPortableFileText("")).toBe("");
  });

  it("returns null for a base64 object entry", () => {
    expect(getPortableFileText({ encoding: "base64", data: "aGk=" })).toBeNull();
  });

  it("returns null for null", () => {
    expect(getPortableFileText(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(getPortableFileText(undefined)).toBeNull();
  });
});

describe("getPortableFileContentType", () => {
  it("prefers an explicit contentType on the entry over the extension", () => {
    expect(
      getPortableFileContentType("logo.png", {
        encoding: "base64",
        data: "AA==",
        contentType: "application/custom",
      }),
    ).toBe("application/custom");
  });

  it("falls back to the extension map when the entry has no contentType", () => {
    expect(getPortableFileContentType("logo.png", { encoding: "base64", data: "AA==" })).toBe(
      "image/png",
    );
  });

  it("falls back to the extension map when entry is a string", () => {
    expect(getPortableFileContentType("notes.svg", "just text")).toBe("image/svg+xml");
  });

  it("falls back to the extension map when entry is null", () => {
    expect(getPortableFileContentType("avatar.jpeg", null)).toBe("image/jpeg");
  });

  it("is case-insensitive when matching the extension", () => {
    expect(getPortableFileContentType("AVATAR.JPG", null)).toBe("image/jpeg");
  });

  it("matches .webp and .gif extensions", () => {
    expect(getPortableFileContentType("anim.gif", null)).toBe("image/gif");
    expect(getPortableFileContentType("photo.webp", null)).toBe("image/webp");
  });

  it("returns null when the path has no extension", () => {
    expect(getPortableFileContentType("README", null)).toBeNull();
  });

  it("returns null for an unrecognized extension", () => {
    expect(getPortableFileContentType("archive.zip", null)).toBeNull();
  });

  it("treats a falsy contentType on the entry as absent and falls back to the extension", () => {
    expect(
      getPortableFileContentType("logo.png", { encoding: "base64", data: "AA==", contentType: null }),
    ).toBe("image/png");
  });

  it("ignores a nested path's directory segments when checking the extension", () => {
    expect(getPortableFileContentType("assets/icons/star.svg", null)).toBe("image/svg+xml");
  });
});

describe("getPortableFileDataUrl", () => {
  it("builds a data URL using the entry's base64 data and resolved content type", () => {
    expect(getPortableFileDataUrl("logo.png", { encoding: "base64", data: "AAA=" })).toBe(
      "data:image/png;base64,AAA=",
    );
  });

  it("uses the entry's explicit contentType when present", () => {
    expect(
      getPortableFileDataUrl("file.bin", {
        encoding: "base64",
        data: "AAA=",
        contentType: "application/pdf",
      }),
    ).toBe("data:application/pdf;base64,AAA=");
  });

  it("falls back to application/octet-stream when no content type can be resolved", () => {
    expect(getPortableFileDataUrl("archive.zip", { encoding: "base64", data: "AAA=" })).toBe(
      "data:application/octet-stream;base64,AAA=",
    );
  });

  it("returns null when the entry is a string", () => {
    expect(getPortableFileDataUrl("notes.txt", "plain text contents")).toBeNull();
  });

  it("returns null when the entry is null", () => {
    expect(getPortableFileDataUrl("logo.png", null)).toBeNull();
  });

  it("returns null when the entry is undefined", () => {
    expect(getPortableFileDataUrl("logo.png", undefined)).toBeNull();
  });
});

describe("isPortableImageFile", () => {
  it("returns true for a resolved image content type", () => {
    expect(isPortableImageFile("logo.png", { encoding: "base64", data: "AA==" })).toBe(true);
  });

  it("returns true when an explicit image contentType is set on the entry", () => {
    expect(
      isPortableImageFile("file.bin", { encoding: "base64", data: "AA==", contentType: "image/png" }),
    ).toBe(true);
  });

  it("returns false for a non-image content type", () => {
    expect(
      isPortableImageFile("doc.pdf", { encoding: "base64", data: "AA==", contentType: "application/pdf" }),
    ).toBe(false);
  });

  it("returns false when the extension is unrecognized", () => {
    expect(isPortableImageFile("archive.zip", { encoding: "base64", data: "AA==" })).toBe(false);
  });

  it("resolves from the file path extension even when the entry is a string", () => {
    // The entry's own type does not gate the extension fallback, only an
    // object entry's explicit `contentType` field does.
    expect(isPortableImageFile("logo.png", "plain text")).toBe(true);
    expect(isPortableImageFile("notes.txt", "plain text")).toBe(false);
  });

  it("resolves from the file path extension even when the entry is null", () => {
    expect(isPortableImageFile("logo.png", null)).toBe(true);
    expect(isPortableImageFile("notes.txt", null)).toBe(false);
  });
});
