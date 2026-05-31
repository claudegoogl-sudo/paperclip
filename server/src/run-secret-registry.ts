/**
 * Per-run value-exact secret registry (PLA-697 / PLA-695 Control 1).
 *
 * When the host mediates a `vault.read` secret resolution and obtains the
 * decrypted plaintext, the exact byte sequence is registered here keyed by the
 * server-validated `runId`. The shared redaction pipeline (`redaction.ts`)
 * consults this registry so any PERSISTED run-log / transcript / event-payload
 * record has exact occurrences replaced with a marker. This catches a
 * high-entropy secret embedded in free-form text that the pattern / field-name
 * heuristics in `redaction.ts` cannot reliably match.
 *
 * The live value still reaches the agent working context unchanged — the
 * `/plugins/tools/execute` route returns the tool result verbatim and this
 * registry only feeds the persistence-time redactors. In-run consumption is
 * never broken.
 *
 * Entries are cleared on run completion (heartbeat run finalize) so a rotated
 * secret's stale value is never retained across runs. A lazy TTL prune bounds
 * memory if a run never reaches its finalize path (e.g. a host crash between
 * resolve and finalize).
 */

interface RegistryEntry {
  values: Set<string>;
  touchedAt: number;
}

const registry = new Map<string, RegistryEntry>();

/**
 * Lazy prune horizon. A run that never calls {@link clearRunSecretValues}
 * (e.g. a crash between resolve and finalize) has its entry dropped once it is
 * older than this, so registered plaintext is never retained indefinitely.
 */
const ENTRY_TTL_MS = 60 * 60 * 1_000;

function pruneExpired(now: number): void {
  for (const [runId, entry] of registry) {
    if (now - entry.touchedAt > ENTRY_TTL_MS) registry.delete(runId);
  }
}

/**
 * Register a plaintext secret value for value-exact redaction within `runId`.
 *
 * Any non-empty value is registered: the registry only ever holds resolved
 * secret bytes, so scrubbing those exact bytes is always correct regardless of
 * length. (Over-redaction is bounded to the literal secret within the resolving
 * run, which is by definition acceptable.)
 *
 * @throws if `runId` or `value` is missing/empty/non-string. Callers MUST treat
 *   a throw as fail-closed: do NOT persist the plaintext if it could not be
 *   registered for redaction. A resolved secret is never legitimately empty, so
 *   this path is purely defensive.
 */
export function registerRunSecretValue(runId: string, value: string): void {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("registerRunSecretValue: runId is required");
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("registerRunSecretValue: a non-empty value is required");
  }
  const now = Date.now();
  pruneExpired(now);
  const existing = registry.get(runId);
  if (existing) {
    existing.values.add(value);
    existing.touchedAt = now;
    return;
  }
  registry.set(runId, { values: new Set([value]), touchedAt: now });
}

/**
 * Clear all registered values for a run. Called on run completion so a rotated
 * secret's stale value is never retained.
 */
export function clearRunSecretValues(runId: string): void {
  registry.delete(runId);
}

/** Test / diagnostic helper: number of runs with at least one registered value. */
export function registeredRunCount(): number {
  return registry.size;
}

/**
 * Replace every registered value (across all active runs) in `input` with
 * `marker`. The cross-run union is intentional: redacting another active run's
 * identical secret bytes is a safe over-redaction, never a leak. The function
 * is allocation-free when no values are registered (the common case).
 */
export function redactRegisteredSecretValues(input: string, marker: string): string {
  if (input.length === 0 || registry.size === 0) return input;
  let output = input;
  for (const entry of registry.values()) {
    for (const value of entry.values) {
      if (output.includes(value)) {
        output = output.split(value).join(marker);
      }
    }
  }
  return output;
}
