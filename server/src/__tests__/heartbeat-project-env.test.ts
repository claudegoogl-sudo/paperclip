import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSkillMentionHref } from "@paperclipai/shared";
import {
  LOW_TRUST_REVIEW_PRESET,
  SANCTIONED_BRIDGE_ENV_KEY,
  applyRunScopedMentionedSkillKeys,
  extractMentionedSkillIdsFromSources,
  resolveExecutionRunAdapterConfig,
} from "../services/heartbeat.ts";

describe("resolveExecutionRunAdapterConfig", () => {
  it("overlays environment, project, and routine env on top of agent env and unions secret keys", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: {
        env: {
          SHARED_KEY: "agent",
          AGENT_ONLY: "agent-only",
        },
        other: "value",
      },
      secretKeys: new Set(["AGENT_SECRET"]),
      manifest: [
        {
          configPath: "env.AGENT_SECRET",
          envKey: "AGENT_SECRET",
          secretId: "secret-agent",
          secretKey: "agent-secret",
          version: 1,
          provider: "local_encrypted",
          outcome: "success",
        },
      ],
    });
    const resolveEnvBindings = vi
      .fn()
      .mockResolvedValueOnce({
        env: {
          SHARED_KEY: "environment",
          ENV_ONLY: "environment-only",
        },
        secretKeys: new Set(["ENV_SECRET"]),
        manifest: [
          {
            configPath: "env.ENV_SECRET",
            envKey: "ENV_SECRET",
            secretId: "secret-environment",
            secretKey: "environment-secret",
            version: 1,
            provider: "local_encrypted",
            outcome: "success",
          },
        ],
      })
      .mockResolvedValueOnce({
        env: {
          SHARED_KEY: "project",
          PROJECT_ONLY: "project-only",
        },
        secretKeys: new Set(["PROJECT_SECRET"]),
        manifest: [
          {
            configPath: "env.PROJECT_SECRET",
            envKey: "PROJECT_SECRET",
            secretId: "secret-project",
            secretKey: "project-secret",
            version: 1,
            provider: "local_encrypted",
            outcome: "success",
          },
        ],
      })
      .mockResolvedValueOnce({
        env: {
          SHARED_KEY: "routine",
          ROUTINE_ONLY: "routine-only",
        },
        secretKeys: new Set(["ROUTINE_SECRET"]),
        manifest: [
          {
            configPath: "env.ROUTINE_SECRET",
            envKey: "ROUTINE_SECRET",
            secretId: "secret-routine",
            secretKey: "routine-secret",
            version: 1,
            provider: "local_encrypted",
            outcome: "success",
          },
        ],
      });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: { env: { SHARED_KEY: "agent" } },
      environmentId: "environment-1",
      environmentEnv: { SHARED_KEY: "environment" },
      projectEnv: { SHARED_KEY: "project" },
      routineEnv: { SHARED_KEY: "routine" },
      routineId: "routine-1",
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(result.resolvedConfig).toMatchObject({
      other: "value",
      env: {
        SHARED_KEY: "routine",
        ENV_ONLY: "environment-only",
        AGENT_ONLY: "agent-only",
        PROJECT_ONLY: "project-only",
        ROUTINE_ONLY: "routine-only",
      },
    });
    expect(Array.from(result.secretKeys).sort()).toEqual(["AGENT_SECRET", "ENV_SECRET", "PROJECT_SECRET", "ROUTINE_SECRET"]);
    expect(result.secretManifest.map((entry) => entry.secretId).sort()).toEqual([
      "secret-agent",
      "secret-environment",
      "secret-project",
      "secret-routine",
    ]);
    expect(JSON.stringify(result.secretManifest)).not.toContain("agent-only");
    expect(JSON.stringify(result.secretManifest)).not.toContain("environment-only");
    expect(JSON.stringify(result.secretManifest)).not.toContain("project-only");
    expect(JSON.stringify(result.secretManifest)).not.toContain("routine-only");
    expect(resolveEnvBindings.mock.calls[0]?.[2]).toMatchObject({
      consumerType: "environment",
      consumerId: "environment-1",
    });
    expect(resolveEnvBindings.mock.calls[2]?.[2]).toMatchObject({
      consumerType: "routine",
      consumerId: "routine-1",
    });
  });

  it("drops Paperclip runtime-owned env before resolving environment, agent, project, and routine overlays", async () => {
    const resolveAdapterConfigForRuntime = vi.fn(async (_companyId, config: Record<string, unknown>) => ({
      config: {
        ...config,
        env: { ...(config.env as Record<string, unknown>) },
      },
      secretKeys: new Set<string>(),
      manifest: [],
    }));
    const resolveEnvBindings = vi.fn(async (_companyId, env: Record<string, unknown>) => ({
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
      secretKeys: new Set<string>(),
      manifest: [],
    }));

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      environmentId: "environment-1",
      environmentEnv: {
        PAPERCLIP_API_KEY: "environment-api-key",
        PAPERCLIP_AGENT_ID: "environment-agent",
        ENV_ONLY: "environment-only",
      },
      executionRunConfig: {
        env: {
          PAPERCLIP_API_KEY: { type: "secret_ref", secretId: "secret-api-key", version: "latest" },
          PAPERCLIP_AGENT_ID: "spoofed-agent",
          AGENT_ONLY: "agent-only",
        },
      },
      projectEnv: {
        PAPERCLIP_API_KEY: "project-api-key",
        PAPERCLIP_COMPANY_ID: "spoofed-company",
        PROJECT_ONLY: "project-only",
      },
      routineEnv: {
        PAPERCLIP_API_KEY: "routine-api-key",
        PAPERCLIP_RUN_ID: "spoofed-run",
        ROUTINE_ONLY: "routine-only",
      },
      routineId: "routine-1",
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(resolveEnvBindings.mock.calls[0]?.[1]).toEqual({
      ENV_ONLY: "environment-only",
    });
    expect(resolveAdapterConfigForRuntime.mock.calls[0]?.[1]).toEqual({
      env: {
        AGENT_ONLY: "agent-only",
      },
    });
    expect(resolveEnvBindings.mock.calls[1]?.[1]).toEqual({
      PROJECT_ONLY: "project-only",
    });
    expect(resolveEnvBindings.mock.calls[2]?.[1]).toEqual({
      ROUTINE_ONLY: "routine-only",
    });
    expect(result.resolvedConfig.env).toEqual({
      ENV_ONLY: "environment-only",
      AGENT_ONLY: "agent-only",
      PROJECT_ONLY: "project-only",
      ROUTINE_ONLY: "routine-only",
    });
    expect(JSON.stringify(result.resolvedConfig.env)).not.toContain("PAPERCLIP_");
  });

  it("skips project env resolution when the project has no bindings", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { AGENT_ONLY: "agent-only" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn();

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: { env: { AGENT_ONLY: "agent-only" } },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(result.resolvedConfig.env).toEqual({ AGENT_ONLY: "agent-only" });
    expect(result.secretManifest).toEqual([]);
    expect(resolveEnvBindings).not.toHaveBeenCalled();
  });

  it("passes low-trust allowed secret binding ids into all runtime secret contexts", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: {} },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: {},
      secretKeys: new Set<string>(),
      manifest: [],
    });

    await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      environmentId: "environment-1",
      projectId: "project-1",
      routineId: "routine-1",
      executionRunConfig: { env: {} },
      environmentEnv: { ENVIRONMENT_FLAG: "plain" },
      projectEnv: { PROJECT_FLAG: "plain" },
      routineEnv: { ROUTINE_FLAG: "plain" },
      trustPreset: {
        kind: "low_trust_review",
        preset: LOW_TRUST_REVIEW_PRESET,
        boundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          companyId: "company-1",
          issueIds: ["issue-1"],
          allowedSecretBindingIds: ["binding-1"],
        },
        sourcePresets: {},
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(resolveAdapterConfigForRuntime.mock.calls[0]?.[2]).toMatchObject({
      allowedBindingIds: ["binding-1"],
    });
    expect(resolveEnvBindings.mock.calls[0]?.[2]).toMatchObject({
      allowedBindingIds: ["binding-1"],
    });
    expect(resolveEnvBindings.mock.calls[1]?.[2]).toMatchObject({
      allowedBindingIds: ["binding-1"],
    });
    expect(resolveEnvBindings.mock.calls[2]?.[2]).toMatchObject({
      allowedBindingIds: ["binding-1"],
    });
  });

  it("blocks required missing user secrets before runtime env resolution", async () => {
    const resolveAdapterConfigForRuntime = vi.fn();
    const resolveEnvBindings = vi.fn();
    const collectMissingRuntimeBindings = vi.fn(async (_companyId, _env, context) =>
      context.consumerType === "agent"
        ? [
            {
              consumerType: "agent",
              consumerId: "agent-1",
              configPath: "env.GITHUB_TOKEN",
              envKey: "GITHUB_TOKEN",
              bindingType: "user_secret_ref",
              secretId: null,
              secretName: null,
              userSecretDefinitionId: "definition-1",
              userSecretDefinitionKey: "github_token",
              userSecretDefinitionName: "GitHub token",
              responsibleUserId: context.responsibleUserId,
              errorCode: "user_secret_missing",
            },
          ]
        : [],
    );

    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      responsibleUserId: "user-1",
      executionRunConfig: {
        env: {
          GITHUB_TOKEN: { type: "user_secret_ref", key: "github_token", required: true },
        },
      },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
        collectMissingRuntimeBindings,
      } as any,
    })).rejects.toMatchObject({
      code: "configuration_incomplete",
      resultJson: {
        configurationIncomplete: {
          reason: "secret_binding_missing",
          companyId: "company-1",
          agentId: "agent-1",
          issueId: "issue-1",
          missingBindings: [
            expect.objectContaining({
              bindingType: "user_secret_ref",
              userSecretDefinitionKey: "github_token",
              responsibleUserId: "user-1",
            }),
          ],
        },
      },
    });
    expect(collectMissingRuntimeBindings.mock.calls[0]?.[2]).toMatchObject({
      responsibleUserId: "user-1",
    });
    expect(resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
    expect(resolveEnvBindings).not.toHaveBeenCalled();
  });

  it("rejects inline sensitive env values for low-trust runs", async () => {
    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      executionRunConfig: {
        env: {
          OPENAI_API_KEY: "inline-secret",
        },
      },
      projectEnv: null,
      trustPreset: {
        kind: "low_trust_review",
        preset: LOW_TRUST_REVIEW_PRESET,
        boundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          companyId: "company-1",
          issueIds: ["issue-1"],
        },
        sourcePresets: {},
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime: vi.fn(),
        resolveEnvBindings: vi.fn(),
      } as any,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "low_trust_inline_sensitive_env_denied" },
    });
  });

  it("fails push-capability preflight when no GitHub write credential is bound at agent or project scope", async () => {
    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      executionRunConfig: { env: { AGENT_ONLY: "agent-only" } },
      projectEnv: { PROJECT_ONLY: "project-only" },
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN", "GITHUB_TOKEN"],
        consumerScopes: ["agent", "project"],
        reason: "push_write_credential_missing",
        remediation: "GitHub PR workflow requires GH_TOKEN or GITHUB_TOKEN bound at project or agent scope.",
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime: vi.fn(),
        resolveEnvBindings: vi.fn(),
      } as any,
    })).rejects.toMatchObject({
      code: "configuration_incomplete",
      message: expect.stringContaining("GitHub PR workflow requires GH_TOKEN or GITHUB_TOKEN"),
      resultJson: {
        configurationIncomplete: {
          reason: "push_write_credential_missing",
          requiredEnvKeys: ["GH_TOKEN", "GITHUB_TOKEN"],
          requiredScopes: ["agent", "project"],
          missingBindings: [],
        },
      },
    });
  });

  it("passes push-capability preflight when a project-scoped GitHub credential is configured", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { AGENT_ONLY: "agent-only" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: { GH_TOKEN: "github-token" },
      secretKeys: new Set(["GH_TOKEN"]),
      manifest: [],
    });
    const collectMissingRuntimeBindings = vi.fn().mockResolvedValue([]);

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      projectId: "project-1",
      executionRunConfig: { env: { AGENT_ONLY: "agent-only" } },
      projectEnv: { GH_TOKEN: { type: "plain", value: "github-token" } },
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN", "GITHUB_TOKEN"],
        consumerScopes: ["agent", "project"],
        reason: "push_write_credential_missing",
        remediation: "GitHub PR workflow requires GH_TOKEN or GITHUB_TOKEN bound at project or agent scope.",
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
        collectMissingRuntimeBindings,
      } as any,
    });

    expect(result.resolvedConfig.env).toEqual({
      AGENT_ONLY: "agent-only",
      GH_TOKEN: "github-token",
    });
    expect(resolveEnvBindings).toHaveBeenCalledOnce();
    expect(collectMissingRuntimeBindings).toHaveBeenCalledTimes(2);
    expect(collectMissingRuntimeBindings.mock.calls[1]?.[2]).toMatchObject({
      consumerType: "project",
      consumerId: "project-1",
    });
  });
});

