/**
 * Plugin secrets host-side handler — resolves secret references through the
 * Paperclip secret provider system.
 *
 * When a plugin worker calls `ctx.secrets.resolve(secretRef)`, the JSON-RPC
 * request arrives at the host with `{ secretRef }`. This module provides the
 * concrete `HostServices.secrets` adapter that:
 *
 * 1. Parses the `secretRef` string to identify the secret.
 * 2. Looks up the secret record and its latest version in the database.
 * 3. Delegates to the configured `SecretProviderModule` to decrypt /
 *    resolve the raw value.
 * 4. Returns the resolved plaintext value to the worker.
 *
 * ## Secret Reference Format
 *
 * A `secretRef` is a **secret UUID** — the primary key (`id`) of a row in
 * the `company_secrets` table. Operators place these UUIDs into plugin
 * config values; plugin workers resolve them at execution time via
 * `ctx.secrets.resolve(secretId)`.
 *
 * ## Security Invariants
 *
 * - Resolved values are **never** logged, persisted, or included in error
 *   messages (per PLUGIN_SPEC.md §22).
 * - The handler is capability-gated: only plugins with `secrets.read-ref`
 *   declared in their manifest may call it (enforced by `host-client-factory`).
 * - The host handler itself does not cache resolved values. Each call goes
 *   through the secret provider to honour rotation.
 *
 * @see PLUGIN_SPEC.md §22 — Secrets
 * @see host-client-factory.ts — capability gating
 * @see services/secrets.ts — secretService used by agent env bindings
 */

import { eq, and, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, companySecretVersions, pluginConfig } from "@paperclipai/db";
import type { SecretProvider } from "@paperclipai/shared";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { pluginRegistryService } from "./plugin-registry.js";
import {
  collectSecretRefPaths,
  InvalidSecretRefAtPathError,
  isUuidSecretRef,
  validateSecretRefsAtPaths,
} from "./json-schema-secret-refs.js";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Produce a redacted, log-safe descriptor for an arbitrary secret-ref input.
 *
 * Callers reach the error path with caller-controlled values that may be
 * secret-shaped (e.g. a raw GitHub PAT mistakenly passed as a ref). To prevent
 * those values from being echoed into log lines or JSON-RPC `error.message`
 * payloads, this helper never returns the raw input. It returns one of:
 *
 *   - `kind=undefined` / `kind=null`
 *   - `kind=non-string type=<typeof>`
 *   - `kind=empty`
 *   - `kind=uuid value=<uuid>`  (UUID-shaped refs are the legitimate format
 *     and are safe to echo back; they are not secret material.)
 *   - `kind=opaque len=<N>`     (everything else — redacts secret-shaped input.)
 *
 * @see PLA-190 — host `secrets.resolve` rejected raw input echo defect.
 */
function describeOpaqueRef(value: unknown): string {
  if (value === undefined) return "kind=undefined";
  if (value === null) return "kind=null";
  if (typeof value !== "string") return `kind=non-string type=${typeof value}`;
  if (value.length === 0) return "kind=empty";
  const trimmed = value.trim();
  if (trimmed.length === 0) return `kind=whitespace len=${value.length}`;
  if (isUuidSecretRef(trimmed)) return `kind=uuid value=${trimmed}`;
  return `kind=opaque len=${value.length}`;
}

/**
 * Create a sanitised error that never leaks secret material.
 * The error message uses {@link describeOpaqueRef} to emit a length/kind
 * descriptor instead of the raw input, so that secret-shaped refs that reach
 * the rejection path are not echoed into logs or JSON-RPC error responses.
 */
function secretNotFound(secretRef: unknown): Error {
  const err = new Error(`Secret not found: ${describeOpaqueRef(secretRef)}`);
  err.name = "SecretNotFoundError";
  return err;
}

function secretVersionNotFound(secretRef: unknown): Error {
  const err = new Error(`No version found for secret: ${describeOpaqueRef(secretRef)}`);
  err.name = "SecretVersionNotFoundError";
  return err;
}

