import { Command } from "commander";
import pc from "picocolors";
import type {
  Agent,
  AgentEnvConfig,
  CompanyPortabilityEnvInput,
  CompanyPortabilityExportPreviewResult,
  CompanyPortabilityInclude,
  CompanySecret,
  EnvBinding,
  SecretProvider,
  SecretProviderDescriptor,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface SecretListOptions extends BaseClientOptions {
  companyId?: string;
}

interface SecretDeclarationsOptions extends BaseClientOptions {
  companyId?: string;
  include?: string;
  kind?: "all" | "secret" | "plain";
}

interface SecretCreateOptions extends BaseClientOptions {
  companyId?: string;
  name?: string;
  key?: string;
  provider?: SecretProvider;
  value?: string;
  valueEnv?: string;
  description?: string;
}

interface SecretLinkOptions extends BaseClientOptions {
  companyId?: string;
  name?: string;
  key?: string;
  provider?: SecretProvider;
  externalRef?: string;
  providerVersionRef?: string;
  description?: string;
}

interface SecretDoctorOptions extends BaseClientOptions {
  companyId?: string;
}

interface SecretMigrateInlineEnvOptions extends BaseClientOptions {
  companyId?: string;
  apply?: boolean;
}

interface EgressReviewOptions extends BaseClientOptions {
  companyId?: string;
}

interface EgressSetAllowlistOptions extends BaseClientOptions {
  companyId?: string;
  bindingId?: string;
  allow?: string[];
}

interface EgressEnforceOptions extends BaseClientOptions {
  companyId?: string;
  bindingId?: string;
  allowEmpty?: boolean;
}

export interface EgressSuggestion {
  origin: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  selected: false;
}

export interface EgressReviewBinding {
  id: string;
  secretId: string;
  targetType: string;
  targetId: string;
  configPath: string;
  label: string | null;
  allowedEgress: string[];
  egressAllowlistEnforced: boolean;
  suggestions: EgressSuggestion[];
}

/**
 * PLA-735 — the operator review console is a high-privilege surface, and the
 * `origin` strings rendered here are harvested from attacker-influenceable
 * egress destinations (an agent can drive a borrowed handle at an arbitrary
 * URL). Even though the server only persists a normalized scheme+host+port, we
 * still treat these as untrusted when writing them to a terminal: strip ANSI
 * escapes and other C0/C1 control characters so a crafted origin cannot move
 * the cursor, recolor the line, or smuggle a terminal escape sequence into the
 * operator's console (contextual output encoding for the TTY sink).
 */
// eslint-disable-next-line no-control-regex
const TERMINAL_UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f]/g;

export function sanitizeForTerminal(value: string): string {
  return value.replace(TERMINAL_UNSAFE_RE, "�");
}

interface SecretProviderHealth {
  provider: SecretProvider;
  status: "ok" | "warn" | "error";
  message: string;
  warnings?: string[];
  backupGuidance?: string[];
  details?: Record<string, unknown>;
}

interface SecretProviderHealthResponse {
  providers: SecretProviderHealth[];
}

export interface InlineSecretMigrationCandidate {
  agentId: string;
  agentName: string;
  envKey: string;
  secretName: string;
  existingSecretId: string | null;
}

const SENSITIVE_ENV_KEY_RE =
  /(^token$|[-_]?token$|api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;

const DEFAULT_DECLARATION_INCLUDE: CompanyPortabilityInclude = {
  company: true,
  agents: true,
  projects: true,
  issues: false,
  skills: false,
};

export function parseSecretsInclude(input: string | undefined): CompanyPortabilityInclude {
  if (!input?.trim()) return { ...DEFAULT_DECLARATION_INCLUDE };
  const values = input.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  const include = {
    company: values.includes("company"),
    agents: values.includes("agents"),
    projects: values.includes("projects"),
    issues: values.includes("issues") || values.includes("tasks"),
    skills: values.includes("skills"),
  };
  if (!Object.values(include).some(Boolean)) {
    throw new Error("Invalid --include value. Use one or more of: company,agents,projects,issues,tasks,skills");
  }
  return include;
}

export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_KEY_RE.test(key);
}

export function toPlainEnvValue(binding: unknown): string | null {
  if (typeof binding === "string") return binding;
  if (typeof binding !== "object" || binding === null || Array.isArray(binding)) return null;
  const record = binding as Record<string, unknown>;
  if (record.type === "plain" && typeof record.value === "string") return record.value;
  return null;
}

export function buildInlineMigrationSecretName(agentId: string, key: string): string {
  return `agent_${agentId.slice(0, 8)}_${key.toLowerCase()}`;
}