describe("resolveExecutionRunAdapterConfig codex_local credential pre-dispatch gate", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function stubManagedCodexEnv(options: { seedSharedAuth: boolean }) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-gate-"));
    cleanupDirs.push(root);
    const paperclipHome = path.join(root, "paperclip-home");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    await fs.mkdir(sharedCodexHome, { recursive: true });
    if (options.seedSharedAuth) {
      await fs.writeFile(
        path.join(sharedCodexHome, "auth.json"),
        '{"OPENAI_API_KEY":"sk-shared"}\n',
        "utf8",
      );
    }
    vi.stubEnv("PAPERCLIP_HOME", paperclipHome);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("CODEX_HOME", sharedCodexHome);
    const managedAgentHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "codex-home",
    );
    return { root, managedAgentHome };
  }

  it("surfaces a configuration-incomplete blocker when a managed home has no auth and OPENAI_API_KEY is empty", async () => {
    const { managedAgentHome } = await stubManagedCodexEnv({ seedSharedAuth: false });
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });

    await expect(
      resolveExecutionRunAdapterConfig({
        companyId: "company-1",
        agentId: "agent-1",
        adapterType: "codex_local",
        issueId: "issue-1",
        responsibleUserId: "user-1",
        executionRunConfig: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "" } },
        projectEnv: null,
        secretsSvc: {
          resolveAdapterConfigForRuntime,
          resolveEnvBindings: vi.fn(),
          collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
        } as any,
      }),
    ).rejects.toMatchObject({
      code: "configuration_incomplete",
      message: expect.stringContaining("no Codex credentials available"),
      resultJson: {
        configurationIncomplete: {
          reason: "codex_credentials_missing",
          adapterType: "codex_local",
          companyId: "company-1",
          agentId: "agent-1",
          issueId: "issue-1",
          responsibleUserId: "user-1",
          requiredEnvKeys: ["OPENAI_API_KEY"],
        },
      },
    });
    // The blocker message must not leak any secret value.
    await expect(
      resolveExecutionRunAdapterConfig({
        companyId: "company-1",
        agentId: "agent-1",
        adapterType: "codex_local",
        executionRunConfig: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "" } },
        projectEnv: null,
        secretsSvc: {
          resolveAdapterConfigForRuntime,
          resolveEnvBindings: vi.fn(),
          collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
        } as any,
      }).catch((err) => err.message),
    ).resolves.not.toContain("sk-");
  });

  it("dispatches normally when a per-agent OPENAI_API_KEY is resolved", async () => {
    const { managedAgentHome } = await stubManagedCodexEnv({ seedSharedAuth: false });
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "sk-agent-resolved" } },
      secretKeys: new Set(["OPENAI_API_KEY"]),
      manifest: [],
    });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      adapterType: "codex_local",
      executionRunConfig: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: { type: "secret_ref" } } },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings: vi.fn(),
        collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
      } as any,
    });
    expect(result.resolvedConfig.env).toMatchObject({ OPENAI_API_KEY: "sk-agent-resolved" });
  });

  it("dispatches normally when the shared host home carries subscription auth", async () => {
    const { managedAgentHome } = await stubManagedCodexEnv({ seedSharedAuth: true });
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      adapterType: "codex_local",
      executionRunConfig: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "" } },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings: vi.fn(),
        collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
      } as any,
    });
    expect(result.resolvedConfig.command).toBe("codex");
  });

  it("does not gate non-codex adapters", async () => {
    await stubManagedCodexEnv({ seedSharedAuth: false });
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { command: "claude", env: { OPENAI_API_KEY: "" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      adapterType: "claude_local",
      executionRunConfig: { command: "claude", env: { OPENAI_API_KEY: "" } },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings: vi.fn(),
        collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
      } as any,
    });
    expect(result.resolvedConfig.command).toBe("claude");
  });
});

