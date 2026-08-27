import { z } from "zod";
import {
  AGENT_ICON_NAMES,
  AGENT_ROLES,
  AGENT_STATUSES,
  INBOX_MINE_ISSUE_STATUS_FILTER,
} from "../constants.js";
import { agentAdapterTypeSchema } from "../adapter-type.js";
import { envConfigSchema } from "./secret.js";
import { trustAuthorizationPolicySchema, trustPresetSchema } from "./trust-policy.js";
import { agentDesiredSkillSelectionSchema } from "./adapter-skills.js";

export const agentPermissionsSchema = z.object({
  canCreateAgents: z.boolean().optional().default(false),
  canCreateSkills: z.boolean().optional().default(true),
  trustPreset: trustPresetSchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
}).catchall(z.unknown());

export const agentInstructionsBundleModeSchema = z.enum(["managed", "external"]);

export const updateAgentInstructionsBundleSchema = z.object({
  mode: agentInstructionsBundleModeSchema.optional(),
  rootPath: z.string().trim().min(1).nullable().optional(),
  entryFile: z.string().trim().min(1).optional(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpdateAgentInstructionsBundle = z.infer<typeof updateAgentInstructionsBundleSchema>;

export const upsertAgentInstructionsFileSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpsertAgentInstructionsFile = z.infer<typeof upsertAgentInstructionsFileSchema>;

const adapterConfigSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const envValue = value.env;
  if (envValue === undefined) return;
  const parsed = envConfigSchema.safeParse(envValue);
  if (!parsed.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "adapterConfig.env must be a map of valid env bindings",
      path: ["env"],
    });
  }
});

export const createAgentInstructionsBundleSchema = z.object({
  entryFile: z.string().trim().min(1).optional(),
  files: z.record(z.string(), z.string()).refine((files) => Object.keys(files).length > 0, {
    message: "instructionsBundle.files must contain at least one file",
  }),
});

const agentModelProfileConfigSchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().trim().min(1).optional(),
  adapterConfig: adapterConfigSchema,
}).strict();

export const agentRuntimeConfigSchema = z.object({
  modelProfiles: z.object({
    cheap: agentModelProfileConfigSchema.optional(),
  }).strict().optional(),
}).catchall(z.unknown());

export const createAgentSchema = z.object({
  name: z.string().min(1),
  role: z.enum(AGENT_ROLES).optional().default("general"),
  title: z.string().optional().nullable(),
  icon: z.enum(AGENT_ICON_NAMES).optional().nullable(),
  reportsTo: z.string().uuid().optional().nullable(),
  capabilities: z.string().optional().nullable(),
  desiredSkills: z.array(agentDesiredSkillSelectionSchema).optional(),
  adapterType: agentAdapterTypeSchema,
  adapterConfig: adapterConfigSchema.optional().default({}),
  instructionsBundle: createAgentInstructionsBundleSchema.optional(),
  runtimeConfig: agentRuntimeConfigSchema.optional().default({}),
  defaultEnvironmentId: z.string().uuid().optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  permissions: agentPermissionsSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export type CreateAgent = z.infer<typeof createAgentSchema>;

export const createAgentHireSchema = createAgentSchema.extend({
  sourceIssueId: z.string().uuid().optional().nullable(),
  sourceIssueIds: z.array(z.string().uuid()).optional(),
});

export type CreateAgentHire = z.infer<typeof createAgentHireSchema>;

export const updateAgentSchema = createAgentSchema
  .omit({ permissions: true })
  .partial()
  .extend({
    permissions: z.never().optional(),
    replaceAdapterConfig: z.boolean().optional(),
    status: z.enum(AGENT_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
  });

export type UpdateAgent = z.infer<typeof updateAgentSchema>;

export const updateAgentInstructionsPathSchema = z.object({
  path: z.string().trim().min(1).nullable(),
  adapterConfigKey: z.string().trim().min(1).optional(),
});

export type UpdateAgentInstructionsPath = z.infer<typeof updateAgentInstructionsPathSchema>;

export const taskBridgeAgentKeyScopeSchema = z.object({
  kind: z.literal("task_bridge"),
  projectId: z.string().uuid().optional().nullable(),
  projectIds: z.array(z.string().uuid()).max(50).optional(),
  parentIssueId: z.string().uuid().optional().nullable(),
  parentIssueIds: z.array(z.string().uuid()).max(50).optional(),
  allowedAssigneeAgentIds: z.array(z.string().uuid()).max(50).optional(),
}).strict().superRefine((value, ctx) => {
  const hasProjectBoundary = Boolean(value.projectId) || Boolean(value.projectIds?.length);
  const hasParentBoundary = Boolean(value.parentIssueId) || Boolean(value.parentIssueIds?.length);
  if (!hasProjectBoundary && !hasParentBoundary) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "task_bridge keys require at least one project or parent issue boundary",
      path: ["projectId"],
    });
  }
});

