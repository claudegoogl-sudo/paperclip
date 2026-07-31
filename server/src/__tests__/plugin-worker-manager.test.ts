import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { companies, createDb, plugins } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createHostClientHandlers,
  JsonRpcCallError,
  PLUGIN_RPC_ERROR_CODES,
  type HostServices,
  type HostToWorkerMethods,
} from "@paperclipai/plugin-sdk";
import {
  appendStderrExcerpt,
  createBoundedFrameReader,
  createPluginWorkerHandle,
  createPluginWorkerManager,
  formatWorkerFailureMessage,
  resolveMaxIpcFrameBytes,
} from "../services/plugin-worker-manager.js";
import { createPluginRunContextRegistry } from "../services/plugin-run-context-registry.js";
import {
  clearRunSecretValues,
  registerRunSecretValue,
  registeredRunCount,
} from "../run-secret-registry.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const DELAYED_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-delayed.cjs");
const INVOCATION_SCOPE_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-invocation-scope.cjs",
);
const LEGACY_SECRETS_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-legacy-secrets.cjs",
);
const NOID_SECRETS_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-noid-secrets.cjs",
);
const TERMINATED_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-terminated.cjs");
const STREAM_SCOPE_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-stream-scope.cjs",
);
const ONEVENT_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-onevent.cjs",
);
const INBOUND_COMMENT_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-inbound-comment.cjs",
);
const OVERSIZE_FRAME_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-oversize-frame.cjs",
);
const IPC_CHANNEL_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-ipc-channel.cjs",
);
const CONFIG_AGREEMENT_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-config-agreement.cjs",
);

const TEST_MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

