import { describe, expect, it, vi } from "vitest";

import type { HostServices } from "../src/host-client-factory.js";
import {
  CapabilityDeniedError,
  createHostClientHandlers,
  InvocationScopeDeniedError,
  SERVICE_SCOPE_COMPANY_METHODS,
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
    const declarations = vi.fn(async () => ({ value: 1 }));
    const services = {
      companies: { list: companiesList },
      localFolders: { declarations },
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
    // PLA-1819: `config.get` is no longer an example of this — it now carries
    // its own fail-closed company guard inside the handler body, so a
    // scope-less read is denied. Use a method with no tenant semantics at all.
    await expect(
      handlers["localFolders.declarations"](undefined as never, {}),
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

    expect(resolve).toHaveBeenCalledWith(
      // v722 plumbs the host-validated call context to HostServices as an
      // explicit second argument; the back-filled params stay the first.
      //
      // PLA-1819: `companyId` is injected from the host-derived pin. The
      // server's `buildHostServices.secrets.resolve` hard-requires it via
      // `ensureCompanyId`, so omitting it throws on every dispatch resolve.
      {
        secretRef: "11111111-1111-1111-1111-111111111111",
        runId: "run-xyz",
        companyId: "company-a",
      },
      { invocationScope: { companyId: "company-a", runId: "run-xyz" } },
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
      { invocationScope: { companyId: "company-a", runId: "run-xyz" } },
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

    // No runId on scope → no runId back-fill. The server-side handler will
    // still throw `runcontext_invalid`, which is the desired fail-closed
    // behaviour for an out-of-dispatch caller. `companyId` is still injected
    // (PLA-1819) because the scope pins a company even without a runId.
    expect(resolve).toHaveBeenCalledWith(
      {
        secretRef: "11111111-1111-1111-1111-111111111111",
        companyId: "company-a",
      },
      { invocationScope: { companyId: "company-a" } },
    );
  });

  it("back-fills runId on secrets.resolve from the service scope (PLA-768)", async () => {
    // A setup()-started loop (e.g. messenger getUpdates) or a background
    // dispatch resolves with NO dispatch in flight, so neither invocation nor
    // single-in-flight scope exists — only the host-minted service scope.
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
      { serviceScope: { runId: "service-run-1" } },
    );

    expect(resolve).toHaveBeenCalledWith(
      {
        secretRef: "11111111-1111-1111-1111-111111111111",
        runId: "service-run-1",
      },
      { serviceScope: { runId: "service-run-1" } },
    );
  });

  it("PLA-1819: injects the host-derived companyId so the v722 server wrapper accepts the call", async () => {
    // Regression for the defect that shipped in be872d0a4: the branch took
    // v722's fail-closed guard but declined to inject `companyId`, while v722's
    // `buildHostServices.secrets.resolve` began hard-requiring it via
    // `ensureCompanyId`. Half of a matched pair => every dispatch resolve threw
    // "companyId is required for this operation", the operator's messenger bot
    // token included. Assert the id actually reaches the service boundary.
    const resolve = vi.fn(async () => "resolved-value");
    const services = { secrets: { resolve } } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["secrets.read-ref"],
      services,
    });

    await handlers["secrets.resolve"](
      { secretRef: "11111111-1111-1111-1111-111111111111" } as never,
      { invocationScope: { companyId: "company-a", runId: "run-xyz" } },
    );

    const [params] = resolve.mock.calls[0] as [Record<string, unknown>];
    expect(params.companyId).toBe("company-a");
  });

  it("PLA-1819: forwards the HOST pin, never the worker-echoed companyId", async () => {
    // A worker that echoes the *correct* company clears the guard's equality
    // check. The value forwarded downstream must still be the host-derived pin
    // — spread last — so params can never become an authority channel even
    // when the two happen to agree today.
    const resolve = vi.fn(async () => "resolved-value");
    const services = { secrets: { resolve } } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["secrets.read-ref"],
      services,
    });

    await handlers["secrets.resolve"](
      {
        secretRef: "11111111-1111-1111-1111-111111111111",
        companyId: "company-a",
      } as never,
      { invocationScope: { companyId: "company-a", runId: "run-xyz" } },
    );

    const [params] = resolve.mock.calls[0] as [Record<string, unknown>];
    expect(params.companyId).toBe("company-a");

    // And a worker naming a DIFFERENT company is still denied outright.
    await expect(
      handlers["secrets.resolve"](
        {
          secretRef: "11111111-1111-1111-1111-111111111111",
          companyId: "company-b",
        } as never,
        { invocationScope: { companyId: "company-a", runId: "run-xyz" } },
      ),
    ).rejects.toThrow(/company/i);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("PLA-1819: omits companyId entirely on the PLA-768 service path", async () => {
    // The service context carries NO company (`RegisteredServiceRunContext` has
    // only `runId`), so there is nothing to inject. The absence is what selects
    // the server wrapper's pass-through branch, where the secrets handler
    // derives the owning company from the operator-created binding. Injecting a
    // guessed or defaulted id here would be a tenancy bug.
    const resolve = vi.fn(async () => "resolved-value");
    const services = { secrets: { resolve } } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["secrets.read-ref"],
      services,
    });

    await handlers["secrets.resolve"](
      { secretRef: "11111111-1111-1111-1111-111111111111" } as never,
      { serviceScope: { runId: "service-run-1" } },
    );

    const [params] = resolve.mock.calls[0] as [Record<string, unknown>];
    expect(params).not.toHaveProperty("companyId");
  });

  it("PLA-1819: serviceScope does not let a worker NAME a company on secrets.resolve", async () => {
    // The PLA-768 carve-out above lets a scope-less `secrets.resolve` through
    // because `serviceScope.runId` is host-minted and the server re-derives the
    // company from (pluginDbId, runId). That must not become a way for the
    // worker to *choose* the tenant: a worker-supplied `companyId` still has no
    // host pin to be checked against, so it is denied outright.
    const resolve = vi.fn(async () => "unreachable");
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["secrets.read-ref"],
      services: { secrets: { resolve } } as unknown as HostServices,
    });

    await expect(
      handlers["secrets.resolve"](
        {
          companyId: "company-attacker",
          secretRef: "11111111-1111-1111-1111-111111111111",
        } as never,
        { serviceScope: { runId: "service-run-1" } },
      ),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });

    expect(resolve).not.toHaveBeenCalled();
  });

  it("PLA-1944: serviceScope with no dispatch pin defers config.get to the host-minted agreement gate", async () => {
    // `serviceScope` carries only a runId, with no company pin — a
    // `setup()`-time read or a background/poll loop has no active dispatch to
    // derive a tenant from. Historically (PLA-1819) that failed closed outright,
    // the same as `secrets.resolve` without a mapped runId. PLA-1944 adds a
    // narrower, read-only escape hatch: `resolveRequiredCompanyId` is passed
    // `context.serviceScope.runId` as its `alternateHostBinding` (mirroring
    // `secrets.resolve`'s PLA-768 pattern above) and returns `null` instead of
    // throwing, deferring resolution to `services.config.getAgreedOrDeny()` —
    // the host-minted agreement gate that checks every owning `plugin_config`
    // row and only ever resolves when they agree (see plugin-host-services.ts).
    const get = vi.fn(async () => ({ apiKey: "unreachable" }));
    const getForCompany = vi.fn(async () => ({ apiKey: "unreachable" }));
    const getAgreedOrDeny = vi.fn(async () => ({ resolvedVia: "agreement" }));
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: [],
      services: {
        config: { get, getForCompany, getAgreedOrDeny },
      } as unknown as HostServices,
    });

    await expect(
      handlers["config.get"](undefined as never, {
        serviceScope: { runId: "service-run-1" },
      }),
    ).resolves.toEqual({ resolvedVia: "agreement" });

    expect(getAgreedOrDeny).toHaveBeenCalledTimes(1);
    expect(getAgreedOrDeny).toHaveBeenCalledWith();
    expect(get).not.toHaveBeenCalled();
    expect(getForCompany).not.toHaveBeenCalled();
  });

  it("PLA-1944: config.get fails closed on serviceScope-only calls when the host doesn't implement the agreement gate", async () => {
    // A host that hasn't been upgraded to expose `getAgreedOrDeny` must keep
    // denying a no-dispatch read rather than silently falling through to an
    // unscoped one.
    const get = vi.fn(async () => ({ apiKey: "unreachable" }));
    const getForCompany = vi.fn(async () => ({ apiKey: "unreachable" }));
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: [],
      services: { config: { get, getForCompany } } as unknown as HostServices,
    });

    await expect(
      handlers["config.get"](undefined as never, {
        serviceScope: { runId: "service-run-1" },
      }),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("does not support the no-dispatch agreement gate"),
    });

    expect(get).not.toHaveBeenCalled();
    expect(getForCompany).not.toHaveBeenCalled();
  });

  it("C3/PLA-1944: config.get is NOT on the SERVICE_SCOPE_COMPANY_METHODS allowlist — a worker-forged companyId with only a serviceScope still denies", async () => {
    // `SERVICE_SCOPE_COMPANY_METHODS` lets a narrow set of methods accept a
    // worker-named companyId under a bare serviceScope (no active dispatch)
    // because each has its own entity-level reach check downstream. config.get
    // was deliberately left off that list (C3): it has no per-call entity to
    // cross-check, so a worker-named companyId here has nothing to validate
    // against. This must keep failing BEFORE the handler body — and therefore
    // before the PLA-1944 agreement gate — ever runs, regardless of whether the
    // host implements getAgreedOrDeny.
    const get = vi.fn(async () => ({ apiKey: "unreachable" }));
    const getForCompany = vi.fn(async () => ({ apiKey: "unreachable" }));
    const getAgreedOrDeny = vi.fn(async () => ({ apiKey: "unreachable" }));
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: [],
      services: {
        config: { get, getForCompany, getAgreedOrDeny },
      } as unknown as HostServices,
    });

    await expect(
      handlers["config.get"](
        { companyId: "company-attacker" } as never,
        { serviceScope: { runId: "service-run-1" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);

    expect(get).not.toHaveBeenCalled();
    expect(getForCompany).not.toHaveBeenCalled();
    expect(getAgreedOrDeny).not.toHaveBeenCalled();
  });

  it("C3/PLA-1944: config.get remains absent from SERVICE_SCOPE_COMPANY_METHODS", () => {
    // Direct guard against a future PR reintroducing config.get here. The
    // behavioral test above happens to still pass even if this membership
    // regresses (resolveRequiredCompanyId independently denies a
    // worker-forged companyId with no host-derived pin), so it alone would
    // not catch that regression — assert the set membership itself.
    expect(SERVICE_SCOPE_COMPANY_METHODS.has("config.get")).toBe(false);
  });

  it("prefers an active dispatch runId over the service scope (PLA-768)", async () => {
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
        // PLA-1819: the dispatch pin also supplies the injected companyId, so
        // the resolve is attributed to the dispatching company, not the
        // service context's binding-derived owner.
        companyId: "company-a",
      },
      {
        invocationScope: { companyId: "company-a", runId: "dispatch-run" },
        serviceScope: { runId: "service-run-1" },
      },
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

describe("createHostClientHandlers artifacts.create capability gate (PLA-888)", () => {
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

describe("createHostClientHandlers config.get per-company scope selection (PLA-761)", () => {
  // id-less legacy workers (e.g. platform.cad ≤0.1.x) never echo a
  // `paperclipInvocationId`, so `invocationScope` is null. PLA-719 gave the host
  // a `singleInFlightScope` (the sole in-flight dispatch's company, host-derived)
  // and wired secrets.resolve/artifacts.fetch to consult it — but config.get was
  // left reading only `invocationScope`, so it fell through to the instance-wide
  // config and handed DPR Platform's secret ref. These tests pin the fix.

  function makeConfigHandlers() {
    const getForCompany = vi.fn(async (companyId: string) => ({
      githubPatSecretId: `secret-for-${companyId}`,
    }));
    const get = vi.fn(async () => ({ githubPatSecretId: "instance-wide-secret" }));
    const services = {
      config: { get, getForCompany },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: [],
      services,
    });
    return { handlers, get, getForCompany };
  }

  it("delegates to getForCompany using singleInFlightScope when the worker echoed no invocation id", async () => {
    const { handlers, get, getForCompany } = makeConfigHandlers();

    await expect(
      handlers["config.get"](undefined as never, {
        invocationScope: null,
        singleInFlightScope: { companyId: "company-dpr" },
      }),
    ).resolves.toEqual({ githubPatSecretId: "secret-for-company-dpr" });

    expect(getForCompany).toHaveBeenCalledWith("company-dpr");
    expect(get).not.toHaveBeenCalled();
  });

  it("prefers invocationScope over singleInFlightScope when both are present", async () => {
    const { handlers, getForCompany } = makeConfigHandlers();

    await handlers["config.get"](undefined as never, {
      invocationScope: { companyId: "company-a" },
      singleInFlightScope: { companyId: "company-b" },
    });

    expect(getForCompany).toHaveBeenCalledWith("company-a");
    expect(getForCompany).not.toHaveBeenCalledWith("company-b");
  });

  it("fails closed with no scope (0 or 2+ in-flight dispatches → no singleInFlightScope)", async () => {
    const { handlers, get, getForCompany } = makeConfigHandlers();

    // PLA-1819: this used to fall through to the instance-wide `get()`. Since
    // v2026.722.0 `plugin_config.company_id` is NOT NULL — there is no
    // instance-wide row, and the host's own handler returns `{}` here. Handing
    // a plugin `{}` makes it read `config.apiKey` as `undefined` and proceed
    // unauthenticated, converting a host-side denial into a plugin-side
    // fail-open. Deny instead (upstream v722's control).
    await expect(
      handlers["config.get"](undefined as never, {}),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });

    expect(get).not.toHaveBeenCalled();
    expect(getForCompany).not.toHaveBeenCalled();
  });

  it("a worker cannot name an arbitrary tenant via a forged companyId param — fails closed", async () => {
    const { handlers, get, getForCompany } = makeConfigHandlers();

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

    expect(getForCompany).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("falls back to get() when the host implements no per-company delivery", async () => {
    const get = vi.fn(async () => ({ githubPatSecretId: "instance-wide-secret" }));
    const services = {
      config: { get },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: [],
      services,
    });

    await expect(
      handlers["config.get"](undefined as never, {
        singleInFlightScope: { companyId: "company-dpr" },
      }),
    ).resolves.toEqual({ githubPatSecretId: "instance-wide-secret" });
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("createHostClientHandlers events.subscribe serviceScope (PLA-810)", () => {
  // A single-company plugin sets its `topicMap`, so its `setup()` loop
  // subscribes with a per-company `filter` instead of unfiltered. There is no
  // active dispatch at `setup()`, so the only host-validated context is the
  // worker-lifetime `serviceScope` (PLA-768). The gate must authorize this
  // narrower filtered subscribe — denying it (the pre-PLA-810 bug) regressed the
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

  it("allows a company-filtered subscribe at setup() under serviceScope (no active dispatch)", async () => {
    const { handlers, subscribe } = makeEventsHandlers();
    const params = {
      eventPattern: "issue.created",
      filter: { companyId: "company-a" },
    };

    await expect(
      handlers["events.subscribe"](params as never, {
        serviceScope: { runId: "service-run-1" },
      }),
    ).resolves.toBeUndefined();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(params);
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

  it("allows a company-filtered subscribe under serviceScope even when base context reports invalidInvocationScope (PLA-818)", async () => {
    const { handlers, subscribe } = makeEventsHandlers();
    const params = {
      eventPattern: "issue.created",
      filter: { companyId: "company-a" },
    };

    // PLA-818: the inbound relay path (onWebhook / getUpdates callback with no
    // resolvable dispatch id) resolves to `invalidInvocationScope` in the host's
    // base context. For an allowlisted, reach-checked method carrying a valid
    // serviceScope this must be authorized — the allowlist bypass is an
    // exception to the invalid-scope rejection. It grants no reach beyond the
    // scope-less `{}` case already allowed (events.subscribe is company-filtered
    // and the filter is reach-checked server-side).
    await expect(
      handlers["events.subscribe"](params as never, {
        invalidInvocationScope: true,
        serviceScope: { runId: "service-run-1" },
      }),
    ).resolves.toBeUndefined();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(params);
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

describe("createHostClientHandlers serviceScope company writes/state (PLA-814)", () => {
  // Inbound sibling of PLA-810: the messenger `getUpdates` poll loop is started
  // in `setup()` and runs with no active dispatch, so an operator reply it
  // routes calls `issues.createComment` (and reads company-scoped state) under
  // the bare worker-lifetime `serviceScope` (PLA-768). The gate must authorize
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

  it("allows issues.createComment under serviceScope even when base context reports invalidInvocationScope (PLA-818 inbound relay)", async () => {
    // PLA-818: the live inbound path — an operator reply routed through
    // onWebhook/getUpdates — produces a worker→host createComment whose base
    // context is `invalidInvocationScope` (no resolvable dispatch id). The
    // PLA-814 allowlist bypass must reach this call: placing the invalid-scope
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
    // PLA-818 must NOT widen the bypass beyond SERVICE_SCOPE_COMPANY_METHODS.
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

describe("createHostClientHandlers issues.resolveInteraction capability + serviceScope (PLA-1438 Part A)", () => {
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

describe("createHostClientHandlers reconcile reads (PLA-923)", () => {
  // The messenger digest seeds/reconciles its pending-blocker set on worker
  // startup by reading the authoritative live set. These reads run from a
  // setup()-started context with no active dispatch, so they must be authorized
  // under the bare serviceScope (SERVICE_SCOPE_COMPANY_METHODS) — but, unlike a
  // host-pinned dispatch, the worker chooses the companyId, so the bridge hard-
  // rejects a missing/empty companyId (the server gate is the second layer).
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

  it("allows both reconcile reads under serviceScope (worker-startup reconcile, no active dispatch)", async () => {
    const { handlers, approvalsList, interactionsList } = makeHandlers();
    const ctx = { serviceScope: { runId: "service-run-1" } };

    await expect(
      handlers["approvals.list"]({ companyId: "company-a" }, ctx),
    ).resolves.toEqual([]);
    await expect(
      handlers["interactions.list"]({ companyId: "company-a" }, ctx),
    ).resolves.toEqual([]);
    expect(approvalsList).toHaveBeenCalledWith({ companyId: "company-a" });
    expect(interactionsList).toHaveBeenCalledWith({ companyId: "company-a" });
  });

  it("hard-rejects a missing/empty companyId at the bridge even under serviceScope", async () => {
    const { handlers, approvalsList, interactionsList } = makeHandlers();
    const ctx = { serviceScope: { runId: "service-run-1" } };

    // Missing companyId maps to scope kind "none", which would otherwise slip
    // the invocation-scope check entirely — the handler's own guard must catch
    // it so no single call can run without a concrete target company.
    await expect(
      handlers["approvals.list"]({} as never, ctx),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    await expect(
      handlers["approvals.list"]({ companyId: "  " } as never, ctx),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    await expect(
      handlers["interactions.list"]({} as never, ctx),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(approvalsList).not.toHaveBeenCalled();
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
