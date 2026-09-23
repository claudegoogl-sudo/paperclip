/**
 * Persisted session-record env redaction.
 *
 * acp-engine (acpx) runtime records are plaintext JSON under the instance
 * state dir (`acp-engine/sessions/<id>.json`), readable by any host-level
 * agent session. The spawn env we hand to `ensureSession` contains resolved
 * secret values — server-resolved `EnvSecretRefBinding` values (adapter
 * `config.env`, e.g. a provider auth token), the harness-minted
 * `PAPERCLIP_API_KEY` run token, and wake payloads carrying user text.
 * Persisting that map verbatim is a secret-exposure incident class.
 *
 * adapter-utils CANNOT classify which `config.env` values are secret-bound:
 * the server resolves `secret_ref`/`user_secret_ref` bindings to plain values
 * before the adapter ever sees `config.env`, so by this layer every configured
 * value is indistinguishable from a resolved secret. The only safe policy is
 * default-deny: persist NO env values at all. Every key is recorded as a
 * reference marker naming the key, so the record env stays a pure key
 * manifest — useful for debugging (which vars the session was spawned with)
 * while carrying zero secret material, including for env keys added later.
 *
 * The real values still reach the spawned agent process through
 * `sessionOptions.env` (memory only); `persistedEnv` is what acpx writes to
 * the record instead (fork patch). Cold-restart resume re-supplies the env
 * fresh from the agent adapter config at `ensureSession` time — it never
 * needs the persisted values back.
 */

/** Marker prefix for a persisted env reference. Value names the env KEY only. */
export const PERSISTED_ENV_REF_PREFIX = "__paperclip_secret_ref:";

/**
 * Build the env map persisted on the acpx session record: every key of the
 * real spawn env mapped to `__paperclip_secret_ref:<KEY>`. Idempotent: the
 * output never depends on env values, only on the key set.
 */
export function buildPersistedSessionEnv(env: Record<string, string>): Record<string, string> {
  const persisted: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    persisted[key] = PERSISTED_ENV_REF_PREFIX + key;
  }
  return persisted;
}

/**
 * Defense-in-depth invariant for tests and wiring checks: the persisted map
 * must carry no real value for any key whose spawn value differs from the
 * marker. Returns the list of keys whose persisted value equals the real
 * value (i.e., leaks); empty array means clean.
 */
export function findPersistedEnvValueLeaks(
  env: Record<string, string>,
  persistedEnv: Record<string, string>,
): string[] {
  const leaks: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    const marker = PERSISTED_ENV_REF_PREFIX + key;
    if (persistedEnv[key] === value && value !== marker) leaks.push(key);
  }
  return leaks;
}
