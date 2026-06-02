/**
 * PLA-781 — wiring contract between the plugin worker manager and the secrets
 * host-handler over a SHARED run-context registry.
 *
 * The PLA-768 service-context resolve path was already correct in isolation, but
 * the running host built the worker manager WITHOUT a registry while the secrets
 * handler read a different one, so `registerService` was a silent no-op and a
 * setup()-loop's `secrets.resolve` always failed Gate 1 with `runcontext_invalid`.
 *
 * These tests drive the REAL worker manager so the service runId is genuinely
 * host-minted (`handle.serviceRunId`) and registered by the manager — NOT
 * hand-registered as the PLA-768 unit tests do. The secrets handler reads the
 * SAME registry instance, mirroring the fixed index.ts/app.ts composition. Each
 * case encodes a guardrail from the SEC advisory (PLA-783):
 *  1. setup()-loop resolve via the manager-minted service runId succeeds, with
 *     the company DERIVED from the binding (`ctx.kind === "service"`).
 *  2. a forged/unregistered runId from the same worker still fails closed with
 *     `runcontext_invalid` (no "accept-any" shortcut).
 *  3. a ref not bound to this install collapses to opaque `not_found` (no
 *     cross-tenant resolution, no allow-list oracle).
 *  4. after worker stop, the stale service runId is deregistered and no longer
 *     resolves.
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveSecretValue: vi.fn().mockResolvedValue("unused"),
  }),
}));

const { createPluginWorkerManager } = await import(
  "../services/plugin-worker-manager.js"
);
const { createPluginRunContextRegistry } = await import(
  "../services/plugin-run-context-registry.js"
);
const { createPluginSecretsHandler } = await import(
  "../services/plugin-secrets-handler.js"
);
const { clearRunSecretValues } = await import("../run-secret-registry.js");

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);
const WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-onevent.cjs");

// In production both the manager's pluginId and the handler's pluginDbId are the
// same plugin-install UUID; the fixture manifest id stands in for it here.
const PLUGIN_ID = "test.plugin";
const PLUGIN_KEY = "platform.test";
const SECRET_BOUND = "11111111-1111-4111-8111-111111111111";
const SECRET_UNBOUND = "33333333-3333-4333-8333-333333333333";
const COMPANY_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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

function buildSecretsHandler(registry: ReturnType<typeof createPluginRunContextRegistry>) {
  const resolverFn = vi.fn(
    async (input: { companyId: string; secretId: string }) =>
      `resolved:${input.companyId}:${input.secretId}`,
  );
  const findServiceBinding = vi.fn(
    async (input: { pluginTargetId: string; secretId: string }) => {
      if (input.secretId !== SECRET_BOUND) return null;
      return {
        companyId: COMPANY_OWNER,
        id: `binding-${input.secretId}`,
        secretId: input.secretId,
        configPath: "tokenSecretId",
        versionSelector: "latest" as const,
        allowedEgress: [],
        egressAllowlistEnforced: false,
      };
    },
  );
  const handler = createPluginSecretsHandler({
    db: {} as never,
    pluginDbId: PLUGIN_ID,
    pluginKey: PLUGIN_KEY,
    runContextRegistry: registry,
    bindings: { findBinding: vi.fn(async () => null), findServiceBinding },
    resolver: { resolve: resolverFn },
  });
  return { handler, resolverFn, findServiceBinding };
}

async function startWorker(registry: ReturnType<typeof createPluginRunContextRegistry>) {
  const manager = createPluginWorkerManager({ runContextRegistry: registry });
  const handle = await manager.startWorker(PLUGIN_ID, {
    entrypointPath: WORKER_ENTRYPOINT,
    manifest: TEST_MANIFEST,
    config: {},
    instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
    apiVersion: 1,
    hostHandlers: {},
  });
  return { manager, serviceRunId: handle.serviceRunId };
}

let activeRunIds: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  activeRunIds = [];
});

afterEach(() => {
  for (const runId of activeRunIds) clearRunSecretValues(runId);
});

describe("PLA-781 — worker manager ↔ secrets handler shared registry", () => {
  it("resolves a setup()-loop secret via the manager-minted service runId (company derived from binding)", async () => {
    const registry = createPluginRunContextRegistry({ sweepIntervalMs: 60_000 });
    const { handler, resolverFn, findServiceBinding } = buildSecretsHandler(registry);
    const { manager, serviceRunId } = await startWorker(registry);
    activeRunIds.push(serviceRunId);

    try {
      // The runId is host-minted by the manager — the worker never supplies it.
      const value = await handler.resolve({
        secretRef: SECRET_BOUND,
        runId: serviceRunId,
      });

      expect(value).toBe(`resolved:${COMPANY_OWNER}:${SECRET_BOUND}`);
      // Company derived from the operator binding, never asserted by the worker.
      expect(findServiceBinding).toHaveBeenCalledWith({
        pluginTargetId: PLUGIN_ID,
        secretId: SECRET_BOUND,
      });
      expect(resolverFn).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: COMPANY_OWNER, secretId: SECRET_BOUND }),
      );
    } finally {
      await manager.stopAll().catch(() => undefined);
      registry.dispose();
    }
  });

  it("fails closed (runcontext_invalid) for a forged/unregistered runId from the same worker", async () => {
    const registry = createPluginRunContextRegistry({ sweepIntervalMs: 60_000 });
    const { handler, findServiceBinding } = buildSecretsHandler(registry);
    const { manager, serviceRunId } = await startWorker(registry);
    activeRunIds.push(serviceRunId);

    try {
      const forgedRunId = randomUUID();
      expect(forgedRunId).not.toBe(serviceRunId);

      await expect(
        handler.resolve({ secretRef: SECRET_BOUND, runId: forgedRunId }),
      ).rejects.toMatchObject({ code: "runcontext_invalid" });

      // An unregistered runId must never reach the binding lookup.
      expect(findServiceBinding).not.toHaveBeenCalled();
    } finally {
      await manager.stopAll().catch(() => undefined);
      registry.dispose();
    }
  });

  it("collapses a ref not bound to this install to opaque not_found", async () => {
    const registry = createPluginRunContextRegistry({ sweepIntervalMs: 60_000 });
    const { handler } = buildSecretsHandler(registry);
    const { manager, serviceRunId } = await startWorker(registry);
    activeRunIds.push(serviceRunId);

    try {
      await expect(
        handler.resolve({ secretRef: SECRET_UNBOUND, runId: serviceRunId }),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await manager.stopAll().catch(() => undefined);
      registry.dispose();
    }
  });

  it("deregisters the stale service runId after worker stop (no longer resolves)", async () => {
    const registry = createPluginRunContextRegistry({ sweepIntervalMs: 60_000 });
    const { handler } = buildSecretsHandler(registry);
    const { manager, serviceRunId } = await startWorker(registry);
    activeRunIds.push(serviceRunId);

    // Resolvable while the worker is alive.
    await expect(
      handler.resolve({ secretRef: SECRET_BOUND, runId: serviceRunId }),
    ).resolves.toBe(`resolved:${COMPANY_OWNER}:${SECRET_BOUND}`);

    await manager.stopWorker(PLUGIN_ID);

    try {
      expect(registry.get(PLUGIN_ID, serviceRunId)).toBeNull();
      await expect(
        handler.resolve({ secretRef: SECRET_BOUND, runId: serviceRunId }),
      ).rejects.toMatchObject({ code: "runcontext_invalid" });
    } finally {
      await manager.stopAll().catch(() => undefined);
      registry.dispose();
    }
  });
});