export const standardAgentKeyScopeSchema = z.object({
  kind: z.literal("standard"),
}).strict();

export const agentApiKeyScopeSchema = z.union([
  standardAgentKeyScopeSchema,
  taskBridgeAgentKeyScopeSchema,
]);

export type AgentApiKeyScope = z.infer<typeof agentApiKeyScopeSchema>;
export type TaskBridgeAgentKeyScope = z.infer<typeof taskBridgeAgentKeyScopeSchema>;

export function normalizeAgentApiKeyScope(value: unknown): AgentApiKeyScope {
  const parsed = agentApiKeyScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : { kind: "standard" };
}

/**
 * A `task_bridge` scope lets a key reach projects/parent-issues that may belong
 * to *other* companies — the cross-company case. Standard keys stay inside the
 * agent's own company. Cross-company keys carry the tighter TTL ceiling.
 */
export function agentApiKeyScopeIsCrossCompany(scope: AgentApiKeyScope | null | undefined): boolean {
  return scope?.kind === "task_bridge";
}

/**
 * Hard server-side maximum lifetime for a minted *cross-company* agent key.
 * Enforced at mint time regardless of what the caller requests (least
 * privilege): a missing TTL, an oversized TTL, or a far-future `expiresAt` all
 * clamp to this ceiling. 24h.
 */
export const CROSS_COMPANY_AGENT_KEY_MAX_TTL_SECONDS = 24 * 60 * 60;

export const createAgentKeySchema = z.object({
  name: z.string().min(1).default("default"),
  scope: agentApiKeyScopeSchema.optional().default({ kind: "standard" }),
  /**
   * Optional caller-requested lifetime. `ttlSeconds` is relative to mint time;
   * `expiresAt` is an absolute instant (ISO string or Date). If both are
   * present, `expiresAt` wins. Cross-company keys are clamped to
   * {@link CROSS_COMPANY_AGENT_KEY_MAX_TTL_SECONDS}.
   */
  ttlSeconds: z.number().int().positive().optional(),
  expiresAt: z.coerce.date().optional(),
});

export type CreateAgentKey = z.infer<typeof createAgentKeySchema>;

export interface ResolveAgentKeyExpiryInput {
  scope?: AgentApiKeyScope | null;
  ttlSeconds?: number | null;
  expiresAt?: Date | string | null;
  /** Injected for deterministic tests; defaults to the current instant. */
  now?: Date;
}

/**
 * Resolve the effective `expiresAt` to persist for a newly minted key, applying
 * the cross-company ceiling. Pure/synchronous so it is unit-testable without a
 * DB. Returns `null` when the key should never auto-expire.
 *
 * - Cross-company (`task_bridge`) keys: clamp to the ceiling. A requested
 *   expiry *shorter* than the ceiling is honoured (shorter is always safe);
 *   anything missing or longer collapses to `now + ceiling`.
 * - Same-company / standard keys: honour an explicit request verbatim,
 *   otherwise never auto-expire (current behaviour, unchanged).
 */
export function computeAgentKeyExpiresAt(input: ResolveAgentKeyExpiryInput): Date | null {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();

  let requestedMs: number | null = null;
  if (input.expiresAt != null) {
    const d = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt);
    if (!Number.isNaN(d.getTime())) requestedMs = d.getTime();
  } else if (
    input.ttlSeconds != null
    && Number.isFinite(input.ttlSeconds)
    && input.ttlSeconds > 0
  ) {
    requestedMs = nowMs + Math.floor(input.ttlSeconds) * 1000;
  }

  if (agentApiKeyScopeIsCrossCompany(input.scope)) {
    const ceilingMs = nowMs + CROSS_COMPANY_AGENT_KEY_MAX_TTL_SECONDS * 1000;
    if (requestedMs == null || requestedMs > ceilingMs) return new Date(ceilingMs);
    return new Date(requestedMs);
  }

  return requestedMs == null ? null : new Date(requestedMs);
}

/**
 * Fail-closed expiry check used by every auth resolver. A key with a non-null
 * `expiresAt` at or before `now` is rejected independent of `revokedAt`
 * `null` means non-expiring. An unparseable value is treated as
 * expired: a corrupt lifetime must not grant access.
 */
