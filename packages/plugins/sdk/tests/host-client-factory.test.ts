import { describe, expect, it, vi } from "vitest";

import type { HostServices } from "../src/host-client-factory.js";
import {
  CapabilityDeniedError,
  createHostClientHandlers,
  InvocationScopeDeniedError,
} from "../src/host-client-factory.js";
import { PLUGIN_RPC_ERROR_CODES } from "../src/protocol.js";

describe("createHostClientHandlers invocation company scope", () => {
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
    // A genuinely no-companyId method (kind "none") still passes with no scope.
    await expect(
      handlers["config.get"](undefined as never, {}),
    ).resolves.toEqual({ value: 1 });
  });
});

describe("createHostClientHandlers dispatch runId back-fill (PLA-673)", () => {
  // Pre-PLA-657 SDK plugins (e.g. cad-0.1.7) call `ctx.secrets.resolve(secretRef)`
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

    expect(resolve).toHaveBeenCalledWith({
      secretRef: "11111111-1111-1111-1111-111111111111",
      runId: "run-xyz",
    });
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

    expect(resolve).toHaveBeenCalledWith({
      secretRef: "11111111-1111-1111-1111-111111111111",
      runId: "worker-supplied-run",
    });
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

    // No runId on scope → we pass through unchanged. The server-side handler
    // will still throw `runcontext_invalid`, which is the desired fail-closed
    // behaviour for an out-of-dispatch caller.
    expect(resolve).toHaveBeenCalledWith({
      secretRef: "11111111-1111-1111-1111-111111111111",
    });
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
});

describe("createHostClientHandlers — singleInFlightScope cannot widen company scope (PLA-722)", () => {
  // PLA-719 added `context.singleInFlightScope` for the legacy runId back-fill
  // ONLY. `requireInvocationCompanyScope` governs tenant scope solely via
  // `invalidInvocationScope` + `invocationScope.companyId`; it must never read
  // `singleInFlightScope`. These tests pin that invariant directly so a future
  // refactor that starts consulting the field for company scope fails loudly.
  const SECRET_REF = "22222222-2222-2222-2222-222222222222";

  it("denies a different-company call even when singleInFlightScope names another company", async () => {
    const resolve = vi.fn(async () => "resolved-value");
    const services = { secrets: { resolve } } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["secrets.read-ref"],
      services,
    });

    const context = {
      invalidInvocationScope: true,
      singleInFlightScope: {
        companyId: "company-a",
        runId: "run-x",
        agentId: "agent-a",
      },
    };

    await expect(
      handlers["secrets.resolve"](
        { secretRef: SECRET_REF, companyId: "company-b" } as never,
        context,
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    await expect(
      handlers["secrets.resolve"](
        { secretRef: SECRET_REF, companyId: "company-b" } as never,
        context,
      ),
    ).rejects.toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
    });
    // Resolved against neither company-a (singleInFlightScope) nor company-b (params).
    expect(resolve).not.toHaveBeenCalled();
  });

  it("still back-fills runId from singleInFlightScope for the legacy no-companyId shape", async () => {
    const resolve = vi.fn(async () => "resolved-value");
    const services = { secrets: { resolve } } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["secrets.read-ref"],
      services,
    });

    // Same context as above, but the legacy `{ secretRef }` shape requests no
    // company, so the scope check is a no-op and the field serves its intended
    // purpose: back-filling the dispatch runId.
    await handlers["secrets.resolve"](
      { secretRef: SECRET_REF } as never,
      {
        invalidInvocationScope: true,
        singleInFlightScope: {
          companyId: "company-a",
          runId: "run-x",
          agentId: "agent-a",
        },
      },
    );

    expect(resolve).toHaveBeenCalledWith({
      secretRef: SECRET_REF,
      runId: "run-x",
    });
  });

  it("denies a company-scoped call that MATCHES singleInFlightScope when no invocationScope resolved", async () => {
    const resolve = vi.fn(async () => "resolved-value");
    const services = { secrets: { resolve } } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["secrets.read-ref"],
      services,
    });

    // Only singleInFlightScope is present — not flagged invalid, no invocationScope.
    // If requireInvocationCompanyScope ever fell back to singleInFlightScope for
    // the allowed company, this would resolve against company-a. It must fail
    // closed instead: this is the assertion that flips throw→resolve under a
    // widening refactor.
    await expect(
      handlers["secrets.resolve"](
        { secretRef: SECRET_REF, companyId: "company-a" } as never,
        {
          singleInFlightScope: {
            companyId: "company-a",
            runId: "run-x",
            agentId: "agent-a",
          },
        },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(resolve).not.toHaveBeenCalled();
  });
});
