/**
 * Shared attachment content-type configuration.
 *
 * By default a curated set of image/document/text/media types are allowed. Set the
 * `PAPERCLIP_ALLOWED_ATTACHMENT_TYPES` environment variable to a
 * comma-separated list of MIME types or wildcard patterns to expand the
 * allowed set for routes that use this allowlist.
 *
 * Examples:
 *   PAPERCLIP_ALLOWED_ATTACHMENT_TYPES=image/*,application/pdf
 *   PAPERCLIP_ALLOWED_ATTACHMENT_TYPES=image/*,application/pdf,text/*
 *
 * Supported pattern syntax:
 *   - Exact types:   "application/pdf"
 *   - Wildcards:     "image/*"  or  "application/vnd.openxmlformats-officedocument.*"
 */
import {
  DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES,
  MAX_COMPANY_ATTACHMENT_MAX_BYTES,
} from "@paperclipai/shared";

export const DEFAULT_ALLOWED_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "application/zip",
  "text/markdown",
  "text/plain",
  "application/json",
  "text/csv",
  "text/html",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
];

/**
 * PLA-888: MIME allowlist for plugin-created attachments (`artifacts.create`).
 *
 * The human upload route trusts whatever MIME multer reports (it only
 * normalises, it does not allowlist). The plugin write path is more hostile —
 * a worker fully controls the declared `mimeType` — so it enforces this
 * explicit, single-source-of-truth allowlist: the curated human-facing set
 * ({@link DEFAULT_ALLOWED_TYPES}) plus the audio/voice types an inbound
 * messenger relay needs (Telegram voice notes are `audio/ogg`; other channels
 * use mp3/m4a/webm/wav). Anything outside this list is rejected before any
 * bytes are stored. Wildcards are intentionally avoided here: the list is exact
 * so the reachable type surface is auditable.
 *
 * `text/html`, `text/csv` and `application/zip` are excluded from the plugin set
 * even though the human route (`DEFAULT_ALLOWED_TYPES`) allows them: an inbound
 * external relay has no need for active/markup document types (PLA-888 F2 —
 * stored-XSS / formula-injection surface) nor archive containers (PLA-1141 —
 * zip-bomb / smuggling surface), so dropping them minimises the hostile-input
 * surface. `application/zip` entered `DEFAULT_ALLOWED_TYPES` upstream after the
 * original review, so it is excluded here to preserve the SE-approved posture.
 *
 * PLA-1139/PLA-1140: also includes a broadened set of inert common-file types so
 * an operator can relay everyday documents, CAD models, photos and video through
 * the inbound messenger path: 3D geometry (STL/3MF/OBJ/STEP/glTF/PLY), office
 * documents (Word/Excel/PowerPoint/OpenDocument/RTF) and extra image formats
 * (TIFF/BMP/HEIC/HEIF). These are all static, non-executable payloads with no
 * active/markup/scripting surface, so they extend the auditable type set without
 * widening the hostile-input risk that F2 (text/html, text/csv) guards against.
 * Common video containers (MP4/WebM/QuickTime) are already covered via
 * {@link DEFAULT_ALLOWED_TYPES} on this host lineage, so they are not re-listed.
 *
 * Deliberately NOT included pending SecurityEngineer ruling (PLA-1141):
 * `image/svg+xml` (active-content/XSS) and archive containers
 * (zip/gzip/7z/tar — zip-bomb / smuggling). Executables are never added.
 *
 * All entries are lowercase: {@link isAllowedPluginArtifactMimeType} lowercases
 * its input before matching, so case variants would be dead duplicates.
 */
const PLUGIN_ARTIFACT_EXCLUDED_DEFAULT_TYPES: readonly string[] = [
  "text/html",
  "text/csv",
  "application/zip",
];

export const PLUGIN_ARTIFACT_ALLOWED_MIME_TYPES: readonly string[] = [
  ...DEFAULT_ALLOWED_TYPES.filter((t) => !PLUGIN_ARTIFACT_EXCLUDED_DEFAULT_TYPES.includes(t)),
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/webm",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
  // PLA-1139/PLA-1140: inert 3D / CAD geometry (static, non-executable).
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
  // PLA-1140: inert office documents.
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/rtf",
  // PLA-1140: extra inert image formats (png/jpeg/webp/gif already in DEFAULT_ALLOWED_TYPES).
  "image/tiff",
  "image/bmp",
  "image/heic",
  "image/heif",
  // PLA-1140: video containers (mp4/webm/quicktime) are supplied by DEFAULT_ALLOWED_TYPES
  // on this fork.626 lineage, so they are intentionally not re-listed here (dedup).
];

/**
 * PLA-888: whether `contentType` is permitted for a plugin-created attachment.
 * Exact, case-insensitive match against {@link PLUGIN_ARTIFACT_ALLOWED_MIME_TYPES}.
 */
export function isAllowedPluginArtifactMimeType(contentType: string): boolean {
  const ct = normalizeContentType(contentType);
  return PLUGIN_ARTIFACT_ALLOWED_MIME_TYPES.includes(ct);
}

export const DEFAULT_ATTACHMENT_CONTENT_TYPE = "application/octet-stream";
export const SVG_CONTENT_TYPE = "image/svg+xml";
export const INLINE_ATTACHMENT_TYPES: readonly string[] = [
  "image/*",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
];

/**
 * Parse a comma-separated list of MIME type patterns into a normalised array.
 * Returns the default image-only list when the input is empty or undefined.
 */
export function parseAllowedTypes(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_ALLOWED_TYPES];
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : [...DEFAULT_ALLOWED_TYPES];
}

/**
 * Check whether `contentType` matches any entry in `allowedPatterns`.
 *
 * Supports exact matches ("application/pdf") and wildcard / prefix
 * patterns ("image/*", "application/vnd.openxmlformats-officedocument.*").
 */
export function matchesContentType(contentType: string, allowedPatterns: string[]): boolean {
  const ct = contentType.toLowerCase();
  return allowedPatterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.endsWith("/*") || pattern.endsWith(".*")) {
      return ct.startsWith(pattern.slice(0, -1));
    }
    return ct === pattern;
  });
}

export function normalizeContentType(contentType: string | null | undefined): string {
  const normalized = (contentType ?? "").trim().toLowerCase();
  return normalized || DEFAULT_ATTACHMENT_CONTENT_TYPE;
}

export function isInlineAttachmentContentType(contentType: string): boolean {
  return matchesContentType(contentType, [...INLINE_ATTACHMENT_TYPES]);
}

// ---------- Module-level singletons read once at startup ----------

const allowedPatterns: string[] = parseAllowedTypes(
  process.env.PAPERCLIP_ALLOWED_ATTACHMENT_TYPES,
);

/** Convenience wrapper using the process-level allowed list. */
export function isAllowedContentType(contentType: string): boolean {
  return matchesContentType(contentType, allowedPatterns);
}

export const MAX_ATTACHMENT_BYTES =
  Number(process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES) || 10 * 1024 * 1024;

export function normalizeIssueAttachmentMaxBytes(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return Math.min(DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES, MAX_ATTACHMENT_BYTES);
  }
  return Math.min(Math.floor(value), MAX_COMPANY_ATTACHMENT_MAX_BYTES, MAX_ATTACHMENT_BYTES);
}
