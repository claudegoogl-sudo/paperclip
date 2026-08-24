import type {
  CompanySecret,
  CompanySecretUsageBinding,
  CompanySecretProviderConfig,
  SecretProviderConfigDiscoveryPreviewResult,
  RemoteSecretImportPreviewResult,
  RemoteSecretImportResult,
  SecretAccessEvent,
  SecretManagedMode,
  SecretProvider,
  SecretProviderConfigStatus,
  SecretProviderConfigHealthResponse,
  SecretProviderDescriptor,
  SecretStatus,
  UserSecretCoverageSummary,
  UserSecretDefinition,
} from "@paperclipai/shared";
import { api } from "./client";

export interface SecretUsageResponse {
  secretId: string;
  bindings: CompanySecretUsageBinding[];
}

/**
 * Posture of a borrowed-handle binding, as derived server-side by
 * `egressPostureFor`. Read from the response's `posture` field — never
 * re-derived in the UI from `egressAllowlistEnforced` + `allowedEgress.length`.
 * That re-inference is what left the born-enforcing bindings invisible and is
 * what `server/src/services/egress-posture.ts` exists to prevent.
 */
export type EgressPosture = "log_only" | "enforcing" | "deny_all";

export interface EgressBindingSuggestion {
  origin: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** Always `false` server-side. Never pre-check or derive from allowedEgress. */
  selected: false;
}

export interface EgressBinding {
  id: string;
  secretId: string;
  targetType: string;
  targetId: string;
  configPath: string;
  label: string | null;
  allowedEgress: string[];
  egressAllowlistEnforced: boolean;
  updatedAt: string;
  posture: EgressPosture;
  suggestions: EgressBindingSuggestion[];
}

export interface EgressBindingsResponse {
  bindings: EgressBinding[];
}

export interface EgressAllowlistResponse {
  binding: EgressBinding;
  handlesPurged: number;
}

/** One "My secrets" row: a company definition paired with the current user's own value (if set). */
export interface MyUserSecretEntry {
  definition: UserSecretDefinition;
  secret: CompanySecret | null;
}

export interface CreateUserSecretDefinitionInput {
  key: string;
  name: string;
  description?: string | null;
  status?: Exclude<SecretStatus, "deleted">;
  provider?: SecretProvider;
  managedMode?: SecretManagedMode;
  providerConfigId?: string | null;
  providerMetadata?: Record<string, unknown> | null;
  usageGuidance?: string | null;
}

export interface UpdateUserSecretDefinitionInput {
  name?: string;
  description?: string | null;
  status?: SecretStatus;
  providerConfigId?: string | null;
  providerMetadata?: Record<string, unknown> | null;
  usageGuidance?: string | null;
}

/** Owner-supplied value for a user secret. Either `value` (managed) or `externalRef`. */
export interface UpsertMyUserSecretInput {
  definitionId?: string;
  definitionKey?: string;
  value?: string | null;
  externalRef?: string | null;
  providerVersionRef?: string | null;
  providerConfigId?: string | null;
}

export interface CreateSecretInput {
  name: string;
  key?: string;
  provider?: SecretProvider;
  managedMode?: SecretManagedMode;
  value?: string | null;
  description?: string | null;
  externalRef?: string | null;
  providerVersionRef?: string | null;
  providerConfigId?: string | null;
  providerMetadata?: Record<string, unknown> | null;
}

export interface SecretProviderHealthResponse {
  providers: Array<{
    provider: SecretProvider;
    status: "ok" | "warn" | "error";
    message: string;
    warnings?: string[];
    backupGuidance?: string[];
    details?: Record<string, unknown>;
  }>;
}

export interface UpdateSecretInput {
  name?: string;
  key?: string;
  status?: SecretStatus;
  description?: string | null;
  externalRef?: string | null;
  providerMetadata?: Record<string, unknown> | null;
}

export interface RotateSecretInput {
  value?: string | null;
  externalRef?: string | null;
  providerVersionRef?: string | null;
  providerConfigId?: string | null;
}

