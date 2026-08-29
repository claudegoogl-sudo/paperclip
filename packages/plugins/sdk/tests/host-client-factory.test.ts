import { describe, expect, it, vi } from "vitest";

import type { HostServices } from "../src/host-client-factory.js";
import {
  CapabilityDeniedError,
  createHostClientHandlers,
  InvocationScopeDeniedError,
} from "../src/host-client-factory.js";
import { PLUGIN_RPC_ERROR_CODES } from "../src/protocol.js";

describe("createHostClientHandlers invocation company scope", () => {
  it("rejects worker-selected config and secret company ids without a host invocation scope", async () => {
    const configGet = vi.fn(async () => ({ apiKeyRef: "unreachable" }));
    const secretsResolve = vi.fn(async () => "unreachable");
    const services = {
      config: { get: configGet },
      secrets: { resolve: secretsResolve },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["secrets.read-ref"],
      services,
    });

    await expect(
      handlers["config.get"]({ companyId: "company-a" }),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    await expect(
      handlers["secrets.resolve"]({
        companyId: "company-a",
        secretRef: { type: "secret_ref", secretId: "secret-a" },
      }),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(configGet).not.toHaveBeenCalled();
    expect(secretsResolve).not.toHaveBeenCalled();
  });

  it("allows explicit config and secret company ids only when they match the host invocation scope", async () => {
    const configGet = vi.fn(async () => ({ apiKeyRef: "ref" }));
    const secretsResolve = vi.fn(async () => "resolved");
    const services = {
      config: { get: configGet },
      secrets: { resolve: secretsResolve },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["secrets.read-ref"],
      services,
    });
    const context = { invocationScope: { companyId: "company-a" } };

    await expect(
      handlers["config.get"]({ companyId: "company-a" }, context),
    ).resolves.toEqual({ apiKeyRef: "ref" });
    await expect(
      handlers["secrets.resolve"]({
        companyId: "company-a",
        secretRef: { type: "secret_ref", secretId: "secret-a" },
      }, context),
    ).resolves.toBe("resolved");

    expect(configGet).toHaveBeenCalledWith({ companyId: "company-a" }, context);
    expect(secretsResolve).toHaveBeenCalledWith({
      companyId: "company-a",
      secretRef: { type: "secret_ref", secretId: "secret-a" },
    }, context);
  });

  it("rejects company-scoped host calls outside the current invocation company", async () => {
    const projectsList = vi.fn(async () => []);
    const services = {
      projects: {
        list: projectsList,
      },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["projects.read"],
      services,
    });

    await expect(
      handlers["projects.list"](
        { companyId: "company-b" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    await expect(
      handlers["projects.list"](
        { companyId: "company-b" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
    });
    expect(projectsList).not.toHaveBeenCalled();
  });

  it("filters companies.list to the current invocation company", async () => {
    const services = {
      companies: {
        list: vi.fn(async () => [
          { id: "company-a", name: "Company A" },
          { id: "company-b", name: "Company B" },
        ]),
      },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["companies.read"],
      services,
    });

    await expect(
      handlers["companies.list"](
        {},
        { invocationScope: { companyId: "company-a" } },
      ),
    ).resolves.toEqual([{ id: "company-a", name: "Company A" }]);
  });

  it("rejects company-scope store access for a different company", async () => {
    const stateGet = vi.fn(async () => null);
    const services = {
      state: {
        get: stateGet,
      },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["plugin.state.read"],
      services,
    });

    await expect(
      handlers["state.get"](
        { scopeKind: "company", scopeId: "company-b", stateKey: "settings" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(stateGet).not.toHaveBeenCalled();
  });

  it.each([
    [
      "access.members.list",
      "access.members.read",
      { companyId: "company-a" },
      (services: HostServices) => vi.mocked(services.access.listMembers),
    ],
    [
      "access.members.update",
      "access.members.write",
      { companyId: "company-a", memberId: "member-a", patch: { status: "active" } },
      (services: HostServices) => vi.mocked(services.access.updateMember),
    ],
    [
      "authorization.grants.set",
      "authorization.grants.write",
      { companyId: "company-a", principalType: "agent", principalId: "agent-a", grants: [] },
      (services: HostServices) => vi.mocked(services.authorization.setGrants),
    ],
    [
      "authorization.policies.update",
      "authorization.policies.write",
      { companyId: "company-a", resourceType: "agent", resourceId: "agent-a", policy: null },
      (services: HostServices) => vi.mocked(services.authorization.updatePolicy),
    ],
    [
      "authorization.audit.search",
      "authorization.audit.read",
      { companyId: "company-a" },
      (services: HostServices) => vi.mocked(services.authorization.searchAudit),
    ],
  ] as const)(
    "rejects %s when the plugin lacks %s",
    async (method, capability, params, getDelegate) => {
      const services = {
        access: {
          listMembers: vi.fn(async () => []),
          updateMember: vi.fn(async () => ({ id: "member-a" })),
        },
        authorization: {
          setGrants: vi.fn(async () => []),
          updatePolicy: vi.fn(async () => ({ policy: null })),
          searchAudit: vi.fn(async () => []),
        },
      } as unknown as HostServices;
      const handlers = createHostClientHandlers({
        pluginId: "paperclip.test",
        capabilities: [],
        services,
      });

      await expect(
        (handlers as Record<string, (input: unknown) => Promise<unknown>>)[method](params),
      ).rejects.toMatchObject({
        name: "CapabilityDeniedError",
        message: expect.stringContaining(capability),
      });
      await expect(
        (handlers as Record<string, (input: unknown) => Promise<unknown>>)[method](params),
      ).rejects.toBeInstanceOf(CapabilityDeniedError);
      expect(getDelegate(services)).not.toHaveBeenCalled();
    },
  );

  it("checks invocation company scope before exposing authorization data", async () => {
    const searchAudit = vi.fn(async () => []);
    const services = {
      authorization: {
        searchAudit,
      },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["authorization.audit.read"],
      services,
    });

    await expect(
      handlers["authorization.audit.search"](
        { companyId: "company-b" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(searchAudit).not.toHaveBeenCalled();
  });

  it("rejects a human-attributed createComment call when only issue.comments.create is granted", async () => {
    const createComment = vi.fn(async () => ({ id: "comment-1" }));
    const services = {
      issues: { createComment },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issue.comments.create"],
      services,
    });
    const context = { invocationScope: { companyId: "company-a" } };

    await expect(
      handlers["issues.createComment"]({
        issueId: "issue-a",
        body: "hello",
        companyId: "company-a",
        actorUserId: "user-a",
      }, context),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(createComment).not.toHaveBeenCalled();
  });

  it("allows a human-attributed createComment call once issue.comments.create_human_attributed is also granted", async () => {
    const createComment = vi.fn(async () => ({ id: "comment-1" }));
    const services = {
      issues: { createComment },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issue.comments.create", "issue.comments.create_human_attributed"],
      services,
    });
    const context = { invocationScope: { companyId: "company-a" } };

    await expect(
      handlers["issues.createComment"]({
        issueId: "issue-a",
        body: "hello",
        companyId: "company-a",
        actorUserId: "user-a",
      }, context),
    ).resolves.toEqual({ id: "comment-1" });
    expect(createComment).toHaveBeenCalledWith({
      issueId: "issue-a",
      body: "hello",
      companyId: "company-a",
      actorUserId: "user-a",
    });
  });

  it("still allows a plain agent-attributed createComment call without the human-attribution capability", async () => {
    const createComment = vi.fn(async () => ({ id: "comment-2" }));
    const services = {
      issues: { createComment },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issue.comments.create"],
      services,
    });
    const context = { invocationScope: { companyId: "company-a" } };

    await expect(
      handlers["issues.createComment"]({
        issueId: "issue-a",
        body: "hello",
        companyId: "company-a",
        authorAgentId: "agent-a",
      }, context),
    ).resolves.toEqual({ id: "comment-2" });
    expect(createComment).toHaveBeenCalled();
  });
});

describe("createHostClientHandlers capability gating for LOOA-641 methods", () => {
  const context = { invocationScope: { companyId: "company-a" } };

  it("denies issues.respondInteraction without issue.interactions.respond", async () => {
    const respondInteraction = vi.fn(async () => ({ interaction: { id: "i" }, applied: true }));
    const services = { issues: { respondInteraction } } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      // A read grant must not confer the ability to respond.
      capabilities: ["issue.interactions.read"],
      services,
    });
    await expect(
      handlers["issues.respondInteraction"]({
        issueId: "issue-a", interactionId: "int-a", companyId: "company-a", action: "accept", actorUserId: "user-a",
      }, context),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(respondInteraction).not.toHaveBeenCalled();
  });

  it("allows issues.respondInteraction with issue.interactions.respond", async () => {
    const respondInteraction = vi.fn(async () => ({ interaction: { id: "i" }, applied: true }));
    const services = { issues: { respondInteraction } } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issue.interactions.respond"],
      services,
    });
    await expect(
      handlers["issues.respondInteraction"]({
        issueId: "issue-a", interactionId: "int-a", companyId: "company-a", action: "accept", actorUserId: "user-a",
      }, context),
    ).resolves.toEqual({ interaction: { id: "i" }, applied: true });
    expect(respondInteraction).toHaveBeenCalledOnce();
  });

  it("denies approvals.decide without approvals.respond", async () => {
    const decide = vi.fn(async () => ({ approval: { id: "a" }, applied: true }));
    const services = { approvals: { decide } } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      // A read grant must not confer the ability to decide.
      capabilities: ["approvals.read"],
      services,
    });
    await expect(
      handlers["approvals.decide"]({
        approvalId: "a", companyId: "company-a", action: "approve", actorUserId: "user-a",
      }, context),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(decide).not.toHaveBeenCalled();
  });

  it("allows approvals.decide with approvals.respond", async () => {
    const decide = vi.fn(async () => ({ approval: { id: "a" }, applied: true }));
    const services = { approvals: { decide } } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["approvals.respond"],
      services,
    });
    await expect(
      handlers["approvals.decide"]({
        approvalId: "a", companyId: "company-a", action: "approve", actorUserId: "user-a",
      }, context),
    ).resolves.toEqual({ approval: { id: "a" }, applied: true });
    expect(decide).toHaveBeenCalledOnce();
  });

  it("denies read methods without their read capability", async () => {
    const listInteractions = vi.fn(async () => []);
    const list = vi.fn(async () => []);
    const getAttachmentContent = vi.fn(async () => null);
    const services = {
      issues: { listInteractions, getAttachmentContent },
      approvals: { list },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: [],
      services,
    });
    await expect(
      handlers["issues.listInteractions"]({ issueId: "i", companyId: "company-a" }, context),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(
      handlers["approvals.list"]({ companyId: "company-a" }, context),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(
      handlers["issues.getAttachmentContent"]({ attachmentId: "at", companyId: "company-a" }, context),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(listInteractions).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(getAttachmentContent).not.toHaveBeenCalled();
  });

  it("enforces invocation company scope on the new methods", async () => {
    const list = vi.fn(async () => []);
    const services = { approvals: { list } } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["approvals.read"],
      services,
    });
    // Requesting company-b while scoped to company-a must be denied.
    await expect(
      handlers["approvals.list"]({ companyId: "company-b" }, context),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(list).not.toHaveBeenCalled();
  });
});

