import { describe, it, expect } from "vitest";
import {
  DEFAULT_ALLOWED_TYPES,
  formatAttachmentSize,
  INLINE_ATTACHMENT_TYPES,
  inferOfficeAttachmentContentTypeFromFilename,
  isAllowedPluginArtifactMimeType,
  isInlineAttachmentContentType,
  isSpreadsheetBaitPluginArtifact,
  matchesContentType,
  MAX_ATTACHMENT_BYTES,
  normalizeContentType,
  normalizeUploadAttachmentContentType,
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

  it("allows common Office document types by default", () => {
    for (const contentType of [
      "application/msword",
      "application/vnd.ms-excel",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ]) {
      expect(matchesContentType(contentType, [...DEFAULT_ALLOWED_TYPES])).toBe(true);
    }
  });

  it("allows common chat audio types by default", () => {
    for (const contentType of [
      "audio/mpeg",
      "audio/mp4",
      "audio/ogg",
      "audio/wav",
      "audio/webm",
    ]) {
      expect(matchesContentType(contentType, [...DEFAULT_ALLOWED_TYPES])).toBe(
        true,
      );
    }
  });
});

describe("normalizeContentType", () => {
  it("lowercases and trims explicit types", () => {
    expect(normalizeContentType(" Application/Zip ")).toBe("application/zip");
  });

  it("normalizes provider Content-Type header parameters to the MIME essence", () => {
    expect(normalizeContentType(" Text/Plain ; charset=utf-8 ")).toBe(
      "text/plain",
    );
    expect(normalizeContentType("image/svg+xml; charset=utf-8")).toBe(
      "image/svg+xml",
    );
  });

  it("falls back to octet-stream when the type is missing", () => {
    expect(normalizeContentType(undefined)).toBe("application/octet-stream");
    expect(normalizeContentType("")).toBe("application/octet-stream");
  });
});

