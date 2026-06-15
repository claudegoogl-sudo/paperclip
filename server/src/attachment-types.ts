/**
 * Shared attachment content-type configuration.
 *
 * By default a curated set of image/document/text types are allowed. Set the
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
  "text/markdown",
  "text/plain",
  "application/json",
  "text/csv",
  "text/html",
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
 * `text/html` and `text/csv` are excluded from the plugin set even though the
 * human route allows them (PLA-888 security review F2): an inbound external
 * relay has no need for active/markup document types, and dropping the classic
 * stored-XSS / formula-injection inputs minimises the hostile-input surface.
 *
 * PLA-1139: also includes inert 3D-geometry types (STL/3MF/OBJ/STEP/glTF) so an
 * operator can relay a CAD model through the inbound messenger path. These are
 * static geometry descriptions — non-executable data, no active/markup surface —
 * so they extend the auditable type set without widening the hostile-input risk.
 * All entries are lowercase: {@link isAllowedPluginArtifactMimeType} lowercases
 * its input before matching, so case variants would be dead duplicates.
 */
const PLUGIN_ARTIFACT_EXCLUDED_DEFAULT_TYPES: readonly string[] = ["text/html", "text/csv"];

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
  // PLA-1139: inert 3D-geometry types (static, non-executable).
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
