import { describe, expect, it, vi } from "vitest";

import type { HostServices, CrossCompanyReadAuditEvent } from "../src/host-client-factory.js";
import {
  CROSS_COMPANY_READ_METHODS,
  createHostClientHandlers,
  InvocationScopeDeniedError,
} from "../src/host-client-factory.js";
import type { WorkerHostCallContext } from "../src/protocol.js";

const OWN = "company-a";
const FOREIGN = "company-b";

function makeServices() {
  const rows = [{ id: OWN }, { id: FOREIGN }];
  return {
    companies: { list: vi.fn(async () => rows), get: vi.fn(async () => ({ id: FOREIGN })) },
    issues: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
      createComment: vi.fn(async () => ({})),
    },
    agents: { list: vi.fn(async () => []), get: vi.fn(async () => null), pause: vi.fn(async () => ({})) },
    projects: { list: vi.fn(async () => []) },
  } as unknown as HostServices & Record<string, Record<string, ReturnType<typeof vi.fn>>>;
}

function make(opts: { allowed?: boolean; caps?: string[]; audit?: (e: CrossCompanyReadAuditEvent) => void } = {}) {
  const services = makeServices();
  const handlers = createHostClientHandlers({
    pluginId: "platform.fleet-reader",
    capabilities: (opts.caps ?? [
      "companies.read",
      "companies.cross-read",
      "issues.read",
      "issues.update",
      "issue.comments.create",
      "agents.read",
      "agents.pause",
      "projects.read",
    ]) as never,
    services,
    crossCompanyReadAllowed: opts.allowed ?? true,
    onCrossCompanyRead: opts.audit,
  });
  return { services, handlers };
}

const toolCtx: WorkerHostCallContext = {
  invocationScope: { companyId: OWN, agentId: "agent-1", runId: "run-1" },
  invocationDispatchMethod: "executeTool",
};

// One foreign-company call per frozen read method.
const READS: Array<[string, Record<string, unknown>]> = [
  ["companies.get", { companyId: FOREIGN }],
  ["issues.list", { companyId: FOREIGN }],
  ["issues.get", { companyId: FOREIGN, issueId: "i-1" }],
  ["agents.list", { companyId: FOREIGN }],
  ["agents.get", { companyId: FOREIGN, agentId: "a-1" }],
];

async function call(h: Record<string, unknown>, m: string, p: unknown, c?: WorkerHostCallContext) {
  return (h[m] as (p: unknown, c?: WorkerHostCallContext) => Promise<unknown>)(p, c);
}

describe("companies.cross-read exemption (real factory gate)", () => {
  it("C1: the method set is exactly the 6 frozen reads", () => {
    expect(new Set(CROSS_COMPANY_READ_METHODS)).toEqual(
      new Set(["companies.list", "companies.get", "issues.list", "issues.get", "agents.list", "agents.get"]),
    );
    expect(CROSS_COMPANY_READ_METHODS).toHaveLength(6);
    expect(Object.isFrozen(CROSS_COMPANY_READ_METHODS)).toBe(true);
    expect(CROSS_COMPANY_READ_METHODS).not.toContain("issue.comments.list");
  });

  it("allowlisted + capability + executeTool dispatch: the 6 reads reach a foreign company and are audited", async () => {
    const audit = vi.fn();
    const { handlers, services } = make({ audit });
    for (const [m, p] of READS) await call(handlers, m, p, toolCtx);
    const listed = await call(handlers, "companies.list", {}, toolCtx);
    expect(listed).toEqual([{ id: OWN }, { id: FOREIGN }]);
    // C4: foreign companyId is passed down unchanged to the row-checked service.
    expect((services as any).issues.get).toHaveBeenCalledWith({ companyId: FOREIGN, issueId: "i-1" });
    const methods = audit.mock.calls.map(([e]) => e.method);
    expect(new Set(methods)).toEqual(new Set(CROSS_COMPANY_READ_METHODS));
    const e = audit.mock.calls.find(([x]) => x.method === "issues.get")![0];
    expect(e).toEqual({
      pluginId: "platform.fleet-reader",
      method: "issues.get",
      targetCompanyId: FOREIGN,
      invocationCompanyId: OWN,
      agentId: "agent-1",
      runId: "run-1",
    });
  });

  const denyCases: Array<[string, Parameters<typeof make>[0], WorkerHostCallContext | undefined]> = [
    ["no capability", { caps: ["companies.read", "issues.read", "agents.read"] }, toolCtx],
    ["not in operator allowlist", { allowed: false }, toolCtx],
    ["non-tool dispatch (performAction)", {}, { ...toolCtx, invocationDispatchMethod: "performAction" }],
    ["background dispatch (onEvent)", {}, { ...toolCtx, invocationDispatchMethod: "onEvent" }],
    ["no dispatch kind", {}, { invocationScope: toolCtx.invocationScope }],
    ["serviceScope only", {}, { serviceScope: { runId: "svc", companyId: null } } as never],
    ["no scope", {}, undefined],
    ["tampered/unknown invocation id", {}, { invalidInvocationScope: true }],
    ["invalid scope even with a stray kind", {}, { invalidInvocationScope: true, invocationDispatchMethod: "executeTool" }],
    [
      "single-in-flight legacy attribution",
      {},
      { invalidInvocationScope: true, singleInFlightScope: toolCtx.invocationScope } as never,
    ],
  ];

  for (const [name, opts, ctx] of denyCases) {
    it(`denies foreign reads: ${name}`, async () => {
      const audit = vi.fn();
      const { handlers } = make({ ...opts, audit });
      for (const [m, p] of READS) {
        await expect(call(handlers, m, p, ctx)).rejects.toBeInstanceOf(Error);
      }
      expect(audit).not.toHaveBeenCalled();
    });
  }

  it("companies.list stays filtered without the exemption", async () => {
    const { handlers } = make({ allowed: false });
    await expect(call(handlers, "companies.list", {}, toolCtx)).resolves.toEqual([{ id: OWN }]);
  });

  it("writes and non-set methods with a foreign companyId are denied even when admitted", async () => {
    const { handlers, services } = make();
    for (const [m, p] of [
      ["issues.update", { companyId: FOREIGN, issueId: "i", patch: {} }],
      ["issues.createComment", { companyId: FOREIGN, issueId: "i", body: "x" }],
      ["agents.pause", { companyId: FOREIGN, agentId: "a" }],
      ["projects.list", { companyId: FOREIGN }],
    ] as const) {
      if (!(m in handlers)) continue;
      await expect(call(handlers, m, p, toolCtx)).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    }
    expect((services as any).issues.update).not.toHaveBeenCalled();
    expect((services as any).agents.pause).not.toHaveBeenCalled();
  });
});
