/**
 * Plugin artifacts host-side handler — resolves attachment bytes on behalf of
 * the dispatching agent, enforcing all seven security gates locked in by
 * SecurityEngineer for PLA-574.
 *
 * The worker calls `ctx.artifacts.fetch(attachmentId)` from a tool handler OR
 * (PLA-897) a background dispatch (`onEvent`/`onWebhook`). The SDK serializes
 * that into a JSON-RPC `artifacts.fetch` request carrying ONLY
 * `{ attachmentId, runId }`. This handler:
 *
 *  1. Validates `(pluginDbId, runId)` against the in-memory run-context
 *     registry. If absent → `runcontext_invalid`. The worker is never trusted
 *     to assert agent identity. A company-less **service** context is rejected
 *     (`runcontext_invalid`): no company means no authorization basis.
 *  2. Loads the attachment by ID.
 *  3. Authorizes against the run-context's companyId — the **dispatching
 *     agent's** company for a dispatch fetch, or the host-validated
 *     **triggering** company for a background fetch (PLA-897) — NOT the
 *     worker's tenant. Mismatch + missing attachment are collapsed into a
 *     single `not_found` shape to deny existence/no-access enumeration.
 *  4. Applies a sliding-window rate limit keyed by dispatching agent when
 *     present, else by company (background), AND a per (principal,
 *     attachment-company) sub-bucket. Either ceiling triggers `rate_limited`.
 *  5. Emits an audit log entry (success OR deny) via `logActivity`. Fields:
 *     contextKind, dispatchingAgentId (null for background), dispatchingCompanyId,
 *     attachmentCompanyId, attachmentId, pluginId, outcome.
 *  6. Streams the storage object into a buffer (single-resource only;
 *     enforces a max byte cap to avoid OOM via JSON-RPC base64 inflation).
 *  7. Returns `{ filename, contentType, byteSize, contentBase64 }`. Bytes
 *     are NEVER logged.
 *
 * @see PLA-574 — host-mediated cross-tenant artifact fetch
 * @see PLA-897 — background run-context fetch, scoped to the triggering company
 */

import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { isAllowedPluginArtifactMimeType, normalizeContentType } from "../attachment-types.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import type { PluginRunContextRegistry } from "./plugin-run-context-registry.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Request shape over the wire. The worker only supplies `runId`. */
export interface PluginArtifactsFetchParams {
  attachmentId: string;
  runId: string;
}

/** Response shape returned to the worker. Bytes are base64-encoded. */
export interface PluginArtifactsFetchResult {
  filename: string;
  contentType: string;
  byteSize: number;
  contentBase64: string;
}

/**
 * PLA-888: request shape for `artifacts.create`. The worker supplies the target
 * company plus the bytes (base64); `runId` is the dispatch/service/background
 * run id the host validates against the registry.
 */
export interface PluginArtifactsCreateParams {
  companyId: string;
  filename: string;
  mimeType: string;
  contentBase64: string;
  runId: string;
}

/** PLA-888: response shape — the created (or deduped) asset id. */
export interface PluginArtifactsCreateResult {
  attachmentId: string;
}

/** Service shape consumed by `HostServices.artifacts`. */
export interface PluginArtifactsService {
  fetch(params: PluginArtifactsFetchParams): Promise<PluginArtifactsFetchResult>;
  create(params: PluginArtifactsCreateParams): Promise<PluginArtifactsCreateResult>;
}

/**
 * Minimal attachment metadata required by this handler. Kept narrow so the
 * service abstraction doesn't bloat — implemented by the existing
 * `issueService(db).getAttachmentById` shape.
 */
export interface AttachmentLookupRow {
  id: string;
  companyId: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  originalFilename: string | null;
}

export interface AttachmentLookup {
  getAttachmentById(id: string): Promise<AttachmentLookupRow | null>;
}

