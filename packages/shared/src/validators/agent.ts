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

export const agentMineInboxQuerySchema = z.object({
  userId: z.string().trim().min(1),
  status: z.string().trim().min(1).optional().default(INBOX_MINE_ISSUE_STATUS_FILTER),
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
