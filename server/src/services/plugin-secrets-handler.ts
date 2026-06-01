/**
 * Plugin secrets host-side handler — resolves secret references through the
 * Paperclip secret provider system with enforced cross-company isolation.
 *
 * When a plugin worker calls `ctx.secrets.resolve(secretRef, runId)`, the
 * JSON-RPC request arrives at the host carrying ONLY `{ secretRef, runId }`.
 * This module provides the concrete `HostServices.secrets` adapter that:
 *
 *  1. Validates `(pluginDbId, runId)` against the in-memory run-context
 *     registry. If absent → `runcontext_invalid`. The worker is NEVER trusted
 *     to assert which company is dispatching.
 *  2. Confirms the ref is bound for the **dispatching company** via a
 *     `company_secret_bindings` row (targetType `plugin`, targetId = the
 *     plugin install UUID). Absent → `not_found` (no allow-list oracle).
 *  3. Resolves through `secretService.resolveSecretValue`, passing the
 *     dispatching company as the trusted company. The service re-checks the
 *     secret's `company_id` (defence in depth) and delegates decryption to the
 *     configured `SecretProviderModule`. The value is never cached (rotation).
 *  4. Collapses EVERY failure shape — cross-company, missing secret,
 *     soft-deleted, inactive, missing/inactive version, not-bound, provider
 *     error — into a single opaque `not_found` at the worker boundary, so a
 *     plugin in company A cannot confirm existence of company B's secret.
 *  5. Applies a sliding-window rate limit per dispatching agent (global) AND
 *     per `(dispatching-agent, dispatching-company)` sub-bucket, both keyed
 *     off the server-validated runContext (never `pluginId`).
 *  6. Emits a value-free allow/deny audit log entry mirroring `artifacts.fetch`.
 *
 * This mirrors the SecurityEngineer-approved `artifacts.fetch` authorization
 * primitive (PLA-574) and the isolation model signed off on PLA-655/PLA-656.
 *
 * ## Secret Reference Format
 *
 * A `secretRef` is a **secret UUID** — the primary key (`id`) of a row in the
 * `company_secrets` table. Operators reference these UUIDs from plugin config;
 * a per-company `company_secret_bindings` row authorizes which company may
 * resolve which ref through which plugin.
 *
 * ## Security Invariants
 *
 * - Resolved values are NEVER logged, persisted, or included in error
 *   messages (PLUGIN_SPEC.md §22, PLA-190/PLA-193).
 * - Worker-facing errors carry ONLY a typed code from {@link SecretsErrorCode};
 *   the raw ref/secretId never reaches the worker (it may appear only in
 *   server-side structured debug logs).
 * - Company scope is sourced ONLY from the run-context registry — never from a
 *   worker-supplied field.
 * - The handler never caches resolved values; each call honours rotation.
 *
 * @see PLUGIN_SPEC.md §22 — Secrets
 * @see plugin-artifacts-handler.ts — the sibling authorization primitive (PLA-574)
 * @see services/secrets.ts — secretService.resolveSecretValue (company-scoped)
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecretBindings } from "@paperclipai/db";
import {
  collectSecretRefPaths,
  isUuidSecretRef,
  readConfigValueAtPath,
} from "./json-schema-secret-refs.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import { secretService } from "./secrets.js";
import { registerRunSecretValue } from "../run-secret-registry.js";
import { mintHandle as mintBorrowedHandle, type HandleCapture } from "../handle-vault.js";
import type { PluginRunContextRegistry } from "./plugin-run-context-registry.js";

/**
 * The binding target type used for plugin secret-ref bindings. A binding row
 * is `(companyId, targetType="plugin", targetId=<plugin install UUID>,
 * configPath=<manifest secret-ref path>, secretId)`. This is the per-company
 * allow-list surface SecurityEngineer required (PLA-656 Q3, model C —
 * `company_secret_bindings`).
 */
export const PLUGIN_SECRET_BINDING_TARGET_TYPE = "plugin";

// ---------------------------------------------------------------------------
// Typed errors — the ONLY shapes that reach the worker (PLA-656 R2)
// ---------------------------------------------------------------------------

export type SecretsErrorCode =
  | "runcontext_invalid"
  | "not_found"
  | "rate_limited"
  | "invalid_ref";

/**
 * The only error surfaced to the plugin worker. Messages are generic and
 * MUST NOT echo the raw ref or any secret material (PLA-656 R2, PLUGIN_SPEC §22).
 */
export class SecretsError extends Error {
  readonly code: SecretsErrorCode;
  constructor(code: SecretsErrorCode, message: string) {
    super(message);
    this.name = "SecretsError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Secret-ref extraction helpers (schema-scoped; retained for the documented
// per-company config-delivery follow-up referenced in the SEC sign-off).
// ---------------------------------------------------------------------------

/**
 * Extract secret reference UUIDs from a plugin's configJson, scoped to only
 * the fields annotated with `format: "secret-ref"` in the schema.
 *
 * When no schema is provided, falls back to collecting all UUID-shaped strings
 * (backwards-compatible for plugins without a declared instanceConfigSchema).
 */
export function extractSecretRefsFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): Set<string> {
  return new Set(extractSecretRefPathsFromConfig(configJson, schema).keys());
}

export function extractSecretRefPathsFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  const addRef = (secretRef: string, path: string) => {
    const existing = refs.get(secretRef) ?? new Set<string>();
    existing.add(path);
    refs.set(secretRef, existing);
  };
  if (configJson == null || typeof configJson !== "object") return new Map();

