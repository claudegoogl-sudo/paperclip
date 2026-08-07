/**
 * policy-gate-fail-closed.mjs
 *
 * Shared fail-closed guard for the `scripts/check-*.mjs` policy gates.
 *
 * Static security checks that walk the repo for offences can silently degrade
 * to zero coverage if their scan root disappears — a directory rename, a move,
 * or an emptied folder leaves the file-walk with no inputs, the success path
 * fires anyway, and the gate reports green from a 0-file scan. The fix is to
 * treat "I could not reach any of my inputs" as an error, not as evidence of
 * cleanliness.
 *
 * Callers invoke `failClosedOnEmptyScan` immediately before their success
 * return. When the walk yielded zero files, it prints an error naming the
 * unresolved expected roots and returns `1`. Otherwise it returns `null`,
 * signalling the caller to continue with its normal success path.
 */

import { statSync } from "node:fs";

/**
 * Returns `true` iff `absolutePath` exists and is a directory.
 *
 * Exported so callers can mark a directory as optional without opting it into
 * the fail-closed expected-roots list (e.g. `docker/quadlet/` may legitimately
 * not exist and should not be reported as missing).
 */
export function isExistingDirectory(absolutePath) {
  try {
    return statSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Fail-closed guard for policy-gate scripts.
 *
 * @param {object} options
 * @param {number} options.scannedCount  Total files the gate's walk produced.
 * @param {{ path: string, label?: string }[]} options.expectedRoots
 *   Directories the gate believes it should scan, each `{ path, label }`. The
 *   `path` MUST be absolute (resolve against `repoRoot` before calling).
 *   Include only mandatory roots — an optional root (e.g. `docker/quadlet/`)
 *   must be filtered out by the caller so its absence is not reported as a
 *   policy failure.
 * @param {(message: string) => void} options.error  Sink for diagnostic output.
 * @param {string} options.gateName  Human-readable gate name for the header line.
 * @returns {number | null} `1` when the gate should fail closed, otherwise
 *   `null` so the caller proceeds with its normal success path.
 */
export function failClosedOnEmptyScan({ scannedCount, expectedRoots, error, gateName }) {
  if (scannedCount > 0) return null;

  const missing = expectedRoots.filter((root) => !isExistingDirectory(root.path));
  // If every expected root exists yet the walk still produced zero files
  // (e.g. an extension filter ruled everything out, or the directory was
  // emptied), list the full set so the operator sees the gate's intended
  // coverage rather than a misleading "all roots missing" message.
  const listed = missing.length > 0 ? missing : expectedRoots;

  error(`ERROR: ${gateName} scanned 0 file(s) from its expected root(s):`);
  for (const root of listed) {
    error(`  - ${root.path}${root.label ? `  (${root.label})` : ""}`);
  }
  error("");
  error(
    "This gate fails closed: a security control that cannot reach its inputs must",
  );
  error(
    "error rather than silently report green at zero coverage. If a root moved on",
  );
  error("purpose, update the gate's expected-roots list in this script.");
  return 1;
}