export function isAgentApiKeyExpired(
  expiresAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (expiresAt == null) return false;
  const d = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return true;
  return d.getTime() <= now.getTime();
}

/**
 * Typed refusal taxonomy for the sanctioned `task_bridge` credential
 * (`PAPERCLIP_BRIDGE_API_KEY`). Replaces the historical single-boolean
 * verifier: an expired key, a revoked key, a missing key row, and a
 * wrong-scope key previously all collapsed into one generic "unverifiable"
 * refusal, which made a bridge outage expensive to diagnose. Every code is
 * distinct and actionable, and every rendered message carries ids and
 * timestamps only — never key plaintext or `keyHash`.
 */
export type BridgeKeyVerifyFailureCode =
  | "key_missing"
  | "key_revoked"
  | "key_expired"
  | "key_scope_mismatch";

/**
 * Classification produced by the verifier injected into the sanctioned
 * bridge-key resolution path. `{ ok: true }` is the only passing result;
 * every failure names exactly why. Shared verbatim by the consumer path
 * (heartbeat run config) and the auto-renewer's post-rotation verification,
 * so both sides classify identically.
 */
export type BridgeKeyVerifyResult =
  | { ok: true }
  | {
      ok: false;
      code: BridgeKeyVerifyFailureCode;
      keyId?: string;
      expiresAt?: string;
      actualScopeKind?: string;
    };

/**
 * Binding- and verifier-level refusals raised before a key can be classified.
 * `binding_absent` means the agent's board-gated env carries no bridge binding
 * at all (nothing is misconfigured — the credential simply is not set up);
 * the rest are faults. `verifier_unavailable` keeps the historical fail-closed
 * default: no verifier wired ⇒ scope unprovable ⇒ refuse.
 */
export type BridgeKeyBindingRefusalCode =
  | "binding_absent"
  | "binding_malformed"
  | "binding_not_secret_ref"
  | "secret_unresolved"
  | "verifier_unavailable";

export type BridgeKeyRefusalCode = BridgeKeyVerifyFailureCode | BridgeKeyBindingRefusalCode;

export interface BridgeKeyRefusal {
  code: BridgeKeyRefusalCode;
  keyId?: string;
  expiresAt?: string;
  actualScopeKind?: string;
}

const BRIDGE_KEY_REFUSAL_LINE_PREFIX: Record<BridgeKeyRefusalCode, string> = {
  key_missing: "TASK_BRIDGE_KEY_MISSING",
  key_revoked: "TASK_BRIDGE_KEY_REVOKED",
  key_expired: "TASK_BRIDGE_KEY_EXPIRED",
  key_scope_mismatch: "TASK_BRIDGE_KEY_SCOPE_MISMATCH",
  binding_absent: "TASK_BRIDGE_BINDING_ABSENT",
  binding_malformed: "TASK_BRIDGE_BINDING_MALFORMED",
  binding_not_secret_ref: "TASK_BRIDGE_BINDING_NOT_SECRET_REF",
  secret_unresolved: "TASK_BRIDGE_SECRET_UNRESOLVED",
  verifier_unavailable: "TASK_BRIDGE_VERIFIER_UNAVAILABLE",
};

/**
 * Render a refusal as the stable, greppable one-line message surfaced in run
 * logs, server logs, and the agent wake context. Pure and secret-free: only
 * the code, key id, expiry timestamp, and scope kind appear. The prefix is a
 * fixed uppercase token so `grep TASK_BRIDGE_KEY_EXPIRED` finds every
 * occurrence of that state on the host or in a transcript.
 */
export function formatBridgeKeyRefusalLine(refusal: BridgeKeyRefusal): string {
  const prefix = BRIDGE_KEY_REFUSAL_LINE_PREFIX[refusal.code] ?? "TASK_BRIDGE_KEY_REFUSED";
  const parts: string[] = [];
  switch (refusal.code) {
    case "key_expired":
      parts.push(`bridge key ${refusal.keyId ?? "<unknown>"} expired ${refusal.expiresAt ?? "<unknown>"}`);
      break;
    case "key_revoked":
      parts.push(`bridge key ${refusal.keyId ?? "<unknown>"} is revoked — re-mint required`);
      break;
    case "key_missing":
      parts.push("no live agent key row matches the bound credential — re-mint required");
      break;
    case "key_scope_mismatch":
      parts.push(
        `bridge key ${refusal.keyId ?? "<unknown>"} has scope kind "${refusal.actualScopeKind ?? "unknown"}", not task_bridge`,
      );
      break;
    case "binding_absent":
      parts.push("no bridge binding is configured in the agent's board-gated env");
      break;
    case "binding_malformed":
      parts.push("bridge env binding is malformed");
      break;
    case "binding_not_secret_ref":
      parts.push("bridge env binding is not an operator secret_ref");
      break;
    case "secret_unresolved":
      parts.push("bound bridge secret failed to resolve");
      break;
    case "verifier_unavailable":
      parts.push("no bridge key verifier is wired; scope is unprovable");
      break;
  }
  return `${prefix}: ${parts.join("; ")}`;
}