describe("plugin-worker-manager stderr failure context", () => {
  it("appends worker stderr context to failure messages", () => {
    expect(
      formatWorkerFailureMessage(
        "Worker process exited (code=1, signal=null)",
        "TypeError: Unknown file extension \".ts\"",
      ),
    ).toBe(
      "Worker process exited (code=1, signal=null)\n\nWorker stderr:\nTypeError: Unknown file extension \".ts\"",
    );
  });

  it("does not duplicate stderr that is already present", () => {
    const message = [
      "Worker process exited (code=1, signal=null)",
      "",
      "Worker stderr:",
      "TypeError: Unknown file extension \".ts\"",
    ].join("\n");

    expect(
      formatWorkerFailureMessage(message, "TypeError: Unknown file extension \".ts\""),
    ).toBe(message);
  });

  it("keeps only the latest stderr excerpt", () => {
    let excerpt = "";
    excerpt = appendStderrExcerpt(excerpt, "first line");
    excerpt = appendStderrExcerpt(excerpt, "second line");

    expect(excerpt).toContain("first line");
    expect(excerpt).toContain("second line");

    excerpt = appendStderrExcerpt(excerpt, "x".repeat(9_000));

    expect(excerpt).not.toContain("first line");
    expect(excerpt).not.toContain("second line");
    expect(excerpt.length).toBeLessThanOrEqual(8_000);
  });

  it("times out environmentExecute calls using the handle default when no override is provided", async () => {
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: DELAYED_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: {},
      rpcTimeoutMs: 10,
    });

    try {
      await handle.start();

      await expect(handle.call("environmentExecute", {
        driverKey: "e2b",
        companyId: "company-1",
        environmentId: "environment-1",
        config: {},
        lease: { providerLeaseId: "lease-1" },
        command: "echo",
        delayMs: 50,
      } as HostToWorkerMethods["environmentExecute"][0])).rejects.toMatchObject({
        message: expect.stringContaining("timed out after 10ms"),
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("honors per-call timeout overrides for environmentExecute", async () => {
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: DELAYED_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: {},
      rpcTimeoutMs: 10,
    });

    try {
      await handle.start();

      await expect(handle.call("environmentExecute", {
        driverKey: "e2b",
        companyId: "company-1",
        environmentId: "environment-1",
        config: {},
        lease: { providerLeaseId: "lease-1" },
        command: "echo",
        delayMs: 50,
      } as HostToWorkerMethods["environmentExecute"][0], 100)).resolves.toMatchObject({
        exitCode: 0,
        stdout: "ok\n",
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("does not emit an unhandled rejection when a plugin responds with terminated before callers attach handlers", async () => {
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);

    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: TERMINATED_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: {},
    });

    try {
      await handle.start();

      const pendingCall = handle.call(
        "environmentExecute" as keyof HostToWorkerMethods,
        {
          driverKey: "e2b",
          companyId: "company-1",
          environmentId: "environment-1",
          config: {},
          lease: { providerLeaseId: "lease-1" },
          command: "echo",
        } as HostToWorkerMethods[keyof HostToWorkerMethods][0],
      );

      await new Promise((resolve) => setImmediate(resolve));

      await expect(pendingCall).rejects.toBeInstanceOf(JsonRpcCallError);
      await expect(pendingCall).rejects.toMatchObject({
        message: expect.stringContaining("terminated"),
      });
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
      await handle.stop().catch(() => undefined);
    }
  });

  it("passes performAction invocation scope to nested worker host calls", async () => {
    const companiesGet = vi.fn(async (
      params: { companyId: string },
      context?: { invocationScope?: { companyId?: string | null } | null },
    ) => ({
      id: params.companyId,
      scopedCompanyId: context?.invocationScope?.companyId ?? null,
    }));
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: {
        "companies.get": companiesGet as never,
      },
    });

    try {
      await handle.start();

      await expect(handle.call("performAction", {
        key: "probe",
        params: {
          mode: "echo",
          requestedCompanyId: "company-a",
        },
        actorContext: {
          type: "agent",
          userId: null,
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-a",
        },
        renderEnvironment: null,
      })).resolves.toEqual({
        id: "company-a",
        scopedCompanyId: "company-a",
      });
      // PLA-673: the invocation scope now carries the dispatching agent's
      // runId/agentId so worker→host callbacks (e.g. pre-PLA-657
      // `secrets.resolve({secretRef})`) can be back-filled by host-client-
      // factory. The values come from the host's `actorContext` and were
      // already on the wire — they're just exposed via scope now too.
      // PLA-768: the host-minted worker-lifetime service scope is also surfaced
      // on every worker→host call (the fallback runId for background/setup-loop
      // secrets.resolve). It never overrides an active dispatch scope.
      expect(companiesGet).toHaveBeenCalledWith(
        { companyId: "company-a" },
        {
          invocationScope: {
            companyId: "company-a",
            runId: "run-1",
            agentId: "agent-1",
          },
          serviceScope: { runId: expect.any(String) },
        },
      );
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("passes echoed invocation scope to worker-to-host handlers", async () => {
    const companiesGet = vi.fn(async () => ({ id: "company-1" }));
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: {
        "companies.get": companiesGet,
      },
    });

    try {
      await handle.start();

      await expect(handle.call("getData", {
        key: "probe",
        companyId: "company-1",
        params: {
          mode: "echo",
          requestedCompanyId: "company-1",
        },
      } as HostToWorkerMethods["getData"][0])).resolves.toEqual({ id: "company-1" });

      // PLA-768: service scope is always present alongside the echoed scope.
      expect(companiesGet).toHaveBeenCalledWith(
        { companyId: "company-1" },
        {
          invocationScope: { companyId: "company-1" },
          serviceScope: { runId: expect.any(String) },
        },
      );
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects performAction nested host calls that omit the invocation id", async () => {
    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["companies.read"],
      services: {
        companies: {
          list: vi.fn(async () => []),
          get: vi.fn(async (params: { companyId: string }) => ({ id: params.companyId })),
        },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: handlers,
    });

    try {
      await handle.start();

      await expect(handle.call("performAction", {
        key: "probe",
        params: {
          requestedCompanyId: "company-b",
        },
        actorContext: {
          type: "agent",
          userId: null,
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-a",
        },
        renderEnvironment: null,
      })).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        message: expect.stringContaining("unknown invocation scope"),
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects nested worker host calls that forge an unknown invocation id", async () => {
    const companiesGet = vi.fn(async (params: { companyId: string }) => ({ id: params.companyId }));
    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["companies.read"],
      services: {
        companies: {
          get: companiesGet,
        },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: handlers,
    });

    try {
      await handle.start();

      await expect(handle.call("performAction", {
        key: "probe",
        params: {
          mode: "unknown",
          requestedCompanyId: "company-a",
        },
        actorContext: {
          type: "agent",
          userId: null,
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-a",
        },
        renderEnvironment: null,
      })).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        message: expect.stringContaining("unknown invocation scope"),
      });
      expect(companiesGet).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects missing or unknown invocation ids while a company invocation is active", async () => {
    const companiesGet = vi.fn(async () => ({ id: "company-2" }));
    const hostHandlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["companies.read"],
      services: {
        companies: {
          get: companiesGet,
        },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers,
    });

    try {
      await handle.start();

      for (const mode of ["omit", "unknown"]) {
        await expect(handle.call("getData", {
          key: "probe",
          companyId: "company-1",
          params: {
            mode,
            requestedCompanyId: "company-2",
          },
        } as HostToWorkerMethods["getData"][0])).rejects.toMatchObject({
          code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        });
      }

      expect(companiesGet).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("drops company-scoped stream notifications with no resolvable invocation scope", async () => {
    const onStreamNotification = vi.fn();
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: STREAM_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: {},
      onStreamNotification,
    });

    try {
      await handle.start();

      // performAction with an empty actor companyId derives no invocation
      // scope, so the worker's stream notifications arrive with an empty host
      // context ({}). The fixture emits a company-scoped notification (dropped)
      // followed by a scope-less one (forwarded) so ordering is deterministic.
      await expect(handle.call("performAction", {
        key: "probe",
        params: {},
        actorContext: {
          type: "agent",
          userId: null,
          agentId: "agent-1",
          runId: "run-1",
          companyId: "",
        },
        renderEnvironment: null,
      })).resolves.toEqual({ ok: true });

      const channels = onStreamNotification.mock.calls.map(
        ([, params]) => (params as { channel?: string }).channel,
      );
      expect(channels).toContain("no-company");
      expect(channels).not.toContain("scoped-dropped");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});

describe("PLA-673 — back-fill runId for pre-PLA-657 SDK secrets.resolve", () => {
  // Plugins bundled against the pre-PLA-657 SDK (e.g. platform.cad ≤0.1.7)
  // call `ctx.secrets.resolve(secretRef)` without threading runId. The new
  // server-side handler requires runId, so any such call would otherwise fail
  // with `runcontext_invalid` even when the host has a valid active dispatch.
  // The fix carries runId/agentId on PluginInvocationScope, and the gated
  // wrapper in host-client-factory back-fills `runId` from the scope.
  //
  // This integration test wires a worker that emulates the legacy wire shape
  // (sends `{secretRef}` only) and asserts the host-side service handler
  // receives the runId from the executeTool dispatch.

  it("back-fills runId from the executeTool invocation scope when the worker omits it", async () => {
    const secretsResolve = vi.fn(async (params: { secretRef: string; runId?: string }) => {
      // The real handler would do dispatch lookup + binding check; we just
      // assert the back-fill threaded runId through to this point.
      return `value-for-${params.secretRef}-via-${params.runId ?? "<missing>"}`;
    });
    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["secrets.read-ref"],
      services: {
        secrets: { resolve: secretsResolve },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: LEGACY_SECRETS_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: handlers,
    });

    try {
      await handle.start();

      await expect(
        handle.call("executeTool", {
          toolName: "cad.export",
          parameters: {
            secretRef: "11111111-1111-1111-1111-111111111111",
          },
          runContext: {
            agentId: "agent-1",
            runId: "run-pla673",
            companyId: "company-a",
            projectId: "project-1",
          },
        } as unknown as HostToWorkerMethods["executeTool"][0]),
      ).resolves.toMatchObject({
        data: {
          resolvedTo: "value-for-11111111-1111-1111-1111-111111111111-via-run-pla673",
        },
      });

      expect(secretsResolve).toHaveBeenCalledTimes(1);
      // The wire payload arrived from the worker without runId; the gated
      // wrapper back-filled it from the active invocation scope (which the
      // host populated from the outer dispatcher's runContext).
      // PLA-1819: the wrapper also injects the host-derived companyId, which
      // v722's `buildHostServices.secrets.resolve` requires.
      expect(secretsResolve.mock.calls[0]?.[0]).toEqual({
        secretRef: "11111111-1111-1111-1111-111111111111",
        runId: "run-pla673",
        companyId: "company-a",
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("still fails closed when there is no active invocation (no scope to back-fill from)", async () => {
    const secretsResolve = vi.fn(async () => "should-not-be-called");
    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["secrets.read-ref"],
      services: {
        secrets: { resolve: secretsResolve },
      } as unknown as HostServices,
    });
    // No active invocation: a forged worker→host call with no
    // paperclipInvocationId arrives.
    //
    // PLA-1819: the denial now happens at the WRAPPER, not downstream in the
    // server-side secrets handler. `resolveRequiredCompanyId` finds no
    // host-derived tenant (no invocationScope, no singleInFlightScope, and no
    // serviceScope.runId to defer resolution to) and throws before host
    // services are entered. The server-side `runcontext_invalid` gate is
    // untouched and remains the second layer.
    await expect(
      handlers["secrets.resolve"](
        { secretRef: "11111111-1111-1111-1111-111111111111" } as never,
        {},
      ),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });

    expect(secretsResolve).not.toHaveBeenCalled();
  });
});

describe("PLA-719 — back-fill runId when the worker echoes no invocation id", () => {
  // The deployed platform.cad worker (cad ≤0.1.7) sends `secrets.resolve`
  // with neither `runId` NOR `paperclipInvocationId` (verified: its bundled
  // worker.js has zero `paperclipInvocation` references). PLA-673's back-fill
  // therefore had nothing to resolve a scope from and the call failed closed
  // at the server's secrets handler. PLA-719 attributes such an id-less
  // callback to the SINGLE in-flight host→worker dispatch and surfaces its
  // host-validated scope via `singleInFlightScope`, so the runId back-fill
  // succeeds — without trusting any worker-supplied field.

  it("back-fills runId from the single in-flight dispatch when the worker omits the invocation id", async () => {
    const secretsResolve = vi.fn(async (params: { secretRef: string; runId?: string }) => {
      return `value-for-${params.secretRef}-via-${params.runId ?? "<missing>"}`;
    });
    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["secrets.read-ref"],
      services: {
        secrets: { resolve: secretsResolve },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: NOID_SECRETS_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: handlers,
    });

    try {
      await handle.start();

      await expect(
        handle.call("executeTool", {
          toolName: "cad.export",
          parameters: {
            secretRef: "11111111-1111-1111-1111-111111111111",
          },
          runContext: {
            agentId: "agent-1",
            runId: "run-pla719",
            companyId: "company-a",
            projectId: "project-1",
          },
        } as unknown as HostToWorkerMethods["executeTool"][0]),
      ).resolves.toMatchObject({
        data: {
          resolvedTo: "value-for-11111111-1111-1111-1111-111111111111-via-run-pla719",
        },
      });

      expect(secretsResolve).toHaveBeenCalledTimes(1);
      // No runId AND no invocation id arrived on the wire; the host resolved
      // the single in-flight executeTool dispatch and the gated wrapper
      // back-filled runId from its host-validated scope.
      // PLA-1819: companyId comes from the same host-derived singleInFlight pin
      // the runId came from — never from the worker.
      expect(secretsResolve.mock.calls[0]?.[0]).toEqual({
        secretRef: "11111111-1111-1111-1111-111111111111",
        runId: "run-pla719",
        companyId: "company-a",
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("does not back-fill (fails closed) when no scope is surfaced — neither invocationScope nor singleInFlightScope", async () => {
    const secretsResolve = vi.fn(async () => "should-not-be-resolved");
    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["secrets.read-ref"],
      services: {
        secrets: { resolve: secretsResolve },
      } as unknown as HostServices,
    });

    // Context with invalidInvocationScope but NO singleInFlightScope models the
    // ambiguous case (0 or 2+ dispatches in-flight).
    //
    // PLA-1819: the wrapper now denies outright instead of forwarding unchanged
    // and letting the server-side secrets handler throw `runcontext_invalid`.
    // Same fail-closed outcome, one layer earlier — host services are never
    // entered.
    await expect(
      handlers["secrets.resolve"](
        { secretRef: "11111111-1111-1111-1111-111111111111" } as never,
        { invalidInvocationScope: true },
      ),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });

    expect(secretsResolve).not.toHaveBeenCalled();
  });

  it("back-fills runId from singleInFlightScope while leaving company-scope enforcement to invalidInvocationScope", async () => {
    const secretsResolve = vi.fn(
      async (params: { secretRef: string; runId?: string }) => params.runId ?? "<missing>",
    );
    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["secrets.read-ref"],
      services: {
        secrets: { resolve: secretsResolve },
      } as unknown as HostServices,
    });

    // singleInFlightScope feeds the runId back-fill. The runId originates from
    // the host scope, never the worker params.
    //
    // PLA-1819: `secrets.resolve` IS now company-guarded at the wrapper, but
    // `singleInFlightScope.companyId` satisfies the guard (it is host-derived),
    // so `invalidInvocationScope` still does not block this call — resolution
    // runs ahead of that rejection, per the PLA-818 ordering precedent.
    await expect(
      handlers["secrets.resolve"](
        { secretRef: "11111111-1111-1111-1111-111111111111" } as never,
        {
          invalidInvocationScope: true,
          singleInFlightScope: {
            companyId: "company-a",
            runId: "run-pla719",
            agentId: "agent-1",
          },
        },
      ),
    ).resolves.toEqual("run-pla719");

    // v722 plumbs the host-validated call context to HostServices as an
    // explicit second argument; the back-filled params stay the first.
    expect(secretsResolve).toHaveBeenCalledWith(
      {
        secretRef: "11111111-1111-1111-1111-111111111111",
        runId: "run-pla719",
        companyId: "company-a",
      },
      expect.anything(),
    );
  });

  it("cannot widen company scope: a worker naming company-b is denied even when singleInFlightScope is company-a", async () => {
    // SEC invariant (PLA-721, narrowed by PLA-1819): a worker that names a
    // *different* company in params is denied. `requireInvocationCompanyScope`
    // runs first and never reads `singleInFlightScope`, and the no-id branch
    // always sets `invalidInvocationScope`.
    //
    // PLA-1819 narrows PLA-721's original wording — `singleInFlightScope` no
    // longer feeds the runId back-fill *only*; for `config.get` and
    // `secrets.resolve` it is also an accepted tenant source in
    // `resolveRequiredCompanyId`. It still cannot WIDEN scope: a worker-named
    // company must equal the host-derived pin or it throws. This test pins that.
    const companiesGet = vi.fn(async (params: { companyId: string }) => ({ id: params.companyId }));
    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["companies.read"],
      services: {
        companies: { get: companiesGet },
      } as unknown as HostServices,
    });

    await expect(
      handlers["companies.get"](
        { companyId: "company-b" } as never,
        {
          invalidInvocationScope: true,
          singleInFlightScope: {
            companyId: "company-a",
            runId: "run-pla719",
            agentId: "agent-1",
          },
        },
      ),
    ).rejects.toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
      message: expect.stringContaining("unknown invocation scope"),
    });

    expect(companiesGet).not.toHaveBeenCalled();
  });
});

