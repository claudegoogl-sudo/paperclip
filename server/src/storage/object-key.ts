import { badRequest } from "../errors.js";

/**
 * Single source of truth for storage object-key validity.
 *
 * This predicate is the contract between the write path and the read path:
 * `buildObjectKey` (write) must never emit a key this function refuses, and
 * `ensureCompanyPrefix` (read) refuses exactly the keys this function refuses.
 * History: three divergent validators let uploads with `..`
 * inside the *stored filename* succeed while every read returned
 * `400 Invalid object key`. Keep ONE predicate; do not add a second copy.
 *
 * Rejected shapes (superset of the historical read-path guard, uniform across
 * providers):
 * - empty keys, empty segments (`a//b`, trailing `/`)
 * - absolute paths (`/a/b`) and Windows-style absolute/traversal (`\\host\share`)
 * - backslash anywhere (`a\..\b`) — backslashes are separators on Windows
 * - any `..` run (`a/../b`, `a..b`) — rejected as a substring, preserving the
 *   historical read-guard semantics verbatim
 * - bare `.` segments (`a/./b`)
 */
export function isObjectKeyReadable(objectKey: string): boolean {
  if (objectKey.length === 0) return false;
  if (objectKey.includes("\\")) return false;
  if (objectKey.includes("..")) return false;
  if (objectKey.startsWith("/")) return false;
  const segments = objectKey.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

/**
 * Read-path guard. Throws 400 `Invalid object key` for any key
 * `isObjectKeyReadable` refuses. Used by `ensureCompanyPrefix` (read) and
 * asserted after `buildObjectKey` (write) so the builder fails closed.
 */
export function assertObjectKeyReadable(objectKey: string): void {
  if (!isObjectKeyReadable(objectKey)) {
    throw badRequest("Invalid object key");
  }
}

/**
 * Repair a stored key that was emitted by the historical builder and now
 * fails `isObjectKeyReadable`. Hardens only *filename* segments (segments
 * that merely contain a `..` run); structural traversal segments (`.`/`..`
 * as whole segments) are refused as `null` because rewriting them would
 * change what the key addresses. Returns `null` when no safe repair exists.
 */
export function repairObjectKey(objectKey: string): string | null {
  if (isObjectKeyReadable(objectKey)) return objectKey;
  const segments = objectKey.split("/");
  const last = segments.length - 1;
  const repaired: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === "." || segment === ".." || segment.length === 0) return null;
    if (!segment.includes("..")) {
      repaired.push(segment);
      continue;
    }
    // Only the stored FILENAME (final segment) may be rewritten: the historical
    // builder concatenated stem+ext into `..`. A dot-run in a directory segment
    // is not something this repair invented a new location for — refuse.
    if (index !== last) return null;
    if (segment.includes("\\")) return null;
    const hardened = segment
      .replace(/\.{2,}/g, ".")
      .replace(/^\.+|\.+$/g, "");
    if (hardened.length === 0) return null;
    repaired.push(hardened);
  }
  const joined = repaired.join("/");
  return isObjectKeyReadable(joined) ? joined : null;
}