export interface CreateSecretProviderConfigInput {
  provider: SecretProvider;
  displayName: string;
  status?: SecretProviderConfigStatus;
  isDefault?: boolean;
  config?: Record<string, unknown>;
}

export interface UpdateSecretProviderConfigInput {
  displayName?: string;
  status?: SecretProviderConfigStatus;
  isDefault?: boolean;
  config?: Record<string, unknown>;
}

export interface RemoteImportPreviewInput {
  providerConfigId: string;
  query?: string | null;
  nextToken?: string | null;
  pageSize?: number;
}

export interface RemoteImportSelectionInput {
  externalRef: string;
  name?: string | null;
  key?: string | null;
  description?: string | null;
  providerVersionRef?: string | null;
  providerMetadata?: Record<string, unknown> | null;
}

export interface RemoteImportInput {
  providerConfigId: string;
  secrets: RemoteImportSelectionInput[];
}

export interface SecretProviderConfigDiscoveryPreviewInput {
  provider: SecretProvider;
  config?: Record<string, unknown>;
  query?: string | null;
  nextToken?: string | null;
  pageSize?: number;
}

export const secretsApi = {
  list: (companyId: string) => api.get<CompanySecret[]>(`/companies/${companyId}/secrets`),
  providers: (companyId: string) =>
    api.get<SecretProviderDescriptor[]>(`/companies/${companyId}/secret-providers`),
  providerHealth: (companyId: string) =>
    api.get<SecretProviderHealthResponse>(`/companies/${companyId}/secret-providers/health`),
  providerConfigs: (companyId: string) =>
    api.get<CompanySecretProviderConfig[]>(`/companies/${companyId}/secret-provider-configs`),
  providerConfigDiscoveryPreview: (
    companyId: string,
    data: SecretProviderConfigDiscoveryPreviewInput,
  ) =>
    api.post<SecretProviderConfigDiscoveryPreviewResult>(
      `/companies/${companyId}/secret-provider-configs/discovery/preview`,
      data,
    ),
  createProviderConfig: (companyId: string, data: CreateSecretProviderConfigInput) =>
    api.post<CompanySecretProviderConfig>(`/companies/${companyId}/secret-provider-configs`, data),
  updateProviderConfig: (id: string, data: UpdateSecretProviderConfigInput) =>
    api.patch<CompanySecretProviderConfig>(`/secret-provider-configs/${id}`, data),
  disableProviderConfig: (id: string) =>
    api.patch<CompanySecretProviderConfig>(`/secret-provider-configs/${id}`, { status: "disabled" }),
  removeProviderConfig: (id: string) =>
    api.delete<CompanySecretProviderConfig>(`/secret-provider-configs/${id}`),
  setDefaultProviderConfig: (id: string) =>
    api.post<CompanySecretProviderConfig>(`/secret-provider-configs/${id}/default`, {}),
  checkProviderConfigHealth: (id: string) =>
    api.post<SecretProviderConfigHealthResponse>(`/secret-provider-configs/${id}/health`, {}),
  create: (companyId: string, data: CreateSecretInput) =>
    api.post<CompanySecret>(`/companies/${companyId}/secrets`, data),
  update: (id: string, data: UpdateSecretInput) =>
    api.patch<CompanySecret>(`/secrets/${id}`, data),
  rotate: (id: string, data: RotateSecretInput) =>
    api.post<CompanySecret>(`/secrets/${id}/rotate`, data),
  disable: (id: string) =>
    api.patch<CompanySecret>(`/secrets/${id}`, { status: "disabled" satisfies SecretStatus }),
  enable: (id: string) =>
    api.patch<CompanySecret>(`/secrets/${id}`, { status: "active" satisfies SecretStatus }),
  archive: (id: string) =>
    api.patch<CompanySecret>(`/secrets/${id}`, { status: "archived" satisfies SecretStatus }),
  remove: (id: string) => api.delete<{ ok: true }>(`/secrets/${id}`),
  usage: (id: string) => api.get<SecretUsageResponse>(`/secrets/${id}/usage`),
  accessEvents: (id: string) => api.get<SecretAccessEvent[]>(`/secrets/${id}/access-events`),

  // --- User-specific secrets ---------------------------------------------
  // Admin: shared definitions each member fills in with their own value.
  listUserSecretDefinitions: (companyId: string) =>
    api.get<UserSecretDefinition[]>(`/companies/${companyId}/user-secret-definitions`),
  createUserSecretDefinition: (companyId: string, data: CreateUserSecretDefinitionInput) =>
    api.post<UserSecretDefinition>(`/companies/${companyId}/user-secret-definitions`, data),
  updateUserSecretDefinition: (
    companyId: string,
    definitionId: string,
    data: UpdateUserSecretDefinitionInput,
  ) =>
    api.patch<UserSecretDefinition>(
      `/companies/${companyId}/user-secret-definitions/${definitionId}`,
      data,
    ),
  removeUserSecretDefinition: (companyId: string, definitionId: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/user-secret-definitions/${definitionId}`),
  userSecretDefinitionCoverage: (companyId: string, definitionId: string) =>
    api.get<UserSecretCoverageSummary>(
      `/companies/${companyId}/user-secret-definitions/${definitionId}/coverage`,
    ),

  // Current user ("My secrets"): each definition paired with my own value.
  listMyUserSecrets: (companyId: string) =>
    api.get<MyUserSecretEntry[]>(`/companies/${companyId}/me/user-secrets`),
  createMyUserSecret: (companyId: string, data: UpsertMyUserSecretInput) =>
    api.post<CompanySecret>(`/companies/${companyId}/me/user-secrets`, data),
  updateMyUserSecret: (
    companyId: string,
    secretId: string,
    data: Partial<UpsertMyUserSecretInput> & { status?: SecretStatus },
  ) => api.patch<CompanySecret>(`/companies/${companyId}/me/user-secrets/${secretId}`, data),
  rotateMyUserSecret: (companyId: string, secretId: string, data: UpsertMyUserSecretInput) =>
    api.post<CompanySecret>(`/companies/${companyId}/me/user-secrets/${secretId}/rotate`, data),
  removeMyUserSecret: (companyId: string, secretId: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/me/user-secrets/${secretId}`),
  remoteImportPreview: (companyId: string, data: RemoteImportPreviewInput) =>
    api.post<RemoteSecretImportPreviewResult>(
      `/companies/${companyId}/secrets/remote-import/preview`,
      data,
    ),
  remoteImport: (companyId: string, data: RemoteImportInput) =>
    api.post<RemoteSecretImportResult>(`/companies/${companyId}/secrets/remote-import`, data),

  // --- Operator-only egress review + per-binding enforce-flip surface -----
  // Bindings are returned company-wide; filter client-side on `secretId`.
  // Allowlist writes are REPLACE semantics (full merged list), not append.
  // Surface `handlesPurged` in the success toast when non-zero so re-minted
  // consumers are not a surprise.
  listEgressBindings: (companyId: string) =>
    api.get<EgressBindingsResponse>(
      `/companies/${companyId}/secret-egress-bindings`,
    ),
  setEgressAllowlist: (
    companyId: string,
    bindingId: string,
    allowedEgress: string[],
  ) =>
    api.post<EgressAllowlistResponse>(
      `/companies/${companyId}/secret-egress-bindings/${bindingId}/allowlist`,
      { allowedEgress },
    ),
  setEgressEnforcement: (
    companyId: string,
    bindingId: string,
    input: { enforced: boolean; allowEmpty?: boolean },
  ) =>
    api.post<EgressAllowlistResponse>(
      `/companies/${companyId}/secret-egress-bindings/${bindingId}/enforce`,
      input.enforced ? { enforced: true, allowEmpty: input.allowEmpty } : { enforced: false },
    ),
};