describe("extractMentionedSkillIdsFromSources", () => {
  it("collects UUID skill mention ids across issue sources", () => {
    const releaseSkillId = "11111111-1111-4111-8111-111111111111";
    const browserSkillId = "22222222-2222-4222-8222-222222222222";
    const releaseHref = buildSkillMentionHref(releaseSkillId, "release-changelog");
    const browserHref = buildSkillMentionHref(browserSkillId, "agent-browser");

    expect(
      extractMentionedSkillIdsFromSources([
        `Please use [/release-changelog](${releaseHref})`,
        `And also [/agent-browser](${browserHref})`,
        `Duplicate mention [/release-changelog](${releaseHref})`,
      ]),
    ).toEqual([releaseSkillId, browserSkillId]);
  });

  it("ignores legacy non-UUID skill mention ids before runtime database lookup", () => {
    const validSkillId = "33333333-3333-4333-8333-333333333333";
    const validHref = buildSkillMentionHref(validSkillId, "greploop");
    const legacyHref = buildSkillMentionHref("skill-greploop", "greploop");

    expect(
      extractMentionedSkillIdsFromSources([
        `Use [/greploop](${legacyHref}) and [/prcheckloop](${validHref})`,
      ]),
    ).toEqual([validSkillId]);
  });
});

describe("applyRunScopedMentionedSkillKeys", () => {
  it("adds mentioned skills without mutating the original config", () => {
    const originalConfig = {
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/paperclip"],
      },
    };

    const updatedConfig = applyRunScopedMentionedSkillKeys(originalConfig, [
      "company/company-1/release-changelog",
      "paperclipai/paperclip/paperclip",
      "company/company-1/release-changelog",
    ]);

    expect(updatedConfig).toEqual({
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: [
          "paperclipai/paperclip/paperclip",
          "company/company-1/release-changelog",
        ],
      },
    });
    expect(originalConfig).toEqual({
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/paperclip"],
      },
    });
  });

  it("preserves existing version pins when adding mentioned skills", () => {
    const originalConfig = {
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: [
          { key: "company/company-1/release-changelog", versionId: "version-1" },
        ],
      },
    };

    const updatedConfig = applyRunScopedMentionedSkillKeys(originalConfig, [
      "company/company-1/security-review",
    ]);

    expect(updatedConfig).toEqual({
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: [
          { key: "company/company-1/release-changelog", versionId: "version-1" },
          { key: "company/company-1/security-review", versionId: null },
        ],
      },
    });
  });
});

