import { describe, it, expect } from "vitest";
import {
  DEFAULT_ALLOWED_TYPES,
  INLINE_ATTACHMENT_TYPES,
  isAllowedPluginArtifactMimeType,
  isInlineAttachmentContentType,
  matchesContentType,
  normalizeContentType,
  parseAllowedTypes,
} from "../attachment-types.js";

describe("parseAllowedTypes", () => {
  it("returns default image types when input is undefined", () => {
    expect(parseAllowedTypes(undefined)).toEqual([...DEFAULT_ALLOWED_TYPES]);
  });

  it("returns default image types when input is empty string", () => {
    expect(parseAllowedTypes("")).toEqual([...DEFAULT_ALLOWED_TYPES]);
  });

  it("parses comma-separated types", () => {
    expect(parseAllowedTypes("image/*,application/pdf")).toEqual([
      "image/*",
      "application/pdf",
    ]);
  });

  it("trims whitespace", () => {
    expect(parseAllowedTypes(" image/png , application/pdf ")).toEqual([
      "image/png",
      "application/pdf",
    ]);
  });

  it("lowercases entries", () => {
    expect(parseAllowedTypes("Application/PDF")).toEqual(["application/pdf"]);
  });

  it("filters empty segments", () => {
    expect(parseAllowedTypes("image/png,,application/pdf,")).toEqual([
      "image/png",
      "application/pdf",
    ]);
  });
});

describe("matchesContentType", () => {
  it("matches exact types", () => {
    const patterns = ["application/pdf", "image/png"];
    expect(matchesContentType("application/pdf", patterns)).toBe(true);
    expect(matchesContentType("image/png", patterns)).toBe(true);
    expect(matchesContentType("text/plain", patterns)).toBe(false);
  });

  it("matches /* wildcard patterns", () => {
    const patterns = ["image/*"];
    expect(matchesContentType("image/png", patterns)).toBe(true);
    expect(matchesContentType("image/jpeg", patterns)).toBe(true);
    expect(matchesContentType("image/svg+xml", patterns)).toBe(true);
    expect(matchesContentType("application/pdf", patterns)).toBe(false);
  });

  it("matches .* wildcard patterns", () => {
    const patterns = ["application/vnd.openxmlformats-officedocument.*"];
    expect(
      matchesContentType(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        patterns,
      ),
    ).toBe(true);
    expect(
      matchesContentType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        patterns,
      ),
    ).toBe(true);
    expect(matchesContentType("application/pdf", patterns)).toBe(false);
  });

  it("is case-insensitive", () => {
    const patterns = ["application/pdf"];
    expect(matchesContentType("APPLICATION/PDF", patterns)).toBe(true);
    expect(matchesContentType("Application/Pdf", patterns)).toBe(true);
  });

  it("combines exact and wildcard patterns", () => {
    const patterns = ["image/*", "application/pdf", "text/*"];
    expect(matchesContentType("image/webp", patterns)).toBe(true);
    expect(matchesContentType("application/pdf", patterns)).toBe(true);
    expect(matchesContentType("text/csv", patterns)).toBe(true);
    expect(matchesContentType("application/zip", patterns)).toBe(false);
  });

  it("handles plain * as allow-all wildcard", () => {
    const patterns = ["*"];
    expect(matchesContentType("image/png", patterns)).toBe(true);
    expect(matchesContentType("application/pdf", patterns)).toBe(true);
    expect(matchesContentType("text/plain", patterns)).toBe(true);
    expect(matchesContentType("application/zip", patterns)).toBe(true);
  });
});

describe("normalizeContentType", () => {
  it("lowercases and trims explicit types", () => {
    expect(normalizeContentType(" Application/Zip ")).toBe("application/zip");
  });

  it("falls back to octet-stream when the type is missing", () => {
    expect(normalizeContentType(undefined)).toBe("application/octet-stream");
    expect(normalizeContentType("")).toBe("application/octet-stream");
  });
});

describe("isAllowedPluginArtifactMimeType", () => {
  // PLA-1140: full broadened set of inert common-file types that must pass.
  const inertAllowed = [
    // 3D / CAD
    "model/stl",
    "application/vnd.ms-pki.stl",
    "application/sla",
    "model/3mf",
    "application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
    "model/obj",
    "model/step",
    "application/step",
    "model/gltf-binary",
    "model/gltf+json",
    "model/ply",
    // office documents
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
    "application/rtf",
    // extra images
    "image/tiff",
    "image/bmp",
    "image/heic",
    "image/heif",
    // video
    "video/mp4",
    "video/webm",
    "video/quicktime",
  ];

  it("allows every broadened inert type", () => {
    for (const ct of inertAllowed) {
      expect(isAllowedPluginArtifactMimeType(ct)).toBe(true);
    }
  });

  it("matches case-insensitively", () => {
    expect(isAllowedPluginArtifactMimeType("Application/STEP")).toBe(true);
    expect(isAllowedPluginArtifactMimeType("MODEL/STL")).toBe(true);
    expect(isAllowedPluginArtifactMimeType("Application/VND.MS-PKI.STL")).toBe(true);
  });

  it("keeps the F2 exclusions (text/html, text/csv) rejected", () => {
    expect(isAllowedPluginArtifactMimeType("text/html")).toBe(false);
    expect(isAllowedPluginArtifactMimeType("text/csv")).toBe(false);
  });

  it("never allows executables", () => {
    for (const ct of [
      "application/x-msdownload",
      "application/x-sh",
      "application/x-msdos-program",
      "application/x-executable",
    ]) {
      expect(isAllowedPluginArtifactMimeType(ct)).toBe(false);
    }
  });

  it("leaves SVG and archive types gated (PLA-1141) until SecurityEngineer rules", () => {
    for (const ct of [
      "image/svg+xml",
      "application/zip",
      "application/gzip",
      "application/x-7z-compressed",
      "application/x-tar",
    ]) {
      expect(isAllowedPluginArtifactMimeType(ct)).toBe(false);
    }
  });
});

describe("isInlineAttachmentContentType", () => {
  it("allows the configured inline-safe types", () => {
    for (const contentType of ["image/png", "image/svg+xml", "application/pdf", "text/plain"]) {
      expect(isInlineAttachmentContentType(contentType)).toBe(true);
    }
  });

  it("rejects potentially unsafe or binary download types", () => {
    expect(INLINE_ATTACHMENT_TYPES).not.toContain("text/html");
    expect(isInlineAttachmentContentType("text/html")).toBe(false);
    expect(isInlineAttachmentContentType("application/zip")).toBe(false);
  });
});