export function collectInlineSecretMigrationCandidates(
  agents: Agent[],
  existingSecrets: CompanySecret[],
): InlineSecretMigrationCandidate[] {
  const secretByName = new Map(existingSecrets.map((secret) => [secret.name, secret]));
  const candidates: InlineSecretMigrationCandidate[] = [];

  for (const agent of agents) {
    const env = asRecord(agent.adapterConfig.env);
    if (!env) continue;
    for (const [envKey, binding] of Object.entries(env)) {
      if (!isSensitiveEnvKey(envKey)) continue;
      const plain = toPlainEnvValue(binding);
      if (plain === null || plain.trim().length === 0) continue;
      const secretName = buildInlineMigrationSecretName(agent.id, envKey);
      candidates.push({
        agentId: agent.id,
        agentName: agent.name,
        envKey,
        secretName,
        existingSecretId: secretByName.get(secretName)?.id ?? null,
      });
    }
  }

  return candidates;
}

export function buildMigratedAgentEnv(
  env: Record<string, unknown>,
  secretIdByEnvKey: Map<string, string>,
): AgentEnvConfig {
  const next: AgentEnvConfig = { ...(env as Record<string, EnvBinding>) };
  for (const [envKey, secretId] of secretIdByEnvKey) {
    next[envKey] = {
      type: "secret_ref",
      secretId,
      version: "latest",
    };
  }
  return next;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readValueFromOptions(opts: SecretCreateOptions): string {
  if (opts.value !== undefined && opts.valueEnv !== undefined) {
    throw new Error("Use only one of --value or --value-env.");
  }
  if (opts.valueEnv !== undefined) {
    const value = process.env[opts.valueEnv];
    if (!value) throw new Error(`Environment variable ${opts.valueEnv} is empty or unset.`);
    return value;
  }
  if (opts.value !== undefined) return opts.value;
  throw new Error("Secret value is required. Pass --value or --value-env.");
}

function renderDeclaration(input: CompanyPortabilityEnvInput): Record<string, unknown> {
  const scope = input.agentSlug
    ? `agent:${input.agentSlug}`
    : input.projectSlug
      ? `project:${input.projectSlug}`
      : "company";
  return {
    key: input.key,
    scope,
    kind: input.kind,
    requirement: input.requirement,
    portability: input.portability,
    hasDefault: input.defaultValue !== null && input.defaultValue.length > 0,
    description: input.description,
  };
}

function renderSecret(secret: CompanySecret): Record<string, unknown> {
  return {
    id: secret.id,
    name: secret.name,
    key: secret.key,
    provider: secret.provider,
    status: secret.status,
    managedMode: secret.managedMode,
    latestVersion: secret.latestVersion,
    externalRef: secret.externalRef ? "yes" : "no",
  };
}

function printProviderHealth(rows: SecretProviderHealth[], json: boolean): void {
  if (json) {
    printOutput(rows, { json: true });
    return;
  }
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  for (const row of rows) {
    console.log(
      formatInlineRecord({
        id: row.provider,
        status: row.status,
        message: row.message,
      }),
    );
    for (const warning of row.warnings ?? []) {
      console.log(pc.yellow(`warning=${warning}`));
    }
    const missingConfig = asStringArray(row.details?.missingConfig);
    if (missingConfig.length > 0) {
      console.log(pc.dim(`missingConfig=${missingConfig.join(",")}`));
    }
    const credentialSource = typeof row.details?.credentialSource === "string"
      ? row.details.credentialSource
      : null;
    if (credentialSource) {
      console.log(pc.dim(`credentialSource=${credentialSource}`));
    }
    const detectedCredentialSources = asStringArray(row.details?.detectedCredentialSources);
    if (detectedCredentialSources.length > 0) {
      console.log(pc.dim(`detectedCredentialSources=${detectedCredentialSources.join(",")}`));
    }
    for (const guidance of row.backupGuidance ?? []) {
      console.log(pc.dim(`backup=${guidance}`));
    }
  }
}

function printEgressReview(bindings: EgressReviewBinding[]): void {
  if (bindings.length === 0) {
    console.log(pc.dim("No borrowed-handle egress bindings in this company."));
    return;
  }
  for (const binding of bindings) {
    const posture = binding.egressAllowlistEnforced ? pc.green("enforced") : pc.yellow("log-only");
    console.log(
      formatInlineRecord({
        binding: binding.id,
        target: `${binding.targetType}:${binding.targetId}`,
        configPath: binding.configPath,
        posture,
      }),
    );
    const allow = binding.allowedEgress.length > 0
      ? binding.allowedEgress.map((e) => sanitizeForTerminal(e)).join(", ")
      : pc.dim("(empty)");
    console.log(`  allowlist: ${allow}`);
    if (binding.suggestions.length === 0) {
      console.log(pc.dim("  suggestions: (none harvested)"));
    } else {
      console.log(pc.dim(`  suggestions (UNCHECKED — select to add, nothing auto-applied):`));
      for (const s of binding.suggestions) {
        // "[ ]" makes it explicit each harvested origin is unselected.
        console.log(
          `    ${pc.dim("[ ]")} ${sanitizeForTerminal(s.origin)} ${pc.dim(`(count=${s.count}, lastSeen=${s.lastSeen})`)}`,
        );
      }
    }
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

async function migrateInlineEnv(opts: SecretMigrateInlineEnvOptions): Promise<void> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  const companyId = ctx.companyId!;
  const agents = (await ctx.api.get<Agent[]>(`/api/companies/${companyId}/agents`)) ?? [];
  const secrets = (await ctx.api.get<CompanySecret[]>(`/api/companies/${companyId}/secrets`)) ?? [];
  const candidates = collectInlineSecretMigrationCandidates(agents, secrets);

  if (!opts.apply) {
    printOutput(
      {
        apply: false,
        agentsToUpdate: new Set(candidates.map((candidate) => candidate.agentId)).size,
        secretsToCreate: candidates.filter((candidate) => !candidate.existingSecretId).length,
        secretsToRotate: candidates.filter((candidate) => candidate.existingSecretId).length,
        candidates,
      },
      { json: ctx.json },
    );
    if (!ctx.json) {
      console.log(pc.dim("Re-run with --apply to create/rotate secrets and update agent env bindings."));
    }
    return;
  }

  const createdOrRotated = new Map<string, string>();
  let createdSecrets = 0;
  let rotatedSecrets = 0;

  for (const candidate of candidates) {
    const agent = agents.find((row) => row.id === candidate.agentId);
    const env = asRecord(agent?.adapterConfig.env);
    const value = env ? toPlainEnvValue(env[candidate.envKey]) : null;
    if (!value) continue;

    if (candidate.existingSecretId) {
      await ctx.api.post(`/api/secrets/${candidate.existingSecretId}/rotate`, { value });
      createdOrRotated.set(`${candidate.agentId}:${candidate.envKey}`, candidate.existingSecretId);
      rotatedSecrets += 1;
      continue;
    }

    const created = await ctx.api.post<CompanySecret>(`/api/companies/${companyId}/secrets`, {
      name: candidate.secretName,
      provider: "local_encrypted",
      value,
      description: `Migrated from agent ${candidate.agentId} env ${candidate.envKey}`,
    });
    if (!created) throw new Error(`Secret create returned no data for ${candidate.secretName}`);
    createdOrRotated.set(`${candidate.agentId}:${candidate.envKey}`, created.id);
    createdSecrets += 1;
  }

  let updatedAgents = 0;
  for (const agent of agents) {
    const env = asRecord(agent.adapterConfig.env);
    if (!env) continue;
    const secretIdByEnvKey = new Map<string, string>();
    for (const [key] of Object.entries(env)) {
      const secretId = createdOrRotated.get(`${agent.id}:${key}`);
      if (secretId) secretIdByEnvKey.set(key, secretId);
    }
    if (secretIdByEnvKey.size === 0) continue;
    const adapterConfig = {
      ...agent.adapterConfig,
      env: buildMigratedAgentEnv(env, secretIdByEnvKey),
    };
    await ctx.api.patch(`/api/agents/${agent.id}`, {
      adapterConfig,
      replaceAdapterConfig: true,
    });
    updatedAgents += 1;
  }

  printOutput(
    {
      apply: true,
      updatedAgents,
      createdSecrets,
      rotatedSecrets,
    },
    { json: ctx.json },
  );
}

export function registerSecretCommands(program: Command): void {
  const secrets = program.command("secrets").description("Secret declaration and provider operations");

  addCommonClientOptions(
    secrets
      .command("list")
      .description("List secret metadata for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: SecretListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<CompanySecret[]>(`/api/companies/${ctx.companyId}/secrets`)) ?? [];
          printOutput(ctx.json ? rows : rows.map(renderSecret), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("declarations")
      .description("List portable env declarations emitted by company export")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--include <values>", "Comma-separated include set: company,agents,projects,issues,tasks,skills", "company,agents,projects")
      .option("--kind <kind>", "Filter declarations: all | secret | plain", "all")
      .action(async (opts: SecretDeclarationsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const kind = opts.kind ?? "all";
          if (!["all", "secret", "plain"].includes(kind)) {
            throw new Error("Invalid --kind value. Use: all, secret, plain");
          }
          const preview = await ctx.api.post<CompanyPortabilityExportPreviewResult>(
            `/api/companies/${ctx.companyId}/exports/preview`,
            { include: parseSecretsInclude(opts.include) },
          );
          const declarations = (preview?.manifest.envInputs ?? [])
            .filter((entry) => kind === "all" || entry.kind === kind);
          printOutput(ctx.json ? declarations : declarations.map(renderDeclaration), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("create")
      .description("Create a Paperclip-managed secret")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--name <name>", "Secret display name")
      .option("--key <key>", "Portable secret key")
      .option("--provider <provider>", "Secret provider id")
      .option("--value <value>", "Secret value")
      .option("--value-env <name>", "Read secret value from an environment variable")
      .option("--description <text>", "Description")
      .action(async (opts: SecretCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const created = await ctx.api.post<CompanySecret>(`/api/companies/${ctx.companyId}/secrets`, {
            name: opts.name,
            key: opts.key,
            provider: opts.provider,
            value: readValueFromOptions(opts),
            description: opts.description,
          });
          printOutput(ctx.json ? created : renderSecret(created!), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("link")
      .description("Link an external provider-owned secret without storing its value in Paperclip")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--name <name>", "Secret display name")
      .requiredOption("--provider <provider>", "Secret provider id")
      .requiredOption("--external-ref <ref>", "Provider secret ARN/name/path/reference")
      .option("--key <key>", "Portable secret key")
      .option("--provider-version-ref <ref>", "Provider version id or label")
      .option("--description <text>", "Description")
      .action(async (opts: SecretLinkOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const created = await ctx.api.post<CompanySecret>(`/api/companies/${ctx.companyId}/secrets`, {
            name: opts.name,
            key: opts.key,
            provider: opts.provider,
            managedMode: "external_reference",
            externalRef: opts.externalRef,
            providerVersionRef: opts.providerVersionRef,
            description: opts.description,
          });
          printOutput(ctx.json ? created : renderSecret(created!), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("doctor")
      .description("Run secret provider health checks through the Paperclip API")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: SecretDoctorOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const health = await ctx.api.get<SecretProviderHealthResponse>(
            `/api/companies/${ctx.companyId}/secret-providers/health`,
          );
          printProviderHealth(health?.providers ?? [], ctx.json);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("providers")
      .description("List configured secret provider descriptors")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: SecretDoctorOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<SecretProviderDescriptor[]>(
            `/api/companies/${ctx.companyId}/secret-providers`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("migrate-inline-env")
      .description("Migrate inline sensitive agent env values into secret references")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--apply", "Persist changes; default is a dry run", false)
      .action(async (opts: SecretMigrateInlineEnvOptions) => {
        try {
          await migrateInlineEnv(opts);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // PLA-735 — operator-only egress review + per-binding enforce-flip. These call
  // the board-authenticated /secret-egress-bindings routes; there is no
  // agent-invokable path. Per-binding by construction (no bulk enforce).
  const egress = secrets
    .command("egress")
    .description("Operator review + per-binding enforce-flip for borrowed-handle egress allowlists");

  addCommonClientOptions(
    egress
      .command("review")
      .description("List bindings with their allowlist, posture, and harvested would-deny suggestions (unchecked)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: EgressReviewOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const res = await ctx.api.get<{ bindings: EgressReviewBinding[] }>(
            `/api/companies/${ctx.companyId}/secret-egress-bindings`,
          );
          const bindings = res?.bindings ?? [];
          if (ctx.json) {
            printOutput({ bindings }, { json: true });
          } else {
            printEgressReview(bindings);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    egress
      .command("set-allowlist")
      .description("Replace one binding's egress allowlist from your affirmative selection")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--binding-id <id>", "Secret binding ID")
      .option(
        "--allow <entry>",
        "Allowlist entry (repeatable). Omit entirely to clear the allowlist.",
        (value: string, prev: string[] = []) => [...prev, value],
        [] as string[],
      )
      .action(async (opts: EgressSetAllowlistOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const allowedEgress = opts.allow ?? [];
          const result = await ctx.api.post(
            `/api/companies/${ctx.companyId}/secret-egress-bindings/${opts.bindingId}/allowlist`,
            { allowedEgress },
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    egress
      .command("enforce")
      .description("Flip ONE binding to enforcing (per-binding; no bulk enforce-all)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--binding-id <id>", "Secret binding ID")
      .option("--allow-empty", "Enforce even with an empty allowlist (deny ALL egress for this secret)", false)
      .action(async (opts: EgressEnforceOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post(
            `/api/companies/${ctx.companyId}/secret-egress-bindings/${opts.bindingId}/enforce`,
            { allowEmpty: opts.allowEmpty === true },
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