function invalidSecretRef(secretRef: unknown): Error {
  const err = new Error(`Invalid secret reference: ${describeOpaqueRef(secretRef)}`);
  err.name = "InvalidSecretRefError";
  return err;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Extract secret reference UUIDs from a plugin's configJson, scoped to only
 * the fields annotated with `format: "secret-ref"` in the schema.
 *
 * When the schema declares `format: "secret-ref"` paths, every value at one
 * of those paths must be either unset/blank or a UUID-shaped sentinel. Any
 * other value triggers {@link InvalidSecretRefAtPathError} with the offending
 * dotted JSON path and a redacted descriptor — the raw value is never echoed.
 * See PLA-198 AC1/AC2.
 *
 * When no schema is provided, falls back to collecting all UUID-shaped strings
 * (backwards-compatible for plugins without a declared instanceConfigSchema).
 *
 * @throws {InvalidSecretRefAtPathError} on a non-UUID value at a secret-ref slot.
 */
export function extractSecretRefsFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): Set<string> {
  if (configJson == null || typeof configJson !== "object") return new Set<string>();

  // Schema-aware branch: enforce strict UUID-or-blank invariant per slot,
  // surfacing path context on violation. This rejects malformed values at
  // extraction time instead of silently dropping them and letting them
  // resurface as context-free errors deep in the resolve handler.
  if (schema && typeof schema === "object" && collectSecretRefPaths(schema).size > 0) {
    return validateSecretRefsAtPaths(configJson, schema);
  }

  // Fallback: no schema or no secret-ref annotations — collect all UUIDs.
  // This preserves backwards compatibility for plugins that omit
  // instanceConfigSchema.
  const refs = new Set<string>();
  function walkAll(value: unknown): void {
    if (typeof value === "string") {
      if (isUuidSecretRef(value)) refs.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walkAll(item);
    } else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walkAll(v);
    }
  }

  walkAll(configJson);
  return refs;
}


// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Input shape for the `secrets.resolve` handler.
 *
 * Matches `WorkerToHostMethods["secrets.resolve"][0]` from `protocol.ts`.
 */
export interface PluginSecretsResolveParams {
  /** The secret reference string (a secret UUID). */
  secretRef: string;
}

/**
 * Options for creating the plugin secrets handler.
 */
export interface PluginSecretsHandlerOptions {
  /** Database connection. */
  db: Db;
  /**
   * The plugin ID using this handler.
   * Used for logging context only; never included in error payloads
   * that reach the plugin worker.
   */
  pluginId: string;
}

/**
 * The `HostServices.secrets` adapter for the plugin host-client factory.
 */
export interface PluginSecretsService {
  /**
   * Resolve a secret reference to its current plaintext value.
   *
   * @param params - Contains the `secretRef` (UUID of the secret)
   * @returns The resolved secret value
   * @throws {Error} If the secret is not found, has no versions, or
   *   the provider fails to resolve
   */
  resolve(params: PluginSecretsResolveParams): Promise<string>;
}

/**
 * Create a `HostServices.secrets` adapter for a specific plugin.
 *
 * The returned service looks up secrets by UUID, fetches the latest version
 * material, and delegates to the appropriate `SecretProviderModule` for
 * decryption.
 *
 * @example
 * ```ts
 * const secretsHandler = createPluginSecretsHandler({ db, pluginId });
 * const handlers = createHostClientHandlers({
 *   pluginId,
 *   capabilities: manifest.capabilities,
 *   services: {
 *     secrets: secretsHandler,
 *     // ...
 *   },
 * });
 * ```
 *
 * @param options - Database connection and plugin identity
 * @returns A `PluginSecretsService` suitable for `HostServices.secrets`
 */
/** Simple sliding-window rate limiter for secret resolution attempts. */
function createRateLimiter(maxAttempts: number, windowMs: number) {
  const attempts = new Map<string, number[]>();

  return {
    check(key: string): boolean {
      const now = Date.now();
      const windowStart = now - windowMs;
      const existing = (attempts.get(key) ?? []).filter((ts) => ts > windowStart);
      if (existing.length >= maxAttempts) return false;
      existing.push(now);
      attempts.set(key, existing);
      return true;
    },
  };
}