describe("PLA-818 — inbound relay createComment authorized end-to-end under invalidInvocationScope", () => {
  // The live fork.16 bug: an operator reply routed through the messenger's
  // onWebhook/getUpdates path calls `ctx.issues.createComment` WITHOUT echoing a
  // resolvable invocation id while a host→worker dispatch is in flight. The host
  // base context surfaces `invalidInvocationScope: true` and attaches the
  // worker-lifetime `serviceScope`. Pre-fix the SDK gate threw on
  // `invalidInvocationScope` before reaching the PLA-814 allowlist bypass, so the
  // comment was denied and never landed. This proves the FULL chain
  // (contextForWorkerMessage → SDK gate) now authorizes the reach-checked,
  // allowlisted createComment — guarding against a context-shape regression
  // silently re-breaking the relay.

  it("authorizes an id-less issues.createComment emitted during an in-flight dispatch (real worker)", async () => {
    const createComment = vi.fn(async (params: { issueId: string; body: string; companyId: string }) => ({
      id: `comment-for-${params.issueId}`,
    }));
    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["issue.comments.create"],
      services: {
        issues: { createComment },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INBOUND_COMMENT_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: handlers,
    });

    try {
      await handle.start();

      await expect(
        handle.call("executeTool", {
          toolName: "messenger.route",
          parameters: {
            issueId: "issue-1",
            body: "operator reply",
            companyId: "company-a",
          },
          runContext: {
            agentId: "agent-1",
            runId: "run-pla818",
            companyId: "company-a",
            projectId: "project-1",
          },
        } as unknown as HostToWorkerMethods["executeTool"][0]),
      ).resolves.toMatchObject({
        data: { commentedVia: { id: "comment-for-issue-1" } },
      });

      // The nested createComment carried no invocation id (→ invalidInvocationScope
      // in base context) yet was authorized via the serviceScope allowlist bypass.
      expect(createComment).toHaveBeenCalledTimes(1);
      expect(createComment).toHaveBeenCalledWith({
        issueId: "issue-1",
        body: "operator reply",
        companyId: "company-a",
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});

describe("PLA-773 — background dispatch run-context (item 1) + redaction cleanup (item 2)", () => {
  const SECRET_REF = "11111111-1111-4111-8111-111111111111";

  it("mints a company-scoped background run-context for an onEvent dispatch and threads its runId to the worker's secrets.resolve", async () => {
    const registry = createPluginRunContextRegistry({ sweepIntervalMs: 60_000 });
    const registerBackground = vi.spyOn(registry, "registerBackground");

    const secretsResolve = vi.fn(
      async (params: { secretRef: string; runId?: string }) =>
        `value-via-${params.runId ?? "<missing>"}`,
    );
    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["secrets.read-ref"],
      services: {
        secrets: { resolve: secretsResolve },
      } as unknown as HostServices,
    });

    const handle = createPluginWorkerHandle(
      "test.plugin",
      {
        entrypointPath: ONEVENT_WORKER_ENTRYPOINT,
        manifest: TEST_MANIFEST,
        config: {},
        instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
        apiVersion: 1,
        hostHandlers: handlers,
      },
      { runContextRegistry: registry },
    );

    try {
      await handle.start();

      await handle.call("onEvent", {
        event: { companyId: "company-a", secretRef: SECRET_REF },
      } as unknown as HostToWorkerMethods["onEvent"][0]);

      // A per-dispatch background ctx was minted for the TRIGGERING company.
      expect(registerBackground).toHaveBeenCalledTimes(1);
      const [, mintedRunId, companyId] = registerBackground.mock.calls[0]!;
      expect(companyId).toBe("company-a");

      // The worker's id-less secrets.resolve callback was back-filled with the
      // minted background runId — NOT the worker-lifetime service runId.
      expect(secretsResolve).toHaveBeenCalledTimes(1);
      // PLA-1819: a background dispatch carries a TRIGGERING company, so the
      // pin exists and is injected — unlike the company-less service context.
      expect(secretsResolve.mock.calls[0]?.[0]).toEqual({
        secretRef: SECRET_REF,
        runId: mintedRunId,
        companyId: "company-a",
      });
      expect(mintedRunId).not.toBe(handle.serviceRunId);

      // The per-dispatch ctx is cleared once the dispatch settles.
      expect(registry.get("test.plugin", mintedRunId)).toBeNull();
    } finally {
      await handle.stop().catch(() => undefined);
      registry.dispose();
    }
  });

  it("clears the worker's service-runId redaction values on manager stopWorker (item 2)", async () => {
    const registry = createPluginRunContextRegistry({ sweepIntervalMs: 60_000 });
    const manager = createPluginWorkerManager({ runContextRegistry: registry });

    const handle = await manager.startWorker("test.plugin", {
      entrypointPath: ONEVENT_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
    });

    const serviceRunId = handle.serviceRunId;
    clearRunSecretValues(serviceRunId);

    try {
      // Simulate a background/setup-loop secrets.resolve registering plaintext
      // under the service runId (TTL-exempt — lingers without explicit clear).
      registerRunSecretValue(serviceRunId, "Zx7Qm2Lp9Rt4Wv6Yb1Nc");
      expect(registeredRunCount()).toBeGreaterThan(0);

      await manager.stopWorker("test.plugin");

      // The service runId's plaintext is gone after stop.
      expect(registeredRunCount()).toBe(0);
    } finally {
      clearRunSecretValues(serviceRunId);
      await manager.stopAll().catch(() => undefined);
      registry.dispose();
    }
  });
});

// PLA-1944 — no-dispatch config.get resolved by the host-minted agreement
// gate, exercised end-to-end: real `createPluginWorkerHandle` dispatch
// mechanics (per PLA-818/PLA-773 above) AND real DB-backed `buildHostServices`
// (per plugin-issue-attachments-host-services.test.ts's embedded-postgres
// pattern) — an SDK-level mock of `services.config.getAgreedOrDeny` alone
// does not exercise the real `plugin_config` agreement/divergence logic this
// gate depends on.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin-worker-manager PLA-1944 agreement-gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("PLA-1944 — no-dispatch config.get agreement gate (real worker + real DB)", () => {
  const PLUGIN_KEY = "test.config-agreement-worker";
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-worker-config-agreement-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createEventBusStub() {
    return {
      forPlugin() {
        return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
      },
    } as any;
  }

  async function createCompany(prefix: string) {
    return db
      .insert(companies)
      .values({
        name: `${prefix} ${randomUUID()}`,
        issuePrefix: `${prefix}${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function installPlugin() {
    return db
      .insert(plugins)
      .values({
        pluginKey: PLUGIN_KEY,
        packageName: "@paperclipai/test-config-agreement-worker",
        version: "0.0.0",
        manifestJson: {
          id: PLUGIN_KEY,
          version: "0.0.0",
          displayName: "Config agreement worker test plugin",
          apiVersion: 1,
          entrypoints: { worker: "worker.js" },
        } as any,
        status: "ready",
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  it("agrees: a setup()-time config.get with zero active invocations resolves via the agreement gate", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const companyA = await createCompany("WKA");
    const companyB = await createCompany("WKB");
    await registry.upsertConfig(plugin.id, companyA.id, { configJson: { defaultBranch: "main" } });
    await registry.upsertConfig(plugin.id, companyB.id, { configJson: { defaultBranch: "main" } });

    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());
    const handlers = createHostClientHandlers({
      pluginId: PLUGIN_KEY,
      capabilities: [],
      services,
    });
    const handle = createPluginWorkerHandle(PLUGIN_KEY, {
      entrypointPath: CONFIG_AGREEMENT_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: handlers,
    });

    try {
      // The fixture fires its no-dispatch config.get BEFORE responding to
      // `initialize`, so by the time `start()` resolves the agreement gate has
      // already run against the real, seeded `plugin_config` rows above.
      await handle.start();

      const outcome = await handle.call("executeTool", {
        toolName: "reportConfigGetOutcome",
        parameters: {},
        runContext: {
          agentId: "agent-1",
          runId: "run-pla1944-agree",
          companyId: companyA.id,
          projectId: "project-1",
        },
      } as unknown as HostToWorkerMethods["executeTool"][0]);

      expect(outcome).toMatchObject({
        data: {
          configGetOutcome: {
            ok: true,
            result: { defaultBranch: "main" },
          },
        },
      });
    } finally {
      services.dispose();
      await handle.stop().catch(() => undefined);
    }
  });

  it("diverges: a setup()-time config.get denies AND surfaces a health signal via plugins.lastError", async () => {
    const plugin = await installPlugin();
    const registry = pluginRegistryService(db);
    const companyA = await createCompany("WKC");
    const companyB = await createCompany("WKD");
    await registry.upsertConfig(plugin.id, companyA.id, { configJson: { defaultBranch: "main" } });
    await registry.upsertConfig(plugin.id, companyB.id, { configJson: { defaultBranch: "dev" } });

    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());
    const handlers = createHostClientHandlers({
      pluginId: PLUGIN_KEY,
      capabilities: [],
      services,
    });
    const handle = createPluginWorkerHandle(PLUGIN_KEY, {
      entrypointPath: CONFIG_AGREEMENT_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: handlers,
    });

    try {
      await handle.start();

      const outcome = await handle.call("executeTool", {
        toolName: "reportConfigGetOutcome",
        parameters: {},
        runContext: {
          agentId: "agent-1",
          runId: "run-pla1944-diverge",
          companyId: companyA.id,
          projectId: "project-1",
        },
      } as unknown as HostToWorkerMethods["executeTool"][0]);

      expect((outcome as any).data.configGetOutcome.ok).toBe(false);

      // Health signal: plugins.lastError names the divergence, no company ids.
      const refreshed = await registry.getById(plugin.id);
      expect(refreshed?.lastError).toBeTruthy();
      expect(refreshed!.lastError).not.toContain(companyA.id);
      expect(refreshed!.lastError).not.toContain(companyB.id);
    } finally {
      services.dispose();
      await handle.stop().catch(() => undefined);
    }
  });
});

// PLA-1149: bounded worker→host IPC frame reader (OOM hardening).
describe("resolveMaxIpcFrameBytes", () => {
  const ENV_KEY = "PAPERCLIP_PLUGIN_MAX_IPC_FRAME_BYTES";
  const original = process.env[ENV_KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("prefers a valid explicit override", () => {
    process.env[ENV_KEY] = "100";
    expect(resolveMaxIpcFrameBytes(4096)).toBe(4096);
  });

  it("falls back to the env var when no override is given", () => {
    process.env[ENV_KEY] = "12345";
    expect(resolveMaxIpcFrameBytes()).toBe(12345);
  });

  it("ignores non-positive / non-finite values and uses the default", () => {
    delete process.env[ENV_KEY];
    const def = resolveMaxIpcFrameBytes();
    expect(def).toBe(64 * 1024 * 1024);
    expect(resolveMaxIpcFrameBytes(0)).toBe(def);
    expect(resolveMaxIpcFrameBytes(-5)).toBe(def);
    expect(resolveMaxIpcFrameBytes(Number.NaN)).toBe(def);
    process.env[ENV_KEY] = "not-a-number";
    expect(resolveMaxIpcFrameBytes()).toBe(def);
  });
});

describe("createBoundedFrameReader", () => {
  it("emits complete newline-delimited frames, including several in one chunk", () => {
    const frames: string[] = [];
    const reader = createBoundedFrameReader({
      maxFrameBytes: 1024,
      onFrame: (line) => frames.push(line),
      onOversize: () => {
        throw new Error("unexpected oversize");
      },
    });
    reader.push(Buffer.from("a\nbb\nccc\n"));
    expect(frames).toEqual(["a", "bb", "ccc"]);
  });

  it("reassembles a frame split across multiple chunks", () => {
    const frames: string[] = [];
    const reader = createBoundedFrameReader({
      maxFrameBytes: 1024,
      onFrame: (line) => frames.push(line),
      onOversize: () => {
        throw new Error("unexpected oversize");
      },
    });
    reader.push(Buffer.from("hel"));
    reader.push(Buffer.from("lo wor"));
    reader.push(Buffer.from("ld\nnext\n"));
    expect(frames).toEqual(["hello world", "next"]);
  });

  it("allows a frame exactly at the cap but trips one byte over", () => {
    const atCap: string[] = [];
    const atCapReader = createBoundedFrameReader({
      maxFrameBytes: 8,
      onFrame: (line) => atCap.push(line),
      onOversize: () => {
        throw new Error("should not trip at exactly the cap");
      },
    });
    atCapReader.push(Buffer.from("12345678\n"));
    expect(atCap).toEqual(["12345678"]);

    const overFrames: string[] = [];
    const trips: Array<{ bytesSeen: number; limit: number }> = [];
    const overReader = createBoundedFrameReader({
      maxFrameBytes: 8,
      onFrame: (line) => overFrames.push(line),
      onOversize: (info) => trips.push(info),
    });
    overReader.push(Buffer.from("123456789\n"));
    expect(overFrames).toEqual([]);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.limit).toBe(8);
  });

  it("trips before the full payload is buffered and resynchronizes on the next frame", () => {
    const frames: string[] = [];
    const trips: Array<{ bytesSeen: number; limit: number }> = [];
    const reader = createBoundedFrameReader({
      maxFrameBytes: 16,
      onFrame: (line) => frames.push(line),
      onOversize: (info) => trips.push(info),
    });

    // Stream a giant newline-less frame in small chunks, then a valid frame.
    for (let i = 0; i < 1000; i++) {
      reader.push(Buffer.from("x".repeat(64)));
    }
    // Trips exactly once; never accumulates the whole 64 KiB.
    expect(trips).toHaveLength(1);
    // bytesSeen is bounded near the cap + one chunk, not the 64 KiB total.
    expect(trips[0]!.bytesSeen).toBeLessThanOrEqual(16 + 64);

    // The next newline resynchronizes; subsequent valid frames parse again.
    reader.push(Buffer.from("\nrecovered\n"));
    expect(frames).toEqual(["recovered"]);
    expect(trips).toHaveLength(1);
  });
});

describe("plugin worker IPC frame cap (PLA-1149 end-to-end)", () => {
  it("terminates a worker that emits an over-limit IPC frame", async () => {
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: OVERSIZE_FRAME_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
      autoRestart: false,
      maxIpcFrameBytes: 4096,
    });

    const crashed = new Promise<void>((resolve) => {
      handle.on("crash", () => resolve());
    });

    try {
      await handle.start();

      // Ask the worker to emit a single ~5 MiB newline-less frame, far above the
      // 4 KiB cap. The host must drop + terminate rather than buffer it.
      const call = handle.call(
        "environmentExecute",
        { oversizeBytes: 5 * 1024 * 1024 } as HostToWorkerMethods["environmentExecute"][0],
      );
      await expect(call).rejects.toThrow();
      await crashed;
      expect(handle.status).not.toBe("running");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});

describe("plugin worker node IPC channel removal (PLA-1154)", () => {
  it("spawns the worker with no live node IPC channel (fd 3 gone)", async () => {
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: IPC_CHANNEL_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
      autoRestart: false,
    });

    try {
      await handle.start();

      const probe = (await handle.call(
        "environmentExecute",
        {} as HostToWorkerMethods["environmentExecute"][0],
      )) as {
        hasProcessSend: boolean;
        hasChannel: boolean;
        fd3Write: { threw: boolean; code?: string };
      };

      // The worker has no IPC channel: no `process.send`, no `process.channel`.
      expect(probe.hasProcessSend).toBe(false);
      expect(probe.hasChannel).toBe(false);
      // The OOM bypass vector — a raw newline-less write to fd 3 — fails because
      // the fd is not provisioned, so the host never buffers the payload.
      expect(probe.fd3Write.threw).toBe(true);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});


describe("plugin host company context guards", () => {
  it("rejects config and secret calls without host-issued company context before host services run", async () => {
    const configGet = vi.fn(async () => ({ apiKey: "unreachable" }));
    const secretsResolve = vi.fn(async () => "unreachable");
    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["secrets.read-ref"],
      services: {
        config: { get: configGet },
        secrets: { resolve: secretsResolve },
      } as unknown as HostServices,
    });

    await expect(handlers["config.get"]({})).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });
    await expect(handlers["config.get"]({ companyId: "company-1" })).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });
    await expect(
      handlers["secrets.resolve"]({
        secretRef: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" },
      }),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });
    await expect(
      handlers["secrets.resolve"]({
        companyId: "company-1",
        secretRef: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" },
      }),
    ).rejects.toMatchObject({
      name: "InvocationScopeDeniedError",
      message: expect.stringContaining("company context is required"),
    });

    expect(configGet).not.toHaveBeenCalled();
    expect(secretsResolve).not.toHaveBeenCalled();
  });

  it("rejects cross-company config and secret reads in scoped worker invocations before host services run", async () => {
    const configGet = vi.fn(async () => ({ apiKeyRef: "unreachable" }));
    const secretsResolve = vi.fn(async () => "unreachable");
    const hostHandlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["secrets.read-ref"],
      services: {
        config: { get: configGet },
        secrets: { resolve: secretsResolve },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers,
    });

    try {
      await handle.start();

      for (const hostMethod of ["config.get", "secrets.resolve"] as const) {
        await expect(handle.call("performAction", {
          key: "probe",
          params: {
            mode: "echo",
            hostMethod,
            requestedCompanyId: "company-b",
          },
          actorContext: {
            type: "agent",
            userId: null,
            agentId: "agent-1",
            runId: "run-1",
            companyId: "company-a",
          },
          renderEnvironment: null,
        })).rejects.toMatchObject({
          code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
          message: expect.stringContaining('requested company "company-b"'),
        });
      }

      expect(configGet).not.toHaveBeenCalled();
      expect(secretsResolve).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});