describe("createHostClientHandlers invocation scope fail-closed (fork serviceScope allowlist)", () => {
  it("fails closed for a company-scoped call with no resolvable invocation scope", async () => {
    const configure = vi.fn(async () => ({ ok: true }));
    const services = {
      localFolders: { configure },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["local.folders"],
      services,
    });

    const params = { companyId: "company-a", folderKey: "root", path: "/tmp/x" };

    // Empty context: no active invocation (e.g. an idle-window worker→host call).
    await expect(
      handlers["localFolders.configure"](params as never, {}),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    await expect(
      handlers["localFolders.configure"](params as never, {}),
    ).rejects.toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
    });
    // Context entirely omitted is denied too.
    await expect(
      handlers["localFolders.configure"](params as never),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(configure).not.toHaveBeenCalled();
  });

  it("allows a company-scoped call inside a matching invocation and still rejects mismatches", async () => {
    const configure = vi.fn(async () => ({ ok: true }));
    const services = {
      localFolders: { configure },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["local.folders"],
      services,
    });

    await expect(
      handlers["localFolders.configure"](
        { companyId: "company-a", folderKey: "root", path: "/tmp/x" } as never,
        { invocationScope: { companyId: "company-a" } },
      ),
    ).resolves.toEqual({ ok: true });
    expect(configure).toHaveBeenCalledTimes(1);

    await expect(
      handlers["localFolders.configure"](
        { companyId: "company-b", folderKey: "root", path: "/tmp/x" } as never,
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(configure).toHaveBeenCalledTimes(1);
  });

  it("keeps companies.list and no-company methods working without an invocation scope", async () => {
    const companiesList = vi.fn(async () => [
      { id: "company-a", name: "Company A" },
      { id: "company-b", name: "Company B" },
    ]);
    const configGet = vi.fn(async () => ({ value: 1 }));
    const services = {
      companies: { list: companiesList },
      config: { get: configGet },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["companies.read"],
      services,
    });

    // companies.list (kind "all") returns the full list when no scope resolves.
    await expect(handlers["companies.list"]({}, {})).resolves.toEqual([
      { id: "company-a", name: "Company A" },
      { id: "company-b", name: "Company B" },
    ]);
    // config.get is company-scoped upstream: with no host-issued company
    // context the restored proactive guard denies it (it is NOT a
    // "no-companyId method"). Background consumers must target the fork-only
    // `config.getForServiceScope` read instead.
    await expect(
      handlers["config.get"](undefined as never, {}),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });
  });
});