export function createPluginSecretsHandler(
  options: PluginSecretsHandlerOptions,
): PluginSecretsService {
  const { db, pluginId } = options;
  const registry = pluginRegistryService(db);

  // Rate limit: max 30 resolution attempts per plugin per minute
  const rateLimiter = createRateLimiter(30, 60_000);

  let cachedAllowedRefs: Set<string> | null = null;
  let cachedAllowedRefsExpiry = 0;
  const CONFIG_CACHE_TTL_MS = 30_000; // 30 seconds, matches event bus TTL

  return {
    async resolve(params: PluginSecretsResolveParams): Promise<string> {
      const { secretRef } = params;

      // ---------------------------------------------------------------
      // 0. Rate limiting — prevent brute-force UUID enumeration
      // ---------------------------------------------------------------
      if (!rateLimiter.check(pluginId)) {
        const err = new Error("Rate limit exceeded for secret resolution");
        err.name = "RateLimitExceededError";
        throw err;
      }

      // ---------------------------------------------------------------
      // 1. Validate the ref format
      // ---------------------------------------------------------------
      if (!secretRef || typeof secretRef !== "string" || secretRef.trim().length === 0) {
        throw invalidSecretRef(secretRef);
      }

      const trimmedRef = secretRef.trim();

      if (!isUuidSecretRef(trimmedRef)) {
        throw invalidSecretRef(trimmedRef);
      }

      // ---------------------------------------------------------------
      // 1b. Scope check — only allow secrets referenced in this plugin's config
      // ---------------------------------------------------------------
      const now = Date.now();
      if (!cachedAllowedRefs || now > cachedAllowedRefsExpiry) {
        const [configRow, plugin] = await Promise.all([
          db
            .select()
            .from(pluginConfig)
            .where(eq(pluginConfig.pluginId, pluginId))
            .then((rows) => rows[0] ?? null),
          registry.getById(pluginId),
        ]);

        const schema = (plugin?.manifestJson as unknown as Record<string, unknown> | null)
          ?.instanceConfigSchema as Record<string, unknown> | undefined;
        try {
          cachedAllowedRefs = extractSecretRefsFromConfig(configRow?.configJson, schema);
          cachedAllowedRefsExpiry = now + CONFIG_CACHE_TTL_MS;
        } catch (extractErr) {
          // PLA-198 AC4: a malformed config (non-UUID at a `format: "secret-ref"`
          // slot) reaches the resolve handler. Audit the structured path so the
          // operator can locate and fix the slot, but never echo the value or
          // pass the raw error message back to the worker — that would leak the
          // ref-existence signal that the scope check is designed to hide.
          if (extractErr instanceof InvalidSecretRefAtPathError) {
            // eslint-disable-next-line no-console
            console.warn(
              "[plugin-secrets] invalid secret-ref at config path",
              {
                pluginId,
                path: extractErr.path,
                descriptor: extractErr.descriptor,
              },
            );
            // Cache an empty allowed-refs set for the standard TTL so subsequent
            // resolves consistently return "not found" until the operator fixes
            // the config — without re-running schema extraction (and re-emitting
            // the audit warning) on every call.
            cachedAllowedRefs = new Set<string>();
            cachedAllowedRefsExpiry = now + CONFIG_CACHE_TTL_MS;
          } else {
            throw extractErr;
          }
        }
      }

      if (!cachedAllowedRefs.has(trimmedRef)) {
        // Return "not found" to avoid leaking whether the secret exists
        throw secretNotFound(trimmedRef);
      }

      // ---------------------------------------------------------------
      // 2. Look up the secret record by UUID
      // ---------------------------------------------------------------
      const secret = await db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.id, trimmedRef))
        .then((rows) => rows[0] ?? null);

      if (!secret) {
        throw secretNotFound(trimmedRef);
      }

      // ---------------------------------------------------------------
      // 3. Fetch the latest version's material
      // ---------------------------------------------------------------
      const versionRow = await db
        .select()
        .from(companySecretVersions)
        .where(
          and(
            eq(companySecretVersions.secretId, secret.id),
            eq(companySecretVersions.version, secret.latestVersion),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!versionRow) {
        throw secretVersionNotFound(trimmedRef);
      }

      // ---------------------------------------------------------------
      // 4. Resolve through the appropriate secret provider
      // ---------------------------------------------------------------
      const provider = getSecretProvider(secret.provider as SecretProvider);
      const resolved = await provider.resolveVersion({
        material: versionRow.material as Record<string, unknown>,
        externalRef: secret.externalRef,
      });

      return resolved;
    },
  };
}
