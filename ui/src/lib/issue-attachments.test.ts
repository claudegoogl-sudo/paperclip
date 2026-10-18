import { describe, expect, it } from "vitest";
import {
  attachmentDownloadPath,
  attachmentFilename,
  attachmentOpenPath,
  isImageAttachment,
  isMarkdownAttachment,
  isVideoAttachment,
} from "./issue-attachments";

describe("attachmentFilename", () => {
  it("prefers the original filename when present", () => {
    expect(attachmentFilename({ id: "att-1", originalFilename: "report.pdf" })).toBe(
      "report.pdf",
    );
  });

  it("falls back to the attachment id when the filename is null", () => {
    expect(attachmentFilename({ id: "att-1", originalFilename: null })).toBe("att-1");
  });
});

describe("attachmentOpenPath", () => {
  it("prefers an explicit openPath when present", () => {
    expect(
      attachmentOpenPath({
        contentPath: "/api/attachments/att-1/content",
        openPath: "/api/attachments/att-1/open",
      }),
    ).toBe("/api/attachments/att-1/open");
  });

  it("falls back to contentPath when openPath is absent", () => {
    expect(
      attachmentOpenPath({ contentPath: "/api/attachments/att-1/content" }),
    ).toBe("/api/attachments/att-1/content");
  });
});

describe("attachmentDownloadPath", () => {
  it("prefers an explicit downloadPath when present", () => {
    expect(
      attachmentDownloadPath({
        contentPath: "/api/attachments/att-1/content",
        downloadPath: "/api/attachments/att-1/download",
      }),
    ).toBe("/api/attachments/att-1/download");
  });

  it("derives a download path from contentPath when downloadPath is absent", () => {
    expect(
      attachmentDownloadPath({ contentPath: "/api/attachments/att-1/content" }),
    ).toBe("/api/attachments/att-1/content?download=1");
  });
});

describe("isImageAttachment", () => {
  it("accepts a plain image/* content type", () => {
    expect(isImageAttachment({ contentType: "image/png" })).toBe(true);
  });

  it("is case-insensitive and ignores MIME parameters", () => {
    expect(isImageAttachment({ contentType: "Image/PNG; charset=binary" })).toBe(true);
  });

  it("excludes HEIC/HEIF image types even though they are image/*", () => {
    expect(isImageAttachment({ contentType: "image/heic" })).toBe(false);
    expect(isImageAttachment({ contentType: "image/HEIF" })).toBe(false);
    expect(isImageAttachment({ contentType: "image/heic-sequence" })).toBe(false);
    expect(isImageAttachment({ contentType: "image/heif-sequence" })).toBe(false);
  });

  it("falls back to filename extension for generic binary content types", () => {
    expect(
      isImageAttachment({
        contentType: "application/octet-stream",
        originalFilename: "photo.PNG",
      }),
    ).toBe(true);
  });

  it("rejects generic binary content types with a non-image extension", () => {
    expect(
      isImageAttachment({
        contentType: "application/octet-stream",
        originalFilename: "report.pdf",
      }),
    ).toBe(false);
  });

  it("rejects a non-image, non-generic content type even with an image filename", () => {
    expect(
      isImageAttachment({
        contentType: "application/pdf",
        originalFilename: "photo.png",
      }),
    ).toBe(false);
  });

  it("rejects a non-image content type with no usable filename", () => {
    expect(isImageAttachment({ contentType: "video/mp4" })).toBe(false);
  });

  it("rejects an empty content type with no extension on the filename", () => {
    expect(isImageAttachment({ contentType: "", originalFilename: "photo" })).toBe(false);
  });
});

describe("isVideoAttachment", () => {
  it("accepts a plain video/* content type", () => {
    expect(
      isVideoAttachment({ contentType: "video/webm", originalFilename: null }),
    ).toBe(true);
  });

  it("is case-insensitive about the content type", () => {
    expect(
      isVideoAttachment({ contentType: "VIDEO/MP4", originalFilename: null }),
    ).toBe(true);
  });

  it("falls back to filename extension for generic binary content types", () => {
    expect(
      isVideoAttachment({
        contentType: "application/octet-stream",
        originalFilename: "clip.MOV",
      }),
    ).toBe(true);
  });

  it("recognizes every known video filename extension via the binary/octet-stream alias", () => {
    for (const ext of [".mp4", ".m4v", ".webm", ".mov", ".qt", ".quicktime"]) {
      expect(
        isVideoAttachment({
          contentType: "binary/octet-stream",
          originalFilename: `clip${ext}`,
        }),
      ).toBe(true);
    }
  });

  it("rejects generic binary content types with a non-video extension", () => {
    expect(
      isVideoAttachment({
        contentType: "application/octet-stream",
        originalFilename: "clip.mp3",
      }),
    ).toBe(false);
  });

  it("rejects generic binary content types with no filename extension", () => {
    expect(
      isVideoAttachment({ contentType: "application/octet-stream", originalFilename: null }),
    ).toBe(false);
  });

  it("does not use the filename fallback for non-generic content types", () => {
    expect(
      isVideoAttachment({ contentType: "text/plain", originalFilename: "clip.mp4" }),
    ).toBe(false);
  });

  it("rejects an unrelated content type with no filename", () => {
    expect(isVideoAttachment({ contentType: "image/png", originalFilename: null })).toBe(false);
  });
});

describe("isMarkdownAttachment", () => {
  it("accepts known markdown content types", () => {
    expect(
      isMarkdownAttachment({ contentType: "text/markdown", originalFilename: null }),
    ).toBe(true);
  });

  it("falls back to a .md filename when the content type is a generic fallback type", () => {
    expect(
      isMarkdownAttachment({ contentType: "text/plain", originalFilename: "notes.md" }),
    ).toBe(true);
    expect(
      isMarkdownAttachment({ contentType: "text/plain", originalFilename: "NOTES.MARKDOWN" }),
    ).toBe(true);
  });

  it("rejects a .md filename when the content type is not a fallback type", () => {
    expect(
      isMarkdownAttachment({ contentType: "text/html", originalFilename: "notes.md" }),
    ).toBe(false);
  });

  it("rejects a non-markdown extension even with a fallback content type", () => {
    expect(
      isMarkdownAttachment({ contentType: "text/plain", originalFilename: "notes.txt" }),
    ).toBe(false);
  });

  it("rejects when there is no filename and the content type is not markdown", () => {
    expect(
      isMarkdownAttachment({ contentType: "application/octet-stream", originalFilename: null }),
    ).toBe(false);
  });
});