describe("createHostClientHandlers dispatch runId back-fill", () => {
  // Older SDK plugins (e.g. cad-0.1.7) call `ctx.secrets.resolve(secretRef)`
  // without threading runId. The new server-side handler requires runId, so
  // the gated wrapper back-fills it from the host-validated active invocation
  // scope (set by the host's executeTool / performAction bracket). The fail-
  // closed throw still fires when no active invocation exists.

  it("back-fills runId on secrets.resolve from the active invocation scope", async () => {
    const resolve = vi.fn(async () => "resolved-value");
    const services = {
      secrets: { resolve },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["secrets.read-ref"],
      services,
    });

    await handlers["secrets.resolve"](
      { secretRef: "11111111-1111-1111-1111-111111111111" } as never,
      { invocationScope: { companyId: "company-a", runId: "run-xyz" } },
    );

    // Upstream handler shape: the scope-validated company rides on the params
    // and the original context is passed through as the second argument.
    expect(resolve).toHaveBeenCalledWith(
      {
        secretRef: "11111111-1111-1111-1111-111111111111",
        runId: "run-xyz",
        companyId: "company-a",
      },
      expect.anything(),
    );
  });

  it("does NOT overwrite a runId the worker already provided", async () => {
    const resolve = vi.fn(async () => "resolved-value");
    const services = {
      secrets: { resolve },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["secrets.read-ref"],
      services,
    });

    await handlers["secrets.resolve"](
      {
        secretRef: "11111111-1111-1111-1111-111111111111",
        runId: "worker-supplied-run",
      } as never,
      { invocationScope: { companyId: "company-a", runId: "run-xyz" } },
    );

    expect(resolve).toHaveBeenCalledWith(
      {
        secretRef: "11111111-1111-1111-1111-111111111111",
        runId: "worker-supplied-run",
        companyId: "company-a",
      },
      expect.anything(),
    );
  });

  it("forwards untouched when no active invocation carries a runId", async () => {
    const resolve = vi.fn(async () => "resolved-value");
    const services = {
      secrets: { resolve },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["secrets.read-ref"],
      services,
    });

    await handlers["secrets.resolve"](
      { secretRef: "11111111-1111-1111-1111-111111111111" } as never,
      { invocationScope: { companyId: "company-a" } },
    );

    // No runId on scope → runId passes through unchanged (the server-side
    // handler still fail-closes with `runcontext_invalid`). The restored
    // upstream handler still threads the scope-validated company.
    expect(resolve).toHaveBeenCalledWith(
      {
        secretRef: "11111111-1111-1111-1111-111111111111",
        companyId: "company-a",
      },
      expect.anything(),
    );
  });

  it("denies a secrets.resolve that carries only the service scope (upstream guard; use resolveService)", async () => {
    // Upstream semantics restored: a company-scoped read with no host-issued
    // company context (a setup()-started loop or background job — no dispatch
    // in flight) is denied proactively at the SDK. Background secret reads
    // must target the fork-only `secrets.resolveService`, which binds the
    // company to the secret binding instead of accepting a worker choice.
    const resolve = vi.fn(async () => "resolved-value");
    const services = {
      secrets: { resolve },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["secrets.read-ref"],
      services,
    });

    await expect(
      handlers["secrets.resolve"](
        { secretRef: "11111111-1111-1111-1111-111111111111" } as never,
        { serviceScope: { runId: "service-run-1" } },
      ),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });

    expect(resolve).not.toHaveBeenCalled();
  });

  it("prefers an active dispatch runId over the service scope", async () => {
    // When both are present (a tool dispatch happens to run inside a worker that
    // also has a service scope), the active dispatch must win so the resolve is
    // attributed to the dispatching agent, not the system actor.
    const resolve = vi.fn(async () => "resolved-value");
    const services = {
      secrets: { resolve },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["secrets.read-ref"],
      services,
    });

    await handlers["secrets.resolve"](
      { secretRef: "11111111-1111-1111-1111-111111111111" } as never,
      {
        invocationScope: { companyId: "company-a", runId: "dispatch-run" },
        serviceScope: { runId: "service-run-1" },
      },
    );

    expect(resolve).toHaveBeenCalledWith(
      {
        secretRef: "11111111-1111-1111-1111-111111111111",
        runId: "dispatch-run",
        companyId: "company-a",
      },
      expect.anything(),
    );
  });

  it("back-fills runId on artifacts.fetch symmetrically", async () => {
    const fetch = vi.fn(async () => ({
      filename: "a.txt",
      contentType: "text/plain",
      byteSize: 0,
      contentBase64: "",
    }));
    const services = {
      artifacts: { fetch },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: [],
      services,
    });

    await handlers["artifacts.fetch"](
      { attachmentId: "att-1" } as never,
      { invocationScope: { companyId: "company-a", runId: "run-xyz" } },
    );

    expect(fetch).toHaveBeenCalledWith({
      attachmentId: "att-1",
      runId: "run-xyz",
    });
  });

  it("back-fills runId on artifacts.create symmetrically", async () => {
    const create = vi.fn(async () => ({ attachmentId: "att-new" }));
    const services = {
      artifacts: { create },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issue.attachments.create"],
      services,
    });

    await handlers["artifacts.create"](
      {
        companyId: "company-a",
        filename: "a.png",
        mimeType: "image/png",
        contentBase64: "AAAA",
      } as never,
      { invocationScope: { companyId: "company-a", runId: "run-xyz" } },
    );

    expect(create).toHaveBeenCalledWith({
      companyId: "company-a",
      filename: "a.png",
      mimeType: "image/png",
      contentBase64: "AAAA",
      runId: "run-xyz",
    });
  });
});