  const secretPaths = collectSecretRefPaths(schema);

  // If schema declares secret-ref paths, extract only those values.
  if (secretPaths.size > 0) {
    for (const dotPath of secretPaths) {
      const current = readConfigValueAtPath(configJson as Record<string, unknown>, dotPath);
      if (typeof current === "string" && isUuidSecretRef(current)) {
        addRef(current, dotPath);
      }
    }
    return refs;
  }

  // Fallback: no schema or no secret-ref annotations — collect all UUIDs.
  // This preserves backwards compatibility for plugins that omit
  // instanceConfigSchema.
  function walkAll(value: unknown): void {
    if (typeof value === "string") {
      if (isUuidSecretRef(value)) addRef(value, "$");
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
// Public types
// ---------------------------------------------------------------------------

/**
 * Input shape for the `secrets.resolve` handler. The worker supplies only the
 * ref and the opaque dispatch `runId`; the dispatching company is re-derived
 * server-side from the run-context registry.
 *
 * Matches `WorkerToHostMethods["secrets.resolve"][0]` from the SDK protocol.
 */
export interface PluginSecretsResolveParams {
  /** The secret reference string (a secret UUID). */
  secretRef: string;
  /** The runId of the currently-executing tool dispatch. */
  runId: string;
}

/**
 * Input shape for the `secrets.mintHandle` handler (PLA-702 Control 2). The
 * worker supplies the resolved plaintext plus the opaque dispatch `runId`; the
 * dispatching company/agent is re-derived server-side from the run-context
 * registry (the worker is never trusted for scope).
 *
 * Matches `WorkerToHostMethods["secrets.mintHandle"][0]` from the SDK protocol.
 */
export interface PluginSecretsMintHandleParams {
  /** The resolved secret plaintext to borrow behind an opaque handle. */
  value: string;
  /** The runId of the currently-executing tool dispatch. */
  runId: string;
  /**
   * The UUID of the secret being borrowed (PLA-723). The host uses it ONLY to
   * look up the per-company binding row and capture that binding's
   * operator-set egress allowlist onto the handle — the worker can never
   * supply the allowlist itself (EG1-provenance). Absent / no-binding mints
   * get the migration-safe log-only posture.
   */
  secretRef?: string;
}

/**
 * A per-company plugin secret-ref binding row, narrowed to the fields this
 * handler needs. Implemented by a query against `company_secret_bindings`.
 */
export interface PluginSecretBindingRow {
  /** Binding row id — the EG3 purge correlation key captured onto the handle. */
  id: string;
  secretId: string;
  configPath: string;
  versionSelector: string | null;
  /** Operator-set egress destination allowlist (PLA-723, EG1-provenance). */
  allowedEgress: string[];
  /** EG4: NEW bindings enforce; pre-existing migrate via log-only. */
  egressAllowlistEnforced: boolean;
}

/**
 * PLA-768: a binding row resolved for a worker-lifetime **service** context,
 * where there is no dispatching company. The owning company is derived from the
 * binding itself: a `secretRef` has exactly one owning company, so a
 * `(plugin install, secretId)` binding uniquely determines the company that may
 * resolve it. The derived `companyId` is then re-checked by `resolveSecretValue`
 * (Gate 4), so this lookup grants no broader access than the plugin's own
 * operator-created bindings.
 */
export interface PluginServiceSecretBindingRow extends PluginSecretBindingRow {
  /** The company that owns this binding (and the secret) — derived, not asserted. */
  companyId: string;
}

export interface PluginSecretBindingLookup {
  findBinding(input: {
    companyId: string;
    pluginTargetId: string;
    secretId: string;
  }): Promise<PluginSecretBindingRow | null>;
  /**
   * PLA-768: find the single binding for `(plugin install, secretId)` WITHOUT a
   * dispatching company, returning the owning company. Fails closed (returns
   * null) if zero rows OR if more than one distinct company has bound the ref to
   * this plugin — an ambiguous derivation must never silently pick a tenant.
   *
   * Optional so existing dispatch-only injected lookups remain valid; when a
   * service-context resolve is attempted and this is absent, the handler fails
   * closed (opaque `not_found`).
   */
  findServiceBinding?(input: {
    pluginTargetId: string;
    secretId: string;
  }): Promise<PluginServiceSecretBindingRow | null>;
}

/**
 * Resolves a secret value scoped to the dispatching company. The default
 * implementation delegates to `secretService.resolveSecretValue`, which
 * enforces the `secret.companyId === companyId` predicate and delegates
 * decryption to the configured provider.
 */
export interface PluginSecretResolver {
  resolve(input: {
    companyId: string;
    secretId: string;
    version: number | "latest";
    pluginDbId: string;
    configPath: string;
  }): Promise<string>;
}

export interface PluginSecretsHandlerOptions {
  /** Database connection (used for the default binding lookup + audit log). */
  db: Db;
  /** The plugin install UUID — registry key, binding targetId, audit actorId. */
  pluginDbId: string;
  /** Human-readable plugin manifest id (audit field only). */
  pluginKey: string;
  /**
   * Server-trusted source of the dispatching company. When absent (e.g. a
   * legacy host built without it) the handler fails closed: every call returns
   * `runcontext_invalid`.
   */
  runContextRegistry?: PluginRunContextRegistry;
  /** Override the per-agent global rate limit (default 30/min). */
  globalRateLimit?: { maxAttempts: number; windowMs: number };
  /** Override the per-(agent, company) sub-bucket limit (default 30/min). */
  perCompanyRateLimit?: { maxAttempts: number; windowMs: number };
  /** Inject the binding lookup (defaults to a company_secret_bindings query). */
  bindings?: PluginSecretBindingLookup;
  /** Inject the resolver (defaults to secretService.resolveSecretValue). */
  resolver?: PluginSecretResolver;
  /** Inject a clock for tests. */
  now?: () => number;
}

/**
 * The `HostServices.secrets` adapter for the plugin host-client factory.
 */
export interface PluginSecretsService {
  /**
   * Resolve a secret reference to its current plaintext value, scoped to the
   * dispatching company.
   *
   * @throws {SecretsError} typed code only — never leaks ref/value.
   */
  resolve(params: PluginSecretsResolveParams): Promise<string>;

  /**
   * Mint an opaque borrowed handle for a resolved secret plaintext within the
   * server-validated dispatch run (PLA-702 Control 2). Registers the value with
   * the Control-1 value-exact redactor (fail-closed) before minting, so the
   * consuming tool's own output is also scrubbed from the transcript.
   *
   * @throws {SecretsError} typed code only — never leaks the value. The value
   *   is never logged.
   */
  mintHandle(params: PluginSecretsMintHandleParams): Promise<{ handle: string }>;
}

// ---------------------------------------------------------------------------
// Rate limiter — sliding-window, in-memory (mirrors plugin-artifacts-handler)
// ---------------------------------------------------------------------------

function createRateLimiter(maxAttempts: number, windowMs: number, now: () => number) {
  const attempts = new Map<string, number[]>();

  return {
    /** Returns true if allowed; records the attempt as side-effect. */
    check(key: string): boolean {
      const ts = now();
      const windowStart = ts - windowMs;
      const existing = (attempts.get(key) ?? []).filter((t) => t > windowStart);
      if (existing.length >= maxAttempts) {
        attempts.set(key, existing);
        return false;
      }
      existing.push(ts);
      attempts.set(key, existing);
      return true;
    },
  };
}

const DEFAULT_GLOBAL = { maxAttempts: 30, windowMs: 60_000 };
const DEFAULT_PER_COMPANY = { maxAttempts: 30, windowMs: 60_000 };

/** Translate a binding's text version selector into the resolver's argument. */
function parseVersionSelector(selector: string | null | undefined): number | "latest" {
  if (!selector || selector === "latest") return "latest";
  const n = Number(selector);
  return Number.isInteger(n) && n > 0 ? n : "latest";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `HostServices.secrets` adapter for a specific plugin install.
 *
 * @example
 * ```ts
 * const secretsHandler = createPluginSecretsHandler({
 *   db, pluginDbId, pluginKey, runContextRegistry,
 * });
 * ```
 */
export function createPluginSecretsHandler(
  options: PluginSecretsHandlerOptions,
): PluginSecretsService {
  const { db, pluginDbId, pluginKey, runContextRegistry } = options;
  const now = options.now ?? (() => Date.now());
  const globalCfg = options.globalRateLimit ?? DEFAULT_GLOBAL;
  const perCompanyCfg = options.perCompanyRateLimit ?? DEFAULT_PER_COMPANY;

  const globalLimiter = createRateLimiter(globalCfg.maxAttempts, globalCfg.windowMs, now);
  const perCompanyLimiter = createRateLimiter(
    perCompanyCfg.maxAttempts,
    perCompanyCfg.windowMs,
    now,
  );
  // PLA-768: a service/background context has no dispatching agent, so it cannot
  // share the per-agent buckets. It gets its own limiter with the same
  // window/limit so a runaway poll loop is still capped.
  //
  // PLA-773 (item 3): the limiter is keyed per `(plugin, company)` whenever the
  // company is known — a background dispatch carries its triggering company, so
  // one tenant's runaway loop can no longer exhaust the bucket every other
  // tenant's background resolves share. The genuinely company-less `setup()`
  // path falls back to the per-plugin key as a pre-lookup enumeration guard
  // (no company is known until after the binding lookup).
  const serviceLimiter = createRateLimiter(globalCfg.maxAttempts, globalCfg.windowMs, now);
  const serviceRateKey = (companyId?: string) =>
    companyId ? `service:${pluginDbId}|company:${companyId}` : `service:${pluginDbId}`;
  const log = logger.child({ service: "plugin-secrets-handler", pluginId: pluginKey });

  const bindings: PluginSecretBindingLookup =
    options.bindings ?? {
      async findBinding(input) {
        const row = await db
          .select({
            id: companySecretBindings.id,
            secretId: companySecretBindings.secretId,
            configPath: companySecretBindings.configPath,
            versionSelector: companySecretBindings.versionSelector,
            allowedEgress: companySecretBindings.allowedEgress,
            egressAllowlistEnforced: companySecretBindings.egressAllowlistEnforced,
          })
          .from(companySecretBindings)
          .where(
            and(
              eq(companySecretBindings.companyId, input.companyId),
              eq(companySecretBindings.targetType, PLUGIN_SECRET_BINDING_TARGET_TYPE),
              eq(companySecretBindings.targetId, input.pluginTargetId),
              eq(companySecretBindings.secretId, input.secretId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        return row;
      },
      async findServiceBinding(input) {
        // PLA-768: no dispatching company is supplied — derive it from the
        // binding. We select ALL rows for (plugin install, secretId) so we can
        // fail closed on ambiguity rather than picking an arbitrary tenant.
        const rows = await db
          .select({
            companyId: companySecretBindings.companyId,
            id: companySecretBindings.id,
            secretId: companySecretBindings.secretId,
            configPath: companySecretBindings.configPath,
            versionSelector: companySecretBindings.versionSelector,
            allowedEgress: companySecretBindings.allowedEgress,
            egressAllowlistEnforced: companySecretBindings.egressAllowlistEnforced,
          })
          .from(companySecretBindings)
          .where(
            and(
              eq(companySecretBindings.targetType, PLUGIN_SECRET_BINDING_TARGET_TYPE),
              eq(companySecretBindings.targetId, input.pluginTargetId),
              eq(companySecretBindings.secretId, input.secretId),
            ),
          );
        if (rows.length === 0) return null;
        const distinctCompanies = new Set(rows.map((r) => r.companyId));
        // Ambiguous: more than one company bound this ref to this plugin. A
        // secret has one owning company, so this should not happen, but if it
        // does we refuse rather than leak a cross-tenant resolution.
        if (distinctCompanies.size > 1) return null;
        return rows[0];
      },
    };

  const resolver: PluginSecretResolver =
    options.resolver ?? {
      async resolve(input) {
        return secretService(db).resolveSecretValue(
          input.companyId,
          input.secretId,
          input.version,
          {
            consumerType: PLUGIN_SECRET_BINDING_TARGET_TYPE,
            consumerId: input.pluginDbId,
            configPath: input.configPath,
            actorType: "plugin",
            actorId: input.pluginDbId,
            pluginId: input.pluginDbId,
          },
        );
      },
    };

  /**
   * Best-effort, value-free audit. Failures are logged but never change the
   * decision returned to the worker. Mirrors the artifacts.fetch six-field
   * schema; on a deny the secret's owning company is left null (the scoped
   * lookup never loaded a cross-company row — see PLA-656 §Audit).
   */
  async function audit(input: {
    outcome: "allowed" | "denied";
    deniedReason?: SecretsErrorCode;
    /**
     * PLA-768: null for a worker-lifetime **service** context (background
     * dispatch / setup-loop) — there is no dispatching agent. The audit row is
     * still attributed to the plugin system actor (`actorType: "plugin"`).
     */
    dispatchingAgentId: string | null;
    dispatchingCompanyId: string;
    secretId: string;
    runId: string;
    toolName: string;
  }) {
    try {
      await logActivity(db, {
        companyId: input.dispatchingCompanyId,
        actorType: "plugin",
        actorId: pluginDbId,
        action: "secret.resolved",
        entityType: "company_secret",
        entityId: input.secretId,
        agentId: input.dispatchingAgentId,
        runId: input.runId,
        details: {
          pluginKey,
          pluginDbId,
          outcome: input.outcome,
          deniedReason: input.deniedReason ?? null,
          dispatchingAgentId: input.dispatchingAgentId,
          dispatchingCompanyId: input.dispatchingCompanyId,
          // Owning company is intentionally null on a deny: the scoped
          // binding/resolve path never loads a cross-company row, so we
          // cannot (and must not) attribute the ref to another tenant.
          secretCompanyId: input.outcome === "allowed" ? input.dispatchingCompanyId : null,
          toolName: input.toolName,
        },
      });
    } catch (err) {
      // Never include the resolved value; secretId is a non-secret UUID.
      log.warn({ err, secretId: input.secretId }, "secret audit log write failed");
    }
  }

  /**
   * PLA-768: resolve a secret for a worker-lifetime **service** context. Used
   * by background dispatches (onEvent/onWebhook/runJob) and setup()-started
   * loops that resolve secrets outside any agent RPC dispatch.
   *
   * Differences from the dispatch path:
   *  - There is NO dispatching agent or company. The owning company is DERIVED
   *    from the operator-created binding (`findServiceBinding`), which fails
   *    closed on zero/ambiguous rows. A secretRef has exactly one owning
   *    company, so this grants no broader access than the plugin's own bindings.
   *  - Rate-limiting uses a dedicated per-plugin service bucket (no agent key).
   *  - The audit row carries `actorType: "plugin"`, `agentId: null`, the derived
   *    company, the host-minted service runId, and a `service:background`
   *    sentinel toolName.
   *
   * Every later gate (resolve company re-check, value-exact redaction, opaque
   * `not_found` collapse) is identical to the dispatch path. The `secretRef` is
   * already shape/UUID-validated by the caller (Gate 0).
   */
  async function resolveForServiceContext(
    trimmedRef: string,
    serviceRunId: string,
  ): Promise<string> {
    const sentinelTool = "service:background";

    // ---------- Gate 2: rate limit (per-plugin service bucket) ----------
    // Checked BEFORE any DB lookup so a forged/looping worker cannot enumerate.
    // No company is known yet, so no audit is possible on this deny.
    if (!serviceLimiter.check(serviceRateKey())) {
      throw new SecretsError("rate_limited", "service rate limit exceeded");
    }

    // ---------- Gate 3: derive company + binding (fail closed) ----------
    // No dispatching company is asserted; the binding determines it. Not-bound
    // (or ambiguous) collapses to not_found with no company to attribute. An
    // injected lookup without service support also fails closed here.
    if (!bindings.findServiceBinding) {
      throw new SecretsError("not_found", "secret not found");
    }
    const binding = await bindings.findServiceBinding({
      pluginTargetId: pluginDbId,
      secretId: trimmedRef,
    });
    if (!binding) {
      throw new SecretsError("not_found", "secret not found");
    }
    const companyId = binding.companyId;

    // ---------- Gate 4: company-scoped resolve (defence in depth) ----------
    // resolveSecretValue re-checks secret.companyId === companyId; every failure
    // shape flattens to opaque not_found. The value is never cached.
    let value: string;
    try {
      value = await resolver.resolve({
        companyId,
        secretId: trimmedRef,
        version: parseVersionSelector(binding.versionSelector),
        pluginDbId,
        configPath: binding.configPath,
      });
    } catch (err) {
      log.warn(
        { err, secretId: trimmedRef, companyId },
        "service-context secret resolution failed; collapsing to not_found",
      );
      await audit({
        outcome: "denied",
        deniedReason: "not_found",
        dispatchingAgentId: null,
        dispatchingCompanyId: companyId,
        secretId: trimmedRef,
        runId: serviceRunId,
        toolName: sentinelTool,
      });
      throw new SecretsError("not_found", "secret not found");
    }

    // ---------- Gate 5: value-exact redaction (fail-closed) ----------
    // Keyed by the host-minted service runId so any persisted record carrying
    // these bytes is scrubbed. Fail-closed: a registration throw refuses the
    // resolution rather than risk leaking plaintext into a transcript.
    try {
      registerRunSecretValue(serviceRunId, value);
    } catch (err) {
      log.warn(
        { err, secretId: trimmedRef, companyId },
        "value-exact redaction registration failed; refusing service resolution (fail-closed)",
      );
      await audit({
        outcome: "denied",
        deniedReason: "not_found",
        dispatchingAgentId: null,
        dispatchingCompanyId: companyId,
        secretId: trimmedRef,
        runId: serviceRunId,
        toolName: sentinelTool,
      });
      throw new SecretsError("not_found", "secret not found");
    }

    // ---------- Gate 6: audit success + return ----------
    await audit({
      outcome: "allowed",
      dispatchingAgentId: null,
      dispatchingCompanyId: companyId,
      secretId: trimmedRef,
      runId: serviceRunId,
      toolName: sentinelTool,
    });

    return value;
  }

  /**
   * PLA-773 (item 1): resolve a secret for a per-dispatch **background** context
   * — a background dispatch (`onEvent`/`onWebhook`) that carries a known
   * TRIGGERING company. Unlike {@link resolveForServiceContext}, the company is
   * NOT derived from the binding: it is the host-validated triggering company,
   * and the binding lookup is **scoped to it** (the same company-scoped
   * `findBinding` the agent-dispatch path uses). So a global plugin worker
   * handling company A's event can resolve ONLY the secrets company A bound to
   * this plugin — a ref bound by company B collapses to the opaque `not_found`,
   * exactly as it would for an agent dispatch in company A.
   *
   * The triggering company comes from the run-context registry (host-derived
   * from the event), never from the worker. Rate-limiting uses the per-(plugin,
   * company) bucket (item 3). Gates 4-6 are identical to the other paths.
   */
  async function resolveForBackgroundContext(
    trimmedRef: string,
    backgroundRunId: string,
    companyId: string,
  ): Promise<string> {
    const sentinelTool = "background:dispatch";

    // ---------- Gate 2: rate limit (per-(plugin, company) bucket) ----------
    if (!serviceLimiter.check(serviceRateKey(companyId))) {
      await audit({
        outcome: "denied",
        deniedReason: "rate_limited",
        dispatchingAgentId: null,
        dispatchingCompanyId: companyId,
        secretId: trimmedRef,
        runId: backgroundRunId,
        toolName: sentinelTool,
      });
      throw new SecretsError("rate_limited", "background rate limit exceeded");
    }

    // ---------- Gate 3: company-scoped allow-list (binding) ----------
    // The ref is resolvable only if the TRIGGERING company has bound it to this
    // plugin. A cross-tenant ref is not bound here and collapses to not_found.
    const binding = await bindings.findBinding({
      companyId,
      pluginTargetId: pluginDbId,
      secretId: trimmedRef,
    });
    if (!binding) {
      await audit({
        outcome: "denied",
        deniedReason: "not_found",
        dispatchingAgentId: null,
        dispatchingCompanyId: companyId,
        secretId: trimmedRef,
        runId: backgroundRunId,
        toolName: sentinelTool,
      });
      throw new SecretsError("not_found", "secret not found");
    }

    // ---------- Gate 4: company-scoped resolve (defence in depth) ----------
    let value: string;
    try {
      value = await resolver.resolve({
        companyId,
        secretId: trimmedRef,
        version: parseVersionSelector(binding.versionSelector),
        pluginDbId,
        configPath: binding.configPath,
      });
    } catch (err) {
      log.warn(
        { err, secretId: trimmedRef, companyId },
        "background-context secret resolution failed; collapsing to not_found",
      );
      await audit({
        outcome: "denied",
        deniedReason: "not_found",
        dispatchingAgentId: null,
        dispatchingCompanyId: companyId,
        secretId: trimmedRef,
        runId: backgroundRunId,
        toolName: sentinelTool,
      });
      throw new SecretsError("not_found", "secret not found");
    }

    // ---------- Gate 5: value-exact redaction (fail-closed) ----------
    try {
      registerRunSecretValue(backgroundRunId, value);
    } catch (err) {
      log.warn(
        { err, secretId: trimmedRef, companyId },
        "value-exact redaction registration failed; refusing background resolution (fail-closed)",
      );
      await audit({
        outcome: "denied",
        deniedReason: "not_found",
        dispatchingAgentId: null,
        dispatchingCompanyId: companyId,
        secretId: trimmedRef,
        runId: backgroundRunId,
        toolName: sentinelTool,
      });
      throw new SecretsError("not_found", "secret not found");
    }

    // ---------- Gate 6: audit success + return ----------
    await audit({
      outcome: "allowed",
      dispatchingAgentId: null,
      dispatchingCompanyId: companyId,
      secretId: trimmedRef,
      runId: backgroundRunId,
      toolName: sentinelTool,
    });

    return value;
  }

  return {
    async resolve(params: PluginSecretsResolveParams): Promise<string> {
      // ---------- Gate 0: shape validation ----------
      if (!params || typeof params !== "object") {
        throw new SecretsError("invalid_ref", "invalid secret reference");
      }
      const { secretRef, runId } = params;
      if (typeof secretRef !== "string" || secretRef.trim().length === 0) {
        throw new SecretsError("invalid_ref", "invalid secret reference");
      }
      const trimmedRef = secretRef.trim();
      if (!isUuidSecretRef(trimmedRef)) {
        // Generic message — the ref is NEVER echoed (PLA-190/PLA-193, R2).
        throw new SecretsError("invalid_ref", "invalid secret reference");
      }
      if (typeof runId !== "string" || runId.trim().length === 0) {
        throw new SecretsError("runcontext_invalid", "no active dispatch for this runId");
      }

      // ---------- Gate 1: server-validated runContext lookup ----------
      // The dispatching company comes ONLY from the registry — never the worker.
      const ctx = runContextRegistry?.get(pluginDbId, runId.trim()) ?? null;
      if (!ctx) {
        // No audit — we have no tenant/agent to attribute the call to.
        throw new SecretsError("runcontext_invalid", "no active dispatch for this runId");
      }

      // ---------- PLA-768: worker-lifetime service context branch ----------
      // A background dispatch (onEvent/onWebhook/runJob) or a setup()-started
      // loop resolves from its OWN tick, outside any agent RPC dispatch. There
      // is no dispatching agent/company; the owning company is derived from the
      // operator-created binding (a secretRef has exactly one owning company),
      // and the resolve is attributed to the plugin system actor. The dispatch
      // path below is left byte-for-byte unchanged.
      if (ctx.kind === "service") {
        return resolveForServiceContext(trimmedRef, ctx.runId);
      }

      // ---------- PLA-773: per-dispatch background context branch ----------
      // A background dispatch (onEvent/onWebhook) with a known TRIGGERING
      // company. The owning company is NOT derived from the binding — it is the
      // host-validated triggering company, and the binding lookup is scoped to
      // it. So company A's event can never resolve company B's bound secret.
      if (ctx.kind === "background") {
        return resolveForBackgroundContext(trimmedRef, ctx.runId, ctx.companyId);
      }

      // ---------- Gate 2: rate limit (global, then per-company) ----------
      // Both buckets are keyed off the server-validated runContext, checked
      // BEFORE any DB lookup so enumeration is strictly bounded and one company
      // can never exhaust another company's bucket (PLA-656 R3).
      if (!globalLimiter.check(`agent:${ctx.agentId}`)) {
        await audit({
          outcome: "denied",
          deniedReason: "rate_limited",
          dispatchingAgentId: ctx.agentId,
          dispatchingCompanyId: ctx.companyId,
          secretId: trimmedRef,
          runId: ctx.runId,
          toolName: ctx.toolName,
        });
        throw new SecretsError("rate_limited", "global per-agent rate limit exceeded");
      }
      if (!perCompanyLimiter.check(`agent:${ctx.agentId}|company:${ctx.companyId}`)) {
        await audit({
          outcome: "denied",
          deniedReason: "rate_limited",
          dispatchingAgentId: ctx.agentId,
          dispatchingCompanyId: ctx.companyId,
          secretId: trimmedRef,
          runId: ctx.runId,
          toolName: ctx.toolName,
        });
        throw new SecretsError("rate_limited", "per-company rate limit exceeded");
      }

      // ---------- Gate 3: per-company allow-list (binding) ----------
      // The ref is resolvable only if the DISPATCHING company has bound it to
      // this plugin. Not-bound collapses to not_found (no allow-list oracle).
      const binding = await bindings.findBinding({
        companyId: ctx.companyId,
        pluginTargetId: pluginDbId,
        secretId: trimmedRef,
      });
      if (!binding) {
        await audit({
          outcome: "denied",
          deniedReason: "not_found",
          dispatchingAgentId: ctx.agentId,
          dispatchingCompanyId: ctx.companyId,
          secretId: trimmedRef,
          runId: ctx.runId,
          toolName: ctx.toolName,
        });
        throw new SecretsError("not_found", "secret not found");
      }

      // ---------- Gate 4: company-scoped resolve (defence in depth) ----------
      // resolveSecretValue re-checks secret.companyId === ctx.companyId and
      // throws distinguishable errors (404 not-found vs 422 cross-company vs
      // secret_deleted/secret_inactive/version_missing/version_inactive). EVERY
      // one of those — plus a provider error — is flattened to a single opaque
      // not_found at the worker boundary (PLA-656 R1, Q2). The value is never
      // cached, honouring rotation.
      let value: string;
      try {
        value = await resolver.resolve({
          companyId: ctx.companyId,
          secretId: trimmedRef,
          version: parseVersionSelector(binding.versionSelector),
          pluginDbId,
          configPath: binding.configPath,
        });
      } catch (err) {
        // The real error (which MAY distinguish cross-company vs missing vs
        // provider) stays server-side only. The worker sees opaque not_found.
        log.warn(
          { err, secretId: trimmedRef, companyId: ctx.companyId },
          "secret resolution failed; collapsing to not_found",
        );
        await audit({
          outcome: "denied",
          deniedReason: "not_found",
          dispatchingAgentId: ctx.agentId,
          dispatchingCompanyId: ctx.companyId,
          secretId: trimmedRef,
          runId: ctx.runId,
          toolName: ctx.toolName,
        });
        throw new SecretsError("not_found", "secret not found");
      }

      // ---------- Gate 5: register for value-exact redaction (fail-closed) ----------
      // The host has just mediated a vault.read resolution and holds plaintext.
      // Register the exact bytes (keyed by the server-validated runId) so any
      // PERSISTED tool-result/transcript/run-log record is value-exact redacted
      // by the shared redaction pipeline — the pattern/field-name heuristics
      // cannot reliably catch a high-entropy value embedded in free-form
      // `content` (PLA-697 / PLA-695 Control 1). The live value still flows back
      // to the worker (agent working context) unchanged below; only persisted
      // records are scrubbed. Fail-closed: if registration throws, persistence
      // could later leak the plaintext into the transcript, so we refuse the
      // resolution (collapse to the opaque not_found) rather than leak it.
      try {
        registerRunSecretValue(ctx.runId, value);
      } catch (err) {
        log.warn(
          { err, secretId: trimmedRef, companyId: ctx.companyId },
          "value-exact redaction registration failed; refusing resolution (fail-closed)",
        );
        await audit({
          outcome: "denied",
          deniedReason: "not_found",
          dispatchingAgentId: ctx.agentId,
          dispatchingCompanyId: ctx.companyId,
          secretId: trimmedRef,
          runId: ctx.runId,
          toolName: ctx.toolName,
        });
        throw new SecretsError("not_found", "secret not found");
      }

      // ---------- Gate 6: audit success + return ----------
      await audit({
        outcome: "allowed",
        dispatchingAgentId: ctx.agentId,
        dispatchingCompanyId: ctx.companyId,
        secretId: trimmedRef,
        runId: ctx.runId,
        toolName: ctx.toolName,
      });

      // The resolved value only ever appears in this return — never in logs.
      return value;
    },

    async mintHandle(
      params: PluginSecretsMintHandleParams,
    ): Promise<{ handle: string }> {
      // ---------- Gate 0: shape validation ----------
      // The `value` is the plaintext secret — it is NEVER echoed in errors or
      // logs (PLA-190/PLA-193, PLA-697 discipline).
      if (!params || typeof params !== "object") {
        throw new SecretsError("invalid_ref", "invalid mint request");
      }
      const { value, runId, secretRef } = params;
      if (typeof value !== "string" || value.length === 0) {
        throw new SecretsError("invalid_ref", "invalid mint request");
      }
      if (typeof runId !== "string" || runId.trim().length === 0) {
        throw new SecretsError("runcontext_invalid", "no active dispatch for this runId");
      }

      // ---------- Gate 1: server-validated runContext lookup (RC3) ----------
      // The borrowed value is keyed off the host-validated runContext, never a
      // worker-asserted run. A run-A handle can never resolve under run B.
      const ctx = runContextRegistry?.get(pluginDbId, runId.trim()) ?? null;
      if (!ctx) {
        throw new SecretsError("runcontext_invalid", "no active dispatch for this runId");
      }
      // PLA-768/PLA-773: borrowed handles are an agent-dispatch primitive (they
      // scope a plaintext to a single tool call's working context). Neither a
      // worker-lifetime service context nor a per-dispatch background context
      // has such a dispatch, so minting is rejected rather than attributed to a
      // non-existent agent.
      if (ctx.kind === "service" || ctx.kind === "background") {
        throw new SecretsError("runcontext_invalid", "no active dispatch for this runId");
      }

      // ---------- Gate 2: rate limit (shared with resolve) ----------
      if (!globalLimiter.check(`agent:${ctx.agentId}`)) {
        await auditMint({ outcome: "denied", deniedReason: "rate_limited", ctx });
        throw new SecretsError("rate_limited", "global per-agent rate limit exceeded");
      }
      if (!perCompanyLimiter.check(`agent:${ctx.agentId}|company:${ctx.companyId}`)) {
        await auditMint({ outcome: "denied", deniedReason: "rate_limited", ctx });
        throw new SecretsError("rate_limited", "per-company rate limit exceeded");
      }

      // ---------- Gate 3: Control-1 registration (RC2, fail-closed) ----------
      // Register the plaintext with the value-exact redactor so the CONSUMING
      // tool's own output (curl -v echo, error text, shell stdout) is scrubbed
      // from the persisted transcript. A registration throw FAILS the mint — we
      // never hand back a handle for a value we could not register, because the
      // substituted plaintext would otherwise reach a tool whose output is not
      // value-exact redacted.
      try {
        registerRunSecretValue(ctx.runId, value);
      } catch (err) {
        log.warn(
          { err, companyId: ctx.companyId, toolName: ctx.toolName },
          "value-exact redaction registration failed; refusing mint (fail-closed)",
        );
        await auditMint({ outcome: "denied", deniedReason: "not_found", ctx });
        throw new SecretsError("not_found", "mint failed");
      }

      // ---------- Gate 4: capture the binding's operator egress posture ----------
      // EG1-provenance: the allowlist is ALWAYS derived host-side from the
      // binding row keyed by (dispatching company, plugin, secretRef). The
      // worker only names WHICH secret it borrowed — it can never pass or
      // extend the allowlist. A mint with no `secretRef`, an invalid ref, or no
      // matching binding falls back to the migration-safe log-only posture
      // (the legacy default) rather than failing the mint.
      let capture: HandleCapture | undefined;
      if (typeof secretRef === "string" && isUuidSecretRef(secretRef.trim())) {
        const binding = await bindings.findBinding({
          companyId: ctx.companyId,
          pluginTargetId: pluginDbId,
          secretId: secretRef.trim(),
        });
        if (binding) {
          capture = {
            allowedEgress: binding.allowedEgress ?? [],
            enforced: binding.egressAllowlistEnforced,
            bindingId: binding.id,
          };
        }
      }

      // ---------- Gate 5: mint + store + audit ----------
      const handle = mintBorrowedHandle(ctx.runId, value, capture);
      await auditMint({ outcome: "allowed", ctx });

      // Only the opaque handle leaves this method; the value is never logged.
      return { handle };
    },
  };

  /**
   * Value-free audit for a borrowed-handle mint. Mirrors the resolve audit
   * discipline: the secret value is NEVER included; only the opaque
   * agent/company/tool dimensions are recorded. Failures never change the
   * decision returned to the worker.
   */
  async function auditMint(input: {
    outcome: "allowed" | "denied";
    deniedReason?: SecretsErrorCode;
    ctx: { agentId: string; companyId: string; runId: string; toolName: string };
  }) {
    try {
      await logActivity(db, {
        companyId: input.ctx.companyId,
        actorType: "plugin",
        actorId: pluginDbId,
        action: "secret.handle_minted",
        entityType: "plugin",
        entityId: pluginDbId,
        agentId: input.ctx.agentId,
        runId: input.ctx.runId,
        details: {
          pluginKey,
          pluginDbId,
          outcome: input.outcome,
          deniedReason: input.deniedReason ?? null,
          dispatchingAgentId: input.ctx.agentId,
          dispatchingCompanyId: input.ctx.companyId,
          toolName: input.ctx.toolName,
        },
      });
    } catch (err) {
      // No value, no secretId — nothing sensitive to leak in this warning.
      log.warn({ err, toolName: input.ctx.toolName }, "mint audit log write failed");
    }
  }
}