// Sanctioned task_bridge credential delivery (separated-identity design).
// The total PAPERCLIP_* strip stays intact (run identity unspoofable, INV-1); the
// operator-bound task_bridge secret is delivered — and ONLY delivered — into the
// distinct PAPERCLIP_BRIDGE_API_KEY slot, gated on an operator secret_ref (INV-2)
// and a task_bridge scope check (INV-3), with the value redacted (INV-5).
describe("resolveExecutionRunAdapterConfig — sanctioned task_bridge bridge key", () => {
  const BRIDGE_SECRET_REF = {
    type: "secret_ref" as const,
    secretId: "0000b41d-9e00-4000-8000-000000000001",
    version: "latest" as const,
  };

  function mockAgentConfigResolver(env: Record<string, unknown>) {
    // Mirrors the real resolver: agent adapterConfig env is already stripped of
    // PAPERCLIP_* by the caller before it reaches resolveAdapterConfigForRuntime.
    return vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({
      config: { ...config, env: { ...env } },
      secretKeys: new Set<string>(),
      manifest: [],
    }));
  }

  it("delivers an operator secret_ref bridge key into PAPERCLIP_BRIDGE_API_KEY when the resolved key is task_bridge-scoped (INV-2/INV-3, acceptance 1a)", async () => {
    const resolveAdapterConfigForRuntime = mockAgentConfigResolver({ AGENT_ONLY: "agent-only" });
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: { [SANCTIONED_BRIDGE_ENV_KEY]: "pat-task-bridge-resolved" },
      secretKeys: new Set([SANCTIONED_BRIDGE_ENV_KEY]),
      manifest: [],
    });
    const verifyTaskBridgeKey = vi.fn(async () => ({ ok: true as const }));

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      executionRunConfig: {
        env: {
          AGENT_ONLY: "agent-only",
        },
      },
      // The bridge secret_ref lives in the agent's board-gated adapterConfig env.
      boardGatedAgentEnv: {
        [SANCTIONED_BRIDGE_ENV_KEY]: BRIDGE_SECRET_REF,
      },
      projectEnv: null,
      secretsSvc: { resolveAdapterConfigForRuntime, resolveEnvBindings } as any,
      verifyTaskBridgeKey,
    });

    // The bridge value is delivered into the distinct sanctioned slot...
    expect(result.resolvedConfig.env).toMatchObject({
      AGENT_ONLY: "agent-only",
      [SANCTIONED_BRIDGE_ENV_KEY]: "pat-task-bridge-resolved",
    });
    // ...and never as run identity (INV-1).
    expect((result.resolvedConfig.env as Record<string, unknown>).PAPERCLIP_API_KEY).toBeUndefined();
    // The live credential is redacted (INV-5).
    expect(result.secretKeys.has(SANCTIONED_BRIDGE_ENV_KEY)).toBe(true);
    // The raw secret_ref binding survived the strip and was resolved via the
    // agent consumer context.
    expect(resolveEnvBindings).toHaveBeenCalledWith(
      "company-1",
      { [SANCTIONED_BRIDGE_ENV_KEY]: BRIDGE_SECRET_REF },
      expect.objectContaining({ consumerType: "agent", consumerId: "agent-1" }),
    );
    // Scope was verified against the resolved value.
    expect(verifyTaskBridgeKey).toHaveBeenCalledWith("pat-task-bridge-resolved");
  });

  it("fails closed (no delivery) when the resolved key is NOT task_bridge-scoped (INV-3)", async () => {
    const resolveAdapterConfigForRuntime = mockAgentConfigResolver({ AGENT_ONLY: "agent-only" });
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: { [SANCTIONED_BRIDGE_ENV_KEY]: "pat-broad-standard-key" },
      secretKeys: new Set([SANCTIONED_BRIDGE_ENV_KEY]),
      manifest: [],
    });
    const verifyTaskBridgeKey = vi.fn(async () => ({ ok: false as const, code: "key_scope_mismatch" as const, keyId: "key-1", actualScopeKind: "standard" })); // wrong scope

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      executionRunConfig: { env: {} },
      boardGatedAgentEnv: { [SANCTIONED_BRIDGE_ENV_KEY]: BRIDGE_SECRET_REF },
      projectEnv: null,
      secretsSvc: { resolveAdapterConfigForRuntime, resolveEnvBindings } as any,
      verifyTaskBridgeKey,
    });

    expect((result.resolvedConfig.env as Record<string, unknown>)[SANCTIONED_BRIDGE_ENV_KEY]).toBeUndefined();
    expect(result.secretKeys.has(SANCTIONED_BRIDGE_ENV_KEY)).toBe(false);
    expect(verifyTaskBridgeKey).toHaveBeenCalledTimes(1);
  });

  it("fails closed (no delivery) when no scope verifier is wired (INV-3 fail-closed default)", async () => {
    const resolveAdapterConfigForRuntime = mockAgentConfigResolver({});
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: { [SANCTIONED_BRIDGE_ENV_KEY]: "pat-task-bridge-resolved" },
      secretKeys: new Set([SANCTIONED_BRIDGE_ENV_KEY]),
      manifest: [],
    });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      executionRunConfig: { env: {} },
      boardGatedAgentEnv: { [SANCTIONED_BRIDGE_ENV_KEY]: BRIDGE_SECRET_REF },
      projectEnv: null,
      secretsSvc: { resolveAdapterConfigForRuntime, resolveEnvBindings } as any,
      // no verifyTaskBridgeKey
    });

    expect((result.resolvedConfig.env as Record<string, unknown>)[SANCTIONED_BRIDGE_ENV_KEY]).toBeUndefined();
  });

  it.each([
    ["a bare inline string", "pat-agent-self-granted"],
    ["an inline plain binding", { type: "plain", value: "pat-agent-self-granted" }],
    ["a per-user secret ref", { type: "user_secret_ref", key: "MY_KEY" }],
  ])("fails closed for %s bridge binding (INV-2: operator secret_ref only)", async (_label, binding) => {
    const resolveAdapterConfigForRuntime = mockAgentConfigResolver({ AGENT_ONLY: "agent-only" });
    const resolveEnvBindings = vi.fn();
    const verifyTaskBridgeKey = vi.fn(async () => ({ ok: true as const }));

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      executionRunConfig: { env: {} },
      boardGatedAgentEnv: { [SANCTIONED_BRIDGE_ENV_KEY]: binding as unknown },
      projectEnv: null,
      secretsSvc: { resolveAdapterConfigForRuntime, resolveEnvBindings } as any,
      verifyTaskBridgeKey,
    });

    expect((result.resolvedConfig.env as Record<string, unknown>)[SANCTIONED_BRIDGE_ENV_KEY]).toBeUndefined();
    // A non-secret_ref binding is refused before any resolution or scope check.
    expect(resolveEnvBindings).not.toHaveBeenCalled();
    expect(verifyTaskBridgeKey).not.toHaveBeenCalled();
  });

  it("keeps run-identity keys stripped even alongside a valid bridge binding (INV-1 regression, acceptance 1b)", async () => {
    const resolveAdapterConfigForRuntime = mockAgentConfigResolver({ AGENT_ONLY: "agent-only" });
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: { [SANCTIONED_BRIDGE_ENV_KEY]: "pat-task-bridge-resolved" },
      secretKeys: new Set([SANCTIONED_BRIDGE_ENV_KEY]),
      manifest: [],
    });
    const verifyTaskBridgeKey = vi.fn(async () => ({ ok: true as const }));

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      executionRunConfig: {
        env: {
          // Agent-settable run-identity spoof attempts — must all be stripped and
          // must NOT reach resolveAdapterConfigForRuntime.
          PAPERCLIP_API_KEY: { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111", version: "latest" },
          PAPERCLIP_RUN_ID: "spoofed-run",
          PAPERCLIP_API_URL: "http://evil.example",
          AGENT_ONLY: "agent-only",
        },
      },
      // Bridge binding comes from the board-gated adapterConfig env.
      boardGatedAgentEnv: {
        [SANCTIONED_BRIDGE_ENV_KEY]: BRIDGE_SECRET_REF,
      },
      projectEnv: null,
      secretsSvc: { resolveAdapterConfigForRuntime, resolveEnvBindings } as any,
      verifyTaskBridgeKey,
    });

    // The agent env handed to the resolver had every PAPERCLIP_* key stripped
    // (including the bridge binding — it is re-resolved on a separate path).
    expect(resolveAdapterConfigForRuntime.mock.calls[0]?.[1]).toEqual({ env: { AGENT_ONLY: "agent-only" } });
    // Run identity never appears in the resolved child env...
    const env = result.resolvedConfig.env as Record<string, unknown>;
    expect(env.PAPERCLIP_API_KEY).toBeUndefined();
    expect(env.PAPERCLIP_RUN_ID).toBeUndefined();
    expect(env.PAPERCLIP_API_URL).toBeUndefined();
    // ...only the sanctioned bridge slot is delivered.
    expect(env[SANCTIONED_BRIDGE_ENV_KEY]).toBe("pat-task-bridge-resolved");
  });

  // Regression (INV-2 hardening): a bridge secret_ref supplied ONLY via
  // the issue-override-merged executionRunConfig.env — with NO board-gated binding
  // for the running agent — must fail closed. The bridge binding is resolved solely
  // from `boardGatedAgentEnv`, so the issue-override path is never even read: no
  // resolution and no scope check happen, and nothing is delivered. This holds even
  // when the override binding WOULD resolve to a valid, correctly-scoped key.
  it("fails closed when the bridge secret_ref is only an issue-override (no board-gated binding)", async () => {
    const resolveAdapterConfigForRuntime = mockAgentConfigResolver({ AGENT_ONLY: "agent-only" });
    // A resolver that WOULD hand back a valid, correctly-scoped key if consulted.
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: { [SANCTIONED_BRIDGE_ENV_KEY]: "pat-task-bridge-resolved" },
      secretKeys: new Set([SANCTIONED_BRIDGE_ENV_KEY]),
      manifest: [],
    });
    const verifyTaskBridgeKey = vi.fn(async () => ({ ok: true as const }));

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      // Simulates an agent-settable issue-assignee adapterConfig override that got
      // shallow-merged into the run config. It carries a well-formed operator-style
      // secret_ref, but the agent — not the operator — placed it here.
      executionRunConfig: {
        env: {
          AGENT_ONLY: "agent-only",
          [SANCTIONED_BRIDGE_ENV_KEY]: BRIDGE_SECRET_REF,
        },
      },
      // The agent's board-gated adapterConfig env carries NO bridge binding.
      boardGatedAgentEnv: { AGENT_ONLY: "agent-only" },
      projectEnv: null,
      secretsSvc: { resolveAdapterConfigForRuntime, resolveEnvBindings } as any,
      verifyTaskBridgeKey,
    });

    // No bridge credential is delivered...
    expect((result.resolvedConfig.env as Record<string, unknown>)[SANCTIONED_BRIDGE_ENV_KEY]).toBeUndefined();
    expect(result.secretKeys.has(SANCTIONED_BRIDGE_ENV_KEY)).toBe(false);
    // ...and the issue-override binding was never even resolved or scope-checked.
    expect(resolveEnvBindings).not.toHaveBeenCalled();
    expect(verifyTaskBridgeKey).not.toHaveBeenCalled();
  });
});