describe("createHostClientHandlers artifacts.create capability gate", () => {
  it("denies artifacts.create when the plugin lacks issue.attachments.create", async () => {
    const create = vi.fn(async () => ({ attachmentId: "att-new" }));
    const services = {
      artifacts: { create },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: [],
      services,
    });

    const params = {
      companyId: "company-a",
      filename: "a.png",
      mimeType: "image/png",
      contentBase64: "AAAA",
    };

    await expect(
      handlers["artifacts.create"](
        params as never,
        { invocationScope: { companyId: "company-a", runId: "run-xyz" } },
      ),
    ).rejects.toMatchObject({
      name: "CapabilityDeniedError",
      message: expect.stringContaining("issue.attachments.create"),
    });
    await expect(
      handlers["artifacts.create"](
        params as never,
        { invocationScope: { companyId: "company-a", runId: "run-xyz" } },
      ),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("createHostClientHandlers config.get company-context guard (upstream semantics restored)", () => {
  // Upstream's proactive company-context guard is restored: a company-scoped
  // `config.get` without a host-issued company context is DENIED at this layer
  // before host services run. The single fork accommodation is
  // `forkLegacyScopeContext`, which presents the host-attributed
  // `singleInFlightScope` (single in-flight dispatch, never worker-supplied)
  // as the invocation scope for legacy id-less workers — a provable no-op for
  // every upstream-constructible context.

  function makeConfigHandlers() {
    const get = vi.fn(
      async (params: { companyId?: string }) => ({
        githubPatSecretId: `secret-for-${params.companyId ?? "<none>"}`,
      }),
    );
    const services = {
      config: { get },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: [],
      services,
    });
    return { handlers, get };
  }

  it("serves the single-in-flight dispatch's company to an id-less legacy worker (fork accommodation)", async () => {
    const { handlers, get } = makeConfigHandlers();

    await expect(
      handlers["config.get"](undefined as never, {
        invalidInvocationScope: true,
        singleInFlightScope: { companyId: "company-dpr" },
      }),
    ).resolves.toEqual({ githubPatSecretId: "secret-for-company-dpr" });

    expect(get).toHaveBeenCalledWith(
      { companyId: "company-dpr" },
      expect.anything(),
    );
  });

  it("prefers invocationScope over singleInFlightScope when both are present", async () => {
    const { handlers, get } = makeConfigHandlers();

    await handlers["config.get"](undefined as never, {
      invocationScope: { companyId: "company-a" },
      singleInFlightScope: { companyId: "company-b" },
    });

    expect(get).toHaveBeenCalledWith(
      { companyId: "company-a" },
      expect.anything(),
    );
    expect(get).not.toHaveBeenCalledWith(
      { companyId: "company-b" },
      expect.anything(),
    );
  });

  it("denies a scope-less config.get outright (upstream byte-compat; no instance-wide fallback)", async () => {
    const { handlers, get } = makeConfigHandlers();

    // No invocationScope and no singleInFlightScope (0 or 2+ in-flight
    // dispatches, or a background loop that owns no dispatch) → upstream's
    // proactive denial. Background consumers must target the fork-only
    // `config.getForServiceScope` read instead.
    await expect(
      handlers["config.get"](undefined as never, {}),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });

    expect(get).not.toHaveBeenCalled();
  });

  it("a worker cannot name an arbitrary tenant via a forged companyId param — fails closed", async () => {
    const { handlers, get } = makeConfigHandlers();

    // config.get carries no companyId in its real contract. If a worker forges
    // one, the gated `requireInvocationCompanyScope` enforcement treats it as a
    // requested company scope; with no matching `invocationScope` it is denied
    // before the handler body runs. The forged company's config is never read —
    // the scope selection in the handler only ever uses host-derived scopes.
    await expect(
      handlers["config.get"](
        { companyId: "company-attacker" } as never,
        { singleInFlightScope: { companyId: "company-dpr" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);

    expect(get).not.toHaveBeenCalled();
  });
});

describe("createHostClientHandlers fork-only service-scope reads", () => {
  // The fork-only background surface: provisioned reach only, concrete
  // companyId mandatory, no kind:"all". `secrets.resolveService` additionally
  // requires the host-minted serviceScope and rejects a worker-supplied
  // companyId (the server derives the company from the secret binding).

  function makeForkHandlers() {
    const getForServiceScope = vi.fn(async () => ({ tier: "pro" }));
    const listPending = vi.fn(async () => []);
    const resolveService = vi.fn(async () => "resolved-value");
    const services = {
      config: { get: vi.fn(), getForServiceScope },
      approvals: { list: vi.fn(), get: vi.fn(), decide: vi.fn(), listPending },
      secrets: { resolve: vi.fn(), mintHandle: vi.fn(), resolveService },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["secrets.read-ref", "board.approvals.read"],
      services,
    });
    return { handlers, getForServiceScope, listPending, resolveService };
  }

  it("config.getForServiceScope: authorizes a concrete company under the bare serviceScope", async () => {
    const { handlers, getForServiceScope } = makeForkHandlers();

    await expect(
      handlers["config.getForServiceScope"](
        { companyId: "company-a" },
        { serviceScope: { runId: "service-run-1" } } as never,
      ),
    ).resolves.toEqual({ tier: "pro" });

    expect(getForServiceScope).toHaveBeenCalledWith({ companyId: "company-a" });
  });

  it("config.getForServiceScope: rejects a missing/empty companyId at the bridge", async () => {
    const { handlers, getForServiceScope } = makeForkHandlers();

    await expect(
      handlers["config.getForServiceScope"]({ companyId: "" } as never, {} as never),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    await expect(
      handlers["config.getForServiceScope"](undefined as never, {} as never),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);

    expect(getForServiceScope).not.toHaveBeenCalled();
  });

  it("approvals.listPending: authorizes a concrete company under the bare serviceScope", async () => {
    const { handlers, listPending } = makeForkHandlers();

    await expect(
      handlers["approvals.listPending"](
        { companyId: "company-a" },
        { serviceScope: { runId: "service-run-1" } } as never,
      ),
    ).resolves.toEqual([]);

    expect(listPending).toHaveBeenCalledWith({ companyId: "company-a" });
  });

  it("approvals.listPending: rejects a missing/empty companyId at the bridge", async () => {
    const { handlers, listPending } = makeForkHandlers();

    await expect(
      handlers["approvals.listPending"]({} as never, {} as never),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("a concrete companyId is required"),
    });

    expect(listPending).not.toHaveBeenCalled();
  });

  it("secrets.resolveService: resolves with the host-minted serviceScope and derives nothing from the worker", async () => {
    const { handlers, resolveService } = makeForkHandlers();

    await expect(
      handlers["secrets.resolveService"](
        { secretRef: "11111111-1111-1111-1111-111111111111" },
        { serviceScope: { runId: "service-run-1" } } as never,
      ),
    ).resolves.toBe("resolved-value");

    expect(resolveService).toHaveBeenCalledWith({
      secretRef: "11111111-1111-1111-1111-111111111111",
      runId: "service-run-1",
    });
  });

  it("secrets.resolveService: denies a call with no host-minted serviceScope", async () => {
    const { handlers, resolveService } = makeForkHandlers();

    await expect(
      handlers["secrets.resolveService"](
        { secretRef: "11111111-1111-1111-1111-111111111111" },
        {},
      ),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("host-minted service scope is required"),
    });

    expect(resolveService).not.toHaveBeenCalled();
  });

  it("secrets.resolveService: rejects a worker-supplied companyId — the company comes from the binding", async () => {
    const { handlers, resolveService } = makeForkHandlers();

    // The generic invocation guard fires FIRST: a params-level companyId is a
    // requested company scope, and a bare serviceScope grants none.
    await expect(
      handlers["secrets.resolveService"](
        { secretRef: "11111111-1111-1111-1111-111111111111", companyId: "company-a" } as never,
        { serviceScope: { runId: "service-run-1" } } as never,
      ),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });

    expect(resolveService).not.toHaveBeenCalled();
  });
});

describe("createHostClientHandlers events.subscribe serviceScope", () => {
  // A single-company plugin sets its `topicMap`, so its `setup()` loop
  // subscribes with a per-company `filter` instead of unfiltered. There is no
  // active dispatch at `setup()`, so the only host-validated context is the
  // worker-lifetime `serviceScope`. The gate must authorize this
  // narrower filtered subscribe — denying it (a prior bug) regressed the
  // messenger's subscriptions 5 → 0 and is a least-privilege inversion: the
  // broader unfiltered subscribe was allowed while the narrower one was denied.
  function makeEventsHandlers() {
    const subscribe = vi.fn(async () => undefined);
    const services = {
      events: { subscribe },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.messenger",
      capabilities: ["events.subscribe"],
      services,
    });
    return { handlers, subscribe };
  }

  it("denies a company-filtered subscribe under serviceScope alone (upstream denial restored)", async () => {
    // Upstream pins the denial of a proactive company-filtered subscribe with
    // no host-issued company context. A setup()-time subscribe for a
    // CONFIGURED company is authorized instead by the host's options-seeded
    // proactive scope (which surfaces as a real invocationScope — see the
    // worker-manager proactive-scope tests); the serviceScope allowance deliberately
    // does NOT cover events.subscribe, so a company outside the seeded set
    // still fails closed here.
    const { handlers, subscribe } = makeEventsHandlers();
    const params = {
      eventPattern: "issue.created",
      filter: { companyId: "company-a" },
    };

    await expect(
      handlers["events.subscribe"](params as never, {
        serviceScope: { runId: "service-run-1" },
      }),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("still allows an unfiltered subscribe under serviceScope (companyScope 'none')", async () => {
    const { handlers, subscribe } = makeEventsHandlers();
    const params = { eventPattern: "issue.created" };

    await expect(
      handlers["events.subscribe"](params as never, {
        serviceScope: { runId: "service-run-1" },
      }),
    ).resolves.toBeUndefined();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("fails closed for a company-filtered subscribe with NO scope at all (no serviceScope)", async () => {
    const { handlers, subscribe } = makeEventsHandlers();
    const params = {
      eventPattern: "issue.created",
      filter: { companyId: "company-a" },
    };

    await expect(
      handlers["events.subscribe"](params as never, {}),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    await expect(
      handlers["events.subscribe"](params as never),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("denies a company-filtered subscribe under serviceScope even when base context reports invalidInvocationScope", async () => {
    // events.subscribe is deliberately OUTSIDE the fork-only serviceScope
    // allowlist (upstream pins this denial; configured companies are
    // covered by the host's options-seeded proactive scope, not by this
    // allowance). The invalid-scope rejection therefore applies.
    const { handlers, subscribe } = makeEventsHandlers();
    const params = {
      eventPattern: "issue.created",
      filter: { companyId: "company-a" },
    };

    await expect(
      handlers["events.subscribe"](params as never, {
        invalidInvocationScope: true,
        serviceScope: { runId: "service-run-1" },
      }),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("missing, expired, or unknown invocation scope"),
    });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("does NOT extend the serviceScope allowance to other company-scoped methods", async () => {
    // The serviceScope allowance is an explicit allowlist
    // (SERVICE_SCOPE_COMPANY_METHODS). A company-scoped method outside it —
    // here projects.list, which trusts companyId as the sole authority with no
    // entity cross-check — must keep failing closed under serviceScope alone.
    const projectsList = vi.fn(async () => []);
    const services = {
      projects: { list: projectsList },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.messenger",
      capabilities: ["projects.read"],
      services,
    });

    await expect(
      handlers["projects.list"](
        { companyId: "company-a" },
        { serviceScope: { runId: "service-run-1" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(projectsList).not.toHaveBeenCalled();
  });

  it("keeps strict enforcement when an active dispatch pins a different company", async () => {
    // When an active invocation pins a company, the serviceScope relaxation does
    // not apply: a filter naming a different company is still denied.
    const { handlers, subscribe } = makeEventsHandlers();

    await expect(
      handlers["events.subscribe"](
        { eventPattern: "issue.created", filter: { companyId: "company-b" } } as never,
        {
          invocationScope: { companyId: "company-a" },
          serviceScope: { runId: "service-run-1" },
        },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe("createHostClientHandlers serviceScope company writes/state", () => {
  // Inbound sibling of the events.subscribe serviceScope allowlist: the messenger
  // `getUpdates` poll loop is started
  // in `setup()` and runs with no active dispatch, so an operator reply it
  // routes calls `issues.createComment` (and reads company-scoped state) under
  // the bare worker-lifetime `serviceScope`. The gate must authorize
  // the narrow allowlist of company-scoped methods that cannot widen reach
  // beyond a host-pinned dispatch — createComment is entity-cross-checked
  // server-side (requireInCompany); company state is the plugin's own data.
  function makeHandlers() {
    const createComment = vi.fn(async () => ({ id: "comment-1" }));
    const stateGet = vi.fn(async () => null);
    const stateSet = vi.fn(async () => undefined);
    const stateDelete = vi.fn(async () => undefined);
    const issuesList = vi.fn(async () => []);
    const services = {
      issues: { createComment, list: issuesList },
      state: { get: stateGet, set: stateSet, delete: stateDelete },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.messenger",
      capabilities: [
        "issue.comments.create",
        "issues.read",
        "plugin.state.read",
        "plugin.state.write",
      ],
      services,
    });
    return { handlers, createComment, stateGet, stateSet, stateDelete, issuesList };
  }

  it("allows issues.createComment under serviceScope (poll loop, no active dispatch)", async () => {
    const { handlers, createComment } = makeHandlers();
    const params = { issueId: "issue-1", body: "operator reply", companyId: "company-a" };

    await expect(
      handlers["issues.createComment"](params as never, {
        serviceScope: { runId: "service-run-1" },
      }),
    ).resolves.toEqual({ id: "comment-1" });
    expect(createComment).toHaveBeenCalledWith(params);
  });

  it("allows company-scoped state get/set/delete under serviceScope (plugin's own data)", async () => {
    const { handlers, stateGet, stateSet, stateDelete } = makeHandlers();
    const ctx = { serviceScope: { runId: "service-run-1" } };

    await expect(
      handlers["state.get"](
        { scopeKind: "company", scopeId: "company-a", stateKey: "open" } as never,
        ctx,
      ),
    ).resolves.toBeNull();
    await expect(
      handlers["state.set"](
        { scopeKind: "company", scopeId: "company-a", stateKey: "open", value: { x: 1 } } as never,
        ctx,
      ),
    ).resolves.toBeUndefined();
    await expect(
      handlers["state.delete"](
        { scopeKind: "company", scopeId: "company-a", stateKey: "open" } as never,
        ctx,
      ),
    ).resolves.toBeUndefined();
    expect(stateGet).toHaveBeenCalledTimes(1);
    expect(stateSet).toHaveBeenCalledTimes(1);
    expect(stateDelete).toHaveBeenCalledTimes(1);
  });

  it("fails closed for issues.createComment with NO scope at all", async () => {
    const { handlers, createComment } = makeHandlers();
    const params = { issueId: "issue-1", body: "x", companyId: "company-a" };

    await expect(
      handlers["issues.createComment"](params as never, {}),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    await expect(
      handlers["issues.createComment"](params as never),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(createComment).not.toHaveBeenCalled();
  });

  it("allows issues.createComment under serviceScope even when base context reports invalidInvocationScope (inbound relay)", async () => {
    // The live inbound path — an operator reply routed through
    // onWebhook/getUpdates — produces a worker→host createComment whose base
    // context is `invalidInvocationScope` (no resolvable dispatch id). The
    // serviceScope allowlist bypass must reach this call: placing the invalid-scope
    // throw first (the fork.16 bug) made the bypass dead code for the only path
    // it exists to serve. The grant is reach-bounded (server-side
    // requireInCompany) and identical to the scope-less `{}` case already
    // authorized above.
    const { handlers, createComment } = makeHandlers();
    const params = { issueId: "issue-1", body: "operator reply", companyId: "company-a" };

    await expect(
      handlers["issues.createComment"](params as never, {
        invalidInvocationScope: true,
        serviceScope: { runId: "service-run-1" },
      }),
    ).resolves.toEqual({ id: "comment-1" });
    expect(createComment).toHaveBeenCalledWith(params);
  });

  it("still fails closed for a NON-allowlisted company-scoped method under invalidInvocationScope + serviceScope (issues.list)", async () => {
    // This bypass must NOT widen beyond SERVICE_SCOPE_COMPANY_METHODS.
    // issues.list trusts companyId as the sole authority (no entity
    // cross-check), so the invalid-scope rejection retains full force for it
    // even with a valid serviceScope present — this is where the throw's
    // protective value lives.
    const { handlers, issuesList } = makeHandlers();

    await expect(
      handlers["issues.list"](
        { companyId: "company-a" } as never,
        {
          invalidInvocationScope: true,
          serviceScope: { runId: "service-run-1" },
        },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(issuesList).not.toHaveBeenCalled();
  });

  it("keeps strict company enforcement when an active dispatch pins a different company", async () => {
    // serviceScope never relaxes a *pinned* dispatch: createComment for
    // company-b while company-a is pinned is still denied. The relaxation only
    // applies when there is no pinned company at all.
    const { handlers, createComment } = makeHandlers();

    await expect(
      handlers["issues.createComment"](
        { issueId: "issue-1", body: "x", companyId: "company-b" } as never,
        {
          invocationScope: { companyId: "company-a" },
          serviceScope: { runId: "service-run-1" },
        },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(createComment).not.toHaveBeenCalled();
  });

  it("does NOT extend the allowance to entity-listing reads that trust companyId alone (issues.list)", async () => {
    // issues.list filters by companyId with no caller-supplied entity to
    // cross-check, so a worker-forged companyId would enumerate an arbitrary
    // tenant's issues. It is deliberately excluded from the allowlist and must
    // fail closed under serviceScope.
    const { handlers, issuesList } = makeHandlers();

    await expect(
      handlers["issues.list"](
        { companyId: "company-a" } as never,
        { serviceScope: { runId: "service-run-1" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(issuesList).not.toHaveBeenCalled();
  });
});

describe("createHostClientHandlers issues.resolveInteraction capability + serviceScope", () => {
  // The messenger auto-resolves the interaction an operator answered by free
  // text, from its inbound relay path (no active dispatch → bare serviceScope).
  // The resolve is default-deny (issue.interactions.resolve, messenger-only) and
  // shares createComment's entity-cross-checked reach argument, so it is on the
  // SERVICE_SCOPE_COMPANY_METHODS allowlist.
  function makeHandlers(capabilities: string[]) {
    const resolveInteraction = vi.fn(async () => ({ id: "interaction-1", status: "expired" }));
    const services = {
      issues: { resolveInteraction },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.messenger",
      capabilities: capabilities as never,
      services,
    });
    return { handlers, resolveInteraction };
  }

  const params = {
    issueId: "issue-1",
    companyId: "company-a",
    interactionId: "interaction-1",
    supersedingCommentId: "comment-1",
  };

  it("denies resolveInteraction when the plugin lacks issue.interactions.resolve (default-deny)", async () => {
    const { handlers, resolveInteraction } = makeHandlers([]);

    await expect(
      handlers["issues.resolveInteraction"](
        params as never,
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toMatchObject({
      name: "CapabilityDeniedError",
      message: expect.stringContaining("issue.interactions.resolve"),
    });
    await expect(
      handlers["issues.resolveInteraction"](
        params as never,
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(resolveInteraction).not.toHaveBeenCalled();
  });

  it("allows the granted plugin to resolveInteraction under an active dispatch", async () => {
    const { handlers, resolveInteraction } = makeHandlers(["issue.interactions.resolve"]);

    await expect(
      handlers["issues.resolveInteraction"](
        params as never,
        { invocationScope: { companyId: "company-a" } },
      ),
    ).resolves.toEqual({ id: "interaction-1", status: "expired" });
    expect(resolveInteraction).toHaveBeenCalledWith(params);
  });

  it("allows resolveInteraction under serviceScope (inbound relay, no active dispatch)", async () => {
    const { handlers, resolveInteraction } = makeHandlers(["issue.interactions.resolve"]);

    await expect(
      handlers["issues.resolveInteraction"](params as never, {
        serviceScope: { runId: "service-run-1" },
      }),
    ).resolves.toEqual({ id: "interaction-1", status: "expired" });
    expect(resolveInteraction).toHaveBeenCalledWith(params);
  });

  it("keeps strict company enforcement when an active dispatch pins a different company", async () => {
    const { handlers, resolveInteraction } = makeHandlers(["issue.interactions.resolve"]);

    await expect(
      handlers["issues.resolveInteraction"](
        { ...params, companyId: "company-b" } as never,
        {
          invocationScope: { companyId: "company-a" },
          serviceScope: { runId: "service-run-1" },
        },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(resolveInteraction).not.toHaveBeenCalled();
  });
});

describe("createHostClientHandlers reconcile reads", () => {
  // The messenger digest seeds/reconciles its pending-blocker set on worker
  // startup via the FORK-ONLY surfaces: `approvals.listPending` (pending-only,
  // provisioning-gated) and `interactions.list`. Upstream's general
  // `approvals.list` read is back to its upstream shape: a plain
  // company-scope-guarded read with NO serviceScope allowance and NO
  // bridge-level companyId requirement — the reconcile contract moved off it.
  function makeHandlers(capabilities: string[] = ["board.approvals.read", "issue.interactions.read"]) {
    const approvalsList = vi.fn(async () => []);
    const interactionsList = vi.fn(async () => []);
    const services = {
      approvals: { list: approvalsList },
      interactions: { list: interactionsList },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.messenger",
      capabilities: capabilities as never,
      services,
    });
    return { handlers, approvalsList, interactionsList };
  }

  it("rejects approvals.list when the plugin lacks board.approvals.read", async () => {
    const { handlers, approvalsList } = makeHandlers([]);
    await expect(
      handlers["approvals.list"](
        { companyId: "company-a" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(approvalsList).not.toHaveBeenCalled();
  });

  it("rejects interactions.list when the plugin lacks issue.interactions.read", async () => {
    const { handlers, interactionsList } = makeHandlers([]);
    await expect(
      handlers["interactions.list"](
        { companyId: "company-a" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(interactionsList).not.toHaveBeenCalled();
  });

  it("authorizes interactions.list — but NOT upstream's approvals.list — under serviceScope", async () => {
    // Fork-only reconcile contract (decision item 2): `interactions.list`
    // keeps its serviceScope allowance with a per-method safety argument
    // (entity cross-checked server-side); `approvals.list` does NOT — the
    // pending-blocker snapshot moved to `approvals.listPending`, so upstream's
    // general read keeps upstream's strict company-context semantics.
    const { handlers, approvalsList, interactionsList } = makeHandlers();
    const ctx = { serviceScope: { runId: "service-run-1" } };

    await expect(
      handlers["approvals.list"]({ companyId: "company-a" }, ctx),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });
    expect(approvalsList).not.toHaveBeenCalled();
    await expect(
      handlers["interactions.list"]({ companyId: "company-a" }, ctx),
    ).resolves.toEqual([]);
    expect(interactionsList).toHaveBeenCalledWith({ companyId: "company-a" });
  });

  it("hard-rejects a missing/empty companyId at the bridge even under serviceScope", async () => {
    const { handlers, approvalsList, interactionsList } = makeHandlers();
    const ctx = { serviceScope: { runId: "service-run-1" } };

    // Missing companyId maps to scope kind "none", which would otherwise slip
    // the invocation-scope check entirely — the handler's own guard must catch
    // it so no single call can run without a concrete target company. This is
    // the bridge contract of the FORK-ONLY reads (`approvals.listPending`,
    // `interactions.list`). Upstream's `approvals.list` has no such
    // requirement (kind "none" passes its generic guard untouched, exactly as
    // upstream wrote it) — the reconcile contract no longer rides on it.
    await expect(
      handlers["approvals.list"]({} as never, ctx),
    ).resolves.toEqual([]);
    await expect(
      handlers["approvals.listPending"]({} as never, ctx),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    await expect(
      handlers["approvals.listPending"]({ companyId: "  " } as never, ctx),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    await expect(
      handlers["interactions.list"]({} as never, ctx),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(approvalsList).toHaveBeenCalledWith({});
    expect(interactionsList).not.toHaveBeenCalled();
  });

  it("keeps strict company enforcement when an active dispatch pins a different company", async () => {
    const { handlers, approvalsList } = makeHandlers();
    await expect(
      handlers["approvals.list"](
        { companyId: "company-b" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(approvalsList).not.toHaveBeenCalled();
  });
});
