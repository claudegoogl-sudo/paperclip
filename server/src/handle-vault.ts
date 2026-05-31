/**
 * Per-run borrowed-handle vault (PLA-702 / PLA-695 Control 2).
 *
 * Control 1 (PLA-697, {@link ./run-secret-registry.ts}) value-exact redacts a
 * resolved secret out of PERSISTED transcript records, but the live plaintext
 * still reaches the agent working context — one reasoning step can copy it into
 * a downstream tool argument and exfiltrate it before any persistence redactor
 * runs. Control 2 closes that by never handing the agent plaintext at all:
 * `vault.read` returns an opaque **borrowed handle** instead, and the host
 * substitutes the real plaintext back in at the worker-dispatch chokepoint
 * ({@link ./services/plugin-tool-registry.ts}) so only the executing tool — not
 * the transcript, not the persisted call record — ever sees the value.
 *
 * This module is the in-memory store backing that indirection:
 *
 *   runId  ->  Map<handle, plaintext>
 *
 * Lifecycle mirrors the Control 1 registry exactly so the two stay coherent:
 * entries are cleared on run finalize (heartbeat), with a lazy TTL prune as a
 * crash backstop so plaintext is never retained indefinitely if a run dies
 * between mint and finalize.
 *
 * Security invariants (SecurityEngineer PLA-701 sign-off RC1–RC5):
 *  - RC3: a handle is ALWAYS resolved against the server-validated `runId`
 *    (`vault[ctx.runId][handle]`), NEVER the runId parsed from the handle
 *    token. A run-A handle presented during run B resolves to nothing.
 *  - RC5: a handle-shaped token that is unresolvable in THIS run's vault
 *    (foreign / expired / forged) is fail-closed — the caller must abort the
 *    outbound call rather than pass a literal `vault-handle://` downstream.
 *  - The plaintext is held only here; it is never logged. Handle ids are
 *    128-bit so they are not guessable.
 */

import { randomBytes } from "node:crypto";

/** Scheme prefix for a borrowed handle. */
export const HANDLE_SCHEME = "vault-handle://";

/**
 * Matches a borrowed-handle token anywhere inside a string leaf. The id is
 * exactly 32 lowercase hex chars (128 bits). The runId segment is the opaque
 * dispatch run id (uuid-shaped in practice, but we only constrain it to the
 * url-safe characters a runId can contain so the token is unambiguous).
 *
 * Substring (not whole-value) matching is required so handles embedded in
 * `Authorization: Bearer vault-handle://…`, URLs, argv, and env templates are
 * resolved (RC5 matching clause).
 */
const HANDLE_TOKEN_RE = /vault-handle:\/\/[A-Za-z0-9._-]+\/[0-9a-f]{32}/g;

/** Number of random bytes in a handle id. 16 bytes = 128 bits (RC entropy). */
const HANDLE_ID_BYTES = 16;

/**
 * Lazy prune horizon. A run that never calls {@link clearRunHandles} (e.g. a
 * crash between mint and finalize) has its entry dropped once it is older than
 * this, so borrowed plaintext is never retained indefinitely. Mirrors the
 * Control 1 registry TTL.
 */
const ENTRY_TTL_MS = 60 * 60 * 1_000;

interface VaultEntry {
  handles: Map<string, string>;
  touchedAt: number;
}

const vault = new Map<string, VaultEntry>();

function pruneExpired(now: number): void {
  for (const [runId, entry] of vault) {
    if (now - entry.touchedAt > ENTRY_TTL_MS) vault.delete(runId);
  }
}

/**
 * Raised when a handle-shaped token cannot be resolved in the resolving run's
 * vault. Callers at the egress chokepoint MUST treat this as fail-closed: abort
 * the outbound tool call rather than let a literal `vault-handle://` leave the
 * host (RC5 fail-closed clause).
 */
