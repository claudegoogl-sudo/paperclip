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

/**
 * Operator-set egress posture captured into a handle at mint time (PLA-723).
 *
 * Mint-time capture is deliberate (PLA-720 EG3): the handle carries an
 * immutable allowlist for its lifetime so the egress-time check never re-reads
 * config (no TOCTOU / re-read attack surface). The trade-off — a tightened
 * allowlist not taking effect until TTL — is closed by {@link purgeHandlesByBinding}.
 */
export interface HandleCapture {
  /** Operator-set destination allowlist for this binding (empty = nothing allowed). */
  allowedEgress: readonly string[];
  /**
   * Enforce (deny on no-match) vs log-only "would-deny" migration mode (EG4).
   * New bindings are born enforcing; pre-existing bindings migrate via log-only.
   */
  enforced: boolean;
  /** Binding this handle was minted under — audit + EG3 purge correlation. */
  bindingId: string | null;
  /**
   * Tool names the operator explicitly opted in for this binding despite the
   * host being unable to enforce their destination (EG1 escape hatch).
   */
  unmediatedOptInTools?: readonly string[];
}

/** A stored handle: the borrowed plaintext plus its captured egress posture. */
export interface HandleRecord extends HandleCapture {
  value: string;
}

/**
 * Default capture for a handle minted without an explicit posture (legacy /
 * test callers, and the pre-PLA-723 mint path). Log-only + empty allowlist =
 * the migration-safe posture: substitution proceeds but a would-deny audit
 * fires. The PRODUCTION mint path derives capture from the binding row, where
 * NEW bindings are born `enforced: true` (EG4) — the secure default lives there,
 * not here.
 */
const DEFAULT_CAPTURE: HandleCapture = {
  allowedEgress: [],
  enforced: false,
  bindingId: null,
};

interface VaultEntry {
  handles: Map<string, HandleRecord>;
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
export function mintHandle(runId: string, value: string, capture?: HandleCapture): string {
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
  const c = capture ?? DEFAULT_CAPTURE;
  const record: HandleRecord = {
    value,
    allowedEgress: c.allowedEgress,
    enforced: c.enforced,
    bindingId: c.bindingId,
    unmediatedOptInTools: c.unmediatedOptInTools,
  };
  const existing = vault.get(runId);
  if (existing) {
    existing.handles.set(handle, record);
    existing.touchedAt = now;
  } else {
    vault.set(runId, { handles: new Map([[handle, record]]), touchedAt: now });
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
  return getHandleRecord(runId, handle)?.value;
}

/**
 * Resolve a single handle to its full record (plaintext + captured egress
 * posture) within `runId`, or `undefined` if this run's vault holds no such
 * handle. Used by the egress chokepoint to make the destination decision from
 * each handle's OWN captured allowlist (PLA-723 EG5) before any substitution.
 */
export function getHandleRecord(runId: string, handle: string): HandleRecord | undefined {
  const entry = vault.get(runId);
  if (!entry) return undefined;
  return entry.handles.get(handle);
}

/**
 * Collect every distinct borrowed-handle token present in the string leaves of
 * `input` (deep walk). Used at the chokepoint to enumerate the handles a call
 * carries WITHOUT resolving them to plaintext (PLA-723 EG5: decide before
 * substitute).
 */
export function collectHandleTokens(input: unknown): string[] {
  const found = new Set<string>();
  collectWalk(input, found);
  return [...found];
}

function collectWalk(value: unknown, found: Set<string>): void {
  if (typeof value === "string") {
    if (value.includes(HANDLE_SCHEME)) {
      HANDLE_TOKEN_RE.lastIndex = 0;
      for (const m of value.matchAll(HANDLE_TOKEN_RE)) found.add(m[0]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectWalk(v, found);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectWalk(v, found);
  }
}

/**
 * Purge every live handle minted under `bindingId`, across all runs (PLA-723
 * EG3). When an operator tightens or revokes a binding's `allowedEgress`, the
 * mint-time-captured allowlist on in-flight handles would otherwise keep
 * authorizing egress to a now-removed destination for up to the handle TTL.
 * Calling this on a binding change makes revocation effective immediately.
 *
 * Returns the number of handles purged. Idempotent and safe to re-run.
 */
export function purgeHandlesByBinding(bindingId: string): number {
  if (typeof bindingId !== "string" || bindingId.length === 0) return 0;
  let purged = 0;
  for (const [runId, entry] of vault) {
    for (const [handle, record] of entry.handles) {
      if (record.bindingId === bindingId) {
        entry.handles.delete(handle);
        purged++;
      }
    }
    if (entry.handles.size === 0) vault.delete(runId);
  }
  return purged;
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