/**
 * PLA-888: the asset-write surface `artifacts.create` needs. Implemented by
 * `issueService(db)` (`createStandaloneAsset` / `findReusableUnattachedAsset`).
 * Kept separate from {@link AttachmentLookup} so the read path stays minimal.
 */
export interface AssetWriter {
  findReusableUnattachedAsset(companyId: string, sha256: string): Promise<{ id: string } | null>;
  createStandaloneAsset(input: {
    companyId: string;
    provider: string;
    objectKey: string;
    contentType: string;
    byteSize: number;
    sha256: string;
    originalFilename?: string | null;
    createdByAgentId?: string | null;
  }): Promise<{ id: string }>;
}

export interface CreateArtifactsHandlerOptions {
  db: Db;
  /** The plugin DB UUID (used as registry key + audit field). */
  pluginDbId: string;
  /** Human-readable plugin manifest id (audit field only). */
  pluginKey: string;
  storage: StorageService;
  attachments: AttachmentLookup;
  /** PLA-888: asset-write surface for `artifacts.create`. */
  assetWriter: AssetWriter;
  /**
   * PLA-888: resolve the per-company attachment byte ceiling — MUST mirror the
   * human upload route (`normalizeIssueAttachmentMaxBytes(company.attachmentMaxBytes)`).
   */
  resolveCompanyMaxBytes(companyId: string): Promise<number>;
  runContextRegistry: PluginRunContextRegistry;
  /** Override the per-agent global rate limit (default 60/min). */
  globalRateLimit?: { maxAttempts: number; windowMs: number };
  /** Override the per-(agent, company) sub-bucket limit (default 30/min). */
  perCompanyRateLimit?: { maxAttempts: number; windowMs: number };
  /** PLA-888: override the per-company write rate limit (default 30/min). */
  writeRateLimit?: { maxAttempts: number; windowMs: number };
  /** Hard ceiling on attachment size streamed through this path. */
  maxByteSize?: number;
  /** Inject a clock for tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export type ArtifactsErrorCode =
  | "runcontext_invalid"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "too_large";

export class ArtifactsError extends Error {
  readonly code: ArtifactsErrorCode;
  constructor(code: ArtifactsErrorCode, message: string) {
    super(message);
    this.name = "ArtifactsError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Rate limiter — sliding-window, in-memory
// ---------------------------------------------------------------------------

function createRateLimiter(
  maxAttempts: number,
  windowMs: number,
  now: () => number,
) {
  const attempts = new Map<string, number[]>();

  return {
    /** Returns true if allowed; records the attempt as side-effect. */
    check(key: string): boolean {
      const ts = now();
      const windowStart = ts - windowMs;
      const existing = (attempts.get(key) ?? []).filter((t) => t > windowStart);
      if (existing.length >= maxAttempts) {
        // Persist the trimmed list so memory doesn't grow unboundedly.
        attempts.set(key, existing);
        return false;
      }
      existing.push(ts);
      attempts.set(key, existing);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Stream → bounded Buffer
// ---------------------------------------------------------------------------

async function readStreamToBuffer(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      // Destroy upstream stream so the storage backend can release resources.
      stream.destroy();
      throw new ArtifactsError(
        "too_large",
        `artifact exceeds maximum size of ${maxBytes} bytes`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_GLOBAL = { maxAttempts: 60, windowMs: 60_000 };
const DEFAULT_PER_COMPANY = { maxAttempts: 30, windowMs: 60_000 };
/** PLA-888: per-company write ceiling — bounds storage-DoS from the relay path
 *  where there is no dispatching agent to key off. */
const DEFAULT_WRITE = { maxAttempts: 30, windowMs: 60_000 };
/**
 * Default plugin-artifact byte ceiling: 25 MiB (PLA-1147, raised from 10 MiB).
 *
 * Sized to cover everything Telegram's Bot API `getFile` can deliver (hard 20 MB
 * inbound cap) plus margin for base64/metadata, so an operator can relay a CAD
 * model / STL through the inbound messenger path. The worker↔host transport is
 * node `fork` IPC over stdio (NOT express), so the 10 MiB JSON body limit
 * (DEFAULT_JSON_BODY_LIMIT) does not gate this path — a ~25 MiB binary inflates
 * to a ~33 MiB base64 string over IPC, which is feasible.
 *
 * Env-tunable, mirroring the human upload route's `PAPERCLIP_ATTACHMENT_MAX_BYTES`:
 * `PAPERCLIP_PLUGIN_ARTIFACT_MAX_BYTES` wins, then the shared
 * `PAPERCLIP_ATTACHMENT_MAX_BYTES`, then this 25 MiB default. NOTE: the effective
 * ceiling is still `Math.min(companyMaxBytes, maxByteSize)` (see the `create`
 * size gate) — the per-company attachment limit can lower it below this value.
 */
const DEFAULT_MAX_BYTES =
  Number(process.env.PAPERCLIP_PLUGIN_ARTIFACT_MAX_BYTES) ||
  Number(process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES) ||
  25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPluginArtifactsHandler(
  opts: CreateArtifactsHandlerOptions,
): PluginArtifactsService {
  const {
    db,
    pluginDbId,
    pluginKey,
    storage,
    attachments,
    assetWriter,
    resolveCompanyMaxBytes,
    runContextRegistry,
  } = opts;
  const now = opts.now ?? (() => Date.now());
  const globalCfg = opts.globalRateLimit ?? DEFAULT_GLOBAL;
  const perCompanyCfg = opts.perCompanyRateLimit ?? DEFAULT_PER_COMPANY;
  const writeCfg = opts.writeRateLimit ?? DEFAULT_WRITE;
  const maxByteSize = opts.maxByteSize ?? DEFAULT_MAX_BYTES;

  const globalLimiter = createRateLimiter(
    globalCfg.maxAttempts,
    globalCfg.windowMs,
    now,
  );
  const perCompanyLimiter = createRateLimiter(
    perCompanyCfg.maxAttempts,
    perCompanyCfg.windowMs,
    now,
  );
  const writeLimiter = createRateLimiter(
    writeCfg.maxAttempts,
    writeCfg.windowMs,
    now,
  );
  const log = logger.child({ service: "plugin-artifacts-handler", pluginId: pluginKey });

  /**
   * Best-effort audit emission. Failures are logged but do NOT change the
   * decision returned to the worker (audit logging is not in the critical
   * authorization path — if it fails, we still return the correct decision).
   */
  async function audit(input: {
    outcome: "allowed" | "denied";
    deniedReason?: ArtifactsErrorCode;
    // PLA-897: a background fetch has no dispatching agent — mirror the create
    // audit and allow null (system actor).
    contextKind: "dispatch" | "background";
    dispatchingAgentId: string | null;
    dispatchingCompanyId: string;
    attachmentCompanyId: string | null;
    attachmentId: string;
    runId: string;
    toolName: string | null;
    byteSize?: number;
  }) {
    try {
      // We audit against the DISPATCHING agent's company so the activity log
      // shows up in their tenant's audit trail (where the data was actually
      // accessed). The plugin key and outcome are first-class for the
      // six-field schema PLA-574 §Audit.
      await logActivity(db, {
        companyId: input.dispatchingCompanyId,
        actorType: "plugin",
        actorId: pluginDbId,
        action: "artifact.fetched",
        entityType: "issue_attachment",
        entityId: input.attachmentId,
        agentId: input.dispatchingAgentId ?? undefined,
        runId: input.runId,
        details: {
          pluginKey,
          pluginDbId,
          outcome: input.outcome,
          deniedReason: input.deniedReason ?? null,
          contextKind: input.contextKind,
          dispatchingAgentId: input.dispatchingAgentId,
          dispatchingCompanyId: input.dispatchingCompanyId,
          attachmentCompanyId: input.attachmentCompanyId,
          attachmentId: input.attachmentId,
          toolName: input.toolName,
          byteSize: input.byteSize ?? null,
        },
      });
    } catch (err) {
      log.warn({ err, attachmentId: input.attachmentId }, "audit log write failed");
    }
  }

  /**
   * PLA-888: audit the write path. Six fields mirror the fetch audit but the
   * action is `artifact.created` and the actor may be a system context (service
   * /background dispatch) with no dispatching agent. Bytes are NEVER recorded —
   * only the sha256 digest + size. Best-effort like {@link audit}.
   */
  async function auditCreate(input: {
    outcome: "allowed" | "denied";
    deniedReason?: ArtifactsErrorCode;
    companyId: string;
    contextKind: "dispatch" | "service" | "background";
    dispatchingAgentId: string | null;
    runId: string;
    toolName: string | null;
    assetId?: string | null;
    sha256?: string | null;
    byteSize?: number | null;
    mimeType?: string | null;
    deduped?: boolean;
  }) {
    try {
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "plugin",
        actorId: pluginDbId,
        action: "artifact.created",
        entityType: "asset",
        entityId: input.assetId ?? input.companyId,
        agentId: input.dispatchingAgentId ?? undefined,
        runId: input.runId,
        details: {
          pluginKey,
          pluginDbId,
          outcome: input.outcome,
          deniedReason: input.deniedReason ?? null,
          contextKind: input.contextKind,
          dispatchingAgentId: input.dispatchingAgentId,
          companyId: input.companyId,
          assetId: input.assetId ?? null,
          sha256: input.sha256 ?? null,
          byteSize: input.byteSize ?? null,
          mimeType: input.mimeType ?? null,
          deduped: input.deduped ?? false,
          toolName: input.toolName,
        },
      });
    } catch (err) {
      log.warn({ err, companyId: input.companyId }, "create audit log write failed");
    }
  }

  return {
    async fetch(params: PluginArtifactsFetchParams): Promise<PluginArtifactsFetchResult> {
      // ---------- Gate 0: shape validation (single-resource) ----------
      if (!params || typeof params !== "object") {
        throw new ArtifactsError("runcontext_invalid", "invalid request");
      }
      const { attachmentId, runId } = params;
      if (typeof attachmentId !== "string" || attachmentId.length === 0) {
        throw new ArtifactsError("runcontext_invalid", "invalid attachmentId");
      }
      if (typeof runId !== "string" || runId.length === 0) {
        throw new ArtifactsError("runcontext_invalid", "invalid runId");
      }

      // ---------- Gate 1: server-validated runContext lookup ----------
      // Source of truth for dispatching agent identity. The worker's claim is
      // discarded — only the (pluginDbId, runId) → registered entry counts.
      const ctx = runContextRegistry.get(pluginDbId, runId);
      if (!ctx) {
        // No audit — we don't have a tenant/agent to log against.
        throw new ArtifactsError(
          "runcontext_invalid",
          "no active dispatch for this runId",
        );
      }
      // PLA-768: a worker-lifetime service context carries NO company, so an
      // attachment fetch has no authorization basis — reject it like an unknown
      // runId. PLA-897: a per-dispatch background context DOES carry the
      // host-validated triggering company, which is the same scope a dispatch
      // fetch authorizes against (company-level), so it is allowed below with no
      // dispatching agent. A back-compat dispatch entry has `kind` absent, so
      // test for the company-less service kind explicitly.
      if (ctx.kind === "service") {
        throw new ArtifactsError(
          "runcontext_invalid",
          "no active dispatch for this runId",
        );
      }

      // PLA-897: derive the authorizing principal once. Background has a company
      // but no agent (system actor); dispatch has both. Rate-limit/audit keys
      // fall back to the company when there is no agent.
      const authCompanyId = ctx.companyId;
      const principalAgentId = ctx.kind === "background" ? null : ctx.agentId;
      const contextKind: "dispatch" | "background" =
        ctx.kind === "background" ? "background" : "dispatch";
      const toolName = ctx.kind === "background" ? null : ctx.toolName;
      const rateKey = principalAgentId
        ? `agent:${principalAgentId}`
        : `company:${authCompanyId}`;

      // ---------- Gate 2: rate limit (global first, then per-company) ----------
      // Global check happens before lookups to make brute-force enumeration
      // strictly bounded. We don't know attachmentCompanyId yet for the
      // per-company bucket; that's a second check after the lookup succeeds.
      if (!globalLimiter.check(rateKey)) {
        await audit({
          outcome: "denied",
          deniedReason: "rate_limited",
          contextKind,
          dispatchingAgentId: principalAgentId,
          dispatchingCompanyId: authCompanyId,
          attachmentCompanyId: null,
          attachmentId,
          runId,
          toolName,
        });
        throw new ArtifactsError("rate_limited", "global rate limit exceeded");
      }

      // ---------- Gate 3: attachment lookup ----------
      const attachment = await attachments.getAttachmentById(attachmentId);
      if (!attachment) {
        // Collapse non-existence into not_found to match the no-access case.
        await audit({
          outcome: "denied",
          deniedReason: "not_found",
          contextKind,
          dispatchingAgentId: principalAgentId,
          dispatchingCompanyId: authCompanyId,
          attachmentCompanyId: null,
          attachmentId,
          runId,
          toolName,
        });
        throw new ArtifactsError("not_found", "attachment not found");
      }

      // ---------- Gate 4: authorization ----------
      // For a dispatch fetch, agents are scoped to a single company per the JWT
      // actor model (routes/authz.ts:assertCompanyAccess): the dispatching
      // agent's company MUST match the attachment's company. PLA-897: a
      // background fetch authorizes against the host-validated TRIGGERING company
      // (`authCompanyId`) — same company-level check, correct result. We DO NOT
      // use the worker's tenant for authz in either case.
      if (authCompanyId !== attachment.companyId) {
        await audit({
          outcome: "denied",
          deniedReason: "not_found",
          contextKind,
          dispatchingAgentId: principalAgentId,
          dispatchingCompanyId: authCompanyId,
          attachmentCompanyId: attachment.companyId,
          attachmentId,
          runId,
          toolName,
        });
        // Collapse to not_found to prevent existence enumeration by a caller
        // guessing IDs in other tenants.
        throw new ArtifactsError("not_found", "attachment not found");
      }

      // ---------- Gate 5: per-(principal, attachment-company) sub-bucket ----------
      // Keyed by agent when present, otherwise by company so a background fetch
      // is bounded per triggering company.
      const subKey = principalAgentId
        ? `agent:${principalAgentId}|company:${attachment.companyId}`
        : `company:${attachment.companyId}`;
      if (!perCompanyLimiter.check(subKey)) {
        await audit({
          outcome: "denied",
          deniedReason: "rate_limited",
          contextKind,
          dispatchingAgentId: principalAgentId,
          dispatchingCompanyId: authCompanyId,
          attachmentCompanyId: attachment.companyId,
          attachmentId,
          runId,
          toolName,
        });
        throw new ArtifactsError(
          "rate_limited",
          "per-attachment-company rate limit exceeded",
        );
      }

      // ---------- Gate 6: storage fetch + bounded read ----------
      const object = await storage.getObject(attachment.companyId, attachment.objectKey);
      let buf: Buffer;
      try {
        buf = await readStreamToBuffer(object.stream, maxByteSize);
      } catch (err) {
        // Authz (Gate 4) already passed, so an oversize read is a deny by an
        // *authorized* caller. Audit it for symmetry with the other deny
        // gates — otherwise a plugin could repeatedly pull a large attachment
        // to OOM-stress storage retrieval with zero audit signal (PLA-578 F1).
        if (err instanceof ArtifactsError && err.code === "too_large") {
          await audit({
            outcome: "denied",
            deniedReason: "too_large",
            contextKind,
            dispatchingAgentId: principalAgentId,
            dispatchingCompanyId: authCompanyId,
            attachmentCompanyId: attachment.companyId,
            attachmentId,
            runId,
            toolName,
          });
        }
        throw err;
      }

      // ---------- Gate 7: audit success + return ----------
      await audit({
        outcome: "allowed",
        contextKind,
        dispatchingAgentId: principalAgentId,
        dispatchingCompanyId: authCompanyId,
        attachmentCompanyId: attachment.companyId,
        attachmentId,
        runId,
        toolName,
        byteSize: buf.length,
      });

      return {
        filename: attachment.originalFilename ?? "attachment",
        contentType: attachment.contentType ?? object.contentType ?? "application/octet-stream",
        byteSize: buf.length,
        // Bytes only ever appear in the response payload — never logs/details.
        contentBase64: buf.toString("base64"),
      };
    },

    async create(params: PluginArtifactsCreateParams): Promise<PluginArtifactsCreateResult> {
      // ---------- Gate 0: shape validation ----------
      if (!params || typeof params !== "object") {
        throw new ArtifactsError("runcontext_invalid", "invalid request");
      }
      const { companyId, filename, mimeType, contentBase64, runId } = params;
      if (typeof runId !== "string" || runId.length === 0) {
        throw new ArtifactsError("runcontext_invalid", "invalid runId");
      }
      if (typeof companyId !== "string" || companyId.length === 0) {
        throw new ArtifactsError("forbidden", "invalid companyId");
      }
      if (typeof contentBase64 !== "string" || contentBase64.length === 0) {
        throw new ArtifactsError("too_large", "missing artifact bytes");
      }

      // ---------- Gate 1: server-validated runContext lookup ----------
      const ctx = runContextRegistry.get(pluginDbId, runId);
      if (!ctx) {
        throw new ArtifactsError("runcontext_invalid", "no active run for this runId");
      }
      const contextKind: "dispatch" | "service" | "background" =
        ctx.kind === "service" ? "service" : ctx.kind === "background" ? "background" : "dispatch";
      const dispatchingAgentId = ctx.kind === "service" || ctx.kind === "background" ? null : ctx.agentId;
      const toolName = ctx.kind === "service" || ctx.kind === "background" ? null : ctx.toolName;

      // ---------- Gate 2: per-tenant authorization ----------
      // dispatch / background contexts carry a server-validated company — the
      // claimed `companyId` MUST match it (no cross-tenant write). A service
      // context (PLA-768, e.g. the messenger inbound relay) carries NO company,
      // so the claimed `companyId` is trusted as the write target: the asset is
      // stored under that company's namespace ONLY and is unattached until
      // `issues.createComment` binds it (which independently re-checks the issue's
      // company). The reachable set equals the plugin's dispatch-lifetime reach;
      // storage cost is bounded by the per-company write rate limit below. This
      // deviates from `artifacts.fetch` (which rejects service/background) — a
      // read is scoped to the dispatching agent's access, but an inbound write
      // legitimately has no agent. See PLA-888 security notes.
      // A dispatch context's `kind` is optional (absent === "dispatch"), so test
      // for the company-less service kind rather than enumerating the others —
      // otherwise a back-compat dispatch entry (no `kind`) would be misread as
      // service and skip the cross-tenant check.
      const scopedCompanyId = ctx.kind === "service" ? null : ctx.companyId;
      if (scopedCompanyId !== null && scopedCompanyId !== companyId) {
        await auditCreate({
          outcome: "denied",
          deniedReason: "forbidden",
          companyId,
          contextKind,
          dispatchingAgentId,
          runId,
          toolName,
        });
        // `forbidden` (not `not_found`): the caller named its OWN company
        // explicitly, so there is no cross-tenant enumeration concern that the
        // fetch path's `not_found` collapse exists to prevent.
        throw new ArtifactsError("forbidden", "companyId does not match the dispatching scope");
      }

      // ---------- Gate 3: per-company write rate limit ----------
      if (!writeLimiter.check(`company:${companyId}`)) {
        await auditCreate({
          outcome: "denied",
          deniedReason: "rate_limited",
          companyId,
          contextKind,
          dispatchingAgentId,
          runId,
          toolName,
        });
        throw new ArtifactsError("rate_limited", "per-company write rate limit exceeded");
      }

      // ---------- Gate 4: MIME allowlist ----------
      const contentType = normalizeContentType(mimeType);
      if (!isAllowedPluginArtifactMimeType(contentType)) {
        await auditCreate({
          outcome: "denied",
          deniedReason: "forbidden",
          companyId,
          contextKind,
          dispatchingAgentId,
          runId,
          toolName,
          mimeType: contentType,
        });
        throw new ArtifactsError("forbidden", `disallowed mime type: ${contentType}`);
      }

      // ---------- Gate 5: decode + size ceiling (per-company, mirrors human route) ----------
      const companyMaxBytes = await resolveCompanyMaxBytes(companyId);
      const ceiling = Math.min(companyMaxBytes, maxByteSize);
      // PLA-888 review F1: bound the encoded string BEFORE decoding so a hostile
      // worker cannot force a large transient allocation (the worker→host
      // transport has no frame cap). base64 inflates ~4/3×; reject anything that
      // could not possibly fit under the ceiling once decoded.
      if (contentBase64.length > ceiling * 1.4 + 8) {
        await auditCreate({
          outcome: "denied",
          deniedReason: "too_large",
          companyId,
          contextKind,
          dispatchingAgentId,
          runId,
          toolName,
          mimeType: contentType,
        });
        throw new ArtifactsError("too_large", `artifact exceeds maximum size of ${ceiling} bytes`);
      }
      // Node's base64 decoder never throws — it silently drops invalid chars —
      // so no try/catch is needed here.
      const body = Buffer.from(contentBase64, "base64");
      if (body.length <= 0) {
        throw new ArtifactsError("too_large", "artifact is empty");
      }
      if (body.length > ceiling) {
        await auditCreate({
          outcome: "denied",
          deniedReason: "too_large",
          companyId,
          contextKind,
          dispatchingAgentId,
          runId,
          toolName,
          byteSize: body.length,
          mimeType: contentType,
        });
        throw new ArtifactsError("too_large", `artifact exceeds maximum size of ${ceiling} bytes`);
      }

      // ---------- Gate 6: idempotency — reuse an unattached same-content asset ----------
      const sha256 = createHash("sha256").update(body).digest("hex");
      const reusable = await assetWriter.findReusableUnattachedAsset(companyId, sha256);
      if (reusable) {
        await auditCreate({
          outcome: "allowed",
          companyId,
          contextKind,
          dispatchingAgentId,
          runId,
          toolName,
          assetId: reusable.id,
          sha256,
          byteSize: body.length,
          mimeType: contentType,
          deduped: true,
        });
        return { attachmentId: reusable.id };
      }

      // ---------- Gate 7: store via the existing internal storage path ----------
      const stored = await storage.putFile({
        companyId,
        namespace: "plugin-artifacts",
        originalFilename: typeof filename === "string" && filename.length > 0 ? filename : null,
        contentType,
        body,
      });
      const asset = await assetWriter.createStandaloneAsset({
        companyId,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        // Persist the sha256 we deduped on (Gate 6) rather than whatever the
        // storage backend returns. Idempotency requires the stored key to equal
        // the lookup key; coupling it to the backend's hashing would silently
        // break convergence if the backend hashed differently (or not at all).
        sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: dispatchingAgentId,
      });

      await auditCreate({
        outcome: "allowed",
        companyId,
        contextKind,
        dispatchingAgentId,
        runId,
        toolName,
        assetId: asset.id,
        sha256,
        byteSize: stored.byteSize,
        mimeType: contentType,
        deduped: false,
      });

      return { attachmentId: asset.id };
    },
  };
}