export class UnresolvedHandleError extends Error {
  readonly handle: string;
  constructor(handle: string) {
    // The handle id is opaque and value-free, so it is safe to name.
    super(`unresolved borrowed handle for this run: ${handle}`);
    this.name = "UnresolvedHandleError";
    this.handle = handle;
  }
}

/** True if `token` looks like a borrowed handle (cheap shape check). */
export function isHandleShaped(token: string): boolean {
  return token.startsWith(HANDLE_SCHEME);
}

/**
 * Mint a borrowed handle for `value` within `runId` and store the mapping.
 *
 * The handle embeds `runId` purely for diagnosability and a defense-in-depth
 * cross-run assertion at resolve time; it is NEVER used to select the vault
 * (RC3). Returns the opaque handle string.
 *
 * @throws if `runId` or `value` is missing/empty. A resolved secret is never
 *   legitimately empty, so this is purely defensive; callers treat a throw as
 *   fail-closed (mint failed → do not return a handle).
 */
export function mintHandle(runId: string, value: string): string {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("mintHandle: runId is required");
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("mintHandle: a non-empty value is required");
  }
  const now = Date.now();
  pruneExpired(now);
  const id = randomBytes(HANDLE_ID_BYTES).toString("hex");
  const handle = `${HANDLE_SCHEME}${runId}/${id}`;
  const existing = vault.get(runId);
  if (existing) {
    existing.handles.set(handle, value);
    existing.touchedAt = now;
  } else {
    vault.set(runId, { handles: new Map([[handle, value]]), touchedAt: now });
  }
  return handle;
}

/**
 * Resolve a single handle to its plaintext within `runId`, or `undefined` if
 * this run's vault holds no such handle.
 *
 * RC3: the lookup is keyed ONLY by the server-validated `runId`; the runId
 * embedded in the handle token is validated to match but is never used to
 * select another run's vault.
 */
export function resolveHandle(runId: string, handle: string): string | undefined {
  const entry = vault.get(runId);
  if (!entry) return undefined;
  return entry.handles.get(handle);
}

/**
 * Clear all borrowed handles for a run. Called on run finalize so a rotated
 * secret's borrowed plaintext is never retained across runs.
 */
export function clearRunHandles(runId: string): void {
  vault.delete(runId);
}

/** Test / diagnostic helper: number of runs with at least one live handle. */
export function activeRunHandleCount(): number {
  return vault.size;
}

/**
 * Substitute every borrowed-handle substring inside the string leaves of
 * `input` with the plaintext borrowed for `runId`, returning a NEW deep copy.
 *
 * The original `input` is never mutated: the substituted copy is used ONLY for
 * worker dispatch, while the caller keeps the handle-bearing original for
 * persistence and audit (RC4).
 *
 * Behaviour per leaf (RC5):
 *  - no handle-shaped token present → leaf passed through unchanged;
 *  - handle resolvable in this run's vault → substring replaced with plaintext;
 *  - handle-shaped but unresolvable here (foreign/expired/forged) → throws
 *    {@link UnresolvedHandleError} so the egress call is aborted fail-closed.
 *
 * Resolution is structural (substring), so a handle embedded mid-string in a
 * header / URL / template is substituted in place.
 */
export function substituteHandles<T>(runId: string, input: T): T {
  return walk(input, runId) as T;
}

function walk(value: unknown, runId: string): unknown {
  if (typeof value === "string") return substituteLeaf(value, runId);
  if (Array.isArray(value)) return value.map((v) => walk(v, runId));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, runId);
    }
    return out;
  }
  return value;
}

function substituteLeaf(leaf: string, runId: string): string {
  if (!leaf.includes(HANDLE_SCHEME)) return leaf;
  // Reset lastIndex defensively (the regex is module-level with /g).
  HANDLE_TOKEN_RE.lastIndex = 0;
  return leaf.replace(HANDLE_TOKEN_RE, (handle) => {
    const plaintext = resolveHandle(runId, handle);
    if (plaintext === undefined) throw new UnresolvedHandleError(handle);
    return plaintext;
  });
}
