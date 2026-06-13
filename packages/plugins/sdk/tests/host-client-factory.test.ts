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

    expect(resolve).toHaveBeenCalledWith({
      secretRef: "11111111-1111-1111-1111-111111111111",
      runId: "service-run-1",
    });
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

    expect(resolve).toHaveBeenCalledWith({
      secretRef: "11111111-1111-1111-1111-111111111111",
      runId: "dispatch-run",
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

describe("createHostClientHandlers issues.listAttachments capability gate (PLA-1050)", () => {
  const params = { issueId: "issue-1", companyId: "company-a" };
  const scope = { invocationScope: { companyId: "company-a", runId: "run-xyz" } };

  it("denies issues.listAttachments when the plugin lacks issue.attachments.read", async () => {
    const listAttachments = vi.fn(async () => []);
    const services = {
      issues: { listAttachments },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: [],
      services,
    });

    await expect(
      handlers["issues.listAttachments"](params as never, scope),
    ).rejects.toMatchObject({
      name: "CapabilityDeniedError",
      message: expect.stringContaining("issue.attachments.read"),
    });
    await expect(
      handlers["issues.listAttachments"](params as never, scope),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(listAttachments).not.toHaveBeenCalled();
  });

  it("allows issues.listAttachments and passes through when the capability is granted", async () => {
    const rows = [
      {
        id: "att-1",
        companyId: "company-a",
        issueId: "issue-1",
        issueCommentId: "comment-1",
        assetId: "asset-1",
        contentType: "image/png",
        byteSize: 1234,
        originalFilename: "shot.png",
        createdAt: new Date("2026-06-13T00:00:00.000Z"),
      },
    ];
    const listAttachments = vi.fn(async () => rows);
    const services = {
      issues: { listAttachments },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issue.attachments.read"],
      services,
    });

    await expect(
      handlers["issues.listAttachments"](params as never, scope),
    ).resolves.toEqual(rows);
    expect(listAttachments).toHaveBeenCalledWith(params);
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

  it("falls back to instance-wide get() with no scope (0 or 2+ in-flight dispatches → no singleInFlightScope)", async () => {
    const { handlers, get, getForCompany } = makeConfigHandlers();

    await expect(
      handlers["config.get"](undefined as never, {}),
    ).resolves.toEqual({ githubPatSecretId: "instance-wide-secret" });

    expect(get).toHaveBeenCalledTimes(1);
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