export const agentMineInboxQuerySchema = z.object({
  userId: z.string().trim().min(1),
  status: z.string().trim().min(1).optional().default(INBOX_MINE_ISSUE_STATUS_FILTER),
});

/**
 * Operator opt-in for the server-internal task_bridge key auto-renewer,
 * stored on `company_secret_bindings.autoRenewPolicy`. The operator's opt-in
 * IS the scope approval — one authorization object: the pinned `scope`
 * snapshot is the exact minimum scope the renewer may mint, re-checked
 * against the live key on every sweep (drift suspends; it never propagates).
 *
 * At-least-minimum pinning is REQUIRED: the project boundary must be pinned
 * via `scope.projectId` OR a non-empty `scope.projectIds` (effective-set
 * semantics, matching how enforcement unions the two forms — a plural-only
 * boundary enumerates the same scope a singular one names); and
 * `scope.parentIssueIds` and `scope.allowedAssigneeAgentIds` must be present
 * and non-empty. An unpinned `task_bridge` snapshot is refused, so the
 * renewer can never be opted into minting a broader key than the operator
 * explicitly enumerated.
 */
export const bindingAutoRenewPolicySchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  scope: taskBridgeAgentKeyScopeSchema,
  authorizedByUserId: z.string().trim().min(1),
  createdAt: z.string().trim().min(1),
}).strict().superRefine((value, ctx) => {
  const pinnedProject = Boolean(value.scope.projectId)
    || (value.scope.projectIds?.length ?? 0) > 0;
  const pinned = pinnedProject
    && (value.scope.parentIssueIds?.length ?? 0) > 0
    && (value.scope.allowedAssigneeAgentIds?.length ?? 0) > 0;
  if (!pinned) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "auto-renew policy requires a pinned task_bridge scope: a project boundary (projectId or non-empty projectIds), parentIssueIds, and allowedAssigneeAgentIds must all be present and non-empty",
      path: ["scope"],
    });
  }
});

export type BindingAutoRenewPolicy = z.infer<typeof bindingAutoRenewPolicySchema>;

/**
 * Board-route body for setting / changing / clearing a binding's auto-renew
 * policy. `policy: null` clears the opt-in (back to default-deny). The route
 * is the ONLY write path — the renewer itself never writes the column.
 */
export const setBindingAutoRenewPolicySchema = z.object({
  policy: bindingAutoRenewPolicySchema.nullable(),
});

export type AgentMineInboxQuery = z.infer<typeof agentMineInboxQuerySchema>;

export const wakeAgentSchema = z.object({
  source: z.enum(["timer", "assignment", "on_demand", "automation"]).optional().default("on_demand"),
  triggerDetail: z.enum(["manual", "ping", "callback", "system"]).optional(),
  reason: z.string().optional().nullable(),
  payload: z.record(z.string(), z.unknown()).optional().nullable(),
  idempotencyKey: z.string().optional().nullable(),
  forceFreshSession: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.boolean().optional().default(false),
  ),
});

export type WakeAgent = z.infer<typeof wakeAgentSchema>;

export const resetAgentSessionSchema = z.object({
  taskKey: z.string().min(1).optional().nullable(),
});

export type ResetAgentSession = z.infer<typeof resetAgentSessionSchema>;

export const testAdapterEnvironmentSchema = z.object({
  adapterConfig: adapterConfigSchema.optional().default({}),
  /**
   * Optional environment to run the adapter test inside. When omitted, the
   * test runs against the local Paperclip host. When provided and the
   * environment is non-local (SSH/sandbox), the test probes are executed
   * inside that environment so the result reflects real agent execution.
   */
  environmentId: z.string().uuid().optional().nullable(),
});

export type TestAdapterEnvironment = z.infer<typeof testAdapterEnvironmentSchema>;

export const updateAgentPermissionsSchema = z.object({
  canCreateAgents: z.boolean(),
  canCreateSkills: z.boolean().optional(),
  canAssignTasks: z.boolean(),
  trustPreset: trustPresetSchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
});

export type UpdateAgentPermissions = z.infer<typeof updateAgentPermissionsSchema>;