describe("inferOfficeAttachmentContentTypeFromFilename", () => {
  it("infers common Office content types from filenames", () => {
    expect(inferOfficeAttachmentContentTypeFromFilename("notes.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(inferOfficeAttachmentContentTypeFromFilename("raw-data.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(inferOfficeAttachmentContentTypeFromFilename("deck.pptx")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(inferOfficeAttachmentContentTypeFromFilename("legacy.doc")).toBe("application/msword");
    expect(inferOfficeAttachmentContentTypeFromFilename("legacy.xls")).toBe("application/vnd.ms-excel");
    expect(inferOfficeAttachmentContentTypeFromFilename("legacy.ppt")).toBe("application/vnd.ms-powerpoint");
  });

  it("does not infer unknown extensions", () => {
    expect(inferOfficeAttachmentContentTypeFromFilename("payload.bin")).toBeNull();
    expect(inferOfficeAttachmentContentTypeFromFilename(undefined)).toBeNull();
  });
});

describe("normalizeUploadAttachmentContentType", () => {
  it("keeps explicit content types unchanged", () => {
    expect(
      normalizeUploadAttachmentContentType({
        contentType: "application/pdf",
        originalFilename: "raw-data.xlsx",
      }),
    ).toBe("application/pdf");
  });

  it("infers Office content type for generic binary uploads", () => {
    expect(
      normalizeUploadAttachmentContentType({
        contentType: "application/octet-stream",
        originalFilename: "raw-data.xlsx",
      }),
    ).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });

  it("keeps generic binary uploads generic when the inferred Office type is not allowed", () => {
    expect(
      normalizeUploadAttachmentContentType({
        contentType: "application/octet-stream",
        originalFilename: "raw-data.xlsx",
        isAllowedContentType: (contentType) => contentType === "application/octet-stream",
      }),
    ).toBe("application/octet-stream");
  });

  it("keeps generic binary uploads generic for unknown filenames", () => {
    expect(
      normalizeUploadAttachmentContentType({
        contentType: "application/octet-stream",
        originalFilename: "payload.bin",
      }),
    ).toBe("application/octet-stream");
  });
});

describe("isAllowedPluginArtifactMimeType", () => {
  // Full broadened set of inert common-file types that must pass.
  const inertAllowed = [
    // 3D / CAD
    "model/stl",
    "application/vnd.ms-pki.stl",
    "application/sla",
    "model/x.stl-binary",
    "model/x.stl-ascii",
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
    // video containers (supplied via DEFAULT_ALLOWED_TYPES on this lineage)
    "video/mp4",
    "video/webm",
    "video/quicktime",
  ];

  it("allows every broadened inert type", () => {
    for (const ct of inertAllowed) {
      expect(isAllowedPluginArtifactMimeType(ct)).toBe(true);
    }
  });

  it("retains the base image/pdf/audio types", () => {
    for (const ct of ["image/png", "image/jpeg", "application/pdf", "audio/ogg"]) {
      expect(isAllowedPluginArtifactMimeType(ct)).toBe(true);
    }
  });

  it("matches case-insensitively", () => {
    expect(isAllowedPluginArtifactMimeType("Application/STEP")).toBe(true);
    expect(isAllowedPluginArtifactMimeType("MODEL/STL")).toBe(true);
    expect(isAllowedPluginArtifactMimeType("Application/VND.MS-PKI.STL")).toBe(true);
  });

  it("keeps text/html rejected on the plugin path", () => {
    expect(isAllowedPluginArtifactMimeType("text/html")).toBe(false);
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

  it("leaves SVG and the remaining archive types gated (the SE ruling admitted zip only)", () => {
    for (const ct of [
      "image/svg+xml",
      "application/x-zip-compressed",
      "application/x-zip",
      "application/gzip",
      "application/x-7z-compressed",
      "application/x-tar",
      "application/octet-stream",
    ]) {
      expect(isAllowedPluginArtifactMimeType(ct)).toBe(false);
    }
  });

  it("admits zip, csv and tsv for opaque storage per the SE ruling", () => {
    for (const ct of ["application/zip", "text/csv", "text/tab-separated-values"]) {
      expect(isAllowedPluginArtifactMimeType(ct)).toBe(true);
    }
  });

  it("admits the inert KiCad exchange types per the SE ruling", () => {
    for (const ct of ["application/x-kicad-pcb", "application/x-kicad-schematic"]) {
      expect(isAllowedPluginArtifactMimeType(ct)).toBe(true);
    }
  });

  it("matches the newly admitted types case-insensitively", () => {
    expect(isAllowedPluginArtifactMimeType("Application/ZIP")).toBe(true);
    expect(isAllowedPluginArtifactMimeType("TEXT/CSV")).toBe(true);
    expect(isAllowedPluginArtifactMimeType("Text/Tab-Separated-Values")).toBe(true);
    expect(isAllowedPluginArtifactMimeType("Application/X-KiCad-PCB")).toBe(true);
    expect(isAllowedPluginArtifactMimeType("Application/X-KiCad-Schematic")).toBe(true);
  });
});

describe("isSpreadsheetBaitPluginArtifact", () => {
  const base = {
    companyId: "company-1",
    objectKey: "company-1/plugin-artifacts/2026/09/13/uuid-gerbers.csv",
    contentType: "text/csv",
    originalFilename: "gerbers.csv",
  };

  it("forces attachment for plugin-created csv/tsv assets (by type)", () => {
    expect(isSpreadsheetBaitPluginArtifact(base)).toBe(true);
    expect(
      isSpreadsheetBaitPluginArtifact({
        ...base,
        contentType: "text/tab-separated-values",
        originalFilename: "bom.tsv",
        objectKey: "company-1/plugin-artifacts/2026/09/13/uuid-bom.tsv",
      }),
    ).toBe(true);
    // Alias x-zip-compressed style case variance on the type is normalized.
    expect(
      isSpreadsheetBaitPluginArtifact({ ...base, contentType: "TEXT/CSV" }),
    ).toBe(true);
  });

  it("forces attachment for plugin-created spreadsheet-named assets even under a generic type", () => {
    for (const filename of ["bom.ods", "bom.xls", "bom.xlsx", "bom.xlsm", "data.tsv"]) {
      expect(
        isSpreadsheetBaitPluginArtifact({
          ...base,
          contentType: "application/octet-stream",
          originalFilename: filename,
          objectKey: `company-1/plugin-artifacts/2026/09/13/uuid-${filename}`,
        }),
      ).toBe(true);
    }
  });

  it("leaves human-uploaded spreadsheet-bait serving unchanged (namespace-scoped)", () => {
    expect(
      isSpreadsheetBaitPluginArtifact({
        ...base,
        objectKey: "issues/issue-1/gerbers.csv",
      }),
    ).toBe(false);
    expect(
      isSpreadsheetBaitPluginArtifact({
        ...base,
        objectKey: "assets/general/gerbers.csv",
      }),
    ).toBe(false);
  });

  it("leaves non-spreadsheet plugin assets alone", () => {
    expect(
      isSpreadsheetBaitPluginArtifact({
        ...base,
        contentType: "image/png",
        originalFilename: "preview.png",
        objectKey: "company-1/plugin-artifacts/2026/09/13/uuid-preview.png",
      }),
    ).toBe(false);
    expect(
      isSpreadsheetBaitPluginArtifact({
        ...base,
        contentType: "image/png",
        originalFilename: null,
        objectKey: "company-1/plugin-artifacts/2026/09/13/uuid-noname",
      }),
    ).toBe(false);
  });

  it("does not match a different company's plugin-artifacts namespace", () => {
    expect(
      isSpreadsheetBaitPluginArtifact({
        ...base,
        objectKey: "company-2/plugin-artifacts/2026/09/13/uuid-gerbers.csv",
      }),
    ).toBe(false);
  });
});

describe("isInlineAttachmentContentType", () => {
  it("allows the configured inline-safe types", () => {
    for (const contentType of ["image/png", "image/svg+xml", "application/pdf", "text/plain", "video/mp4"]) {
      expect(isInlineAttachmentContentType(contentType)).toBe(true);
    }
  });

  it("rejects potentially unsafe or binary download types", () => {
    expect(INLINE_ATTACHMENT_TYPES).not.toContain("text/html");
    expect(isInlineAttachmentContentType("text/html")).toBe(false);
    expect(isInlineAttachmentContentType("application/zip")).toBe(false);
  });
});

describe("formatAttachmentSize", () => {
  it("renders the default deployment cap as a round megabyte figure", () => {
    // The fork deliberately raised the shared default 10 MiB -> 25 MiB so a
    // fresh install accepts ~15-20 MiB STL relays without env tuning; keep
    // upstream's shape check but assert the fork's default.
    expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
    expect(formatAttachmentSize(MAX_ATTACHMENT_BYTES)).toBe("25 MB");
  });

  it("keeps one decimal place for fractional sizes and drops a trailing .0", () => {
    expect(formatAttachmentSize(10.5 * 1024 * 1024)).toBe("10.5 MB");
    expect(formatAttachmentSize(1024 * 1024)).toBe("1 MB");
    expect(formatAttachmentSize(2.25 * 1024 * 1024)).toBe("2.3 MB");
  });

  it("renders sub-megabyte values in kilobytes", () => {
    expect(formatAttachmentSize(1024)).toBe("1 KB");
    expect(formatAttachmentSize(512 * 1024)).toBe("512 KB");
    expect(formatAttachmentSize(1536)).toBe("1.5 KB");
  });

  it("steps up to gigabytes for very large caps", () => {
    expect(formatAttachmentSize(2 * 1024 * 1024 * 1024)).toBe("2 GB");
  });

  it("keeps sub-kilobyte values in bytes rather than collapsing to 0 KB", () => {
    expect(formatAttachmentSize(10)).toBe("10 bytes");
    expect(formatAttachmentSize(1)).toBe("1 byte");
    expect(formatAttachmentSize(1023)).toBe("1023 bytes");
  });

  it("never renders a nonsense figure for a degenerate input", () => {
    expect(formatAttachmentSize(0)).toBe("0 bytes");
    expect(formatAttachmentSize(-1)).toBe("0 bytes");
    expect(formatAttachmentSize(Number.NaN)).toBe("0 bytes");
  });
});
